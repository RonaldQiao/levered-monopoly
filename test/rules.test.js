'use strict';
// Skill-test rule options (draft, sealed bids, seeded dice, noise toggles, risk-priced credit, round cap)
// and the bank-desk exploit fixes.
const test = require('node:test');
const assert = require('node:assert');
const { Game, GameError, PRESETS } = require('../src/engine');
const bot = require('../src/bot');
const { EVENT_CARDS, TREASURY_CARDS } = require('../src/cards');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function newGame(n = 3, settings = {}, seed = 1) {
  let t = 0;
  const g = new Game('TEST', { rng: seeded(seed), now: () => (t += 1000) });
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(g.addPlayer(`P${i}`));
  g.updateSettings(ps[0].id, settings);
  g.start(ps[0].id);
  return g;
}

// Run a draft to the end: everyone passes except `bidder`, who bids `amount` on every lot it can afford.
function finishDraft(g, bidder, amount) {
  for (let guard = 0; g.auction && guard < 1000; guard++) {
    for (const id of g.auction.active.slice()) {
      const p = g.player(id);
      if (bidder && id === bidder.id && p.cash >= amount) g.bid(p, amount); else g.passAuction(p);
    }
  }
}

test('skill preset sets every skill-test option', () => {
  let t = 0;
  const g = new Game('T', { rng: seeded(1), now: () => (t += 1000) });
  const a = g.addPlayer('A'); g.addPlayer('B');
  g.updateSettings(a.id, { preset: 'skill' });
  for (const [k, v] of Object.entries(PRESETS.skill)) assert.deepStrictEqual(g.settings[k], v, k);
  g.updateSettings(a.id, { preset: 'classic' });
  assert.strictEqual(g.settings.acquisition, 'land');
  assert.throws(() => g.updateSettings(a.id, { acquisition: 'lottery' }), GameError);
});

test('opening draft: sealed, second-price, blocks rolling until done', () => {
  const g = newGame(3, { acquisition: 'draft' });
  const [a, b, c] = g.players;
  assert.strictEqual(g.turn.phase, 'draft');
  assert.ok(g.auction && g.auction.sealed && g.auction.draft);
  assert.throws(() => g.roll(g.current()), /cannot roll/);
  const lot = g.auction.space;
  g.bid(a, 300); g.bid(b, 120);
  assert.throws(() => g.bid(a, 400), /already bid/);
  // bids are private in the shared view; each player sees only their own
  const view = g.serialize().auction;
  assert.strictEqual(view.bids, undefined);
  assert.deepStrictEqual(view.submitted.sort(), [a.id, b.id].sort());
  assert.strictEqual(g.auctionView(b.id).myBid, 120);
  assert.strictEqual(g.auctionView(c.id).myBid, undefined);
  g.passAuction(c);
  assert.strictEqual(g.props[lot].owner, a.id);
  assert.strictEqual(a.cash, 1500 - 120, 'winner pays the second-highest bid');
  finishDraft(g, null, 0);
  assert.strictEqual(g.auction, null);
  assert.strictEqual(g.turn.phase, 'roll');
  g.roll(g.current());
});

test('sealed auction with a single bidder pays $1; tied bids go to one of the tied bidders', () => {
  const g = newGame(3, { acquisition: 'draft' });
  const [a, b, c] = g.players;
  let lot = g.auction.space;
  g.bid(a, 500); g.passAuction(b); g.passAuction(c);
  assert.strictEqual(g.props[lot].owner, a.id);
  assert.strictEqual(a.cash, 1499);
  lot = g.auction.space;
  g.bid(b, 200); g.bid(c, 200); g.passAuction(a);
  assert.ok([b.id, c.id].includes(g.props[lot].owner));
  assert.strictEqual(g.player(g.props[lot].owner).cash, 1300);
});

