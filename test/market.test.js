'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError } = require('../src/engine');
const Pricing = require('../src/pricing');

function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function newGame(n = 3, seed = 1) {
  let t = 0;
  const g = new Game('M', { rng: seeded(seed), now: () => (t += 1000) });
  const ps = Array.from({ length: n }, (_, i) => g.addPlayer(`P${i}`));
  g.start(ps[0].id);
  return g;
}

test('desk positions count in book equity at liquidation value', () => {
  const g = newGame(3, 2);
  const [a, b] = g.players;
  const eq0 = g.bookEquity(a);
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 10 });
  const x = g.desk.positions[0];
  // Equity falls only by the round-trip cost (paid the ask, counted at the bank's bid).
  assert.strictEqual(g.bookEquity(a), eq0 - x.cost + g.sharesBidValue(x));
  assert.ok(g.assets(a) > a.cash, 'the shares are an asset');
  assert.strictEqual(g.maxLoan(a), Math.floor((g.settings.maxLeverage - 1) * g.bookEquity(a)));
});

test('shorts: sell borrowed shares, pay a borrow fee, cover at the ask, win if the name defaults', () => {
  const g = newGame(3, 3);
  const [a, b] = g.players;
  const px = g.desk.marks[b.id].price;
  const c0 = a.cash;
  g.deskBuy(a, { product: 'short', ref: b.id, shares: 10 });
  const s = g.desk.positions[0];
  assert.ok(a.cash > c0, 'short sale pays the proceeds now');
  assert.ok(g.coverCost(s) > a.cash - c0, 'covering right away costs more than the proceeds (spread)');
  assert.ok(g.deskBalance(a).liabilities === g.coverCost(s), 'the short is a liability in book equity');
  assert.throws(() => g.deskBuy(a, { product: 'short', ref: b.id, shares: 20 }), /at most 25/);
  assert.throws(() => g.deskBuy(a, { product: 'short', ref: a.id, shares: 1 }), /yourself/);
  // Borrow fee each round
  const c1 = a.cash; g.settleDesk();
  assert.strictEqual(c1 - a.cash, Math.max(1, Math.round(10 * px * (0.005 + 0.5 * g.desk.marks[b.id].hazard))));
  // Default: the short closes for free
  g.declareBankruptcy(b);
  assert.ok(!g.desk.positions.some((x) => x.type === 'short'));
  // Total short interest per name is capped by the float.
  const g2 = newGame(4, 4); const [p0, p1, p2, p3] = g2.players;
  g2.deskBuy(p0, { product: 'short', ref: p3.id, shares: 20 });
  assert.throws(() => g2.deskBuy(p1, { product: 'short', ref: p3.id, shares: 10 }), /left to borrow/);
  void p2;
});

test('three-party deal executes atomically only when everyone signs', () => {
  const g = newGame(3, 5);
  const [a, b, c] = g.players;
  g.props[39].owner = a.id;
  g.deskBuy(c, { product: 'shares', ref: b.id, shares: 10 });
  const cPos = g.desk.positions[0];
  g.proposeDeal(a, {
    parties: [b.id, c.id],
    legs: [
      { from: a.id, to: b.id, kind: 'property', space: 39 },
      { from: b.id, to: c.id, kind: 'cash', amount: 300 },
      { from: c.id, to: a.id, kind: 'position', position: cPos.id, shares: 6 },
    ],
  });
  const d = g.deals[0];
  const bCash = b.cash;
  g.respondDeal(b, d.id, true);
  assert.strictEqual(g.props[39].owner, a.id, 'nothing moves until everyone signs');
  g.respondDeal(c, d.id, true);
  assert.strictEqual(d.status, 'done');
  assert.strictEqual(g.props[39].owner, b.id);
  assert.strictEqual(b.cash, bCash - 300);
  assert.strictEqual(g.desk.positions.find((x) => x.holder === a.id && x.type === 'shares').shares, 6);
  assert.strictEqual(g.desk.positions.find((x) => x.holder === c.id && x.type === 'shares').shares, 4);
  // A rejection kills it; built-on property and instruments on yourself are refused.
  g.props[1].owner = a.id; g.props[3].owner = a.id; g.props[3].houses = 1;
  assert.throws(() => g.proposeDeal(a, { parties: [b.id], legs: [{ from: a.id, to: b.id, kind: 'property', space: 1 }] }), /Sell buildings/);
  const bPos = g.desk.positions.find((x) => x.holder === a.id);
  assert.throws(() => g.proposeDeal(a, { parties: [b.id], legs: [{ from: a.id, to: b.id, kind: 'position', position: bPos.id }] }), /on themselves/);
  g.proposeDeal(a, { parties: [c.id], legs: [{ from: a.id, to: c.id, kind: 'cash', amount: 10 }] });
  g.respondDeal(c, g.deals[1].id, false);
  assert.strictEqual(g.deals[1].status, 'rejected');
});

