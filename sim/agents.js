'use strict';
// Agents for simulation. Every agent returns ONE action message (same shape the browser sends) or null.
// "pro" is the shipped AI (src/bot.js). The other agents are either weaker baselines or pro with ONE
// skill switched on/off, so a rule set's ability to reveal that skill can be measured in isolation.
const bot = require('../src/bot');
const { SPACES, GROUP_MEMBERS } = require('../src/board');

// ------------------------------------------------------------------ baselines
// A sensible casual human: buys what it can afford, bids up to list price, builds with spare cash,
// never trades, never borrows, never touches the desk or contracts.
function casual(g, pid) {
  const me = g.player(pid);
  if (g.auction && g.auction.active.includes(pid)) {
    const a = g.auction;
    if (a.sealed) { const b = Math.min(g.price(a.space), me.cash - g.scale(250)); return b >= 1 ? { action: 'bid', amount: b } : { action: 'passAuction' }; }
    if (a.highBidder === pid) return null;
    const price = g.price(a.space); const next = a.highBid + Math.max(5, Math.round(price * 0.05));
    return next <= price && me.cash - next > g.scale(250) ? { action: 'bid', amount: next } : { action: 'passAuction' };
  }
  const t = g.trades.find((x) => x.status === 'pending' && x.to === pid);
  if (t) return { action: 'rejectTrade', id: t.id };
  const c = g.contracts.find((x) => x.status === 'proposed' && x.parties[1] === pid);
  if (c) return { action: 'rejectContract', id: c.id };
  const myTurn = g.current().id === pid;
  if (me.cash < 0) {
    const built = g.ownedBy(pid).find((i) => g.props[i].houses > 0 && g.props[i].houses >= Math.max(...GROUP_MEMBERS[SPACES[i].group].map((j) => g.props[j].houses)));
    if (built !== undefined) return { action: 'sell', space: built };
    const m = g.ownedBy(pid).find((i) => !g.props[i].mortgaged && !(SPACES[i].group && g.groupHasBuildings(SPACES[i].group)));
    if (m !== undefined) return { action: 'mortgage', space: m };
    const d = g.desk.positions.find((x) => x.holder === pid);
    if (d) return { action: 'deskClose', id: d.id };
    return myTurn ? { action: 'bankrupt' } : null;
  }
  if (!myTurn) return null;
  const ph = g.turn.phase;
  if (ph === 'buy') return me.cash - g.price(g.turn.pendingBuy) >= g.scale(100) ? { action: 'buy' } : { action: 'decline' };
  if (ph === 'roll' || ph === 'done') {
    if (me.inJail && ph === 'roll' && me.cash > 400 && me.jailCards.length) return { action: 'useJailCard' };
    for (const [grp, members] of Object.entries(GROUP_MEMBERS)) {
      if (!g.ownsGroup(pid, grp)) continue;
      const mm = members.find((j) => g.props[j].mortgaged);
      if (mm !== undefined) { if (me.cash - g.props[mm].mortgageAmt * 1.1 > 300) return { action: 'unmortgage', space: mm }; continue; }
      const minH = Math.min(...members.map((j) => g.props[j].houses));
      if (minH >= 5) continue;
      const j = members.find((x) => g.props[x].houses === minH);
      if (me.cash - g.houseCost(j) > g.scale(300) && (minH === 4 ? g.bankHotels : g.bankHouses) > 0) return { action: 'build', space: j };
    }
    return { action: ph === 'roll' ? 'roll' : 'endTurn' };
  }
  return null;
}

