'use strict';
// The central bank's trading desk. The bank acts as a market maker: it estimates a fair value from the
// board, quotes around it with a spread it keeps, manages its inventory and exposure, and refuses trades
// where it cannot price the risk or where the trade would make the game worse.
//
// Installed onto Game.prototype; touches the core rules only through a few hooks
// (round start, rent paid, bankruptcy, net worth).
const { DESK, optionAsk, optionBid, shareAskCost, shareBidProceeds, issueProceeds, cdsPremium, turnLanding } = require('./pricing');
const { LAND } = require('./board');

const PRODUCTS = ['shares', 'issue', 'call', 'put', 'cds', 'insurance', 'swap'];
const HORIZON = 8; // rounds of expected net rent the bank capitalises into a player's share price

module.exports = function installDesk(Game, { fail, toInt, toNum, clamp, round2 }) {
  Object.assign(Game.prototype, {
    initDesk() {
      this.desk = { positions: [], marks: {}, equity: {}, pnl: 0 };
      for (const p of this.players) {
        this.desk.equity[p.id] = { insider: DESK.insiderShares, float: DESK.floatShares, issued: 0, inv: DESK.floatShares, issuedThisRound: 0 };
      }
      this.markEquity();
      this.desk.startInventoryValue = this.deskInventoryValue();
    },

    // ---------------------------------------------------------------- share structure
    outstanding(pid) { const e = this.desk.equity[pid]; return e.insider + e.float + e.issued; },
    outsideShares(pid) { const e = this.desk.equity[pid]; return e.float + e.issued; },
    insiderFraction(pid) { return this.desk.equity[pid].insider / this.outstanding(pid); },

    // ---------------------------------------------------------------- fair value & risk
    // Expected rent cash flow per round (income from own property minus rent likely paid to others
    // minus loan interest), and the size of a typical rent shock either way (for volatility).
    rentFlow(pid) {
      const nOpp = this.active().filter((p) => p.id !== pid).length;
      let inc = 0; let out = 0; let jump2 = 0;
      for (const k of Object.keys(this.props)) {
        const i = Number(k); const pr = this.props[i];
        if (!pr.owner || pr.mortgaged) continue;
        const r = this.rentFor(i, 7);
        if (pr.owner === pid) { inc += LAND[i] * r * nOpp; jump2 += nOpp * LAND[i] * r * r; } else { out += LAND[i] * r; jump2 += LAND[i] * r * r; }
      }
      const interest = this.player(pid).loans.reduce((a, l) => a + (l.principal * l.rate) / 100, 0);
      return { net: inc - out - interest, jump: Math.sqrt(jump2) };
    },
    // Book equity plus ~8 rounds of expected net rent, discounted for the chance of default.
    // (Book equity alone ignores what a built-up colour set will earn, which made monopolists' shares a free lunch.)
    fairValue(pid) {
      const p = this.player(pid);
      if (p.bankrupt) return 0;
      const v = this.bookEquity(p) + HORIZON * this.rentFlow(pid).net;
      return Math.max(0, v * (1 - Math.min(0.8, 4 * this.hazard(pid))));
    },
    livePrice(pid) { return this.fairValue(pid) / this.outstanding(pid); },
    // The price every desk trade, payout and valuation uses: fixed once per round (bankrupt = 0).
    markPrice(pid) { return this.player(pid).bankrupt ? 0 : (this.desk.marks[pid] ? this.desk.marks[pid].price : 0); },
    markEquity() {
      for (const p of this.players) {
        const m = (this.desk.marks[p.id] ||= { price: 0, history: [], vol: 0.2 });
        m.price = round2(this.livePrice(p.id));
        m.history.push(m.price);
        if (m.history.length > 12) m.history.shift();
        m.vol = this.equityVol(p.id);
        this.desk.equity[p.id].issuedThisRound = 0;
      }
    },
    // Realised volatility of the marks, combined with the jump risk the board implies (one big rent bill
    // or windfall relative to the player's value). History alone looks calm right up until a hotel hit.
    equityVol(pid) {
      const h = this.desk.marks[pid].history;
      const rets = [];
      for (let k = 1; k < h.length; k++) if (h[k - 1] > 0 && h[k] > 0) rets.push(Math.log(h[k] / h[k - 1]));
      let sd = 0;
      if (rets.length >= 2) {
        const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
        sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
      }
      const jump = this.player(pid).bankrupt ? 0 : this.rentFlow(pid).jump / Math.max(1, this.fairValue(pid));
      return round2(clamp(Math.sqrt(sd * sd + jump * jump), 0.12, 1.0));
    },
    maxOpponentRent(pid) {
      let mx = 0;
      for (const i of Object.keys(this.props)) {
        const pr = this.props[i];
        if (pr.owner && pr.owner !== pid) mx = Math.max(mx, this.rentFor(Number(i), 7));
      }
      return mx;
    },
    // Per-round default probability used to price credit and to decide when to stop dealing.
    hazard(pid) {
      const p = this.player(pid);
      if (p.bankrupt) return 1;
      const eq = this.bookEquity(p);
      if (eq <= 0) return 0.25;
      let h = 0.004 + 0.012 * Math.max(0, this.leverage(p) - 1);
      if (p.cash < 0) h += 0.08;
      else if (p.cash < this.scale(100)) h += 0.02;
      h += 0.03 * Math.min(1, this.maxOpponentRent(pid) / eq);
      return round2(clamp(h, 0.002, 0.3) * 1000) / 1000;
    },
    // Rent insurance is priced from where you stand right now: the expected covered rent over your
    // next turn (dice odds from your square, including a second move after doubles), plus the bank's load.
    insuranceQuote(pid, deductible) {
      const p = this.player(pid);
      const land = turnLanding(p.pos);
      const moveChance = p.inJail ? (p.jailTurns >= 2 ? 1 : 1 / 6) : 1;
      let e = 0;
      for (const k of Object.keys(this.props)) {
        const i = Number(k); const pr = this.props[i];
        if (!pr.owner || pr.owner === pid || pr.mortgaged) continue;
        const rent = this.rentFor(i, 7);
        e += land[i] * Math.min(DESK.insuranceCap, DESK.insuranceCoverage * Math.max(0, rent - deductible));
      }
      return Math.max(DESK.insuranceMin, Math.round(e * moveChance * DESK.insuranceLoad));
    },
    swapRate(term, side) {
      const mid = this.curveRate(term);
      return round2(side === 'payFixed' ? mid + DESK.swapSpread : mid - DESK.swapSpread);
    },
    deskLimit(p) { return Math.max(this.scale(500), 2 * Math.max(0, this.bookEquity(p))); },
    optionExposure(ref) { return this.desk.positions.filter((x) => (x.type === 'call' || x.type === 'put') && x.ref === ref).reduce((a, x) => a + x.shares, 0); },
    cdsExposure(ref) { return this.desk.positions.filter((x) => x.type === 'cds' && x.ref === ref).reduce((a, x) => a + x.notional, 0); },
    cdsCap(ref) { return Math.max(this.scale(500), Math.round(1.5 * Math.max(0, this.bookEquity(this.player(ref))))); },
    deskInventoryValue() {
      return this.players.reduce((a, p) => a + this.desk.equity[p.id].inv * this.markPrice(p.id), 0);
    },

    // ---------------------------------------------------------------- cash movement with P&L
    deskPay(fromId, toId, amount, reason) {
      const paid = this.pay(fromId, toId, amount, `bank desk: ${reason}`);
      if (!fromId) this.desk.pnl -= paid;
      if (!toId) this.desk.pnl += paid;
      return paid;
    },

    // ---------------------------------------------------------------- trading
    deskBuy(p, o = {}) {
      this.requirePlaying(); this.requireAlive(p);
      const product = String(o.product);
      if (!PRODUCTS.includes(product)) fail('Unknown desk product');
      const mine = this.desk.positions.filter((x) => x.holder === p.id);
      if (product !== 'issue' && mine.length >= DESK.maxPositions) fail(`At most ${DESK.maxPositions} open desk positions`);
      const term = () => { const t = toInt(o.term, 'term'); if (!DESK.terms.includes(t)) fail('Term must be 5, 10 or 20 rounds'); return t; };
      const refPlayer = () => {
        const r = this.player(o.ref);
        if (r.id === p.id) fail('You cannot trade instruments on yourself');
        if (r.bankrupt) fail(`${r.name} is bankrupt`);
        return r;
      };
      const pctH = (h) => `${(h * 100).toFixed(1)}%`;
      const pos = { id: this.id('D'), holder: p.id, type: product, opened: this.round };

      if (product === 'shares') {
        const r = refPlayer(); const n = toInt(o.shares, 'shares'); const e = this.desk.equity[r.id];
        const held = mine.filter((x) => x.type === 'shares' && x.ref === r.id).reduce((a, x) => a + x.shares, 0);
        if (n < 1 || held + n > DESK.maxSharesPerName) fail(`You can hold at most ${DESK.maxSharesPerName} shares of one player`);
        if (n > e.inv) fail(e.inv ? `Only ${e.inv} ${r.name} shares are available — more exist only if ${r.name} issues them` : `No ${r.name} shares are available — ${r.name} would have to issue more`);
        const price = this.markPrice(r.id);
        if (price <= 0) fail(`${r.name}'s shares have no value`);
        const cost = shareAskCost(price, n, e.inv, this.outsideShares(r.id));
        if (p.cash < cost) fail(`Need $${cost}`);
        this.deskPay(p.id, null, cost, `bought ${n} shares of ${r.name} (mark $${price.toFixed(2)})`);
        e.inv -= n;
        const ex = mine.find((x) => x.type === 'shares' && x.ref === r.id);
        if (ex) { ex.cost += cost; ex.shares += n; return; }
        Object.assign(pos, { ref: r.id, shares: n, cost });
      } else if (product === 'issue') {
        const e = this.desk.equity[p.id]; const n = toInt(o.shares, 'shares');
        const room = Math.min(DESK.maxIssuePerRound - e.issuedThisRound, DESK.maxIssuedTotal - e.issued);
        if (n < 1 || n > room) fail(room > 0 ? `You can issue at most ${room} more shares this round` : 'You cannot issue more shares this round');
        const price = this.markPrice(p.id); const h = this.hazard(p.id);
        if (price <= 0 || this.bookEquity(p) <= 0) fail('The bank will not buy new shares from a player with no equity');
        if (h > DESK.issueMaxHazard) fail(`The bank will not take new shares while your default risk is ${pctH(h)} a round — get your finances in order first`);
        const proceeds = issueProceeds(price, n, this.outstanding(p.id), h);
        if (proceeds <= 0) fail('No bid for those shares');
        this.deskPay(null, p.id, proceeds, `${p.name} issues ${n} new shares (mark $${price.toFixed(2)})`);
        e.issued += n; e.inv += n; e.issuedThisRound += n;
        this.addLog(`🏛 ${p.name} issues ${n} new shares to the market for $${proceeds}; ${e.insider} of ${this.outstanding(p.id)} shares are now theirs.`, 'bank');
        return;
      } else if (product === 'call' || product === 'put') {
        const r = refPlayer(); const n = toInt(o.shares, 'shares'); const t = term();
        if (n < 1 || n > DESK.maxSharesPerName) fail(`1 to ${DESK.maxSharesPerName} shares per option`);
        const K = round2(Math.max(0, toNum(o.strike, 'strike')));
        const m = this.desk.marks[r.id];
        // Black-Scholes has no answer at a $0 price (a put would cost more than it can pay, a call next to nothing).
        if (m.price <= 0) fail(`${r.name}'s shares are marked at $0 — no options until they recover`);
        const h = this.hazard(r.id);
        if (h > DESK.optionMaxHazard) fail(`The bank is not writing options on ${r.name} while their default risk is ${pctH(h)} a round`);
        if (this.optionExposure(r.id) + n > DESK.maxOptionSharesPerName) fail(`The bank's option book on ${r.name} is full (${DESK.maxOptionSharesPerName} shares)`);
        const premium = optionAsk(product, m.price, K, t, this.econ.policyRate, m.vol, n);
        if (p.cash < premium) fail(`Need $${premium} premium`);
        this.deskPay(p.id, null, premium, `${product} on ${n} ${r.name} shares, strike $${K}`);
        Object.assign(pos, { ref: r.id, shares: n, strike: K, expiry: this.round + t, premium });
      } else if (product === 'cds') {
        const r = refPlayer(); const t = term(); const notional = toInt(o.notional, 'notional');
        if (notional < 50 || notional > this.deskLimit(p)) fail(`Notional must be $50 to $${this.deskLimit(p)}`);
        const h = this.hazard(r.id);
        if (h > DESK.cdsMaxHazard) fail(`The bank is not selling protection on ${r.name} — default risk ${pctH(h)} a round is too high to price`);
        const cap = this.cdsCap(r.id); const used = this.cdsExposure(r.id);
        if (used + notional > cap) fail(`The bank caps protection on ${r.name} at $${cap} in total (about 1.5x their equity); $${Math.max(0, cap - used)} is left`);
        const premium = cdsPremium(notional, h);
        if (p.cash < premium) fail(`Need $${premium} for the first premium`);
        this.deskPay(p.id, null, premium, `CDS premium on ${r.name}`);
        Object.assign(pos, { ref: r.id, notional, premium, expiry: this.round + t });
      } else if (product === 'insurance') {
        if (mine.some((x) => x.type === 'insurance')) fail('You already have a rent insurance policy');
        const d = toInt(o.deductible, 'deductible'); const t = term();
        if (!DESK.deductibles.includes(d)) fail('Deductible must be 100, 250 or 500');
        const premium = this.insuranceQuote(p.id, d);
        if (p.cash < premium) fail(`Need $${premium} for this round's premium`);
        this.deskPay(p.id, null, premium, 'rent insurance premium');
        Object.assign(pos, { deductible: d, coverage: DESK.insuranceCoverage, cap: DESK.insuranceCap, premium, expiry: this.round + t });
      } else if (product === 'swap') {
        const side = o.side === 'receiveFixed' ? 'receiveFixed' : 'payFixed';
        const t = term(); const notional = toInt(o.notional, 'notional');
        if (notional < 100 || notional > this.deskLimit(p)) fail(`Notional must be $100 to $${this.deskLimit(p)}`);
        Object.assign(pos, { side, notional, fixed: this.swapRate(t, side), expiry: this.round + t });
      }
      this.desk.positions.push(pos);
      this.addLog(`🏛 ${p.name} opens a bank-desk ${this.describePos(pos)}.`, 'bank');
    },

    describePos(x) {
      const ref = x.ref ? this.player(x.ref).name : '';
      switch (x.type) {
        case 'shares': return `position: ${x.shares} shares of ${ref}`;
        case 'call': case 'put': return `${x.type} on ${x.shares} ${ref} shares @ $${x.strike} (expires round ${x.expiry})`;
        case 'cds': return `CDS on ${ref}, $${x.notional} notional`;
        case 'insurance': return `rent insurance, $${x.deductible} deductible`;
        case 'swap': return `${x.side === 'payFixed' ? 'pay-fixed' : 'receive-fixed'} swap at ${x.fixed.toFixed(2)}% on $${x.notional}`;
        default: return x.type;
      }
    },

    optionPayoff(x, S) { return Math.round(x.shares * Math.max(0, x.type === 'call' ? S - x.strike : x.strike - S)); },
    // What the bank pays to buy an option back now: fair value (with the time left) minus its spread.
    optionBidValue(x) {
      const m = this.desk.marks[x.ref];
      return optionBid(x.type, this.markPrice(x.ref), x.strike, Math.max(0, x.expiry - this.round), this.econ.policyRate, m ? m.vol : 0.2, x.shares);
    },
    sharesBidValue(x) {
      const e = this.desk.equity[x.ref];
      return shareBidProceeds(this.markPrice(x.ref), x.shares, e.inv, this.outsideShares(x.ref), this.player(x.ref).bankrupt ? 1 : this.hazard(x.ref));
    },

    swapMtm(x) {
      const left = Math.max(0, x.expiry - this.round);
      if (!left) return 0;
      const sign = x.side === 'payFixed' ? 1 : -1;
      return Math.round((sign * x.notional * (this.curveRate(left) - x.fixed) * left) / 100);
    },

    deskClose(p, id) {
      this.requirePlaying(); this.requireAlive(p);
      const x = this.desk.positions.find((y) => y.id === id && y.holder === p.id);
      if (!x) fail('Position not found');
      if (x.type === 'shares') {
        const proceeds = this.sharesBidValue(x);
        this.deskPay(null, p.id, proceeds, `sold ${x.shares} shares of ${this.player(x.ref).name} (mark $${this.markPrice(x.ref).toFixed(2)})`);
        this.desk.equity[x.ref].inv += x.shares;
      } else if (x.type === 'call' || x.type === 'put') {
        const v = this.optionBidValue(x);
        if (v > 0) this.deskPay(null, p.id, v, `${x.type} sold back to the bank`);
        else this.addLog(`🏛 ${p.name} closes a worthless ${x.type}.`, 'bank');
      } else if (x.type === 'swap') {
        const v = this.swapMtm(x) - Math.round(x.notional * 0.01);
        if (v > 0) this.deskPay(null, p.id, v, 'swap closed out'); else this.deskPay(p.id, null, -v, 'swap closed out');
      } else {
        this.addLog(`🏛 ${p.name} cancels ${this.describePos(x)}.`, 'bank');
      }
      this.desk.positions = this.desk.positions.filter((y) => y !== x);
    },

    // ---------------------------------------------------------------- hooks
    // Runs at the start of every round, after markEquity(), so expiring options settle at the fresh mark.
    settleDesk() {
      for (const x of this.desk.positions.slice()) {
        const h = this.player(x.holder);
        if (h.bankrupt) continue;
        const expired = x.expiry !== undefined && this.round >= x.expiry;
        if (x.type === 'cds' && !expired) this.deskPay(h.id, null, x.premium, 'CDS premium');
        else if (x.type === 'insurance' && !expired) {
          x.premium = this.insuranceQuote(h.id, x.deductible); // re-underwritten every round from where you stand
          this.deskPay(h.id, null, x.premium, 'insurance premium');
        } else if (x.type === 'swap') {
          const net = Math.round((x.notional * (this.econ.policyRate - x.fixed) * (x.side === 'payFixed' ? 1 : -1)) / 100);
          if (net > 0) this.deskPay(null, h.id, net, 'swap settlement'); else if (net < 0) this.deskPay(h.id, null, -net, 'swap settlement');
        } else if ((x.type === 'call' || x.type === 'put') && expired) {
          const pay = this.optionPayoff(x, this.markPrice(x.ref));
          if (pay > 0) this.deskPay(null, h.id, pay, `${x.type} auto-exercised at expiry`);
        }
        if (expired) this.desk.positions = this.desk.positions.filter((y) => y !== x);
      }
    },

    onRentPaid(payerId, rent) {
      const x = this.desk.positions.find((y) => y.holder === payerId && y.type === 'insurance');
      if (!x) return;
      const payout = Math.min(x.cap, Math.round(x.coverage * Math.max(0, rent - x.deductible)));
      if (payout > 0) this.deskPay(null, payerId, payout, 'rent insurance claim');
    },

    deskOnBankrupt(p) {
      for (const x of this.desk.positions.slice()) {
        if (x.ref !== p.id || this.player(x.holder).bankrupt) continue;
        if (x.type === 'cds') this.deskPay(null, x.holder, x.notional, `CDS payout: ${p.name} defaulted`);
        if (x.type === 'put') this.deskPay(null, x.holder, this.optionPayoff(x, 0), `put pays out: ${p.name} defaulted`);
        this.desk.positions = this.desk.positions.filter((y) => y !== x);
      }
      this.desk.positions = this.desk.positions.filter((y) => y.holder !== p.id);
      if (this.desk.marks[p.id]) this.desk.marks[p.id].price = 0;
    },

    // Desk positions valued at what the bank would pay to take them back right now.
    deskValue(p) {
      let v = 0;
      for (const x of this.desk.positions) {
        if (x.holder !== p.id) continue;
        if (x.type === 'shares') v += this.sharesBidValue(x);
        else if (x.type === 'call' || x.type === 'put') v += this.optionBidValue(x);
        else if (x.type === 'swap') v += this.swapMtm(x);
      }
      return v;
    },

    deskView() {
      const hazards = {}; const insurance = {}; const equity = {};
      for (const p of this.players) {
        hazards[p.id] = p.bankrupt ? 1 : this.hazard(p.id);
        if (!p.bankrupt) insurance[p.id] = Object.fromEntries(DESK.deductibles.map((d) => [d, this.insuranceQuote(p.id, d)]));
        const e = this.desk.equity[p.id];
        equity[p.id] = {
          ...e, outstanding: this.outstanding(p.id), outside: this.outsideShares(p.id),
          optionExposure: this.optionExposure(p.id), cdsExposure: this.cdsExposure(p.id), cdsCap: p.bankrupt ? 0 : this.cdsCap(p.id),
        };
      }
      const inventoryValue = Math.round(this.deskInventoryValue());
      return {
        positions: this.desk.positions, marks: this.desk.marks, pnl: this.desk.pnl, hazards, insurance, equity,
        inventoryValue, totalPnl: Math.round(this.desk.pnl + inventoryValue - this.desk.startInventoryValue),
        swapRates: Object.fromEntries(DESK.terms.map((t) => [t, { payFixed: this.swapRate(t, 'payFixed'), receiveFixed: this.swapRate(t, 'receiveFixed') }])),
      };
    },
  });
};