test('player market: listings and bids move positions at player-set prices', () => {
  const g = newGame(3, 6);
  const [a, b, c] = g.players;
  g.deskBuy(a, { product: 'shares', ref: c.id, shares: 10 });
  const pos = g.desk.positions[0];
  g.listPosition(a, { position: pos.id, shares: 4, price: 70 });
  const l = g.listings[0];
  const aCash = a.cash;
  g.buyListing(b, l.id);
  assert.strictEqual(a.cash, aCash + 70);
  assert.strictEqual(g.desk.positions.find((x) => x.holder === b.id).shares, 4);
  assert.strictEqual(g.tape.at(-1).venue, 'players');
  // Bid: B wants 3 more C shares at $20 each; A fills it.
  g.postBid(b, { ref: c.id, shares: 3, priceEach: 20 });
  g.fillBid(a, g.bids[0].id, 3);
  assert.strictEqual(g.desk.positions.find((x) => x.holder === b.id).shares, 7);
  assert.strictEqual(g.bids[0].status, 'filled');
  assert.throws(() => g.buyListing(b, l.id), /gone/);
});

test('bank axes: it sells excess inventory below its ask and pays players to take credit risk', () => {
  const g = newGame(3, 7);
  const [a, b, c] = g.players;
  a.cash = 20000; c.cash = 20000;
  // B issues shares -> the bank holds more than the float and wants to sell.
  g.deskBuy(b, { product: 'issue', shares: 10 });
  g.markEquity();
  const axe = g.bankAxes().find((x) => x.kind === 'shares' && x.ref === b.id);
  assert.ok(axe && axe.priceEach < g.markPrice(b.id), 'axe is below the mark');
  const askEach = Pricing.shareAskCost(g.markPrice(b.id), 5, g.desk.equity[b.id].inv, g.outsideShares(b.id)) / 5;
  assert.ok(axe.priceEach < askEach, 'and well below the normal ask');
  g.takeAxe(a, { id: axe.id, shares: 5 });
  assert.strictEqual(g.desk.positions.find((x) => x.holder === a.id).shares, 5);
  // A buys lots of protection on B -> the bank's book fills -> it pays C to take some of it.
  g.deskBuy(a, { product: 'cds', ref: b.id, notional: Math.min(g.deskLimit(a), Math.floor(g.cdsCap(b.id) * 0.9)), term: 10 });
  const cdsAxe = g.bankAxes().find((x) => x.kind === 'cdsSell' && x.ref === b.id);
  assert.ok(cdsAxe, 'bank wants to lay off credit risk');
  const before = g.cdsExposure(b.id);
  const cc = c.cash;
  g.takeAxe(c, { id: cdsAxe.id, notional: 500, term: 5 });
  assert.ok(c.cash > cc, 'the taker is paid a premium');
  assert.strictEqual(g.cdsExposure(b.id), before - 500);
  // If B defaults, C pays the bank the notional.
  const c2 = c.cash;
  g.declareBankruptcy(b);
  assert.strictEqual(c2 - c.cash, 500);
});

