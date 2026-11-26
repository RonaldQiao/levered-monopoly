'use strict';
// AI players. decide(game, botId) returns ONE action message (same shape a browser sends) or null.
// The bot reads the public game state and only acts through game.apply(), so it plays by exactly
// the same rules as humans.
//
// Strategy summary:
// - Values property by its role in colour groups (completing / blocking / building toward a set),
//   transit synergy, and steady-state landing frequencies.
// - Keeps a cash reserve sized to the rents it might hit in the next roll and the worst rent on the board.
// - Builds where rent-per-dollar is highest, prefers the 3rd house, holds at 4 houses when the bank
//   is short (house shortage), and borrows from the central bank when building ROI beats the loan rate.
// - Bids to its valuation in auctions, haggles for monopoly-completing trades, refuses lopsided deals.
// - Values player contracts by discounted expected cash flows and counterparty risk.
// - Uses the bank desk for rent insurance when one bad roll could ruin it. (It no longer parks idle cash
//   in the leader's shares: simulation showed that habit roughly halved its results — see sim/REPORT.md.)
// - In sealed-bid auctions (and the opening draft) it bids its valuation once.
// - Sizes leverage to the cost of credit: next round's interest bill is part of its cash reserve, and it
//   borrows to build only when the building's return clears the loan rate by `roiMultiple`.
const { SPACES, GROUP_MEMBERS, TRANSITS, UTILITIES, LAND } = require('./board');

// Tunables (exported so the simulator can tune them).
const params = {
  targetLeverage: 2.3,  // max assets/equity it will borrow up to
  roiMultiple: 2,       // borrow to build only if building ROI > roiMultiple x loan rate
  interestReserve: 0,   // rounds of interest to hold in reserve (0 tested best in sim/tune.js)
  investInLeader: false,
  dividendInvest: true, // park idle cash in the rival stock paying the most dividend per dollar
  divHurdle: 1.5,       // ... only if that yield beats divHurdle x the policy rate (per round)
  divCashMult: 5,       // ... and only with more than divCashMult x its cash reserve on hand (sim: neutral vs not investing)
  draftMode: 'budget',  // 'budget' (below) or 'value' (bid like any auction)
  draftMult: 0.8,       // opening draft: max multiple of list price for any other lot (tuned: sim/tuneDraft.js)
  draftKeyMult: 1.6,    // opening draft: max multiple of list price for a set-completing/blocking lot
  draftKeep: 0.15,      // opening draft: share of starting cash kept back for building
};


const memo = (g, pid) => {
  g.botMem ||= {};
  return (g.botMem[pid] ||= { turnKey: '', failed: new Set(), done: {}, offers: {}, lastPropose: -9 });
};
const key = (a) => JSON.stringify(a);

// ------------------------------------------------------------------ valuation helpers
function opponents(g, pid) { return g.active().filter((p) => p.id !== pid); }

function groupInfo(g, pid, i) {
  const members = GROUP_MEMBERS[SPACES[i].group];
  const mine = members.filter((j) => g.props[j].owner === pid).length;
  const theirs = members.filter((j) => g.props[j].owner && g.props[j].owner !== pid);
  return { members, mine, theirs, theirOwners: new Set(theirs.map((j) => g.props[j].owner)) };
}

// What property i is worth to player pid (in $), beyond its sticker price.
function worth(g, pid, i) {
  const s = SPACES[i]; const price = g.price(i);
  if (s.type === 'street') {
    const { members, mine, theirs, theirOwners } = groupInfo(g, pid, i);
    const owned = g.props[i].owner === pid;
    const mineWithout = owned ? mine - 1 : mine;
    if (mineWithout === members.length - 1) return price * 3.0;                                   // completes my set
    if (theirs.length === members.length - 1 && theirOwners.size === 1 && !owned) return price * 2.2; // blocks a set
    if (theirs.filter((j) => j !== i).length === 0) return price * (1.15 + 0.35 * mineWithout);    // building toward one
    return price * 0.9;
  }
  if (s.type === 'transit') {
    const n = TRANSITS.filter((j) => j !== i && g.props[j].owner === pid).length;
    return price * (1.0 + 0.3 * n);
  }
  return price * 0.75;
}