test('declined lots use sealed bids when auctionFormat is sealed', () => {
  const g = newGame(2, { auctionFormat: 'sealed' });
  const p = g.current();
  g.turn.phase = 'buy'; g.turn.pendingBuy = 1;
  g.decline(p);
  assert.ok(g.auction.sealed && !g.auction.draft);
  for (const x of g.players) g.bid(x, x === p ? 30 : 50);
  assert.strictEqual(g.props[1].owner, g.players.find((x) => x !== p).id);
  assert.strictEqual(g.turn.phase, 'done');
});

test('seeded dice: seat order is join order and each seat gets the same rolls whatever others do', () => {
  const rolls = (otherSeatRolls) => {
    const g = newGame(3, { diceMode: 'seeded', seed: 42, jail: false, doubles: false });
    assert.deepStrictEqual(g.players.map((p) => p.name), ['P0', 'P1', 'P2']);
    const out = [];
    for (let r = 0; r < 6; r++) {
      for (const p of g.players) {
        g.turn.idx = g.players.indexOf(p);
        const n = p.name === 'P1' ? 1 : (p.name === 'P2' ? otherSeatRolls : 1);
        for (let k = 0; k < n; k++) { const d = [g.die(), g.die()]; if (p.name === 'P0') out.push(d.join('+')); }
      }
    }
    return out;
  };
  assert.deepStrictEqual(rolls(1), rolls(3), "seat 0's dice don't depend on seat 2's rolls");
});

test('money cards off leaves only macro shocks; jail and doubles can be switched off', () => {
  const g = newGame(2, { moneyCards: false, jail: false, doubles: false });
  assert.ok(g.decks.event.every((i) => EVENT_CARDS[i].type.startsWith('macro')));
  assert.ok(g.decks.treasury.every((i) => TREASURY_CARDS[i].type.startsWith('macro')));
  const p = g.current();
  p.pos = 25; g.turn.phase = 'moving';
  g.moveBy(p, 5); // lands on Go to Lockup
  assert.strictEqual(p.inJail, false);
  assert.strictEqual(p.pos, 30);
  // doubles: force a pair and check there is no extra roll
  g.props[34].owner = p.id; // something harmless to land on
  p.pos = 30; g.turn = g.freshTurn(g.turn.idx);
  const die = g.die; g.die = () => 2;
  g.roll(p); g.die = die;
  assert.strictEqual(g.turn.phase, 'done');
});

test('round cap ends the game on net worth', () => {
  const g = newGame(2, { maxRounds: 3 });
  for (let guard = 0; g.status === 'playing' && guard < 100; guard++) {
    const p = g.current();
    if (g.turn.phase === 'buy') g.decline(p);
    if (g.auction) g.closeAuction();
    if (g.turn.phase === 'roll') g.roll(p);
    else if (g.turn.phase === 'done') { if (p.cash < 0) p.cash = 0; g.endTurn(p); }
  }
  assert.strictEqual(g.status, 'finished');
  assert.strictEqual(g.round, 3);
  assert.ok(g.winner);
});

test('risk-priced credit: steeper spread that re-prices every round with leverage', () => {
  const classic = newGame(2);
  const risk = newGame(2, { creditModel: 'riskPriced' });
  for (const g of [classic, risk]) g.borrow(g.players[0], 1000, 10, 'fixed');
  assert.ok(risk.players[0].loans[0].rate > classic.players[0].loans[0].rate);
  const l = risk.players[0].loans[0]; const before = l.rate;
  risk.players[0].cash -= 1500; // losses: equity falls, leverage rises
  risk.round = 2; risk.newRound();
  assert.ok(l.rate > before, 'spread re-priced up after losses');
  classic.players[0].cash -= 1500; const cBefore = classic.players[0].loans[0].rate;
  classic.round = 2; classic.newRound();
  assert.strictEqual(classic.players[0].loans[0].rate, cBefore, 'classic fixed loans keep their rate');
});

