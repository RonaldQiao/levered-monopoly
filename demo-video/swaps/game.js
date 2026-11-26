'use strict';
// Seeded game with one scripted human ("You") and four AI agents. Routine moves for "You" come from the
// shipped AI; at the hedge point the script borrows floating, signs a swap with Keynes and buys a desk swap.
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { Game, GameError } = require(`${REPO}/src/engine`);
const bot = require(`${REPO}/src/bot`);
const { SPACES } = require(`${REPO}/src/board`);

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NAMES = ['You', 'Keynes', 'Minsky', 'Volcker', 'Hayek'];

function play({ TERM = 15, seed, hedgeRound = 14, loan = 1200, notional = 800, deskNotional = 400, record = false, until = 60, collateral = true, script = true }) {
  let clock = 1_700_000_000_000;
  const g = new Game('DEMO', { rng: seeded(seed), now: () => clock });
  const me = g.addPlayer(NAMES[0]);
  for (let k = 1; k < NAMES.length; k++) g.addPlayer(NAMES[k], { bot: true });
  g.start(me.id);
  const keynes = g.players.find((p) => p.name === 'Keynes');
  const poll = seeded((seed ^ 0x9e3779b9) >>> 0);
  const frames = []; const fresh = [];
  const origLog = g.addLog.bind(g);
  g.addLog = (msg, kind) => { fresh.push({ msg, kind, round: g.round }); origLog(msg, kind); };
  const snap = (actor, action, tag) => {
    const f = { actor, action, tag, round: g.round, events: fresh.splice(0), rate: g.econ.policyRate };
    if (record) { g.version++; f.state = JSON.parse(JSON.stringify(g.serialize())); f.state.log = f.state.log.slice(-40); }
    frames.push(f);
  };
  snap(null, null);
  const info = { hedged: false };
  const apply = (pid, a, tag) => { g.apply(pid, a); clock += 1500; snap(pid, a, tag); };
  let steps = 0; const fails = {};
  while (g.status === 'playing' && g.round <= until) {
    if (++steps > 100000) break;
    // Scripted hedge at the start of "You"'s turn in the hedge round.
    if (script && !info.hedged && g.round >= hedgeRound && g.current().id === me.id && g.turn.phase === 'roll' && !g.auction && me.cash >= 0) {
      info.hedged = true; info.round = g.round; info.rate0 = g.econ.policyRate;
      try {
        apply(me.id, { action: 'borrow', amount: loan, term: 20, kind: 'floating' }, 'borrow');
        // Find the lowest fixed rate (0.05 steps) Keynes's AI will sign.
        const kprops = g.ownedBy(keynes.id).filter((i) => !g.props[i].mortgaged && !(SPACES[i].group && g.groupHasBuildings(SPACES[i].group)) && !(SPACES[i].group && g.ownsGroup(keynes.id, SPACES[i].group)));
        const coll = collateral && kprops.length ? kprops.sort((a, b) => g.price(a) - g.price(b))[0] : null;
        const mk = (f) => ({ to: keynes.id, name: 'Rate hedge', term: TERM, clauses: [
          { kind: 'rate', from: me.id, to: keynes.id, notional, rateType: 'fixed', rate: f, spread: 0 },
          { kind: 'rate', from: keynes.id, to: me.id, notional, rateType: 'floating', rate: 0, spread: 0 },
          ...(coll != null ? [{ kind: 'collateral', from: keynes.id, to: me.id, spaces: [coll] }] : []),
        ] });
        let f = Math.round(g.econ.policyRate * 20) / 20; let c = null;
        for (; f < g.econ.policyRate + 3; f = Math.round((f + 0.05) * 100) / 100) {
          const trial = { ...mk(f), parties: [me.id, keynes.id], clauses: mk(f).clauses };
          if (bot.evalContract(g, keynes, trial)) { c = mk(f); break; }
        }
        info.fixed = f; info.coll = coll;
        if (!c) throw new Error('no acceptable swap');
        apply(me.id, { action: 'proposeContract', contract: c }, 'propose');
        const cid = g.contracts[g.contracts.length - 1].id;
        apply(keynes.id, { action: 'acceptContract', id: cid }, 'accept');
        info.contract = g.contracts.find((x) => x.id === cid);
        apply(me.id, { action: 'deskBuy', order: { product: 'swap', side: 'payFixed', notional: deskNotional, term: 20 } }, 'desk');
        info.deskFixed = g.desk.positions.find((x) => x.holder === me.id && x.type === 'swap').fixed;
      } catch (e) { info.error = e.message; }
      continue;
    }
    const order = g.players.slice();
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(poll() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    let acted = false;
    for (const p of order) {
      if (p.bankrupt) continue;
      let a = null;
      try { a = bot.decide(g, p.id); } catch { /* ignore */ }
      if (!a) continue;
      // "You" keeps the hedge book: don't let autopilot repay the demo loan early or close swaps.
      if (p.id === me.id && info.hedged && ['repay', 'deskClose'].includes(a.action)) { bot.markFailed(g, p.id, a); acted = true; break; }
      try { g.apply(p.id, a); fails[p.id] = 0; } catch (e) {
        if (!(e instanceof GameError)) throw e;
        bot.markFailed(g, p.id, a); fails[p.id] = (fails[p.id] || 0) + 1; if (fails[p.id] > 60) continue; acted = true; break;
      }
      clock += a.action === 'bid' || a.action === 'passAuction' ? 700 : 1500;
      snap(p.id, a); acted = true; break;
    }
    if (!acted) { if (g.auction) { clock = Math.max(clock, g.auction.deadline + 1); g.closeAuction(); snap(null, { action: 'closeAuction' }); } else break; }
  }
  return { g, frames, info, me };
}
module.exports = { play, NAMES };