function rentIfLand(g, pid, i) {
  const s = SPACES[i];
  if (s.type === 'tax') return g.taxAmount(i);
  const pr = g.props[i];
  if (!pr || !pr.owner || pr.owner === pid || pr.mortgaged) return 0;
  return g.rentFor(i, 7);
}

// Cash the bot wants to keep on hand.
function reserve(g, me) {
  let exp = 0; let worst = 0;
  for (let d = 2; d <= 12; d++) {
    const pd = (6 - Math.abs(d - 7)) / 36;
    const r = rentIfLand(g, me.id, (me.pos + d) % 40);
    exp += pd * r; worst = Math.max(worst, r);
  }
  const boardMax = g.maxOpponentRent(me.id);
  const insured = g.desk.positions.some((x) => x.holder === me.id && x.type === 'insurance');
  const tail = insured ? 0.12 : 0.25;
  const interest = me.loans.reduce((a, l) => a + (l.principal * l.rate) / 100, 0) * params.interestReserve;
  return Math.round(Math.max(g.scale(100), exp * 2, worst * (insured ? 0.3 : 0.6), boardMax * tail) + interest);
}

// Strategic value of an ownership map for one player (used for trades).
function stratValue(g, pid, owner) {
  let v = 0;
  for (const members of Object.values(GROUP_MEMBERS)) {
    const mine = members.filter((j) => owner[j] === pid);
    if (!mine.length) continue;
    const full = mine.length === members.length;
    const contested = members.some((j) => owner[j] && owner[j] !== pid);
    for (const j of mine) {
      const base = g.price(j) - (g.props[j].mortgaged ? g.props[j].mortgageAmt * 1.1 : 0);
      v += base * (full ? 2.6 : contested ? 0.95 : 1 + 0.25 * (mine.length - 1));
      v += g.props[j].houses * g.houseCost(j) * 0.5;
    }
  }
  const t = TRANSITS.filter((j) => owner[j] === pid).length;
  v += t * g.scale(200) * (1 + 0.25 * (t - 1));
  v += UTILITIES.filter((j) => owner[j] === pid).length * g.scale(150) * 0.8;
  return v;
}

function ownerMap(g) { return Object.fromEntries(Object.keys(g.props).map((i) => [i, g.props[i].owner])); }

function expectedRentIncome(g, pid, spaces) {
  const n = opponents(g, pid).length;
  return spaces.reduce((a, i) => a + LAND[i] * g.rentFor(i, 7) * n, 0);
}

function bestLoan(g, me, amount) {
  // Floating is cheaper today; lock a fixed rate when the economy is running hot (rates likely to rise).
  const kind = g.econ.heat > 62 || g.econ.inflation > 1.2 ? 'fixed' : 'floating';
  return { action: 'borrow', amount: Math.max(10, Math.round(amount)), term: 10, kind };
}
const targetLeverage = (g) => Math.min(g.settings.maxLeverage, params.targetLeverage);

// ------------------------------------------------------------------ building
function buildCandidates(g, me) {
  const out = [];
  const n = opponents(g, me.id).length;
  for (const [grp, members] of Object.entries(GROUP_MEMBERS)) {
    if (!g.ownsGroup(me.id, grp) || members.some((j) => g.props[j].mortgaged)) continue;
    const minH = Math.min(...members.map((j) => g.props[j].houses));
    if (minH >= 5) continue;
    if (minH === 4 && (g.bankHotels < 1 || g.bankHouses < 10)) continue; // hold at 4 houses: starve the house supply
    if (minH < 4 && g.bankHouses < 1) continue;
    const target = members.filter((j) => g.props[j].houses === minH).sort((a, b) => SPACES[b].rent[minH + 1] - SPACES[a].rent[minH + 1])[0];
    const cost = g.houseCost(target);
    const dRent = g.scale(SPACES[target].rent[minH + 1]) - g.rentFor(target, 7);
    out.push({ space: target, cost, roi: (LAND[target] * n * dRent) / cost, houses: minH });
  }
  return out.sort((a, b) => b.roi - a.roi);
}

