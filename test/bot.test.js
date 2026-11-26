'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError } = require('../src/engine');
const bot = require('../src/bot');
const { GROUP_MEMBERS } = require('../src/board');
const Pricing = require('../src/pricing');

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
  // shares: bought from the bank's float at the round mark + spread + scarcity premium
  const px = g.desk.marks[b.id].price;
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 10 });
  assert.strictEqual(a.cash, 1500 - Pricing.shareAskCost(px, 10, 25, 25));
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
  assert.strictEqual(g.deskValue(a), g.optionBidValue(put));
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

test('options: bank sells above fair value, buys back below it, and pays time value on a sell-back', () => {
  const { g } = newGame(11, ['A', 'B', 'C']);
  const [a, b] = g.players;
  const m = g.desk.marks[b.id];
  const K = Math.round(m.price * 0.7); // well out of the money put
  const fair = Pricing.fairOption('put', m.price, K, 10, g.econ.policyRate, m.vol, 20);
  const c0 = a.cash;
  g.deskBuy(a, { product: 'put', ref: b.id, shares: 20, strike: K, term: 10 });
  const paid = c0 - a.cash;
  const put = g.desk.positions[0];
  const back = g.optionBidValue(put);
  assert.ok(paid > fair && fair > back, `ask ${paid} > fair ${fair.toFixed(1)} > bid ${back}`);
  assert.ok(back > 0, 'an out-of-the-money option with time left is worth something');
  const c1 = a.cash; g.deskClose(a, put.id);
  assert.strictEqual(a.cash - c1, back);
  // No free money: for every strike and term, the bank's ask is at or above its bid (deep in-the-money too).
  for (const kind of ['call', 'put']) for (const f of [0.3, 0.7, 1, 1.3, 2]) for (const T of [1, 5, 20]) {
    const K = m.price * f;
    const ask = Pricing.optionAsk(kind, m.price, K, T, 4, m.vol, 10); const bid = Pricing.optionBid(kind, m.price, K, T, 4, m.vol, 10);
    assert.ok(ask >= bid, `${kind} K=${K.toFixed(2)} T=${T}: ask ${ask} < bid ${bid}`);
  }
});

test('shares: limited float, scarcity pricing, and issuing new shares', () => {
  const { g } = newGame(12, ['A', 'B', 'C']);
  const [a, b, c] = g.players;
  a.cash = 10000; c.cash = 10000;
  const px = g.desk.marks[b.id].price;
  const first = Pricing.shareAskCost(px, 5, 25, 25);
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 20 });
  const last = Pricing.shareAskCost(px, 5, 5, 25);
  assert.ok(last > first, 'later buyers pay more as the float runs out');
  g.deskBuy(c, { product: 'shares', ref: b.id, shares: 5 });
  assert.throws(() => g.deskBuy(c, { product: 'shares', ref: b.id, shares: 1 }), /would have to issue/);
  // B issues 10 new shares: B gets cash, the float reopens, B's own stake shrinks.
  const nw0 = g.netWorth(b); const cash0 = b.cash;
  g.deskBuy(b, { product: 'issue', shares: 10 });
  assert.ok(b.cash > cash0);
  assert.strictEqual(g.outstanding(b.id), 135);
  assert.strictEqual(g.desk.equity[b.id].inv, 10);
  assert.ok(g.netWorth(b) <= nw0 && g.netWorth(b) > nw0 * 0.9, 'issuing at a discount costs the issuer a little');
  g.deskBuy(c, { product: 'shares', ref: b.id, shares: 5 });
  assert.throws(() => g.deskBuy(b, { product: 'issue', shares: 20 }), /at most 15 more/);
});

