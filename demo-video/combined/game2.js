'use strict';
// "You" vs 4 AI agents. Routine moves for You come from the shipped AI; four finance moves are scripted:
//  1. raise equity: sell `eqPct`% of yourself to an AI for upfront cash (the highest offer the AI signs)
//  2. at the hedge round, borrow floating and hedge it: a swap with an AI (with collateral) + a desk swap
//  3. once an AI looks shaky (desk default risk >= `hz`), buy a CDS and a put on it from the bank desk
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

function play(o) {
  const { seed, eqRound = 6, eqPct = 20, hedgeRound = 12, loan = 2000, notional = 1200, deskNotional = 800, cp = 'Hayek', TERM = 20,
    hz = 0.04, cdsNotional = 1000, putShares = 30, record = false, until = 80 } = o;
  let clock = 1_700_000_000_000;
  const g = new Game('DEMO', { rng: seeded(seed), now: () => clock });
  const me = g.addPlayer(NAMES[0]);
  for (let k = 1; k < NAMES.length; k++) g.addPlayer(NAMES[k], { bot: true });
  g.start(me.id);
  const byName = (n) => g.players.find((p) => p.name === n);
  const poll = seeded((seed ^ 0x9e3779b9) >>> 0);
  const frames = []; const fresh = [];
  const origLog = g.addLog.bind(g);
  g.addLog = (msg, kind) => { fresh.push({ msg, kind, round: g.round }); origLog(msg, kind); };
  const snap = (actor, action, tag) => {
    const f = { actor, action, tag, round: g.round, events: fresh.splice(0), rate: g.econ.policyRate, nw: Object.fromEntries(g.players.map((p) => [p.id, p.bankrupt ? 0 : Math.round(g.netWorth(p))])) };
    if (record) { g.version++; f.state = JSON.parse(JSON.stringify(g.serialize())); f.state.log = f.state.log.slice(-40); }
    frames.push(f);
  };
  snap(null, null);
  const info = {};
  const apply = (pid, a, tag) => { g.apply(pid, a); clock += 1500; snap(pid, a, tag); };
  const myTurnStart = () => g.current().id === me.id && g.turn.phase === 'roll' && !g.auction && me.cash >= 0 && !me.inJail;
  const proposeAccepted = (cpP, c, tagP, tagA) => {
    apply(me.id, { action: 'proposeContract', contract: c }, tagP);
    const cid = g.contracts[g.contracts.length - 1].id;
    apply(cpP.id, { action: 'acceptContract', id: cid }, tagA);
  };
  const signs = (cpP, c) => bot.evalContract(g, cpP, { ...c, parties: [me.id, cpP.id] });
  let steps = 0; const fails = {};
  while (g.status === 'playing' && g.round <= until) {
    if (++steps > 100000) break;
    if (myTurnStart()) {
      try {
        // 1. Raise equity
        if (!info.equity && g.round >= eqRound) {
          info.equity = { tried: true };
          let best = null;
          for (const n of NAMES.slice(1)) {
            const inv = byName(n); if (inv.bankrupt) continue;
            for (let up = 1500; up >= 100; up -= 25) {
              const c = { to: inv.id, name: 'Equity raise', term: 0, clauses: [{ kind: 'upfront', from: inv.id, to: me.id, amount: up }, { kind: 'equity', from: me.id, to: inv.id, pct: eqPct }] };
              if (signs(inv, c)) { if (!best || up > best.up) best = { inv, c, up }; break; }
            }
          }
          if (best) { proposeAccepted(best.inv, best.c, 'equity', 'equityAccept'); info.equity = { inv: best.inv.name, up: best.up, round: g.round }; }
          continue;
        }
        // 2. Borrow floating and hedge it
        if (!info.hedge && g.round >= hedgeRound) {
          info.hedge = { round: g.round, rate0: g.econ.policyRate };
          apply(me.id, { action: 'borrow', amount: loan, term: 20, kind: 'floating' }, 'borrow');
          const k = byName(cp);
          const kprops = g.ownedBy(k.id).filter((i) => !g.props[i].mortgaged && !(SPACES[i].group && g.groupHasBuildings(SPACES[i].group)) && !(SPACES[i].group && g.ownsGroup(k.id, SPACES[i].group)) && !g.encumbrances(i).length);
          const coll = kprops.length ? kprops.sort((a, b) => g.price(a) - g.price(b))[0] : null;
          const mk = (f) => ({ to: k.id, name: 'Rate hedge', term: TERM, clauses: [
            { kind: 'rate', from: me.id, to: k.id, notional, rateType: 'fixed', rate: f, spread: 0 },
            { kind: 'rate', from: k.id, to: me.id, notional, rateType: 'floating', rate: 0, spread: 0 },
            ...(coll != null ? [{ kind: 'collateral', from: k.id, to: me.id, spaces: [coll] }] : []),
          ] });
          let f = Math.round(g.econ.policyRate * 20) / 20; let c = null;
          for (; f < g.econ.policyRate + 3; f = Math.round((f + 0.05) * 100) / 100) if (signs(k, mk(f))) { c = mk(f); break; }
          if (!c) throw new Error('no swap');
          Object.assign(info.hedge, { fixed: f, coll, cp });
          proposeAccepted(k, c, 'propose', 'accept');
          apply(me.id, { action: 'deskBuy', order: { product: 'swap', side: 'payFixed', notional: deskNotional, term: 20 } }, 'desk');
          info.hedge.deskFixed = g.desk.positions.find((x) => x.holder === me.id && x.type === 'swap').fixed;
          continue;
        }
        // 3. Credit protection on the shakiest AI
        if (info.hedge && !info.credit) {
          const cands = g.active().filter((p) => p.id !== me.id && p.cash >= 0 && g.desk.marks[p.id] && g.desk.marks[p.id].price > 0).map((p) => ({ p, h: g.hazard(p.id) })).sort((a, b) => b.h - a.h);
          if (cands.length && cands[0].h >= hz) {
            const r = cands[0].p;
            info.credit = { ref: r.name, round: g.round, hazard: cands[0].h };
            apply(me.id, { action: 'deskBuy', order: { product: 'cds', ref: r.id, notional: Math.min(cdsNotional, g.deskLimit(me)), term: 10 } }, 'cds');
            apply(me.id, { action: 'deskBuy', order: { product: 'put', ref: r.id, shares: putShares, strike: g.desk.marks[r.id].price, term: 10 } }, 'put');
            const pos = g.desk.positions.filter((x) => x.holder === me.id && x.ref === r.id);
            Object.assign(info.credit, { cdsPremium: pos.find((x) => x.type === 'cds').premium, putPremium: pos.find((x) => x.type === 'put').premium, strike: pos.find((x) => x.type === 'put').strike });
            continue;
          }
        }
      } catch (e) { info.error = (info.error || '') + e.message + ';'; }
    }
    const order = g.players.slice();
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(poll() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    let acted = false;
    for (const p of order) {
      if (p.bankrupt) continue;
      let a = null;
      try { a = bot.decide(g, p.id); } catch { /* ignore */ }
      if (!a) continue;
      // Keep the scripted book: no early repayment or closing of desk positions by autopilot.
      if (p.id === me.id && info.hedge && ['repay', 'deskClose'].includes(a.action)) { bot.markFailed(g, p.id, a); acted = true; break; }
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