// ------------------------------------------------------------------ decisions
function buyMove(g, me, m) {
  const i = g.turn.pendingBuy; const price = g.price(i); const w = worth(g, me.id, i);
  const res = reserve(g, me);
  if (me.cash - price >= res * 0.6) return { action: 'buy' };
  if (w >= 1.8 * price) {
    if (me.cash >= price) return { action: 'buy' };
    const need = price - me.cash + res * 0.3;
    if (!m.done.borrowBuy && g.borrowHeadroom(me) >= need && g.leverage(me) < targetLeverage(g)) { m.done.borrowBuy = true; return bestLoan(g, me, need); }
  }
  if (me.cash >= price && w >= 1.1 * price && me.cash - price >= res * 0.3) return { action: 'buy' };
  return { action: 'decline' };
}

// What a package of lots (possibly a whole built colour group) is worth to pid: the change in strategic
// value from owning it, with buildings at 90% of their cost when the package completes a set.
function packageValue(g, pid, lots) {
  const before = ownerMap(g); const after = { ...before };
  for (const i of lots) after[i] = pid;
  let v = stratValue(g, pid, after) - stratValue(g, pid, before);
  for (const i of lots) if (g.props[i].houses) v += g.props[i].houses * g.houseCost(i) * 0.4; // stratValue counts 0.5
  return v;
}

function auctionCap(g, me, i) {
  const a = g.auction;
  if (a && (a.kind === 'liquidation' || a.kind === 'estate')) {
    const res = reserve(g, me);
    return Math.floor(Math.min(packageValue(g, me.id, a.lots), me.cash - res * 0.3));
  }
  const price = g.price(i); const w = worth(g, me.id, i);
  const key = w >= 1.8 * price;
  if (g.auction && g.auction.draft && params.draftMode === 'budget') {
    // Opening draft: the whole board is for sale at once, so spend to a budget. Pay up to 1.6x list for a
    // lot that completes or blocks a set, 0.8x list otherwise, and keep 15% of the starting cash to build with.
    return Math.floor(Math.min(price * (key ? params.draftKeyMult : params.draftMult), me.cash - params.draftKeep * g.scale(g.settings.startingCash)));
  }
  const res = reserve(g, me);
  return Math.floor(Math.min(key ? w : Math.min(w, price * 1.05), me.cash - (key ? res * 0.15 : res * 0.5)));
}

function auctionMove(g, me) {
  const a = g.auction;
  if (a.sealed) {
    // Second-price sealed bid: bidding the true valuation is optimal. Only our own bid is ever read.
    const cap = auctionCap(g, me, a.space);
    return cap >= Math.max(1, a.reserve || 1) ? { action: 'bid', amount: cap } : { action: 'passAuction' };
  }
  if (a.highBidder === me.id) return null;
  const i = a.space; const price = g.price(i);
  const cap = auctionCap(g, me, i);
  const inc = Math.max(5, Math.round(price * 0.05));
  const next = a.highBid === 0 ? Math.max(1, Math.min(cap, Math.round(price * 0.4))) : a.highBid + inc;
  if (next <= cap && next > a.highBid) return { action: 'bid', amount: next };
  return { action: 'passAuction' };
}

// Cash the bank route could still raise: mortgages, half-price building sales, desk positions, new loans.
function bankLiquidity(g, me) {
  let v = me.cash + g.deskValue(me) + g.borrowHeadroom(me);
  for (const i of g.ownedBy(me.id)) v += g.bankValue([i]);
  return v;
}

// Underwater and the bank route can't cover it: sell to the other players instead, biggest package first.
function liquidationMove(g, me, m) {
  if (g.settings.liquidation !== 'auction' || g.auction || g.player(me.id).cash >= 0) return null;
  if (bankLiquidity(g, g.player(me.id)) >= 0) return null;
  const tried = (m.done.liq ||= new Set()); // each package once per turn
  const seen = new Set(); const pkgs = [];
  for (const i of g.ownedBy(me.id)) {
    if (seen.has(i) || g.encumbrances(i).length) continue;
    const lots = g.salePackage(i); lots.forEach((j) => seen.add(j));
    if (lots.some((j) => g.props[j].owner !== me.id) || tried.has(lots.join(','))) continue;
    pkgs.push({ lots, v: g.bankValue(lots) + lots.reduce((a, j) => a + g.price(j) * 0.3, 0) });
  }
  pkgs.sort((a, b) => b.v - a.v);
  if (!pkgs.length) return null;
  tried.add(pkgs[0].lots.join(','));
  return { action: 'liquidate', space: pkgs[0].lots[0] };
}

