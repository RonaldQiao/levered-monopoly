'use strict';
// Play one all-AI game through the real engine + shipped bot, optionally recording every state.
const REPO = require('path').join(__dirname, '..');
const { Game, GameError } = require(`${REPO}/src/engine`);
const bot = require(`${REPO}/src/bot`);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Keynes', 'Minsky', 'Volcker', 'Hayek', 'Friedman'];

function play({ seed, n = 5, settings = {}, record = false, maxActions = 3000 }) {
  let clock = 1_700_000_000_000;
  const g = new Game('DEMO', { rng: seeded(seed), now: () => clock });
  const host = g.addPlayer(NAMES[0], { bot: true });
  host.host = true;
  for (let k = 1; k < n; k++) g.addPlayer(NAMES[k], { bot: true });
  Object.assign(g.settings, settings);
  g.start(host.id);
  const poll = seeded((seed ^ 0x9e3779b9) >>> 0);
  const frames = [];
  const fails = {};
  let logSeen = g.log.length; let logTotal = g.log.length;
  const origLog = g.addLog.bind(g);
  const fresh = [];
  g.addLog = (msg, kind) => { fresh.push({ msg, kind, round: g.round }); origLog(msg, kind); };
  const snap = (actor, action) => {
    const f = { actor, action, round: g.round, events: fresh.splice(0), nw: Object.fromEntries(g.players.map((p) => [p.id, p.bankrupt ? 0 : Math.round(g.netWorth(p))])), rate: g.econ.policyRate };
    if (record) { g.version++; f.state = JSON.parse(JSON.stringify(g.serialize())); f.state.log = f.state.log.slice(-40); }
    frames.push(f);
  };
  snap(null, null);
  let steps = 0;
  while (g.status === 'playing' && frames.length < maxActions) {
    if (++steps > 200000) break;
    const order = g.players.slice();
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(poll() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    let acted = false;
    for (const p of order) {
      if (p.bankrupt) continue;
      let a = null;
      try { a = bot.decide(g, p.id); } catch (e) { /* ignore */ }
      if (!a) continue;
      try { g.apply(p.id, a); fails[p.id] = 0; } catch (e) {
        if (!(e instanceof GameError)) throw e;
        bot.markFailed(g, p.id, a);
        fails[p.id] = (fails[p.id] || 0) + 1;
        if (fails[p.id] > 60) continue;
        acted = true; break;
      }
      clock += a.action === 'bid' || a.action === 'passAuction' ? 700 : 1500;
      snap(p.id, a);
      acted = true; break;
    }
    if (!acted) {
      if (g.auction) { clock = Math.max(clock, g.auction.deadline + 1); g.closeAuction(); snap(null, { action: 'closeAuction' }); }
      else break;
    }
  }
  return { g, frames };
}

module.exports = { play, NAMES };
