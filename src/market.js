'use strict';
// Player-to-player market, alongside the bank desk's baseline quotes:
// - multi-party deals: any number of players, legs of cash / property / get-out cards / desk positions,
//   executed atomically once every party accepts;
// - listings: offer a desk position (or part of a share position) to anyone at an asking price;
// - bids: offer to buy shares of a player from whoever holds them;
// - a trade tape and stock tickers for the market terminal.
// Installed onto Game.prototype; the classic two-player trade rules are untouched.
const { SPACES, GROUPS } = require('./board');
const { DESK } = require('./pricing');

const TRANSFERABLE = ['shares', 'call', 'put', 'swap'];

module.exports = function installMarket(Game, { fail, toInt, toNum, round2 }) {
  Object.assign(Game.prototype, {
    initMarket() {
      this.deals = []; this.listings = []; this.bids = []; this.tape = [];
      const used = new Set(); this.tickers = {};
      for (const p of this.players) {
        const base = p.name.replace(/\(AI\)/i, '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'PLYR';
        let t = base; let k = 2;
        while (used.has(t)) t = `${base.slice(0, 3)}${k++}`;
        used.add(t); this.tickers[p.id] = t;
      }
    },
    ticker(pid) { return (this.tickers && this.tickers[pid]) || '???'; },
    print(sym, side, qty, px, who, venue) {
      this.tape.push({ round: this.round, t: this.now(), sym, side, qty, px: round2(px), who, venue });
      if (this.tape.length > 200) this.tape.shift();
    },

    // Move a desk position (or n of its shares) to another player, keeping cost basis sensible.
    movePosition(id, toId, shares, paid) {
      const x = this.desk.positions.find((y) => y.id === id);
      if (x.type !== 'shares') {
        x.holder = toId;
        if (paid !== undefined) x.premium = paid;
      } else {
        const n = shares ?? x.shares;
        const basis = Math.round((x.cost * n) / x.shares);
        x.shares -= n; x.cost -= basis;
        if (x.shares <= 0) this.desk.positions = this.desk.positions.filter((y) => y !== x);
        const cost = paid ?? basis;
        const ex = this.desk.positions.find((y) => y.holder === toId && y.type === 'shares' && y.ref === x.ref);
        if (ex) { ex.shares += n; ex.cost += cost; } else this.desk.positions.push({ id: this.id('D'), holder: toId, type: 'shares', ref: x.ref, shares: n, cost, opened: this.round });
      }
      for (const l of this.listings) if (l.status === 'open' && l.position === id) l.status = 'stale';
    },
    checkReceive(toId, x, n) {
      if (x.ref === toId) fail(`${this.player(toId).name} cannot hold instruments on themselves`);
      if (x.type === 'shares') {
        const held = this.desk.positions.filter((y) => y.holder === toId && y.type === 'shares' && y.ref === x.ref).reduce((a, y) => a + y.shares, 0);
        if (held + n > DESK.maxSharesPerName) fail(`${this.player(toId).name} can hold at most ${DESK.maxSharesPerName} shares of one player`);
      }
    },

    // ---------------------------------------------------------------- multi-party deals
    normalizeLeg(raw, parties) {
      const from = String(raw.from); const to = String(raw.to);
      if (!parties.includes(from) || !parties.includes(to)) fail('Every leg must be between parties to the deal');
      if (from === to) fail('A leg cannot go from a player to themselves');
      const kind = String(raw.kind);
      const leg = { from, to, kind };
      if (kind === 'cash') { leg.amount = toInt(raw.amount, 'amount'); if (leg.amount <= 0) fail('Cash legs must be positive'); } else if (kind === 'property') {
        leg.space = toInt(raw.space, 'property');
        if (!this.props[leg.space]) fail('Not a property');
      } else if (kind === 'card') leg.count = Math.max(1, Math.min(2, toInt(raw.count || 1, 'cards')));
      else if (kind === 'position') {
        leg.position = String(raw.position);
        if (raw.shares !== undefined && raw.shares !== null && raw.shares !== '') leg.shares = toInt(raw.shares, 'shares');
      } else fail(`Unknown leg type ${kind}`);
      return leg;
    },
    checkDeal(d) {
      const cashOut = {}; const cards = {}; const spaces = new Set(); const used = {};
      for (const id of d.parties) if (this.player(id).bankrupt) fail(`${this.player(id).name} is bankrupt`);
      for (const l of d.legs) {
        const from = this.player(l.from);
        if (l.kind === 'cash') cashOut[l.from] = (cashOut[l.from] || 0) + l.amount;
        if (l.kind === 'card') cards[l.from] = (cards[l.from] || 0) + l.count;
        if (l.kind === 'property') {
          const i = l.space;
          if (spaces.has(i)) fail(`${SPACES[i].name} appears in two legs`);
          spaces.add(i);
          if (this.props[i].owner !== l.from) fail(`${from.name} does not own ${SPACES[i].name}`);
          if (SPACES[i].group && this.groupHasBuildings(SPACES[i].group)) fail(`Sell buildings in ${GROUPS[SPACES[i].group].name} before trading ${SPACES[i].name}`);
          if (this.encumbrances(i).length) fail(`${SPACES[i].name} is pledged under a contract`);
        }
        if (l.kind === 'position') {
          const x = this.desk.positions.find((y) => y.id === l.position);
          if (!x || x.holder !== l.from) fail(`${from.name} does not hold that position`);
          if (!TRANSFERABLE.includes(x.type)) fail(`A ${x.type} position cannot change hands`);
          const n = x.type === 'shares' ? (l.shares ?? x.shares) : 1;
          if (x.type === 'shares' && (n < 1 || n > x.shares)) fail(`${from.name} holds ${x.shares} of those shares`);
          used[x.id] = (used[x.id] || 0) + n;
          if (used[x.id] > (x.type === 'shares' ? x.shares : 1)) fail('The same position is used twice');
          this.checkReceive(l.to, x, n);
        }
      }
      for (const [id, amt] of Object.entries(cashOut)) if (amt > this.player(id).cash) fail(`${this.player(id).name} does not have $${amt}`);
      for (const [id, n] of Object.entries(cards)) if (n > this.player(id).jailCards.length) fail(`${this.player(id).name} lacks that many get-out cards`);
    },
    proposeDeal(p, raw = {}) {
      this.requirePlaying(); this.requireAlive(p);
      const parties = [...new Set([p.id, ...(raw.parties || []).map(String)])];
      if (parties.length < 2) fail('A deal needs at least two players');
      for (const id of parties) this.player(id);
      if (!Array.isArray(raw.legs) || !raw.legs.length) fail('Add at least one leg');
      if (raw.legs.length > 30) fail('Too many legs');
      const legs = raw.legs.map((l) => this.normalizeLeg(l, parties));
      for (const id of parties) if (!legs.some((l) => l.from === id || l.to === id)) fail(`${this.player(id).name} has no part in the deal`);
      const d = { id: this.id('X'), proposer: p.id, parties, legs, note: this.cleanText(raw.note, 80, 'Deal note'), accepted: { [p.id]: true }, status: 'pending', round: this.round };
      this.checkDeal(d);
      this.deals.push(d);
      this.addLog(`🤝 ${p.name} proposes a ${parties.length}-party deal with ${parties.filter((x) => x !== p.id).map((x) => this.player(x).name).join(', ')}.`);
    },
    respondDeal(p, id, accept) {
      const d = this.deals.find((x) => x.id === id && x.status === 'pending');
      if (!d) fail('Deal not found');
      if (!d.parties.includes(p.id)) fail('You are not part of that deal');
      if (!accept) { d.status = 'rejected'; d.rejectedBy = p.id; this.addLog(`${p.name} rejects a deal.`); return; }
      d.accepted[p.id] = true;
      if (!d.parties.every((x) => d.accepted[x])) { this.addLog(`${p.name} signs a deal (${d.parties.filter((x) => d.accepted[x]).length}/${d.parties.length}).`); return; }
      this.checkDeal(d);
      for (const l of d.legs) {
        const from = this.player(l.from); const to = this.player(l.to);
        if (l.kind === 'cash') this.pay(l.from, l.to, l.amount, 'deal');
        if (l.kind === 'property') { this.props[l.space].owner = l.to; this.addLog(`${SPACES[l.space].name}: ${from.name} → ${to.name}`); }
        if (l.kind === 'card') for (let k = 0; k < l.count; k++) to.jailCards.push(from.jailCards.pop());
        if (l.kind === 'position') {
          const x = this.desk.positions.find((y) => y.id === l.position);
          if (x.type === 'shares') this.print(this.ticker(x.ref), 'deal', l.shares ?? x.shares, 0, l.to, 'deal');
          this.movePosition(l.position, l.to, x.type === 'shares' ? (l.shares ?? x.shares) : undefined);
        }
      }
      d.status = 'done';
      this.addLog(`🤝 ${d.parties.length}-party deal completed between ${d.parties.map((x) => this.player(x).name).join(', ')}.`);
    },
    cancelDeal(p, id) {
      const d = this.deals.find((x) => x.id === id && x.status === 'pending');
      if (!d || d.proposer !== p.id) fail('Deal not found');
      d.status = 'cancelled';
    },

    // ---------------------------------------------------------------- listings (sell a position to anyone)
    listPosition(p, raw = {}) {
      this.requirePlaying(); this.requireAlive(p);
      const x = this.desk.positions.find((y) => y.id === String(raw.position) && y.holder === p.id);
      if (!x) fail('Position not found');
      if (!TRANSFERABLE.includes(x.type)) fail(`A ${x.type} position cannot be sold to another player`);
      if (this.listings.some((l) => l.status === 'open' && l.position === x.id)) fail('That position is already listed');
      const n = x.type === 'shares' ? toInt(raw.shares ?? x.shares, 'shares') : 1;
      if (x.type === 'shares' && (n < 1 || n > x.shares)) fail(`You hold ${x.shares} shares`);
      const price = toInt(raw.price, 'price');
      if (price < 1) fail('Asking price must be at least $1');
      const l = { id: this.id('O'), seller: p.id, position: x.id, type: x.type, ref: x.ref, shares: x.type === 'shares' ? n : x.shares, strike: x.strike, expiry: x.expiry, side: x.side, notional: x.notional, fixed: x.fixed, price, status: 'open', round: this.round };
      this.listings.push(l);
      this.addLog(`📋 ${p.name} offers ${x.type === 'shares' ? `${n} ${this.ticker(x.ref)} shares` : this.describePos(x)} for $${price}.`, 'bank');
    },
    buyListing(p, id) {
      this.requirePlaying(); this.requireAlive(p);
      const l = this.listings.find((y) => y.id === id && y.status === 'open');
      if (!l) fail('That listing is gone');
      if (l.seller === p.id) fail('That is your own listing');
      const x = this.desk.positions.find((y) => y.id === l.position && y.holder === l.seller);
      if (!x || (x.type === 'shares' && x.shares < l.shares)) { l.status = 'stale'; fail('The seller no longer holds that position'); }
      this.checkReceive(p.id, x, l.shares);
      if (p.cash < l.price) fail(`Need $${l.price}`);
      this.pay(p.id, l.seller, l.price, 'player market purchase');
      if (x.type === 'shares' || x.type === 'call' || x.type === 'put') this.print(x.type === 'shares' ? this.ticker(x.ref) : `${this.ticker(x.ref)} ${x.strike}${x.type === 'call' ? 'C' : 'P'}`, 'buy', l.shares, l.price / Math.max(1, l.shares), p.id, 'players');
      this.movePosition(x.id, p.id, x.type === 'shares' ? l.shares : undefined, l.price);
      l.status = 'filled'; l.buyer = p.id;
      this.addLog(`📋 ${p.name} buys ${this.player(l.seller).name}'s listing for $${l.price}.`, 'bank');
    },
    cancelListing(p, id) {
      const l = this.listings.find((y) => y.id === id && y.status === 'open');
      if (!l || l.seller !== p.id) fail('Listing not found');
      l.status = 'cancelled';
    },

    // ---------------------------------------------------------------- bids (buy shares from any holder)
    postBid(p, raw = {}) {
      this.requirePlaying(); this.requireAlive(p);
      const r = this.player(raw.ref);
      if (r.id === p.id) fail('You cannot bid for your own shares');
      if (r.bankrupt) fail(`${r.name} is bankrupt`);
      const n = toInt(raw.shares, 'shares'); const px = round2(toNum(raw.priceEach, 'price'));
      if (n < 1 || n > DESK.maxSharesPerName) fail(`1 to ${DESK.maxSharesPerName} shares`);
      if (px <= 0) fail('Price must be positive');
      if (this.bids.some((b) => b.status === 'open' && b.buyer === p.id && b.ref === r.id)) fail(`You already have a bid out for ${r.name}`);
      if (p.cash < Math.ceil(n * px)) fail(`Need $${Math.ceil(n * px)}`);
      this.bids.push({ id: this.id('B'), buyer: p.id, ref: r.id, shares: n, priceEach: px, status: 'open', round: this.round });
      this.addLog(`📋 ${p.name} bids $${px.toFixed(2)} for up to ${n} ${this.ticker(r.id)} shares.`, 'bank');
    },
    fillBid(p, id, shares) {
      this.requirePlaying(); this.requireAlive(p);
      const b = this.bids.find((y) => y.id === id && y.status === 'open');
      if (!b) fail('That bid is gone');
      if (b.buyer === p.id) fail('That is your own bid');
      const x = this.desk.positions.find((y) => y.holder === p.id && y.type === 'shares' && y.ref === b.ref);
      if (!x) fail(`You hold no ${this.ticker(b.ref)} shares`);
      const n = Math.min(toInt(shares ?? b.shares, 'shares'), b.shares, x.shares);
      if (n < 1) fail('Nothing to sell');
      const buyer = this.player(b.buyer);
      const cost = Math.ceil(n * b.priceEach);
      if (buyer.cash < cost) { b.status = 'stale'; fail(`${buyer.name} can no longer pay`); }
      this.checkReceive(buyer.id, x, n);
      this.pay(buyer.id, p.id, cost, `sold ${n} ${this.ticker(b.ref)} shares into a bid`);
      this.movePosition(x.id, buyer.id, n, cost);
      this.print(this.ticker(b.ref), 'sell', n, b.priceEach, p.id, 'players');
      b.shares -= n;
      if (b.shares <= 0) b.status = 'filled';
    },
    cancelBid(p, id) {
      const b = this.bids.find((y) => y.id === id && y.status === 'open');
      if (!b || b.buyer !== p.id) fail('Bid not found');
      b.status = 'cancelled';
    },

    marketOnBankrupt(p) {
      for (const d of this.deals) if (d.status === 'pending' && d.parties.includes(p.id)) d.status = 'cancelled';
      for (const l of this.listings) if (l.status === 'open' && (l.seller === p.id || l.ref === p.id)) l.status = 'cancelled';
      for (const b of this.bids) if (b.status === 'open' && (b.buyer === p.id || b.ref === p.id)) b.status = 'cancelled';
    },

    marketView() {
      const live = (l) => { const x = this.desk.positions.find((y) => y.id === l.position && y.holder === l.seller); return !!x && (x.type !== 'shares' || x.shares >= l.shares); };
      return {
        tickers: this.tickers,
        deals: this.deals.filter((d) => d.status === 'pending' || d.round >= this.round - 3).slice(-30),
        listings: this.listings.filter((l) => l.status === 'open' && live(l)),
        bids: this.bids.filter((b) => b.status === 'open'),
        tape: this.tape.slice(-80),
      };
    },
  });
};
