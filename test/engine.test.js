'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError } = require('../src/engine');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function newGame(n = 3, seed = 1) {
  let t = 0;
  const g = new Game('TEST', { rng: seeded(seed), now: () => (t += 1000) });
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(g.addPlayer(`P${i}`));
  g.start(ps[0].id);
  return g;
}

test('rent doubles on a full unimproved group and scales with houses', () => {
  const g = newGame();
  const [a, b] = g.players;
  g.props[1].owner = a.id; g.props[3].owner = a.id;
  assert.strictEqual(g.rentFor(1, 7), 4);
  g.props[1].houses = 3;
  assert.strictEqual(g.rentFor(1, 7), 90);
  g.props[3].owner = b.id;
  assert.strictEqual(g.rentFor(3, 7), 4);
});

test('transit and utility rent', () => {
  const g = newGame();
  const [a] = g.players;
  g.props[5].owner = a.id; g.props[15].owner = a.id;
  assert.strictEqual(g.rentFor(5, 7), 50);
  g.props[12].owner = a.id;
  assert.strictEqual(g.rentFor(12, 8), 32);
  g.props[28].owner = a.id;
  assert.strictEqual(g.rentFor(12, 8), 80);
});

test('building must be even and needs the full group', () => {
  const g = newGame();
  const [a] = g.players;
  g.props[1].owner = a.id;
  assert.throws(() => g.build(a, 1), GameError);
  g.props[3].owner = a.id;
  g.build(a, 1);
  assert.throws(() => g.build(a, 1), /evenly/);
  g.build(a, 3); g.build(a, 1);
  assert.strictEqual(g.props[1].houses, 2);
  assert.strictEqual(g.bankHouses, 29);
  assert.throws(() => g.mortgage(a, 3), /buildings/);
});

test('central-bank borrowing is capped by leverage and locks a fixed rate', () => {
  const g = newGame();
  const a = g.players[0];
  assert.strictEqual(g.maxLoan(a), 3000); // (3-1) * 1500 equity
  g.borrow(a, 2000, 10);
  const rate = a.loans[0].rate;
  assert.strictEqual(a.cash, 3500);
  assert.throws(() => g.borrow(a, 1200, 5), /Leverage cap/);
  g.econ.policyRate = 9;
  assert.strictEqual(a.loans[0].rate, rate, 'existing loan rate is fixed');
  assert.ok(g.quote(a, 5) > rate, 'new quotes move with policy rate');
});

test('margin call triggers forced liquidation at end of turn', () => {
  const g = newGame();
  const a = g.players[0];
  g.borrow(a, 3000, 5);
  a.cash -= 1000; // big loss -> equity 500, max loan 1000
  assert.ok(g.inBreach(a));
  g.turn.phase = 'done';
  g.endTurn(a);
  assert.ok(!g.inBreach(a));
  assert.strictEqual(g.bankDebt(a), 1000);
});

test('interest rate swap nets fixed vs floating each round', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  g.proposeContract(a, { to: b.id, name: 'IRS', term: 2, clauses: [
    { kind: 'rate', from: a.id, to: b.id, notional: 1000, rateType: 'fixed', rate: 3 },
    { kind: 'rate', from: b.id, to: a.id, notional: 1000, rateType: 'floating', spread: 0 },
  ] });
  const c = g.contracts[0];
  g.respondContract(b, c.id, true);
  g.econ.policyRate = 5;
  const a0 = a.cash, b0 = b.cash;
  g.round = 2;
  g.settleContracts();
  assert.strictEqual(a.cash - a0, 20); // receives 50 floating, pays 30 fixed
  assert.strictEqual(b.cash - b0, -20);
  g.round = 3; g.settleContracts();
  assert.strictEqual(c.status, 'matured');
});

test('secured loan default seizes collateral', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  g.props[39].owner = a.id;
  g.proposeContract(a, { to: b.id, name: 'Secured', term: 3, clauses: [
    { kind: 'upfront', from: b.id, to: a.id, amount: 500 },
    { kind: 'fixed', from: a.id, to: b.id, amount: 100 },
    { kind: 'collateral', from: a.id, to: b.id, spaces: [39] },
  ] });
  g.respondContract(b, g.contracts[0].id, true);
  assert.throws(() => g.proposeTrade(a, { to: b.id, give: { spaces: [39] }, get: {} }), /pledged/);
  a.cash = 10;
  g.round = 2; g.settleContracts();
  assert.strictEqual(g.contracts[0].status, 'defaulted');
  assert.strictEqual(g.props[39].owner, b.id);
});

test('call option exercise transfers property for the strike', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  g.props[24].owner = b.id;
  g.proposeContract(a, { to: b.id, name: 'Call', term: 5, clauses: [
    { kind: 'upfront', from: a.id, to: b.id, amount: 30 },
    { kind: 'call', holder: a.id, writer: b.id, space: 24, strike: 200 },
  ] });
  g.respondContract(b, g.contracts[0].id, true);
  const a0 = a.cash;
  g.exercise(a, g.contracts[0].id, 1);
  assert.strictEqual(g.props[24].owner, a.id);
  assert.strictEqual(a.cash, a0 - 200);
  assert.strictEqual(g.contracts[0].status, 'exercised');
});