function raiseCash(g, me) {
  const deficit = -me.cash;
  const shares = g.desk.positions.find((x) => x.holder === me.id && x.type === 'shares');
  if (shares) return { action: 'deskClose', id: shares.id };
  const room = g.borrowHeadroom(me);
  if (room >= deficit + 10) return bestLoan(g, me, Math.min(room, deficit + reserve(g, me) * 0.25));
  const mine = g.ownedBy(me.id);
  const inSet = (i) => SPACES[i].type === 'street' && g.ownsGroup(me.id, SPACES[i].group);
  const loose = mine.filter((i) => !g.props[i].mortgaged && !inSet(i) && !(SPACES[i].group && g.groupHasBuildings(SPACES[i].group)))
    .sort((a, b) => worth(g, me.id, a) - worth(g, me.id, b));
  if (loose.length) return { action: 'mortgage', space: loose[0] };
  const built = mine.filter((i) => g.props[i].houses > 0);
  if (built.length) {
    // sell from the group with the worst rent per house cost, highest pile first (keeps building even)
    built.sort((a, b) => (SPACES[a].rent[3] / g.houseCost(a)) - (SPACES[b].rent[3] / g.houseCost(b)) || g.props[b].houses - g.props[a].houses);
    const grp = SPACES[built[0]].group;
    const pile = GROUP_MEMBERS[grp].filter((j) => g.props[j].owner === me.id).sort((a, b) => g.props[b].houses - g.props[a].houses)[0];
    return { action: 'sell', space: pile };
  }
  const rest = mine.filter((i) => !g.props[i].mortgaged).sort((a, b) => worth(g, me.id, a) - worth(g, me.id, b));
  if (rest.length) return { action: 'mortgage', space: rest[0] };
  return null;
}