// A noise trader: legal but uninformed choices.
function makeRandom(seed = 1) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  return function random(g, pid) {
    const me = g.player(pid);
    if (g.auction && g.auction.active.includes(pid)) {
      const a = g.auction;
      if (a.sealed) { const b = Math.floor(Math.min(me.cash - 50, g.price(a.space) * (0.3 + r()))); return r() < 0.6 && b >= 1 ? { action: 'bid', amount: b } : { action: 'passAuction' }; }
      if (a.highBidder === pid) return null;
      const bid = a.highBid + 10;
      return r() < 0.5 && bid < me.cash - 50 ? { action: 'bid', amount: bid } : { action: 'passAuction' };
    }
    const t = g.trades.find((x) => x.status === 'pending' && x.to === pid);
    if (t) return { action: r() < 0.5 ? 'acceptTrade' : 'rejectTrade', id: t.id };
    const c = g.contracts.find((x) => x.status === 'proposed' && x.parties[1] === pid);
    if (c) return { action: 'rejectContract', id: c.id };
    const base = casual(g, pid);
    if (!base) return null;
    if (base.action === 'buy' && r() < 0.4) return { action: 'decline' };
    if (base.action === 'build' && r() < 0.5) return { action: g.turn.phase === 'roll' ? 'roll' : 'endTurn' };
    return base;
  };
}

// ------------------------------------------------------------------ pro variants
// Wraps pro: actions matching `forbid` are refused (marked failed so pro picks its next choice);
// `pre` can inject actions before pro decides; `override` can replace specific responses.
function wrapPro({ forbid, pre, override } = {}) {
  return function decide(g, pid) {
    if (pre) { const a = pre(g, pid); if (a) return a; }
    for (let k = 0; k < 12; k++) {
      let a = bot.decide(g, pid);
      if (a && override) a = override(g, pid, a) || a;
      if (!a || !forbid || !forbid(a, g, pid)) return a;
      bot.markFailed(g, pid, a);
    }
    return null;
  };
}

const isTrade = (a) => a.action === 'proposeTrade';
const isBorrow = (a) => a.action === 'borrow';
const isDesk = (a) => a.action === 'deskBuy';

const variants = {
  pro: bot.decide,
  casual,
  random: makeRandom(7),
  // negotiation off: never proposes and refuses every trade
  pro_noTrade: wrapPro({ forbid: isTrade, override: (g, pid, a) => (a.action === 'acceptTrade' ? { action: 'rejectTrade', id: a.id } : null) }),
  // negotiation exploitable: accepts every trade offered
  pro_sucker: wrapPro({ override: (g, pid, a) => (a.action === 'rejectTrade' ? { action: 'acceptTrade', id: a.id } : null) }),
  // leverage off
  pro_noLev: wrapPro({ forbid: isBorrow }),
  // desk off
  pro_noDesk: wrapPro({ forbid: isDesk }),
  // reckless leverage: borrows to the cap the moment it can, then lets pro deploy the cash
  pro_reckless: wrapPro({
    pre: (g, pid) => {
      const me = g.player(pid); const m = (g.simMem ||= {})[pid] ||= {};
      if (g.current().id !== pid || g.turn.phase !== 'roll' || m.r === g.round) return null;
      m.r = g.round;
      const room = g.borrowHeadroom(me);
      return room >= 50 ? { action: 'borrow', amount: room, term: 20, kind: 'floating' } : null;
    },
  }),
  // poor valuation: in auctions bids to 1.6x list on anything, ignoring set value
  pro_overbid: wrapPro({
    pre: (g, pid) => {
      const a = g.auction; if (!a || !a.active.includes(pid) || a.highBidder === pid) return null;
      const me = g.player(pid); const cap = Math.min(me.cash - 50, Math.round(g.price(a.space) * 1.6));
      if (a.sealed) return cap >= 1 ? { action: 'bid', amount: cap } : { action: 'passAuction' };
      const next = a.highBid + Math.max(5, Math.round(g.price(a.space) * 0.05));
      return next <= cap ? { action: 'bid', amount: next } : { action: 'passAuction' };
    },
  }),
};

module.exports = { variants, casual, makeRandom, wrapPro };

// desk sub-ablations (diagnose which desk habit costs the shipped AI)
variants.pro_noInsure = wrapPro({ forbid: (a) => a.action === 'deskBuy' && a.order && a.order.product === 'insurance' });
variants.pro_noShares = wrapPro({ forbid: (a) => a.action === 'deskBuy' && a.order && a.order.product === 'shares' });