test('credit default swap pays out on reference bankruptcy', () => {
  const g = newGame(3);
  const [a, b, c] = g.players;
  g.proposeContract(a, { to: b.id, name: 'CDS', term: 10, clauses: [
    { kind: 'fixed', from: a.id, to: b.id, amount: 10 },
    { kind: 'default', from: b.id, to: a.id, amount: 400, ref: c.id },
  ] });
  g.respondContract(b, g.contracts[0].id, true);
  const a0 = a.cash;
  g.declareBankruptcy(c);
  assert.strictEqual(a.cash - a0, 400);
  assert.strictEqual(g.contracts[0].status, 'triggered');
});

test('equity stake pays dividends on rent and shifts net worth', () => {
  const g = newGame(3);
  const [a, b, c] = g.players;
  g.props[39].owner = a.id;
  g.proposeContract(a, { to: b.id, name: 'Equity', term: 0, clauses: [
    { kind: 'upfront', from: b.id, to: a.id, amount: 300 },
    { kind: 'equity', from: a.id, to: b.id, pct: 25 },
  ] });
  g.respondContract(b, g.contracts[0].id, true);
  const b0 = b.cash;
  c.pos = 39; g.resolveLanding(c);
  assert.strictEqual(b.cash - b0, Math.round(g.rentFor(39, 7) * 0.25));
  assert.ok(g.netWorth(b) > g.bookEquity(b));
});

test('economy: hot economy raises inflation and the policy rate', () => {
  const g = newGame(2);
  const r0 = g.econ.policyRate;
  const a = g.players[0];
  // A debt-fuelled spending boom.
  for (let k = 0; k < 6; k++) { g.borrow(a, 400, 20); g.econ.roundSpending = 5000; g.closeRoundEconomy(); }
  assert.ok(g.econ.heat > 75, `heat ${g.econ.heat}`);
  assert.ok(g.econ.policyRate > r0);
  assert.ok(g.econ.priceLevel > 1);
  assert.strictEqual(g.econ.fiscal, 'surtax');
  // Deleveraging + no spending -> recession.
  a.loans = [];
  for (let k = 0; k < 10; k++) { g.econ.roundSpending = 0; g.closeRoundEconomy(); }
  assert.ok(g.econ.heat < 30);
  assert.strictEqual(g.econ.fiscal, 'stimulus');
});

test('a player with negative cash can sell property in a trade but cannot pay cash', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  g.props[39].owner = a.id;
  a.cash = -200;
  g.proposeTrade(a, { to: b.id, give: { spaces: [39] }, get: { cash: 450 } });
  g.respondTrade(b, g.trades[0].id, true);
  assert.strictEqual(g.props[39].owner, b.id);
  assert.strictEqual(a.cash, 250);
  a.cash = -10;
  assert.throws(() => g.proposeTrade(a, { to: b.id, give: { cash: 5 }, get: { spaces: [39] } }), /does not have/);
});

test('three doubles sends you to lockup', () => {
  const g = newGame(2);
  g.rng = () => 0; // always rolls 1+1
  const a = g.current();
  a.pos = 10; // just visiting: 1+1 lands on 12, 14, then speeding
  g.roll(a); if (g.turn.phase === 'buy') g.decline(a); while (g.auction) g.closeAuction();
  g.roll(a); if (g.turn.phase === 'buy') g.decline(a); while (g.auction) g.closeAuction();
  g.roll(a);
  assert.ok(a.inJail);
  assert.strictEqual(g.turn.phase, 'done');
});