function manage(g, me, m) {
  const res = reserve(g, me);
  // 1. Margin call: pay it down before the bank liquidates on our behalf.
  if (g.inBreach(me)) {
    const excess = g.bankDebt(me) - g.maxLoan(me);
    const loan = me.loans.slice().sort((a, b) => b.rate - a.rate)[0];
    const amt = loan ? Math.min(g.maxPrepay(me, loan), excess) : 0;
    if (amt > 0) return { action: 'repay', loanId: loan.id, amount: amt };
    const r = raiseCash(g, { ...me, cash: -1 });
    if (r && r.action !== 'borrow') return r;
  }
  // 2. Lift mortgages inside complete sets (needed before building).
  for (const [grp, members] of Object.entries(GROUP_MEMBERS)) {
    if (!g.ownsGroup(me.id, grp)) continue;
    const mm = members.find((j) => g.props[j].mortgaged);
    if (mm !== undefined && me.cash - Math.ceil(g.props[mm].mortgageAmt * 1.1) >= res) return { action: 'unmortgage', space: mm };
  }
  // 3. Build where the rent per dollar is best.
  const cands = buildCandidates(g, me);
  const top = cands[0];
  if (top && me.cash - top.cost >= res) return { action: 'build', space: top.space };
  if (top && !m.done.borrowBuild && g.settings.maxLeverage > 1) {
    const rate = g.quote(me, 10, 0, 'floating') / 100;
    const need = top.cost * Math.min(3, cands.length + 1) + res - me.cash;
    const levAfter = (g.assets(me) + need) / Math.max(1, g.bookEquity(me));
    if (top.roi > rate * params.roiMultiple && g.borrowHeadroom(me) >= need && levAfter <= targetLeverage(g)) { m.done.borrowBuild = true; return bestLoan(g, me, need); }
  }
  // 4. Lift other mortgages when flush.
  const mort = g.ownedBy(me.id).filter((i) => g.props[i].mortgaged).sort((a, b) => worth(g, me.id, b) - worth(g, me.id, a));
  if (mort.length && me.cash - Math.ceil(g.props[mort[0]].mortgageAmt * 1.1) >= res * 2) return { action: 'unmortgage', space: mort[0] };
  // 5. Pay down expensive debt with idle cash.
  if (me.loans.length && !top && me.cash > res * 2.5) {
    const loan = me.loans.slice().sort((a, b) => b.rate - a.rate)[0];
    const amt = g.maxPrepay({ ...me, cash: me.cash - res * 2 }, loan);
    if (amt > 0) return { action: 'repay', loanId: loan.id, amount: amt };
  }
  // 5b. Rates have risen: buy back a fixed loan below par and bank the gain.
  const cheap = me.loans.find((l) => l.kind !== 'floating' && g.loanMarketRatio(l) < 0.97);
  if (cheap && me.cash > res * 1.5) {
    const amt = g.maxPrepay({ ...me, cash: me.cash - res }, cheap);
    if (amt > 0) return { action: 'repay', loanId: cheap.id, amount: amt };
  }
  // 6. Insure against a ruinous rent when the board gets dangerous.
  const hasIns = g.desk.positions.some((x) => x.holder === me.id && x.type === 'insurance');
  if (!hasIns && !m.done.insure) {
    const maxRent = g.maxOpponentRent(me.id);
    const premium = g.insuranceQuote(me.id, 250);
    if (maxRent > 0.5 * (me.cash + g.propertyValue(me.id) * 0.4) && premium < me.cash * 0.08) {
      m.done.insure = true;
      return { action: 'deskBuy', order: { product: 'insurance', deductible: 250, term: 10 } };
    }
  }
  // 7. Park idle cash in the strongest rival: a hedge against them winning.
  const boardSettled = g.round >= 10 && Object.values(g.props).filter((x) => !x.owner).length < 6;
  if (params.investInLeader && boardSettled && !top && !me.loans.length && me.cash > res * 3 + g.scale(400) && !m.done.invest) {
    m.done.invest = true;
    const leader = opponents(g, me.id).sort((a, b) => g.netWorth(b) - g.netWorth(a))[0];
    const price = leader && g.desk.marks[leader.id].price;
    const held = g.desk.positions.filter((x) => x.holder === me.id && x.type === 'shares' && x.ref === leader?.id).reduce((a, x) => a + x.shares, 0);
    const inv = leader ? g.desk.equity[leader.id].inv : 0;
    const n = price > 0 ? Math.min(25, 50 - held, inv, Math.floor((me.cash - res * 3) / (price * 1.3))) : 0;
    if (n >= 5) return { action: 'deskBuy', order: { product: 'shares', ref: leader.id, shares: n } };
  }
  // 8. Idle cash into the rival stock that pays the most dividend per dollar. Besides the yield, it hedges:
  // some of every rent you pay that player comes back to you.
  if (params.dividendInvest && boardSettled && !top && !me.loans.length && me.cash > res * params.divCashMult + g.scale(300) && m.divRound !== g.round) {
    m.divRound = g.round;
    let best = null;
    for (const r of opponents(g, me.id)) {
      const e = g.desk.equity[r.id]; const ask = g.deal(r.id, 'ask');
      if (ask <= 0 || e.inv < 5 || g.storedHazard(r.id) > 0.05) continue;
      const held = g.desk.positions.filter((x) => x.holder === me.id && x.type === 'shares' && x.ref === r.id).reduce((a, x) => a + x.shares, 0);
      if (held > 45) continue;
      const y = g.expectedDividend(r.id) / (ask * 1.1);
      if (y > (g.econ.policyRate / 100) * params.divHurdle && (!best || y > best.y)) best = { r, y, held, ask, inv: e.inv };
    }
    if (best) {
      const n = Math.min(25, 50 - best.held, best.inv, Math.floor((me.cash - res * params.divCashMult) / (best.ask * 1.25)));
      if (n >= 5) return { action: 'deskBuy', order: { product: 'shares', ref: best.r.id, shares: n } };
    }
  }
  return null;
}

function jailMove(g, me) {
  const unowned = Object.values(g.props).filter((p) => !p.owner).length;
  const danger = g.maxOpponentRent(me.id);
  const early = unowned >= 6 && danger < g.scale(400);
  if (!early) return null; // late game: sit in Lockup and keep collecting rent
  if (me.jailCards.length) return { action: 'useJailCard' };
  if (me.cash >= g.bail() + reserve(g, me) * 0.3) return { action: 'payBail' };
  return null;
}

