'use strict';
// The central bank's trading desk: players trade instruments with the bank as counterparty.
// Installed onto Game.prototype; touches the core rules only through a few hooks
// (round start, rent paid, bankruptcy, net worth).
const { DESK, optionPremium, cdsPremium, shareAsk, shareBid } = require('./pricing');

const PRODUCTS = ['shares', 'call', 'put', 'cds', 'insurance', 'swap'];

module.exports = function installDesk(Game, { fail, toInt, toNum, clamp, round2 }) {
  Object.assign(Game.prototype, {
    initDesk() {
      this.desk = { positions: [], marks: {}, pnl: 0 };
      this.markEquity();
    },

    // ---------------------------------------------------------------- marks & risk
    livePrice(pid) {
      const p = this.player(pid);
      return p.bankrupt ? 0 : Math.max(0, this.bookEquity(p)) / DESK.sharesOutstanding;
    },
    markEquity() {
      for (const p of this.players) {
        const m = (this.desk.marks[p.id] ||= { price: 0, history: [], vol: 0.2 });
        m.price = round2(this.livePrice(p.id));
        m.history.push(m.price);
        if (m.history.length > 12) m.history.shift();
        m.vol = this.equityVol(p.id);
      }
    },
    equityVol(pid) {
      const h = this.desk.marks[pid].history;
      const rets = [];
      for (let k = 1; k < h.length; k++) if (h[k - 1] > 0 && h[k] > 0) rets.push(Math.log(h[k] / h[k - 1]));
      let sd = 0;
      if (rets.length >= 2) {
        const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
        sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
      }
      return round2(clamp(sd, 0.12, 0.8));
    },
    maxOpponentRent(pid) {
      let mx = 0;
      for (const i of Object.keys(this.props)) {
        const pr = this.props[i];
        if (pr.owner && pr.owner !== pid) mx = Math.max(mx, this.rentFor(Number(i), 7));
      }
      return mx;
    },
    // Per-round default probability used to price credit protection.
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
    insuranceQuote(pid, deductible) {
      let e = 0;
      for (const k of Object.keys(this.props)) {
        const i = Number(k); const pr = this.props[i];
        if (!pr.owner || pr.owner === pid || pr.mortgaged) continue;
        const rent = this.rentFor(i, 7);
        e += DESK.landingProb * Math.min(DESK.insuranceCap, DESK.insuranceCoverage * Math.max(0, rent - deductible));
      }
      return Math.max(DESK.minPremium, Math.round(e * DESK.insuranceLoad));
    },
    swapRate(term, side) {
      const mid = this.curveRate(term);
      return round2(side === 'payFixed' ? mid + DESK.swapSpread : mid - DESK.swapSpread);
    },
    deskLimit(p) { return Math.max(this.scale(500), 2 * Math.max(0, this.bookEquity(p))); },

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
      if (mine.length >= DESK.maxPositions) fail(`At most ${DESK.maxPositions} open desk positions`);
      const term = () => { const t = toInt(o.term, 'term'); if (!DESK.terms.includes(t)) fail('Term must be 5, 10 or 20 rounds'); return t; };
      const refPlayer = () => {
        const r = this.player(o.ref);
        if (r.id === p.id) fail('You cannot trade instruments on yourself');
        if (r.bankrupt) fail(`${r.name} is bankrupt`);
        return r;
      };
      const pos = { id: this.id('D'), holder: p.id, type: product, opened: this.round };

      if (product === 'shares') {
        const r = refPlayer(); const n = toInt(o.shares, 'shares');
        const held = mine.filter((x) => x.type === 'shares' && x.ref === r.id).reduce((a, x) => a + x.shares, 0);
        if (n < 1 || held + n > DESK.maxSharesPerName) fail(`You can hold at most ${DESK.maxSharesPerName} shares of one player`);
        const price = this.desk.marks[r.id].price;
        if (price <= 0) fail(`${r.name}'s shares have no value`);
        const cost = shareAsk(price, n);
        if (p.cash < cost) fail(`Need $${cost}`);
        this.deskPay(p.id, null, cost, `bought ${n} shares of ${r.name} @ $${price.toFixed(2)}`);
        const ex = mine.find((x) => x.type === 'shares' && x.ref === r.id);
        if (ex) { ex.cost += cost; ex.shares += n; return; }
        Object.assign(pos, { ref: r.id, shares: n, cost });
      } else if (product === 'call' || product === 'put') {
        const r = refPlayer(); const n = toInt(o.shares, 'shares'); const t = term();
        if (n < 1 || n > DESK.maxSharesPerName) fail(`1 to ${DESK.maxSharesPerName} shares per option`);
        const K = round2(Math.max(0, toNum(o.strike, 'strike')));
        const m = this.desk.marks[r.id];
        const premium = optionPremium(product, m.price, K, t, this.econ.policyRate, m.vol, n);
        if (p.cash < premium) fail(`Need $${premium} premium`);
        this.deskPay(p.id, null, premium, `${product} on ${n} ${r.name} shares, strike $${K}`);
        Object.assign(pos, { ref: r.id, shares: n, strike: K, expiry: this.round + t, premium });
      } else if (product === 'cds') {
        const r = refPlayer(); const t = term(); const notional = toInt(o.notional, 'notional');
        if (notional < 50 || notional > this.deskLimit(p)) fail(`Notional must be $50 to $${this.deskLimit(p)}`);
        const premium = cdsPremium(notional, this.hazard(r.id));
        if (p.cash < premium) fail(`Need $${premium} for the first premium`);
        this.deskPay(p.id, null, premium, `CDS premium on ${r.name}`);
        Object.assign(pos, { ref: r.id, notional, premium, expiry: this.round + t });
      } else if (product === 'insurance') {
        if (mine.some((x) => x.type === 'insurance')) fail('You already have a rent insurance policy');
        const d = toInt(o.deductible, 'deductible'); const t = term();
        if (!DESK.deductibles.includes(d)) fail('Deductible must be 100, 250 or 500');
        const premium = this.insuranceQuote(p.id, d);
        if (p.cash < premium) fail(`Need $${premium} for the first premium`);
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

    swapMtm(x) {
      const left = Math.max(0, x.expiry - this.round);
      if (!left) return 0;
      const t = DESK.terms.reduce((a, b) => (Math.abs(b - left) < Math.abs(a - left) ? b : a));
      const sign = x.side === 'payFixed' ? 1 : -1;
      return Math.round((sign * x.notional * (this.curveRate(t) - x.fixed) * left) / 100);
    },

    deskClose(p, id) {
      this.requirePlaying(); this.requireAlive(p);
      const x = this.desk.positions.find((y) => y.id === id && y.holder === p.id);
      if (!x) fail('Position not found');
      if (x.type === 'shares') {
        const price = this.desk.marks[x.ref].price;
        this.deskPay(null, p.id, shareBid(price, x.shares), `sold ${x.shares} shares of ${this.player(x.ref).name} @ $${price.toFixed(2)}`);
      } else if (x.type === 'call' || x.type === 'put') {
        const pay = this.optionPayoff(x, this.desk.marks[x.ref].price);
        if (pay > 0) this.deskPay(null, p.id, pay, `${x.type} exercised`);
        else this.addLog(`🏛 ${p.name} abandons an out-of-the-money ${x.type}.`, 'bank');
      } else if (x.type === 'swap') {
        const v = this.swapMtm(x) - Math.round(x.notional * 0.01);
        if (v > 0) this.deskPay(null, p.id, v, 'swap closed out'); else this.deskPay(p.id, null, -v, 'swap closed out');
      } else {
        this.addLog(`🏛 ${p.name} cancels ${this.describePos(x)}.`, 'bank');
      }
      this.desk.positions = this.desk.positions.filter((y) => y !== x);
    },

    // ---------------------------------------------------------------- hooks
    settleDesk() {
      for (const x of this.desk.positions.slice()) {
        const h = this.player(x.holder);
        if (h.bankrupt) continue;
        const expired = x.expiry !== undefined && this.round >= x.expiry;
        if (x.type === 'cds' || x.type === 'insurance') {
          if (!expired) this.deskPay(h.id, null, x.premium, `${x.type === 'cds' ? 'CDS' : 'insurance'} premium`);
        } else if (x.type === 'swap') {
          const net = Math.round((x.notional * (this.econ.policyRate - x.fixed) * (x.side === 'payFixed' ? 1 : -1)) / 100);
          if (net > 0) this.deskPay(null, h.id, net, 'swap settlement'); else if (net < 0) this.deskPay(h.id, null, -net, 'swap settlement');
        } else if ((x.type === 'call' || x.type === 'put') && expired) {
          const pay = this.optionPayoff(x, this.livePrice(x.ref));
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

    deskValue(p) {
      let v = 0;
      for (const x of this.desk.positions) {
        if (x.holder !== p.id) continue;
        if (x.type === 'shares') v += shareBid(this.livePrice(x.ref), x.shares);
        else if (x.type === 'call' || x.type === 'put') v += this.optionPayoff(x, this.livePrice(x.ref));
        else if (x.type === 'swap') v += this.swapMtm(x);
      }
      return v;
    },

    deskView() {
      const hazards = {}; const insurance = {};
      for (const p of this.players) {
        hazards[p.id] = p.bankrupt ? 1 : this.hazard(p.id);
        if (!p.bankrupt) insurance[p.id] = Object.fromEntries(DESK.deductibles.map((d) => [d, this.insuranceQuote(p.id, d)]));
      }
      return {
        positions: this.desk.positions, marks: this.desk.marks, pnl: this.desk.pnl, hazards, insurance,
        swapRates: Object.fromEntries(DESK.terms.map((t) => [t, { payFixed: this.swapRate(t, 'payFixed'), receiveFixed: this.swapRate(t, 'receiveFixed') }])),
      };
    },
  });
};
