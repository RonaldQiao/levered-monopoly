'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError } = require('../src/engine');
const bot = require('../src/bot');
const { GROUP_MEMBERS } = require('../src/board');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// A reasonable casual player: buys what it can afford, builds with spare cash, never trades.
function casual(g, pid) {
  const me = g.player(pid);
  if (g.auction && g.auction.active.includes(pid)) return g.auction.highBidder === pid ? null : { action: 'passAuction' };
  const t = g.trades.find((x) => x.status === 'pending' && x.to === pid);
  if (t) return { action: 'rejectTrade', id: t.id };
  const c = g.contracts.find((x) => x.status === 'proposed' && x.parties[1] === pid);
  if (c) return { action: 'rejectContract', id: c.id };
  const myTurn = g.current().id === pid;
  if (me.cash < 0) {
    const built = g.ownedBy(pid).find((i) => g.props[i].houses > 0 && g.props[i].houses >= Math.max(...GROUP_MEMBERS[require('../src/board').SPACES[i].group].map((j) => g.props[j].houses)));
    if (built !== undefined) return { action: 'sell', space: built };
    const m = g.ownedBy(pid).find((i) => !g.props[i].mortgaged && !(require('../src/board').SPACES[i].group && g.groupHasBuildings(require('../src/board').SPACES[i].group)));
    if (m !== undefined) return { action: 'mortgage', space: m };
    return myTurn ? { action: 'bankrupt' } : null;
  }
  if (!myTurn) return null;
  const ph = g.turn.phase;
  if (ph === 'roll' && g.auction) return null;
  if (ph === 'buy') return me.cash >= g.price(g.turn.pendingBuy) ? { action: 'buy' } : { action: 'decline' };
  if (ph === 'roll' || ph === 'done') {
    if (me.cash > 350) {
      for (const [grp, members] of Object.entries(GROUP_MEMBERS)) {
        if (!g.ownsGroup(pid, grp) || members.some((j) => g.props[j].mortgaged)) continue;
        const minH = Math.min(...members.map((j) => g.props[j].houses));
        if (minH >= 5) continue;
        const j = members.find((x) => g.props[x].houses === minH);
        if (me.cash - g.houseCost(j) > 300 && (minH === 4 ? g.bankHotels : g.bankHouses) > 0) return { action: 'build', space: j };
      }
    }
    return { action: ph === 'roll' ? 'roll' : 'endTurn' };
  }
  return null;
}

function play(g, policy, maxRounds = 150) {
  const failures = new Map();
  for (let steps = 0; g.status === 'playing' && g.round <= maxRounds; steps++) {
    if (steps > 200000) throw new Error('step limit');
    let acted = false;
    for (const p of g.players) {
      if (p.bankrupt) continue;
      const a = policy[p.id](g, p.id);
      if (!a) continue;
      try { g.apply(p.id, a); failures.delete(p.id); } catch (e) {
        if (!(e instanceof GameError)) throw e;
        bot.markFailed(g, p.id, a);
        const n = (failures.get(p.id) || 0) + 1; failures.set(p.id, n);
        if (n > 50) throw new Error(`${p.name} stuck on ${JSON.stringify(a)}: ${e.message}`);
      }
      acted = true; break;
    }
    if (!acted) { if (g.auction) g.closeAuction(); else throw new Error('nobody can act'); }
  }
  const alive = g.active();
  return alive.length === 1 ? alive[0] : alive.sort((a, b) => g.netWorth(b) - g.netWorth(a))[0];
}

function newGame(seed, names, opts = {}) {
  let t = 0;
  const g = new Game('T', { rng: seeded(seed), now: () => (t += 1000) });
  const ps = names.map((n) => g.addPlayer(n));
  Object.assign(g.settings, opts);
  g.start(ps[0].id);
  return { g, ps };
}

test('bots-only games run to completion within the rules', () => {
  let finished = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { g, ps } = newGame(seed * 101, ['A', 'B', 'C', 'D']);
    const policy = Object.fromEntries(ps.map((p) => [p.id, bot.decide]));
    play(g, policy, 250);
    if (g.status === 'finished') finished++;
    for (const p of g.players) assert.ok(Number.isFinite(p.cash));
    assert.ok(g.bankHouses >= 0 && g.bankHotels >= 0);
  }
  assert.ok(finished >= 4, `only ${finished}/6 bot games finished by round 250`);
});

