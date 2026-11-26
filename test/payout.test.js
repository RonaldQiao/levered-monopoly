'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Payout = require('../src/payout');
const { Game, GameError } = require('../src/engine');

const settle = (mode, players, reason = 'cap') => Payout.settle({ mode, players, reason });
const byId = (r) => Object.fromEntries(r.rows.map((x) => [x.id, x]));
const pays = (r) => Object.fromEntries(r.rows.map((x) => [x.id, x.payoutCents]));
const sumPaid = (r) => r.rows.reduce((a, x) => a + x.payoutCents, 0);
const P = (id, stake, netWorth, extra = {}) => ({ id, name: id.toUpperCase(), stake, netWorth, bankrupt: false, out: 0, ...extra });
const dead = (id, stake, out) => P(id, stake, 0, { bankrupt: true, out });

// ------------------------------------------------------------------ winner take all
test('winner take all: equal stakes, the highest net worth at the cap takes the pot', () => {
  const r = settle('winner', [P('a', 10, 1500), P('b', 10, 4000), P('c', 10, 2500)]);
  assert.strictEqual(r.potCents, 3000);
  assert.deepStrictEqual(pays(r), { b: 3000, c: 0, a: 0 });
  assert.deepStrictEqual(r.rows.map((x) => x.id), ['b', 'c', 'a']);
  assert.strictEqual(byId(r).b.net, 20);
  assert.strictEqual(byId(r).a.net, -10);
});

test('winner take all: the last player standing wins, whatever their net worth', () => {
  const r = settle('winner', [dead('a', 25, 2), P('b', 25, 300), dead('c', 25, 1)], 'lastStanding');
  assert.deepStrictEqual(pays(r), { b: 7500, a: 0, c: 0 });
  assert.deepStrictEqual(r.rows.map((x) => [x.id, x.place]), [['b', 1], ['a', 2], ['c', 3]]);
});

test('winner take all: unequal stakes use side pots, so the winner takes at most their stake from each rival', () => {
  // A wins with the smallest stake: A takes 10 from each of B and C; B and C settle the rest between them.
  const r = settle('winner', [P('a', 10, 5000), P('b', 50, 3000), P('c', 100, 1000)]);
  assert.deepStrictEqual(pays(r), { a: 3000, b: 8000, c: 5000 });
  assert.strictEqual(byId(r).a.net, 20);  // 10 from each opponent, no more
  assert.strictEqual(byId(r).b.net, 30);  // B beat C on the 10..50 layer
  assert.strictEqual(byId(r).c.net, -50);
  assert.strictEqual(sumPaid(r), r.potCents);
});

test('winner take all: a tie for first splits the pot', () => {
  const r = settle('winner', [P('a', 10, 3000), P('b', 10, 3000), P('c', 10, 1000)]);
  assert.deepStrictEqual(pays(r), { a: 1500, b: 1500, c: 0 });
  assert.ok(byId(r).a.tie && byId(r).b.tie);
  assert.strictEqual(Payout.placeLabel(byId(r).a), '=1st');
  assert.strictEqual(byId(r).c.place, 3);
});