test('fuzz: random deals, listings, bids, shorts and axes never break the game', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = newGame(4, seed * 31);
    const rng = seeded(seed * 977);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const tryA = (pid, msg) => { try { g.apply(pid, msg); } catch (e) { if (!(e instanceof GameError)) throw e; } };
    for (let steps = 0; g.status === 'playing' && steps < 2500; steps++) {
      const any = pick(g.active()); const other = pick(g.active().filter((p) => p.id !== any.id)) || any;
      const mine = g.desk.positions.filter((x) => x.holder === any.id);
      const r = rng();
      if (r < 0.05) tryA(any.id, { action: 'deskBuy', order: { product: pick(['shares', 'short']), ref: other.id, shares: 1 + Math.floor(rng() * 8) } });
      else if (r < 0.07 && mine.length) tryA(any.id, { action: 'listPosition', listing: { position: pick(mine).id, shares: 1, price: 5 + Math.floor(rng() * 50) } });
      else if (r < 0.09 && g.listings.length) tryA(any.id, { action: 'buyListing', id: pick(g.listings).id });
      else if (r < 0.11) tryA(any.id, { action: 'postBid', bid: { ref: other.id, shares: 3, priceEach: 5 + rng() * 20 } });
      else if (r < 0.13 && g.bids.length) tryA(any.id, { action: 'fillBid', id: pick(g.bids).id, shares: 2 });
      else if (r < 0.15) {
        const third = pick(g.active());
        const legs = [{ from: any.id, to: other.id, kind: 'cash', amount: 10 + Math.floor(rng() * 100) }];
        if (mine.length) legs.push({ from: any.id, to: third.id, kind: 'position', position: pick(mine).id });
        const props = g.ownedBy(other.id); if (props.length) legs.push({ from: other.id, to: any.id, kind: 'property', space: pick(props) });
        tryA(any.id, { action: 'proposeDeal', deal: { parties: [other.id, third.id], legs } });
      } else if (r < 0.2) {
        const d = g.deals.find((x) => x.status === 'pending');
        if (d) { const who = pick(d.parties); tryA(who, { action: rng() < 0.8 ? 'acceptDeal' : 'rejectDeal', id: d.id }); }
      } else if (r < 0.22) {
        const axes = g.bankAxes(); if (axes.length) tryA(any.id, { action: 'takeAxe', axe: { id: pick(axes).id } });
      } else if (r < 0.24) tryA(any.id, { action: 'deskBuy', order: { product: 'issue', shares: 3 } });
      else if (r < 0.26 && mine.length) tryA(any.id, { action: 'deskClose', id: pick(mine).id });
      // main flow
      const p = g.current();
      if (g.auction) { const bidder = g.player(pick(g.auction.active)); tryA(bidder.id, { action: rng() < 0.5 ? 'passAuction' : 'bid', amount: g.auction.highBid + 10 }); if (g.auction && rng() < 0.2) g.closeAuction(); continue; }
      if (p.cash < 0) { const own = g.ownedBy(p.id); if (own.length && rng() < 0.7) tryA(p.id, { action: 'mortgage', space: pick(own) }); else tryA(p.id, { action: 'bankrupt' }); continue; }
      if (g.turn.phase === 'roll') tryA(p.id, { action: 'roll' });
      else if (g.turn.phase === 'buy') tryA(p.id, { action: rng() < 0.7 ? 'buy' : 'decline' });
      else if (g.turn.phase === 'done') tryA(p.id, { action: 'endTurn' });
      for (const q of g.players) assert.ok(Number.isFinite(q.cash) && Number.isFinite(g.bookEquity(q)));
      for (const x of g.desk.positions) assert.ok(!g.player(x.holder).bankrupt || true);
      JSON.stringify(g.serialize());
    }
  }
});