test('bots beat casual players clearly', () => {
  let botWins = 0; const N = 24;
  for (let seed = 1; seed <= N; seed++) {
    const { g, ps } = newGame(seed * 7919, ['Bot1', 'Casual1', 'Bot2', 'Casual2']);
    const policy = Object.fromEntries(ps.map((p) => [p.id, p.name.startsWith('Bot') ? bot.decide : casual]));
    const w = play(g, policy, 150);
    if (w.name.startsWith('Bot')) botWins++;
  }
  console.log(`  bots won ${botWins}/${N} (2 bots vs 2 casual players; 50% = no edge)`);
  assert.ok(botWins / N >= 0.7, `bots won only ${botWins}/${N}`);
});

test('bank desk: shares, options, CDS, insurance and swaps settle correctly', () => {
  const { g, ps } = newGame(5, ['A', 'B', 'C']);
  const [a, b, c] = g.players;
  void ps;
  // shares: bought at the round mark + spread, sold at mark - spread
  const px = g.desk.marks[b.id].price;
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 10 });
  assert.strictEqual(a.cash, 1500 - Math.ceil(px * 10 * 1.03));
  assert.throws(() => g.deskBuy(a, { product: 'shares', ref: a.id, shares: 1 }), /yourself/);
  // insurance pays 80% of rent above the deductible
  g.props[39].owner = c.id; g.props[39].houses = 5;
  g.deskBuy(a, { product: 'insurance', deductible: 250, term: 10 });
  const before = a.cash;
  a.pos = 39; g.resolveLanding(a);
  assert.strictEqual(a.cash - before, -2000 + Math.round(0.8 * (2000 - 250)));
  // CDS pays notional on bankruptcy; put pays strike x shares
  a.cash = 5000;
  g.deskBuy(a, { product: 'cds', ref: b.id, notional: 400, term: 10 });
  g.deskBuy(a, { product: 'put', ref: b.id, shares: 10, strike: 10, term: 10 });
  const pre = a.cash;
  g.declareBankruptcy(b);
  assert.strictEqual(a.cash - pre, 400 + 100);
  assert.ok(!g.desk.positions.some((x) => x.ref === b.id));
  // pay-fixed swap gains when the policy rate is above the fixed rate
  g.deskBuy(a, { product: 'swap', side: 'payFixed', notional: 1000, term: 5 });
  const sw = g.desk.positions.find((x) => x.type === 'swap');
  g.econ.policyRate = sw.fixed + 2;
  g.deskClose(a, g.desk.positions.find((x) => x.type === 'insurance').id); // isolate the swap from the insurance premium
  const s0 = a.cash; g.settleDesk();
  assert.strictEqual(a.cash - s0, 20);
});

test('bank-desk puts stay consistent when the share price falls to $0', () => {
  const { g } = newGame(9, ['A', 'B', 'C']);
  const [a, b] = g.players;
  g.deskBuy(a, { product: 'put', ref: b.id, shares: 10, strike: 10, term: 5 });
  const put = g.desk.positions[0];
  // Mid-round crash: net worth and a close both use the round mark, so they agree (no free value, no lost value).
  b.cash = -100;
  assert.strictEqual(g.deskValue(a), g.optionPayoff(put, g.desk.marks[b.id].price));
  // At the next re-mark the put is worth the full strike and pays it.
  g.markEquity();
  assert.strictEqual(g.desk.marks[b.id].price, 0);
  assert.strictEqual(g.deskValue(a), 100);
  // Expiry settles at the fresh mark.
  g.round = put.expiry; const c0 = a.cash; g.settleDesk();
  assert.strictEqual(a.cash - c0, 100);
  assert.strictEqual(g.desk.positions.length, 0);
  // No new options on a player marked at $0.
  assert.throws(() => g.deskBuy(a, { product: 'call', ref: b.id, shares: 50, strike: 0, term: 20 }), /marked at \$0/);
  assert.throws(() => g.deskBuy(a, { product: 'put', ref: b.id, shares: 10, strike: 10, term: 5 }), /marked at \$0/);
});

test('fixed-rate loans always cost more than floating at signing', () => {
  const { g } = newGame(3, ['A', 'B']);
  const a = g.players[0];
  for (const rate of [0.25, 2, 6, 12]) {
    g.econ.policyRate = rate;
    for (const t of [5, 10, 20]) assert.ok(g.quote(a, t, 0, 'fixed') > g.quote(a, t, 0, 'floating'), `policy ${rate} term ${t}`);
  }
  g.econ.policyRate = 2;
  g.borrow(a, 500, 10, 'floating');
  const l = a.loans[0];
  assert.strictEqual(l.kind, 'floating');
  g.econ.policyRate = 5; g.round = 2; g.newRound();
  assert.strictEqual(l.rate, Math.round((g.econ.policyRate + l.margin) * 100) / 100, 'floating loans reset to policy + margin');
});