// ------------------------------------------------------------------ trades
function tradeDeltas(g, t) {
  const before = ownerMap(g); const after = { ...before };
  for (const i of t.give.spaces) after[i] = t.to;
  for (const i of t.get.spaces) after[i] = t.from;
  const card = 50;
  const toDelta = stratValue(g, t.to, after) - stratValue(g, t.to, before) + t.give.cash - t.get.cash + card * (t.give.jailCards - t.get.jailCards);
  const fromDelta = stratValue(g, t.from, after) - stratValue(g, t.from, before) - t.give.cash + t.get.cash - card * (t.give.jailCards - t.get.jailCards);
  return { toDelta, fromDelta };
}

function evalTrade(g, me, t) {
  if (t.get.cash > me.cash - reserve(g, me) * 0.3) return false;
  const { toDelta, fromDelta } = tradeDeltas(g, t);
  return toDelta > 0 && toDelta >= 0.75 * fromDelta;
}

function proposeTradeMove(g, me, m) {
  if (g.round - m.lastPropose < 2) return null;
  if (g.trades.some((t) => t.status === 'pending' && t.from === me.id)) return null;
  const res = reserve(g, me);
  for (const members of Object.values(GROUP_MEMBERS)) {
    const mine = members.filter((j) => g.props[j].owner === me.id);
    if (mine.length !== members.length - 1) continue;
    const j = members.find((x) => g.props[x].owner !== me.id);
    const q = g.props[j].owner;
    if (!q || g.player(q).bankrupt || g.props[j].houses > 0 || g.groupHasBuildings(SPACES[j].group) || g.encumbrances(j).length) continue;
    // Prefer a swap that completes a set for each side.
    for (const m2 of Object.values(GROUP_MEMBERS)) {
      const theirs = m2.filter((x) => g.props[x].owner === q);
      if (theirs.length !== m2.length - 1) continue;
      const k = m2.find((x) => g.props[x].owner !== q);
      if (g.props[k].owner !== me.id || g.groupHasBuildings(SPACES[k].group) || g.encumbrances(k).length) continue;
      const k2 = `swap-${j}-${k}`;
      if ((m.offers[k2] || 0) >= 1) continue;
      m.offers[k2] = 1; m.lastPropose = g.round;
      const trade = { to: q, give: { spaces: [k] }, get: { spaces: [j] } };
      const { toDelta, fromDelta } = tradeDeltas(g, { from: me.id, to: q, give: g.normalizeSide(trade.give), get: g.normalizeSide(trade.get) });
      const sweetener = Math.max(0, Math.round((fromDelta - toDelta) / 3));
      if (sweetener && sweetener < me.cash - res) trade.give.cash = sweetener;
      return { action: 'proposeTrade', trade };
    }
    // Otherwise a cash offer that escalates after each rejection.
    const levels = [1.6, 2.0, 2.5];
    const k1 = `cash-${j}`;
    const lvl = m.offers[k1] || 0;
    if (lvl >= levels.length) continue;
    const offer = Math.round(g.price(j) * levels[lvl]);
    if (me.cash - offer < res * 0.8) continue;
    m.offers[k1] = lvl + 1; m.lastPropose = g.round;
    return { action: 'proposeTrade', trade: { to: q, give: { cash: offer }, get: { spaces: [j] } } };
  }
  return null;
}