test('fuzz: random full games never throw unexpected errors', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = seeded(seed * 7919);
    const g = newGame(2 + (seed % 5), seed);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    let steps = 0;
    while (g.status === 'playing' && steps++ < 4000) {
      const cur = g.current();
      const any = pick(g.active());
      const tryA = (pid, msg) => { try { g.apply(pid, msg); } catch (e) { if (!(e instanceof GameError)) throw e; } };
      // random side actions by any player
      const r = rng();
      const mine = g.ownedBy(any.id);
      const other = pick(g.active().filter((p) => p.id !== any.id)) || any;
      if (r < 0.08) tryA(any.id, { action: 'borrow', amount: Math.floor(rng() * 800) + 10, term: pick([5, 10, 20]) });
      else if (r < 0.12 && any.loans[0]) tryA(any.id, { action: 'repay', loanId: any.loans[0].id, amount: 100 });
      else if (r < 0.2 && mine.length) tryA(any.id, { action: pick(['build', 'sell', 'mortgage', 'unmortgage', 'liquidate']), space: pick(mine) });
      else if (r < 0.23 && mine.length) tryA(any.id, { action: 'proposeTrade', trade: { to: other.id, give: { spaces: [pick(mine)] }, get: { cash: 100 } } });
      else if (r < 0.27) {
        const kinds = [
          { kind: 'rate', from: any.id, to: other.id, notional: 1000, rateType: 'fixed', rate: 3 },
          { kind: 'rate', from: other.id, to: any.id, notional: 1000, rateType: 'floating', spread: 0 },
          { kind: 'upfront', from: other.id, to: any.id, amount: 100 },
          { kind: 'fixed', from: any.id, to: other.id, amount: 20 },
          { kind: 'maturity', from: any.id, to: other.id, amount: 100 },
          { kind: 'equity', from: any.id, to: other.id, pct: 10 },
          { kind: 'rentShare', from: any.id, to: other.id, pct: 50, spaces: [] },
          { kind: 'default', from: other.id, to: any.id, amount: 200, ref: pick(g.active()).id },
          mine.length ? { kind: 'collateral', from: any.id, to: other.id, spaces: [pick(mine)] } : null,
          mine.length ? { kind: 'call', holder: other.id, writer: any.id, space: pick(mine), strike: 150 } : null,
          mine.length ? { kind: 'put', holder: any.id, writer: other.id, space: pick(mine), strike: 150 } : null,
        ].filter(Boolean);
        tryA(any.id, { action: 'proposeContract', contract: { to: other.id, name: 'fuzz', term: pick([0, 3, 6]), clauses: [pick(kinds), pick(kinds)] } });
      } else if (r < 0.32) {
        const t = g.trades.find((x) => x.status === 'pending');
        if (t) tryA(t.to, { action: rng() < 0.5 ? 'acceptTrade' : 'rejectTrade', id: t.id });
        const c = g.contracts.find((x) => x.status === 'proposed');
        if (c) tryA(c.parties[1], { action: rng() < 0.7 ? 'acceptContract' : 'rejectContract', id: c.id });
      } else if (r < 0.34) {
        const c = g.contracts.find((x) => x.status === 'active' && x.clauses.some((y) => ['call', 'put'].includes(y.kind)));
        if (c) { const k = c.clauses.findIndex((y) => ['call', 'put'].includes(y.kind)); tryA(c.clauses[k].holder, { action: 'exercise', id: c.id, clause: k }); }
      } else if (r < 0.39) {
        const order = pick([
          { product: 'shares', ref: other.id, shares: 1 + Math.floor(rng() * 20) },
          { product: pick(['call', 'put']), ref: other.id, shares: 10, strike: Math.floor(rng() * 30), term: pick([5, 10, 20]) },
          { product: 'cds', ref: other.id, notional: 300, term: pick([5, 10]) },
          { product: 'insurance', deductible: pick([100, 250, 500]), term: 10 },
          { product: 'swap', side: pick(['payFixed', 'receiveFixed']), notional: 500, term: 5 },
          { product: 'issue', shares: 1 + Math.floor(rng() * 10) },
        ]);
        tryA(any.id, { action: 'deskBuy', order });
        const mineD = g.desk.positions.filter((x) => x.holder === any.id);
        if (mineD.length && rng() < 0.3) tryA(any.id, { action: 'deskClose', id: pick(mineD).id });
      } else if (r < 0.41) {
        tryA(any.id, { action: 'borrow', amount: 200, term: pick([5, 10, 20]), kind: pick(['fixed', 'floating']) });
      }
      if (g.status !== 'playing') break;
      // main turn flow
      const p = g.current();
      if (g.auction) {
        const bidder = pick(g.auction.active.map((id) => g.player(id)));
        if (rng() < 0.5) tryA(bidder.id, { action: 'bid', amount: g.auction.highBid + 10 }); else tryA(bidder.id, { action: 'passAuction' });
        if (g.auction && rng() < 0.1) g.closeAuction();
      } else if (p.cash < 0) {
        // raise money or go bust
        const own = g.ownedBy(p.id);
        if (own.length && rng() < 0.8) tryA(p.id, { action: pick(['sell', 'mortgage', 'liquidate']), space: pick(own) });
        else tryA(p.id, { action: 'bankrupt' });
      } else if (g.turn.phase === 'roll') {
        if (p.inJail && rng() < 0.3) tryA(p.id, { action: 'payBail' });
        tryA(p.id, { action: 'roll' });
      } else if (g.turn.phase === 'buy') tryA(p.id, { action: rng() < 0.6 ? 'buy' : 'decline' });
      else if (g.turn.phase === 'done') tryA(p.id, { action: 'endTurn' });
      void cur;
      // invariants
      for (const q of g.players) {
        assert.ok(Number.isFinite(q.cash), 'cash finite');
        if (q.bankrupt) assert.strictEqual(g.ownedBy(q.id).length, 0);
      }
      assert.ok(g.bankHouses >= 0 && g.bankHouses <= 32, `houses ${g.bankHouses}`);
      for (const k of Object.keys(g.props)) {
        const pr = g.props[k];
        if (pr.houses > 0) assert.ok(pr.estate || (pr.owner && g.ownsGroup(pr.owner, require('../src/board').SPACES[k].group)), `buildings on a split group at ${k}`);
      }
      assert.ok(g.bankHotels >= 0 && g.bankHotels <= 12);
      JSON.stringify(g.serialize());
    }
    assert.ok(g.round >= 1);
  }
});