test('the bank refuses trades it cannot price or that invite abuse', () => {
  const { g } = newGame(13, ['A', 'B', 'C']);
  const [a, b] = g.players;
  a.cash = 20000;
  // Protection is capped at ~1.5x the reference's equity across all buyers.
  g.deskBuy(a, { product: 'cds', ref: b.id, notional: g.deskLimit(a) > 2000 ? 2000 : g.deskLimit(a), term: 10 });
  assert.throws(() => g.deskBuy(a, { product: 'cds', ref: b.id, notional: 1000, term: 10 }), /caps protection/);
  // No new protection, options or equity once a player is close to default.
  b.cash = -50; // negative cash pushes default risk above every limit
  assert.ok(g.hazard(b.id) > 0.12);
  assert.throws(() => g.deskBuy(g.players[2], { product: 'cds', ref: b.id, notional: 100, term: 5 }), /not selling protection|distress/);
  assert.throws(() => g.deskBuy(b, { product: 'issue', shares: 5 }), /default risk|no equity/);
  // The option book on one name is capped.
  const c = g.players[2]; c.cash = 20000;
  for (let k = 0; k < 2; k++) g.deskBuy(c, { product: 'call', ref: a.id, shares: 50, strike: 1, term: 5 });
  assert.throws(() => g.deskBuy(c, { product: 'call', ref: a.id, shares: 1, strike: 1, term: 5 }), /option book/);
});

test('rent insurance is priced from where you stand, so knowing the board gives no edge against the bank', () => {
  const { g } = newGame(14, ['A', 'B']);
  const [a, b] = g.players;
  for (const i of [37, 39]) { g.props[i].owner = b.id; g.props[i].houses = 5; }
  g.props[21].owner = b.id; g.props[21].houses = 3; g.props[23].owner = b.id; g.props[24].owner = b.id;
  a.pos = 32; const danger = g.insuranceQuote(a.id, 250);
  a.pos = 0; const safe = g.insuranceQuote(a.id, 250);
  assert.ok(danger > safe * 5, `in front of the hotels ${danger} vs far away ${safe}`);
  // Monte Carlo: buy insurance every turn from a random square, pay the quote, roll real dice.
  const rng = seeded(4242); const die = () => 1 + Math.floor(rng() * 6);
  let bankPnl = 0;
  for (let k = 0; k < 4000; k++) {
    a.pos = Math.floor(rng() * 40); if (a.pos === 30) continue;
    bankPnl += g.insuranceQuote(a.id, 100);
    const land = [];
    const r1 = [die(), die()]; land.push((a.pos + r1[0] + r1[1]) % 40);
    if (r1[0] === r1[1]) { const r2 = [die(), die()]; land.push((land[0] + r2[0] + r2[1]) % 40); }
    for (const s of land) {
      const pr = g.props[s];
      if (pr && pr.owner === b.id) bankPnl -= Math.min(1500, Math.round(0.8 * Math.max(0, g.rentFor(s, 7) - 100)));
    }
  }
  assert.ok(bankPnl > 0, `bank P&L on 4000 insured turns: ${bankPnl}`);
});

test('fixed loans are marked to market: repay below par after rates rise, make-whole after they fall', () => {
  const { g } = newGame(15, ['A', 'B']);
  const a = g.players[0];
  g.borrow(a, 1000, 20, 'fixed');
  const l = a.loans[0];
  assert.ok(Math.abs(g.loanMarketRatio(l) - 1) < 0.005, 'worth par at signing');
  assert.strictEqual(g.prepayCost(l, 100), 101); // par + 0.5% fee
  g.econ.policyRate = 7; g.econ.heat = 80;
  assert.ok(g.loanMarketRatio(l) < 0.95 && g.loanMtmGain(a) > 0, 'rates up: the borrower holds a cheap loan');
  const nw = g.netWorth(a); const eq = g.bookEquity(a);
  assert.ok(nw > 0 && g.maxLoan(a) === Math.floor((g.settings.maxLeverage - 1) * eq), 'the gain is in net worth, not borrowing power');
  const c0 = a.cash; g.repay(a, l.id, 500);
  assert.ok(c0 - a.cash < 500, 'repaid $500 of principal for less than $500');
  g.econ.policyRate = 0.25; g.econ.heat = 15;
  assert.ok(g.loanMarketRatio(l) > 1.02, 'rates down: repaying early costs a make-whole premium');
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
