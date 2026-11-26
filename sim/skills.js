'use strict';
// Skill-specialist agents: pro + ONE trading skill. Used to test which skills the rules reward.
const bot = require('../src/bot');
const { wrapPro } = require('./agents');
const { SPACES } = require('../src/board');

const mem = (g, pid) => ((g.simMem ||= {})[pid] ||= {});
const mine = (g, pid, type) => g.desk.positions.filter((x) => x.holder === pid && (!type || x.type === type));
const rivals = (g, pid) => g.active().filter((p) => p.id !== pid);

// Cash a player could still raise before going bankrupt (mortgages, half-price building sales,
// desk positions at bid, fresh bank borrowing).
function liquidity(g, p) {
  let v = p.cash;
  for (const i of g.ownedBy(p.id)) {
    const pr = g.props[i];
    if (pr.houses) v += Math.round(g.houseCost(i) / 2) * (pr.houses === 5 ? 5 : pr.houses);
    if (!pr.mortgaged) v += g.mortgageValue(i);
  }
  v += g.deskValue(p);
  v += g.borrowHeadroom(p);
  return v;
}

// ---- credit: buys CDS + ATM puts on a rival whose bankruptcy is now certain
function distressPre(g, pid) {
  const me = g.player(pid); const m = mem(g, pid);
  for (const r of rivals(g, pid)) {
    if (r.cash >= 0 || liquidity(g, r) >= 0) continue;
    const k = `${r.id}-${g.round}`;
    if (!m[`cds${k}`]) {
      m[`cds${k}`] = 1;
      const notional = g.deskLimit(me);
      const prem = Math.round(notional * g.hazard(r.id) * 1.3);
      if (prem < me.cash && mine(g, pid).length < 12) return { action: 'deskBuy', order: { product: 'cds', ref: r.id, notional, term: 5 } };
    }
    const mark = g.desk.marks[r.id].price;
    if (!m[`put${k}`] && mark > 0) {
      m[`put${k}`] = 1;
      return { action: 'deskBuy', order: { product: 'put', ref: r.id, shares: 50, strike: mark, term: 5 } };
    }
  }
  return null;
}

// ---- rates: receive-fixed carry when the curve is steep and the economy is not overheating.
// (The 20-round fixed leg is anchored to neutral + target, so it pays well above a low policy rate.)
function carryPre(g, pid) {
  const me = g.player(pid); const m = mem(g, pid);
  const swaps = mine(g, pid, 'swap');
  const e = g.econ;
  const hot = e.heat > 66 || e.inflation > 1.3;
  if (hot && swaps.length) return { action: 'deskClose', id: swaps[0].id };
  if (m.r === g.round) return null;
  m.r = g.round;
  if (hot || mine(g, pid).length >= 12 || me.cash < 0) return null;
  const carry = g.swapRate(20, 'receiveFixed') - e.policyRate;
  if (carry > 0.5 && swaps.length < (m.maxSwaps || 6)) return { action: 'deskBuy', order: { product: 'swap', side: 'receiveFixed', notional: g.deskLimit(me), term: 20 } };
  return null;
}

// ---- information: trades desk shares against the once-a-round stale mark
function stalePre(g, pid) {
  const me = g.player(pid); const m = mem(g, pid);
  m.stale ||= {};
  // realise positions once the mark has caught up (next round)
  const held = mine(g, pid, 'shares').find((x) => m.stale[x.ref] !== undefined && m.stale[x.ref] < g.round);
  if (held) { delete m.stale[held.ref]; return { action: 'deskClose', id: held.id }; }
  for (const r of rivals(g, pid)) {
    const mark = g.desk.marks[r.id].price; const live = g.livePrice(r.id);
    if (mark <= 0 || live < mark * 1.1 || m.stale[r.id] !== undefined) continue;
    const have = mine(g, pid, 'shares').filter((x) => x.ref === r.id).reduce((a, x) => a + x.shares, 0);
    const n = Math.min(50 - have, Math.floor((me.cash - 150) / (mark * 1.03)));
    if (n >= 5 && mine(g, pid).length < 12) { m.stale[r.id] = g.round; return { action: 'deskBuy', order: { product: 'shares', ref: r.id, shares: n } }; }
  }
  return null;
}

// ---- valuation under a budget: in an opening draft, bid to set value but keep cash to build with
function makeDrafter({ keyMult = 1.6, mult = 1.0, keep = 0.3 } = {}) {
  return (g, pid) => {
    const a = g.auction;
    if (!a || !a.active.includes(pid) || a.highBidder === pid || !(g.draftQueue && g.round === 1)) return null;
    if (a.sealed) {
      const me = g.player(pid); const price = g.price(a.space); const key = bot.worth(g, pid, a.space) >= 1.8 * price;
      const cap = Math.floor(Math.min(price * (key ? keyMult : mult), me.cash - keep * g.settings.startingCash));
      return cap >= 1 ? { action: 'bid', amount: cap } : { action: 'passAuction' };
    }
    const me = g.player(pid); const i = a.space; const price = g.price(i);
    const w = bot.worth(g, pid, i);
    const key = w >= 1.8 * price;
    const cap = Math.floor(Math.min(price * (key ? keyMult : mult), me.cash - keep * g.settings.startingCash));
    const next = a.highBid === 0 ? Math.max(1, Math.min(cap, Math.round(price * 0.5))) : a.highBid + Math.max(5, Math.round(price * 0.05));
    return next <= cap ? { action: 'bid', amount: next } : { action: 'passAuction' };
  };
}

const draftPre = makeDrafter();
const agents = {
  pro_draft: wrapPro({ pre: makeDrafter() }),
  pro_draftLoose: wrapPro({ pre: makeDrafter({ keyMult: 2.2, mult: 1.2, keep: 0.1 }) }),
  pro_draftTight: wrapPro({ pre: makeDrafter({ keyMult: 1.3, mult: 0.8, keep: 0.45 }) }),
  pro_distress: wrapPro({ pre: distressPre }),
  pro_carry: wrapPro({ pre: carryPre }),
  pro_stale: wrapPro({ pre: stalePre }),
  pro_quant: wrapPro({ pre: (g, pid) => draftPre(g, pid) || distressPre(g, pid) || stalePre(g, pid) || carryPre(g, pid) }),
};

module.exports = { agents, liquidity, makeDrafter };
void bot; void SPACES;
