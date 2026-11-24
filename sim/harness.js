'use strict';
// Headless, ultra-fast simulation harness. Runs full games with AI agents through the real rules
// engine (game.apply), with no timers or sockets. Rule variants are applied by patching a Game
// instance, so src/ is untouched.
const { Game, GameError } = require('../src/engine');
const bot = require('../src/bot');
const { SPACES, OWNABLE } = require('../src/board');

function seeded(seed) {
  // mulberry32: better-distributed than an LCG for many short independent streams
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Telemetry: attribute every cash flow to a "luck" or "decision" bucket per player.
function instrument(g) {
  const T = {};
  const t = (pid) => (T[pid] ||= {
    cards: 0, rentIn: 0, rentOut: 0, salary: 0, tax: 0, bail: 0, desk: 0, contracts: 0,
    landUnowned: 0, bought: 0, auctionWon: 0, auctionSpend: 0, tradesDone: 0, firstSetRound: null,
    peakRentHit: 0, borrowed: 0, interest: 0, liquidated: 0, distressBuys: 0, distressSales: 0, distressProceeds: 0, estateBuys: 0,
  });
  g.tele = T;
  const pay = g.pay.bind(g);
  g.pay = (from, to, amount, reason, opts) => {
    const paid = pay(from, to, amount, reason, opts);
    if (!paid || !reason) return paid;
    const r = String(reason);
    const add = (pid, k, v) => { if (pid) t(pid)[k] += v; };
    if (r === 'card' || r === 'repairs' || r === 'fiscal stimulus') { add(to, 'cards', paid); add(from, 'cards', -paid); }
    else if (r.startsWith('rent on')) { add(to, 'rentIn', paid); add(from, 'rentOut', paid); if (from) t(from).peakRentHit = Math.max(t(from).peakRentHit, paid); }
    else if (r.startsWith('PAYDAY')) add(to, 'salary', paid);
    else if (r === 'Income Tax' || r === 'Wealth Tax') add(from, 'tax', paid);
    else if (r.includes('bail')) add(from, 'bail', paid);
    else if (r.startsWith('bank desk')) { add(to, 'desk', paid); add(from, 'desk', -paid); }
    else if (r.startsWith('interest on')) add(from, 'interest', paid);
    else if (r.includes(': ')) { add(to, 'contracts', paid); add(from, 'contracts', -paid); }
    else if (r.startsWith('won auction')) { add(from, 'auctionWon', 1); add(from, 'auctionSpend', paid); }
    else if (r.startsWith('won liquidation')) { add(from, 'distressBuys', 1); add(to, 'distressSales', 1); add(to, 'distressProceeds', paid); }
    else if (r.startsWith('won estate')) add(from, 'estateBuys', 1);
    else if (r.startsWith('bought ')) add(from, 'bought', 1);
    else if (r.startsWith('forced mortgage')) add(to, 'liquidated', 1);
    return paid;
  };
  const land = g.resolveLanding.bind(g);
  g.resolveLanding = (p, opts) => {
    const s = SPACES[p.pos];
    if (OWNABLE.has(s.type) && !g.props[p.pos].owner) t(p.id).landUnowned++;
    return land(p, opts);
  };
  const borrow = g.borrow.bind(g);
  g.borrow = (p, amount, term, kind) => { borrow(p, amount, term, kind); t(p.id).borrowed += Math.floor(Number(amount)); };
  const respond = g.respondTrade.bind(g);
  g.respondTrade = (p, id, accept) => {
    respond(p, id, accept);
    const tr = g.trades.find((x) => x.id === id);
    if (tr && tr.status === 'accepted') { t(tr.from).tradesDone++; t(tr.to).tradesDone++; }
  };
}

const SNAP_ROUNDS = [5, 10, 15, 20, 30, 40, 60];

function trackSets(g) {
  const { GROUP_MEMBERS } = require('../src/board');
  for (const p of g.active()) {
    const T = g.tele[p.id];
    if (T && T.firstSetRound === null && Object.keys(GROUP_MEMBERS).some((grp) => g.ownsGroup(p.id, grp))) T.firstSetRound = g.round;
  }
}

/**
 * Play one game.
 * @param {object} o
 *   seed, agents: [{name, decide}], variant: fn(g) patch, settings: {}, maxRounds
 */
function runGame(o) {
  let clock = 0;
  const g = new Game('SIM', { rng: seeded(o.seed), now: () => (clock += 1000) });
  const seats = o.agents.map((a, k) => ({ ...a, p: g.addPlayer(`${a.name}#${k}`) }));
  Object.assign(g.settings, o.settings || {});
  g.simMaxRounds = o.maxRounds || 100;
  if (o.variant && o.variant.pre) o.variant.pre(g);
  g.start(seats[0].p.id);
  instrument(g);
  if (o.variant && o.variant.post) o.variant.post(g);
  const byId = Object.fromEntries(seats.map((s) => [s.p.id, s]));
  const failures = {};
  const poll = seeded((o.seed ^ 0x9e3779b9) >>> 0);
  let steps = 0; let actions = 0; let lastRound = g.round; const snaps = {};
  const maxRounds = g.simMaxRounds;
  while (g.status === 'playing' && g.round <= maxRounds) {
    if (++steps > 400000) { g.simAborted = 'steps'; break; }
    if (g.round !== lastRound) {
      lastRound = g.round; trackSets(g);
      if (SNAP_ROUNDS.includes(g.round)) snaps[g.round] = Object.fromEntries(g.players.map((p) => [p.id, p.bankrupt ? 0 : g.netWorth(p)]));
    }
    let acted = false;
    // Poll players in a fresh random order each step (simultaneous play): a fixed order hands ties in
    // English auctions to whoever is asked last.
    const order = g.players.slice();
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(poll() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    for (const p of order) {
      if (p.bankrupt) continue;
      const s = byId[p.id];
      let a = null;
      try { a = s.decide(g, p.id); } catch (e) { if (!(e instanceof GameError)) throw e; }
      if (!a) continue;
      try { g.apply(p.id, a); failures[p.id] = 0; actions++; } catch (e) {
        if (!(e instanceof GameError)) throw e;
        bot.markFailed(g, p.id, a);
        if (s.markFailed) s.markFailed(g, p.id, a);
        failures[p.id] = (failures[p.id] || 0) + 1;
        if (failures[p.id] > 60) {
          // A stuck agent forfeits its turn action (counts as a blunder, never as a crash).
          if (g.current().id === p.id && g.turn.phase === 'done' && p.cash >= 0) { try { g.endTurn(p); } catch { g.declareBankruptcy(p, 'was stuck'); } }
          else if (g.current().id === p.id) g.declareBankruptcy(p, 'was stuck');
          else continue;
          failures[p.id] = 0;
        }
      }
      acted = true; break;
    }
    if (!acted) {
      if (g.auction) g.closeAuction();
      else if (g.status === 'playing') { g.simAborted = 'deadlock'; break; }
    }
  }
  trackSets(g);
  const nw = (p) => (p.bankrupt ? 0 : Math.max(0, g.netWorth(p)));
  const total = g.players.reduce((a, p) => a + nw(p), 0) || 1;
  const alive = g.active();
  const winner = alive.length === 1 ? alive[0] : alive.slice().sort((a, b) => g.netWorth(b) - g.netWorth(a))[0];
  const ranked = g.players.slice().sort((a, b) => (b.bankrupt ? -1 : g.netWorth(b)) - (a.bankrupt ? -1 : g.netWorth(a)));
  return {
    seed: o.seed,
    rounds: Math.min(g.round, maxRounds),
    finished: g.status === 'finished',
    aborted: g.simAborted || null,
    actions,
    econ: { policyRate: g.econ.policyRate, priceLevel: g.econ.priceLevel, bankLosses: g.econ.bankLosses },
    deskPnl: g.desk.pnl,
    players: seats.map((s) => {
      const p = s.p;
      return {
        agent: s.name, seat: g.players.indexOf(p), win: p === winner,
        rank: ranked.indexOf(p) + 1, bankrupt: p.bankrupt, nw: nw(p), share: nw(p) / total,
        tele: g.tele[p.id] || {},
        snaps: Object.fromEntries(Object.entries(snaps).map(([r, m]) => [r, m[p.id]])),
      };
    }),
  };
}

module.exports = { runGame, seeded, Game, GameError };