// ------------------------------------------------------------------ order of bankruptcy
test('order of bankruptcy: weights n-1 ... 0 by place, normalised; rounding remainder to the top finisher', () => {
  // 4 players, $10 each: weights 3,2,1,0 / 6 of $40 -> 20, 13.33, 6.66(+0.01 remainder to 1st), 0
  const r = settle('order', [P('a', 10, 4000), P('b', 10, 2000), dead('c', 10, 2), dead('d', 10, 1)]);
  assert.deepStrictEqual(r.rows.map((x) => [x.id, x.place]), [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  assert.deepStrictEqual(pays(r), { a: 2001, b: 1333, c: 666, d: 0 });
  assert.strictEqual(sumPaid(r), 4000);
});

test('order of bankruptcy: survivors at the cap rank by net worth, then the bankrupt in reverse order of going out', () => {
  const r = settle('order', [dead('a', 6, 1), P('b', 6, 900), dead('c', 6, 2), P('d', 6, 2500)]);
  assert.deepStrictEqual(r.rows.map((x) => x.id), ['d', 'b', 'c', 'a']);
  // weights 3,2,1,0 of $24
  assert.deepStrictEqual(pays(r), { d: 1200, b: 800, c: 400, a: 0 });
});

test('order of bankruptcy: ended by bankruptcy uses the full finishing order', () => {
  const r = settle('order', [dead('a', 10, 1), dead('b', 10, 2), P('c', 10, 100)], 'lastStanding');
  // weights 2,1,0 of $30 -> c 20, b 10, a 0
  assert.deepStrictEqual(pays(r), { c: 2000, b: 1000, a: 0 });
});

test('order of bankruptcy: tied places share the average of their weights', () => {
  // a and b tie for 1st: weights (2+1)/2 each, c 0.
  const r = settle('order', [P('a', 10, 2000), P('b', 10, 2000), P('c', 10, 500)]);
  assert.deepStrictEqual(pays(r), { a: 1500, b: 1500, c: 0 });
  assert.strictEqual(byId(r).a.place, 1);
  assert.strictEqual(byId(r).b.place, 1);
  assert.strictEqual(byId(r).c.place, 3);
});

test('order of bankruptcy: unequal stakes, layers renormalised among their funders', () => {
  // places a,b,c -> weights 2,1,0. Layer 0..10 ($30) split 2:1:0 -> a 20, b 10.
  // Layer 10..30 ($40, b and c) split 1:0 -> b 40. Total a 20, b 50, c 0.
  const r = settle('order', [P('a', 10, 3000), P('b', 30, 2000), P('c', 30, 1000)]);
  assert.deepStrictEqual(pays(r), { a: 2000, b: 5000, c: 0 });
  assert.strictEqual(byId(r).a.net, 10); // a only ever risked $10, so wins at most $10 from each rival
});

// ------------------------------------------------------------------ share
test('share payout: weight = net-worth share; bankrupt and negative net worth count as 0', () => {
  const r = settle('share', [P('a', 10, 3000), P('b', 10, 1000), P('c', 10, -400), dead('d', 10, 1)]);
  assert.deepStrictEqual(pays(r), { a: 3000, b: 1000, c: 0, d: 0 });
  assert.strictEqual(byId(r).a.share, 0.75);
  assert.strictEqual(byId(r).b.share, 0.25);
  assert.strictEqual(byId(r).c.share, 0);
  assert.strictEqual(byId(r).d.share, 0);
});

test('share payout: unequal stakes', () => {
  // shares .5/.3/.2. Layer 0..10 ($30): 15, 9, 6. Layer 10..50 ($80, b and c renormalised .6/.4): 48, 32. Layer 50..100: c's own 50.
  const r = settle('share', [P('a', 10, 5000), P('b', 50, 3000), P('c', 100, 2000)]);
  assert.deepStrictEqual(pays(r), { a: 1500, b: 5700, c: 8800 });
  assert.strictEqual(sumPaid(r), 16000);
});

test('share payout: bankruptcy before the cap gives the sole survivor weight 1', () => {
  // The survivor's net worth is negative, so their share is 0 — but they outlasted everyone.
  const r = settle('share', [dead('a', 20, 1), P('b', 20, -50), dead('c', 20, 2)], 'lastStanding');
  assert.deepStrictEqual(pays(r), { b: 6000, a: 0, c: 0 });
  assert.strictEqual(byId(r).b.weight, 1);
});

test('share payout: if nobody has positive net worth, the best-placed funder takes each layer', () => {
  const r = settle('share', [P('a', 10, -100), P('b', 10, -500)]);
  assert.deepStrictEqual(pays(r), { a: 2000, b: 0 });
});

// ------------------------------------------------------------------ share cubed
test('share³ payout: weight = share³ / Σshare³, remainder cent to the top finisher', () => {
  // shares .75/.25 -> cubes .421875/.015625 -> 96.43% / 3.57% of $30 = 28.928.. / 1.071..
  const r = settle('share3', [P('a', 15, 3000), P('b', 15, 1000)]);
  assert.deepStrictEqual(pays(r), { a: 2893, b: 107 });
  assert.ok(Math.abs(byId(r).a.weight - 0.421875 / 0.4375) < 1e-12);
  assert.strictEqual(byId(r).a.share, 0.75);
});

test('share³ payout: unequal stakes and a bankrupt player', () => {
  // shares a .5, b .5, c 0 (bankrupt) -> cubed weights equal for a and b.
  // Layer 0..5 ($15): 7.5 each. Layer 5..20 ($30, b and c): b 30. Totals a 7.5, b 37.5, c 0.
  const r = settle('share3', [P('a', 5, 2000), P('b', 20, 2000), dead('c', 20, 1)]);
  assert.deepStrictEqual(pays(r), { a: 750, b: 3750, c: 0 });
});

test('share³ payout: bankruptcy before the cap gives the sole survivor the pot', () => {
  const r = settle('share3', [P('a', 10, 800), dead('b', 30, 1)], 'lastStanding');
  // a funds only the first $10 layer; b's extra $20 has no other funder and comes back to b.
  assert.deepStrictEqual(pays(r), { a: 2000, b: 2000 });
  assert.strictEqual(byId(r).a.net, 10);
  assert.strictEqual(byId(r).b.net, -10);
});

// ------------------------------------------------------------------ $0 stakes
test('$0 stakes: a $0 player can neither win nor lose in any mode, even finishing first', () => {
  for (const mode of Payout.MODE_KEYS) {
    const r = settle(mode, [P('a', 0, 9000), P('b', 10, 3000), P('c', 10, 1000)]);
    assert.strictEqual(byId(r).a.payoutCents, 0, mode);
    assert.strictEqual(byId(r).a.netCents, 0, mode);
    assert.strictEqual(byId(r).a.place, 1, mode);
    assert.strictEqual(sumPaid(r), 2000, mode);
  }
  // Winner take all: the best-placed player with money in takes it.
  assert.deepStrictEqual(pays(settle('winner', [P('a', 0, 9000), P('b', 10, 3000), P('c', 10, 1000)])), { a: 0, b: 2000, c: 0 });
});

test('all-$0 game: the table has every player with zeros', () => {
  for (const mode of Payout.MODE_KEYS) {
    const r = settle(mode, [P('a', 0, 3000), P('b', 0, 1000), dead('c', 0, 1)]);
    assert.strictEqual(r.pot, 0);
    assert.strictEqual(r.rows.length, 3);
    for (const x of r.rows) {
      assert.strictEqual(x.stake, 0);
      assert.strictEqual(x.payout, 0);
      assert.strictEqual(x.net, 0);
    }
    assert.deepStrictEqual(r.rows.map((x) => x.place), [1, 2, 3]);
  }
});

test('a single player with money in just gets their stake back', () => {
  for (const mode of Payout.MODE_KEYS) {
    const r = settle(mode, [P('a', 0, 3000), P('b', 12.34, 1000)]);
    assert.deepStrictEqual(pays(r), { a: 0, b: 1234 }, mode);
  }
});

// ------------------------------------------------------------------ invariants
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('fuzz: payouts sum to the pot exactly, are never negative, and nobody wins more than they risked per rival', () => {
  const rnd = lcg(7);
  for (let k = 0; k < 2000; k++) {
    const n = 2 + Math.floor(rnd() * 7);
    let out = 0;
    const players = Array.from({ length: n }, (_, i) => {
      const stake = rnd() < 0.2 ? 0 : Math.round(rnd() * 10000) / 100;
      const bankrupt = rnd() < 0.3 && i > 0;
      const nw = rnd() < 0.3 ? 2000 : Math.round(rnd() * 6000 - 500);
      return bankrupt ? dead(`p${i}`, stake, ++out) : P(`p${i}`, stake, nw);
    });
    const reason = players.filter((p) => !p.bankrupt).length === 1 ? 'lastStanding' : (rnd() < 0.5 ? 'cap' : 'host');
    const stakes = Object.fromEntries(players.map((p) => [p.id, p.stake]));
    for (const mode of Payout.MODE_KEYS) {
      const r = settle(mode, players, reason);
      assert.strictEqual(sumPaid(r), r.potCents);
      assert.strictEqual(r.rows.length, n);
      for (const x of r.rows) {
        assert.ok(x.payoutCents >= 0);
        if (x.stakeCents === 0) assert.strictEqual(x.payoutCents, 0);
        const { maxWin } = Payout.exposure(stakes, x.id);
        assert.ok(x.netCents <= Math.round(maxWin * 100), `${mode} ${x.id} wins ${x.netCents} > ${maxWin}`);
        assert.ok(x.netCents >= -x.stakeCents);
      }
    }
  }
});

test('exposure and stake parsing', () => {
  assert.deepStrictEqual(Payout.exposure({ a: 10, b: 50, c: 0 }, 'a'), { maxWin: 10, maxLoss: 10 });
  assert.deepStrictEqual(Payout.exposure({ a: 10, b: 50, c: 0 }, 'b'), { maxWin: 10, maxLoss: 50 });
  assert.strictEqual(Payout.parseStake('12.345'), 12.35);
  assert.strictEqual(Payout.parseStake(0), 0);
  assert.strictEqual(Payout.parseStake(-1), null);
  assert.strictEqual(Payout.parseStake('abc'), null);
  assert.strictEqual(Payout.parseStake(2e6), null);
  assert.strictEqual(Payout.signed(-3.5), '−$3.50');
  assert.strictEqual(Payout.signed(0), '±$0.00');
});

// ------------------------------------------------------------------ engine integration
function lobby(n = 3) {
  let t = 0;
  const g = new Game('TEST', { rng: lcg(3), now: () => (t += 1000) });
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(g.addPlayer(`P${i}`));
  return { g, ps, host: ps[0].id };
}

test('lobby: the toggle, the payout mode and the 40-round default for share modes', () => {
  const { g, host, ps } = lobby();
  assert.strictEqual(g.settings.realMoney, false);
  assert.throws(() => g.apply(ps[1].id, { action: 'stake', amount: 5 }), /off/);
  assert.throws(() => g.apply(ps[1].id, { action: 'settings', settings: { realMoney: true } }), /host/);
  g.apply(host, { action: 'settings', settings: { realMoney: true, payoutMode: 'share' } });
  assert.strictEqual(g.settings.maxRounds, 40);
  g.apply(host, { action: 'settings', settings: { maxRounds: 0 } });
  assert.strictEqual(g.settings.maxRounds, 40); // share modes always keep a cap
  g.apply(host, { action: 'settings', settings: { maxRounds: 25 } });
  assert.strictEqual(g.settings.maxRounds, 25);
  g.apply(host, { action: 'settings', settings: { preset: 'classic' } });
  assert.strictEqual(g.settings.maxRounds, 40);
  g.apply(host, { action: 'settings', settings: { payoutMode: 'winner', maxRounds: 0 } });
  assert.strictEqual(g.settings.maxRounds, 0); // winner take all can play to the end
  assert.throws(() => g.apply(host, { action: 'settings', settings: { payoutMode: 'lottery' } }), GameError);
});

test('lobby: each human sets their own stake; AI players stay at $0; stakes lock at the start', () => {
  const { g, host, ps } = lobby(2);
  g.apply(host, { action: 'settings', settings: { realMoney: true } });
  g.apply(host, { action: 'addBot' });
  const bot = g.players.find((p) => p.bot);
  g.apply(ps[0].id, { action: 'stake', amount: 20 });
  g.apply(ps[1].id, { action: 'stake', amount: '7.5' });
  assert.throws(() => g.apply(bot.id, { action: 'stake', amount: 5 }), /AI/);
  assert.throws(() => g.apply(ps[1].id, { action: 'stake', amount: -1 }), /Stake/);
  assert.deepStrictEqual(g.serialize().players.map((p) => p.stake), [20, 7.5, 0]);
  g.start(host);
  assert.throws(() => g.apply(ps[0].id, { action: 'stake', amount: 50 }), /locked/);
  assert.ok(g.log.some((l) => /Pot \$27\.50/.test(l.msg)));
});

test('game end: the host ending it settles the pot, logs it and serializes the table', () => {
  const { g, host, ps } = lobby(3);
  g.apply(host, { action: 'settings', settings: { realMoney: true, payoutMode: 'winner' } });
  ps.forEach((p, i) => g.apply(p.id, { action: 'stake', amount: 10 * (i + 1) }));
  g.start(host);
  const rich = g.players[1];
  rich.cash += 5000;
  g.apply(host, { action: 'endNow' });
  const s = g.serialize();
  assert.strictEqual(s.status, 'finished');
  assert.strictEqual(s.endReason, 'host');
  assert.ok(s.payout);
  assert.strictEqual(s.payout.potCents, 6000);
  assert.strictEqual(s.payout.rows[0].id, rich.id);
  assert.strictEqual(s.payout.rows.reduce((a, x) => a + x.payoutCents, 0), 6000);
  assert.ok(g.log.some((l) => /Real-money payout — Winner take all/.test(l.msg)));
  assert.strictEqual(g.log.filter((l) => /^💵 (=)?\d/.test(l.msg)).length, 3);
});

test('game end: bankruptcy order sets finishing places; the last player standing ends it', () => {
  const { g, host, ps } = lobby(3);
  g.apply(host, { action: 'settings', settings: { realMoney: true, payoutMode: 'order' } });
  for (const p of ps) g.apply(p.id, { action: 'stake', amount: 10 });
  g.start(host);
  const [first, second, third] = g.players;
  g.declareBankruptcy(second);
  g.declareBankruptcy(first);
  assert.strictEqual(g.status, 'finished');
  assert.strictEqual(g.endReason, 'lastStanding');
  const r = byId(g.payout);
  assert.deepStrictEqual([r[third.id].place, r[first.id].place, r[second.id].place], [1, 2, 3]);
  assert.deepStrictEqual([r[third.id].payoutCents, r[first.id].payoutCents, r[second.id].payoutCents], [2000, 1000, 0]);
});

test('game end: the round cap settles a share game', () => {
  const { g, host, ps } = lobby(2);
  g.apply(host, { action: 'settings', settings: { realMoney: true, payoutMode: 'share', maxRounds: 3 } });
  for (const p of ps) g.apply(p.id, { action: 'stake', amount: 50 });
  g.start(host);
  g.players[0].cash = 3000; g.players[1].cash = 1000;
  g.round = 3;
  g.newRound();
  assert.strictEqual(g.status, 'finished');
  assert.strictEqual(g.endReason, 'cap');
  const r = byId(g.payout);
  const a = g.players[0].id; const b = g.players[1].id;
  assert.ok(r[a].netWorth > r[b].netWorth);
  assert.strictEqual(r[a].payoutCents + r[b].payoutCents, 10000);
  assert.ok(Math.abs(r[a].share - r[a].netWorth / (r[a].netWorth + r[b].netWorth)) < 1e-12);
});

test('real-money payouts off: no settlement and stakes are cleared at the start', () => {
  const { g, host, ps } = lobby(2);
  g.apply(host, { action: 'settings', settings: { realMoney: true } });
  g.apply(ps[1].id, { action: 'stake', amount: 10 });
  g.apply(host, { action: 'settings', settings: { realMoney: false } });
  g.start(host);
  assert.strictEqual(g.players.find((p) => p.id === ps[1].id).stake, 0);
  g.apply(host, { action: 'endNow' });
  assert.strictEqual(g.payout, null);
});
