'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine');

function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function newGame(n = 3, seed = 1) {
  let t = 0;
  const g = new Game('V', { rng: seeded(seed), now: () => (t += 1000) });
  const ps = Array.from({ length: n }, (_, i) => g.addPlayer(`P${i}`));
  g.start(ps[0].id);
  for (const p of ps) p.cash = 5000;
  return g;
}
// B owns two built-up properties so their shares have a value and their rent has a size.
function rentier(g, b) {
  for (const i of [37, 39]) { g.props[i].owner = b.id; g.props[i].houses = 3; }
  g.markEquity();
}
// Collect rent the way resolveLanding does.
function collect(g, payer, owner, rent) {
  g.pay(payer.id, owner.id, rent, 'rent on test');
  g.onRentReceived(owner.id, 39, rent);
}

test('open-market shares pay rent x shares / outstanding, like a negotiated stake', () => {
  const g = newGame(3, 1);
  const [a, b, c] = g.players;
  rentier(g, b);
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 20 });
  const a0 = a.cash; const b0 = b.cash;
  collect(g, c, b, 1000);
  assert.strictEqual(g.outstanding(b.id), 125);
  assert.strictEqual(a.cash - a0, 160, '20/125 of $1000');
  assert.strictEqual(b.cash - b0, 840);
  assert.strictEqual(g.desk.positions.find((x) => x.holder === a.id).divs, 160);
});

test('shares still in the bank inventory pay nothing: no change until someone buys', () => {
  const g = newGame(3, 2);
  const [, b, c] = g.players;
  rentier(g, b);
  const b0 = b.cash;
  collect(g, c, b, 1000);
  assert.strictEqual(b.cash - b0, 1000);
});

test('short sellers owe the dividend to the bank', () => {
  const g = newGame(3, 3);
  const [a, b, c] = g.players;
  rentier(g, b);
  g.deskBuy(a, { product: 'short', ref: b.id, shares: 10 });
  const a0 = a.cash; const pnl0 = g.desk.pnl;
  collect(g, c, b, 1000);
  assert.strictEqual(a0 - a.cash, 80);
  assert.strictEqual(g.desk.pnl - pnl0, 80);
});

test('dividends follow shares sold on the player market', () => {
  const g = newGame(3, 4);
  const [a, b, c] = g.players;
  rentier(g, b);
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 10 });
  g.listPosition(a, { position: g.desk.positions[0].id, shares: 10, price: 50 });
  g.buyListing(c, g.listings[0].id);
  const a0 = a.cash; const c0 = c.cash;
  collect(g, a, b, 500); // a pays the rent; c holds the shares now
  assert.strictEqual(c.cash - c0, 40, '10/125 of $500');
  assert.strictEqual(a0 - a.cash, 500);
});

test('contract payouts come first and dividends never exceed the rent', () => {
  const g = newGame(3, 5);
  const [a, b, c] = g.players;
  rentier(g, b);
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 25 });
  // B has already promised 90% of every rent to C through a contract.
  g.contracts.push({ id: 'K1', name: 'big stake', status: 'active', parties: [b.id, c.id], clauses: [{ kind: 'equity', from: b.id, to: c.id, pct: 90 }] });
  const b0 = b.cash; const a0 = a.cash;
  collect(g, c, b, 1000);
  assert.strictEqual(a.cash - a0, 100, 'scaled down to the $100 left after the contract');
  assert.strictEqual(b.cash - b0, 0);
});

test('price: a share is worth more when its owner collects more rent', () => {
  const g = newGame(3, 6);
  const [, b, c] = g.players;
  rentier(g, b);
  for (const i of [37, 39]) g.props[i].houses = 1;
  g.markEquity();
  const low = g.livePrice(b.id);
  const divLow = g.expectedDividend(b.id);
  for (const i of [37, 39]) g.props[i].houses = 5;
  const high = g.livePrice(b.id);
  assert.ok(g.expectedDividend(b.id) > divLow * 2);
  assert.ok(high > low);
  // The dividend part of the value is the present value of ~12 rounds of expected dividends.
  const f = g.rentFlow(b.id);
  assert.ok(g.dividendValue(f.gross, g.hazard(b.id)) > 7 * f.gross);
  void c;
});