test('desk deals at the worse of mark and live price: stale-quote arbitrage does not pay', () => {
  const g = newGame(3);
  const [a, b] = g.players;
  const mark = g.desk.marks[b.id].price;
  b.cash += 2000; // b's equity jumps mid-round; the mark is stale
  const live = g.livePrice(b.id);
  assert.ok(live > mark);
  const c0 = a.cash;
  g.deskBuy(a, { product: 'shares', ref: b.id, shares: 20 });
  assert.strictEqual(c0 - a.cash, Math.ceil(live * 20 * 1.03), 'bought at the live (higher) price');
  // after the re-mark the position is worth less than it cost (spread), never a free profit
  g.markEquity();
  assert.ok(g.deskValue(a) < c0 - a.cash);
  // pump-and-dump inside a round doesn't pay either: selling uses the lower of mark and live
  b.cash -= 2000;
  const pos = g.desk.positions.find((x) => x.holder === a.id);
  const c1 = a.cash; g.deskClose(a, pos.id);
  assert.strictEqual(a.cash - c1, Math.floor(Math.min(g.desk.marks[b.id].price, g.livePrice(b.id)) * 20 * 0.97));
});

test('no CDS or puts on a player already in distress; swaps have no free carry and a total cap', () => {
  const g = newGame(3);
  const [a, b] = g.players;
  b.cash = -50;
  assert.throws(() => g.deskBuy(a, { product: 'cds', ref: b.id, notional: 500, term: 5 }), /distress/);
  assert.throws(() => g.deskBuy(a, { product: 'put', ref: b.id, shares: 10, strike: 10, term: 5 }), /distress/);
  b.cash = 1500;
  g.deskBuy(a, { product: 'cds', ref: b.id, notional: 500, term: 5 });
  // swap fixed legs straddle the expected policy path (curve minus term premium)
  for (const t of [5, 10, 20]) {
    const mid = g.swapMid(t);
    assert.ok(g.swapRate(t, 'receiveFixed') < mid && g.swapRate(t, 'payFixed') > mid);
  }
  g.econ.policyRate = 0; // zero floor: receive-fixed no longer earns the term premium for free
  assert.ok(g.swapRate(20, 'receiveFixed') <= g.curveRate(20) - 1.0);
  const lim = g.deskLimit(a);
  g.deskBuy(a, { product: 'swap', side: 'receiveFixed', notional: lim - 100, term: 20 });
  assert.throws(() => g.deskBuy(a, { product: 'swap', side: 'receiveFixed', notional: 200, term: 20 }), /capped/);
});

test('bots play skill-preset games to the round cap through the rules', () => {
  for (let seed = 1; seed <= 4; seed++) {
    let t = 0;
    const g = new Game('T', { rng: seeded(seed * 31), now: () => (t += 1000) });
    const ps = ['A', 'B', 'C', 'D'].map((n) => g.addPlayer(n));
    g.updateSettings(ps[0].id, { preset: 'skill', seed });
    g.start(ps[0].id);
    let drafted = null;
    for (let steps = 0; g.status === 'playing'; steps++) {
      assert.ok(steps < 100000, 'step limit');
      if (drafted === null && g.turn.phase !== 'draft') drafted = Object.values(g.props).filter((x) => x.owner).length;
      let acted = false;
      for (const p of g.players) {
        if (p.bankrupt) continue;
        const a = bot.decide(g, p.id);
        if (!a) continue;
        try { g.apply(p.id, a); } catch (e) { if (!(e instanceof GameError)) throw e; bot.markFailed(g, p.id, a); }
        acted = true; break;
      }
      if (!acted) { assert.ok(g.auction, 'nobody can act'); g.closeAuction(); }
    }
    assert.strictEqual(g.status, 'finished');
    assert.ok(g.round <= PRESETS.skill.maxRounds);
    assert.ok(drafted >= 20, `the draft distributed the board (${drafted} lots sold)`);
  }
});

// ------------------------------------------------------------------ distressed sales
function builtGame() {
  const g = newGame(3);
  const [a, b, c] = g.players;
  // a owns the full orange group with 2 houses each, then falls below $0
  for (const i of [16, 18, 19]) { g.props[i].owner = a.id; g.props[i].houses = 2; }
  g.bankHouses -= 6;
  g.props[5].owner = a.id; // a transit, no buildings
  a.cash = -300;
  return { g, a, b, c };
}