// ------------------------------------------------------------------ multi-party deals
function positionValue(g, x, shares) {
  if (x.type === 'shares') return g.sharesBidValue(x) * ((shares ?? x.shares) / x.shares);
  if (x.type === 'call' || x.type === 'put') return g.optionBidValue(x);
  if (x.type === 'swap') return g.swapMtm(x);
  return 0;
}
// Value change for every party to a multi-party deal (strategic property value + cash + positions).
function dealDeltas(g, d, meId) {
  const before = ownerMap(g); const after = { ...before };
  const delta = Object.fromEntries(d.parties.map((id) => [id, 0]));
  let cashOut = 0;
  for (const l of d.legs) {
    let v = 0;
    if (l.kind === 'cash') { v = l.amount; if (l.from === meId) cashOut += l.amount; }
    if (l.kind === 'card') v = 50 * l.count;
    if (l.kind === 'property') after[l.space] = l.to;
    if (l.kind === 'position') { const x = g.desk.positions.find((y) => y.id === l.position); v = x ? positionValue(g, x, l.shares) : 0; }
    delta[l.to] += v; delta[l.from] -= v;
  }
  for (const id of d.parties) delta[id] += stratValue(g, id, after) - stratValue(g, id, before);
  return { delta, cashOut };
}
function evalDeal(g, me, d) {
  const { delta, cashOut } = dealDeltas(g, d, me.id);
  if (cashOut > me.cash - reserve(g, me) * 0.3) return false;
  const mine = delta[me.id];
  const best = Math.max(...d.parties.filter((id) => id !== me.id).map((id) => delta[id]));
  return mine > 0 && mine >= 0.75 * best;
}

// ------------------------------------------------------------------ contracts
function evalContract(g, me, c) {
  const r = (g.econ.policyRate + 1.5) / 100;
  const n = c.term || 20;
  const ann = (1 - (1 + r) ** -n) / r;
  const disc = (1 + r) ** -n;
  const other = c.parties.find((x) => x !== me.id);
  const credit = Math.min(0.5, g.hazard(other) * n); // chance the counterparty never pays in full
  let npv = 0; let gross = 0; let upfrontOut = 0;
  const sign = (cl) => (cl.to === me.id ? 1 : cl.from === me.id ? -1 : 0);
  const recv = (v) => (v > 0 ? v * (1 - credit) : v);
  for (const cl of c.clauses) {
    switch (cl.kind) {
      case 'upfront': npv += sign(cl) * cl.amount; gross += cl.amount; if (sign(cl) < 0) upfrontOut += cl.amount; break;
      case 'fixed': npv += recv(sign(cl) * cl.amount * ann); gross += cl.amount * ann; break;
      case 'rate': { const f = g.clauseFlow(cl); npv += recv(sign(cl) * f * ann); gross += f * ann; break; }
      case 'maturity': npv += recv(sign(cl) * cl.amount * disc); gross += cl.amount * disc; break;
      case 'rentShare': {
        const payer = cl.from; const sp = cl.spaces.length ? cl.spaces : g.ownedBy(payer);
        const v = (cl.pct / 100) * expectedRentIncome(g, payer, sp) * ann * 1.3; // rents grow with building
        npv += recv(sign(cl) * v); gross += v; break;
      }
      case 'equity': {
        const issuer = g.player(cl.from);
        const v = (cl.pct / 100) * (expectedRentIncome(g, issuer.id, g.ownedBy(issuer.id)) * ann * 1.3 + Math.max(0, g.bookEquity(issuer)));
        npv += sign(cl) < 0 ? -v * 1.25 : recv(v); gross += v; break; // giving away our upside costs extra
      }
      case 'default': {
        const p = Math.min(0.9, g.hazard(cl.ref) * n * 1.4);
        npv += sign(cl) * cl.amount * p; gross += cl.amount * p; break;
      }
      case 'call': case 'put': {
        const i = cl.space; const val = g.price(i); const w = worth(g, me.id, i);
        let v;
        if (cl.kind === 'call') v = cl.writer === me.id ? -(Math.max(0, w - cl.strike) + 0.25 * w) : Math.max(0, worth(g, me.id, i) - cl.strike) + 0.1 * val;
        else v = cl.writer === me.id ? -(Math.max(0, cl.strike - val * 0.9) + 0.1 * val) : Math.max(0, cl.strike - val * 0.9) + 0.05 * val;
        if (cl.writer === me.id && SPACES[i].group && g.ownsGroup(me.id, SPACES[i].group)) v -= val * 3; // never option away a set
        npv += v; gross += Math.abs(v); break;
      }
      case 'collateral': if (cl.from === me.id) npv -= cl.spaces.reduce((a, i) => a + worth(g, me.id, i), 0) * 0.08; break;
      default: break;
    }
  }
  if (upfrontOut && me.cash - upfrontOut < reserve(g, me) * 0.5) return false;
  return npv > Math.max(10, 0.04 * gross);
}