test('an underwater player can auction a built colour group as one package, buildings included', () => {
  const { g, a, b, c } = builtGame();
  assert.throws(() => g.liquidate(b, 5), /You do not own|below \$0/);
  g.liquidate(a, 18);
  const au = g.auction;
  assert.deepStrictEqual(au.lots.slice().sort((x, y) => x - y), [16, 18, 19]);
  assert.strictEqual(au.reserve, 6 * 50 + 90 + 90 + 100, 'reserve = half building cost + mortgage values');
  assert.ok(!au.active.includes(a.id), 'the seller cannot bid');
  assert.throws(() => g.bid(b, au.reserve - 1), /reserve/);
  assert.throws(() => g.liquidate(a, 5), /Another auction/);
  assert.throws(() => g.roll(g.current()), /auction/);
  g.bid(b, 1200); g.bid(c, 900);
  for (const i of [16, 18, 19]) { assert.strictEqual(g.props[i].owner, b.id); assert.strictEqual(g.props[i].houses, 2); }
  assert.strictEqual(a.cash, -300 + 900, 'seller receives the second-highest bid');
  assert.strictEqual(b.cash, 1500 - 900);
});

test('a distressed sale with no bid at the reserve leaves the property with the seller', () => {
  const { g, a, b, c } = builtGame();
  g.liquidate(a, 5);
  assert.deepStrictEqual(g.auction.lots, [5]);
  g.passAuction(b); g.passAuction(c);
  assert.strictEqual(g.props[5].owner, a.id);
  assert.strictEqual(g.auction, null);
});

test('distressed sales need a deficit or margin call, and can be switched off', () => {
  const g = newGame(3);
  const [a] = g.players;
  g.props[5].owner = a.id;
  assert.throws(() => g.liquidate(a, 5), /below \$0/);
  const off = newGame(3, { liquidation: 'bank' });
  off.props[5].owner = off.players[0].id; off.players[0].cash = -10;
  assert.throws(() => off.liquidate(off.players[0], 5), /off/);
});

test('a bankrupt estate is auctioned with buildings intact; unsold land returns to the bank', () => {
  const g = newGame(4);
  const [a, b, c, d] = g.players;
  for (const i of [16, 18, 19]) { g.props[i].owner = a.id; g.props[i].houses = 3; }
  g.bankHouses -= 9;
  g.props[5].owner = a.id;
  const houses0 = g.bankHouses;
  g.declareBankruptcy(a);
  assert.ok(g.auction && g.auction.kind === 'estate');
  const first = g.auction.lots;
  // land in the queue earns nobody rent and can't be bought by landing on it
  for (const i of [16, 18, 19, 5]) assert.strictEqual(g.props[i].owner, null);
  const cash0 = b.cash;
  if (first.length === 3) { g.bid(b, 800); g.bid(c, 500); g.passAuction(d); } else { g.passAuction(b); g.passAuction(c); g.passAuction(d); }
  const second = g.auction.lots;
  if (second.length === 3) { g.bid(b, 800); g.bid(c, 500); g.passAuction(d); } else { g.passAuction(b); g.passAuction(c); g.passAuction(d); }
  assert.strictEqual(g.auction, null);
  for (const i of [16, 18, 19]) { assert.strictEqual(g.props[i].owner, b.id); assert.strictEqual(g.props[i].houses, 3); }
  assert.strictEqual(b.cash, cash0 - 500, 'estate buyer pays the second-highest bid to the bank');
  assert.strictEqual(g.props[5].owner, null, 'unsold transit returns to the bank');
  assert.ok(!g.props[5].estate);
  assert.strictEqual(g.bankHouses, houses0, 'sold buildings stay on the board');
});

test('with distressed sales off, bankruptcy returns everything to the bank as before', () => {
  const g = newGame(3, { liquidation: 'bank' });
  const [a] = g.players;
  g.props[1].owner = a.id; g.props[3].owner = a.id; g.props[1].houses = 1; g.bankHouses--;
  g.declareBankruptcy(a);
  assert.strictEqual(g.auction, null);
  assert.strictEqual(g.props[1].owner, null);
  assert.strictEqual(g.bankHouses, 32);
});