// ------------------------------------------------------------------ main entry
function decide(g, pid) {
  if (g.status !== 'playing') return null;
  const me = g.player(pid);
  if (me.bankrupt) return null;
  const m = memo(g, pid);
  const tk = `${g.round}-${g.turn.idx}`;
  if (m.turnKey !== tk) { m.turnKey = tk; m.failed = new Set(); m.done = {}; }
  const ok = (a) => (a && !m.failed.has(key(a)) ? a : null);

  if (g.auction && g.auction.active.includes(pid)) {
    const a = auctionMove(g, me);
    if (a) return ok(a) || (g.auction.highBidder === pid ? null : { action: 'passAuction' });
  }
  const t = g.trades.find((x) => x.status === 'pending' && x.to === pid);
  if (t) return ok({ action: evalTrade(g, me, t) ? 'acceptTrade' : 'rejectTrade', id: t.id }) || { action: 'rejectTrade', id: t.id };
  const c = g.contracts.find((x) => x.status === 'proposed' && x.parties[1] === pid);
  if (c) {
    let yes = false;
    try { yes = evalContract(g, me, c); } catch { yes = false; }
    return ok({ action: yes ? 'acceptContract' : 'rejectContract', id: c.id }) || { action: 'rejectContract', id: c.id };
  }
  const deal = (g.deals || []).find((x) => x.status === 'pending' && x.parties.includes(pid) && !x.accepted[pid]);
  if (deal) {
    let yes = false;
    try { yes = evalDeal(g, me, deal); } catch { yes = false; }
    return ok({ action: yes ? 'acceptDeal' : 'rejectDeal', id: deal.id }) || { action: 'rejectDeal', id: deal.id };
  }
  // Sell shares into a player's bid when it beats what the bank would pay.
  for (const b of (g.bids || [])) {
    if (b.status !== 'open' || b.buyer === pid) continue;
    const x = g.desk.positions.find((y) => y.holder === pid && y.type === 'shares' && y.ref === b.ref);
    if (!x) continue;
    if (b.priceEach > g.sharesBidValue(x) / x.shares) { const a = ok({ action: 'fillBid', id: b.id, shares: Math.min(b.shares, x.shares) }); if (a) return a; }
  }

  const myTurn = g.current().id === pid;
  if (me.cash < 0) {
    const l = ok(liquidationMove(g, me, m)); if (l) return l;
    if (g.auction && g.auction.seller === pid) return null; // our sale is running: wait for the proceeds
    const a = ok(raiseCash(g, me));
    if (a) return a;
    return myTurn ? { action: 'bankrupt' } : null;
  }
  if (!myTurn) return null;
  const ph = g.turn.phase;
  if (ph === 'buy') return ok(buyMove(g, me, m)) || { action: 'decline' };
  if (ph === 'roll') {
    const a = ok(manage(g, me, m)); if (a) return a;
    if (g.auction) return null; // wait for the auction (e.g. an estate sale) to close
    if (me.inJail) { const j = ok(jailMove(g, me)); if (j) return j; }
    return { action: 'roll' };
  }
  if (ph === 'done') {
    const a = ok(manage(g, me, m)); if (a) return a;
    const tr = ok(proposeTradeMove(g, me, m)); if (tr) return tr;
    return { action: 'endTurn' };
  }
  return null;
}

// Called by the server when an action the bot chose was refused, so it won't retry it this turn.
function markFailed(g, pid, action) { memo(g, pid).failed.add(key(action)); }

// decide() with some params swapped in for this one call (a model-driven seat's fallback plays in character).
function decideWith(g, pid, overrides) {
  if (!overrides || !Object.keys(overrides).length) return decide(g, pid);
  const saved = {};
  for (const k of Object.keys(overrides)) if (k in params) { saved[k] = params[k]; params[k] = overrides[k]; }
  try { return decide(g, pid); } finally { Object.assign(params, saved); }
}

module.exports = { decide, decideWith, markFailed, worth, reserve, buildCandidates, evalTrade, evalContract, evalDeal, tradeDeltas, dealDeltas, auctionCap, packageValue, params };
