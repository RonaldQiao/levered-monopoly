'use strict';
// Rule variants, applied as patches on a Game instance (src/ is never modified).
// `pre(g)` runs before start(), `post(g)` right after start().
const { SPACES, OWNABLE, GROUP_MEMBERS } = require('../src/board');
const { EVENT_CARDS, TREASURY_CARDS } = require('../src/cards');

// Approximate long-run landing probability per space per turn (same table the AI uses).
const LAND = [0.031, 0.021, 0.019, 0.022, 0.024, 0.029, 0.023, 0.009, 0.023, 0.023,
  0.063, 0.027, 0.026, 0.024, 0.025, 0.029, 0.028, 0.026, 0.029, 0.031,
  0.028, 0.028, 0.011, 0.027, 0.032, 0.031, 0.027, 0.027, 0.028, 0.026,
  0.000, 0.027, 0.026, 0.024, 0.025, 0.024, 0.009, 0.022, 0.022, 0.026];

const compose = (...vs) => ({
  pre: (g) => vs.forEach((v) => v.pre && v.pre(g)),
  post: (g) => vs.forEach((v) => v.post && v.post(g)),
});

const V = {};
V.base = {};

// ---- ablations of current rules ------------------------------------------------
V.noCards = { post: (g) => { g.drawCard = () => {}; } };
V.noMacroCards = {
  post: (g) => {
    g.decks.event = g.decks.event.filter((i) => !EVENT_CARDS[i].type.startsWith('macro'));
    g.decks.treasury = g.decks.treasury.filter((i) => !TREASURY_CARDS[i].type.startsWith('macro'));
  },
};
// Only cards that move cash or position randomly between players and the bank (keeps macro shocks).
V.noCashCards = {
  post: (g) => {
    const keep = (c) => c.type.startsWith('macro');
    g.decks.event = g.decks.event.filter((i) => keep(EVENT_CARDS[i]));
    g.decks.treasury = g.decks.treasury.filter((i) => keep(TREASURY_CARDS[i]));
  },
};
V.noDoubles = {
  post: (g) => {
    const roll = g.roll.bind(g);
    g.roll = (p) => {
      if (p.inJail) return roll(p);
      const die = g.die.bind(g); let first = null;
      // Re-draw the second die until it differs from the first: same marginal spread, no doubles.
      g.die = () => { if (first === null) { first = die(); return first; } let d = die(); while (d === first) d = die(); return d; };
      try { roll(p); } finally { g.die = die; }
    };
  },
};
V.noJail = {
  post: (g) => {
    const send = g.sendToJail.bind(g);
    g.sendToJail = (p) => { void send; g.addLog(`${p.name} would be jailed (jail disabled).`); if (g.turn && g.current().id === p.id) g.turn.extraRoll = false; };
  },
};
V.noAuction = { pre: (g) => { g.settings.auctions = false; } };
V.lev1 = { pre: (g) => { g.settings.maxLeverage = 1; } };
V.lev5 = { pre: (g) => { g.settings.maxLeverage = 5; } };
V.noEconNoise = {
  post: (g) => {
    const close = g.closeRoundEconomy.bind(g);
    g.closeRoundEconomy = () => { const r = g.rng; g.rng = () => 0.5; try { close(); } finally { g.rng = r; } };
  },
};
V.cash3000 = { pre: (g) => { g.settings.startingCash = 3000; } };

// ---- candidate low-luck / fast rules -------------------------------------------
// Opening draft: every property is auctioned before round 1 (acquisition no longer depends on where you land).
V.draft = {
  post: (g) => {
    const order = Object.keys(g.props).map(Number);
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(g.rng() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    g.draftQueue = order;
    const close = g.closeAuction.bind(g);
    const open = () => {
      const i = g.draftQueue.shift();
      if (i === undefined) return;
      g.auction = { space: i, highBid: 0, highBidder: null, active: g.active().map((x) => x.id), deadline: g.now() + 25000 };
    };
    g.closeAuction = () => { close(); if (g.draftQueue.length && g.status === 'playing') open(); };
    open();
  },
};

// Expected-value rent: instead of paying rent on landing, every player pays every rival's property
// (landing probability x current rent) at the start of each round. Removes "who hit the hotel" luck
// while keeping the economics (rent engines, building ROI, liquidity needs).
V.smoothRent = {
  post: (g) => {
    const land = g.resolveLanding.bind(g);
    g.resolveLanding = (p, opts = {}) => {
      const s = SPACES[p.pos];
      if (OWNABLE.has(s.type) && g.props[p.pos].owner) return; // rent is charged in expectation instead
      return land(p, opts);
    };
    const nr = g.newRound.bind(g);
    g.newRound = () => {
      const live = g.active();
      for (const payer of live) {
        const owed = {};
        for (const k of Object.keys(g.props)) {
          const i = Number(k); const pr = g.props[i];
          if (!pr.owner || pr.owner === payer.id || pr.mortgaged) continue;
          owed[pr.owner] = (owed[pr.owner] || 0) + LAND[i] * 1.18 * g.rentFor(i, 7); // 1.18 = moves per turn incl. doubles
        }
        for (const [owner, amt] of Object.entries(owed)) {
          const paid = g.pay(payer.id, owner, amt, 'rent on portfolio (expected)', { spending: true });
          if (paid) g.onRentReceived(owner, -1, paid);
        }
      }
      nr();
    };
  },
};

// Low-variance movement: 1d6 + 4 instead of 2d6 (same mean, range 5-10 instead of 2-12).
V.lowVarDice = {
  post: (g) => {
    const roll = g.roll.bind(g);
    g.roll = (p) => {
      // second "die" is a fixed 4: total = 1d6 + 4, and doubles still happen 1 time in 6
      const die = g.die.bind(g); let n = 0;
      g.die = () => (n++ % 2 === 0 ? die() : 4);
      try { roll(p); } finally { g.die = die; }
    };
  },
};

// ---- tournament format: duplicate dice ---------------------------------------------
// Seat order is fixed to join order and every seat gets its own dice + card stream, so the same seed
// replayed with the lineup rotated gives each agent the other side's luck (as in duplicate bridge).
function mulberry(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
V.dup = {
  post: (g) => {
    g.players.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    g.turn = g.freshTurn(0);
    const base = Math.floor(g.rng() * 2 ** 32);
    const dice = g.players.map((_, k) => mulberry(base + 1000 * k + 1));
    const cards = g.players.map((_, k) => mulberry(base + 1000 * k + 7));
    const seat = () => g.turn ? g.turn.idx : 0;
    g.die = () => 1 + Math.floor(dice[seat()]() * 6);
    const draw = g.drawCard.bind(g);
    g.drawCard = (p, deck) => {
      const order = g.decks[deck];
      const k = Math.floor(cards[g.players.indexOf(p)]() * order.length);
      const [idx] = order.splice(k, 1); order.unshift(idx);
      return draw(p, deck);
    };
  },
};

// ---- desk fixes -------------------------------------------------------------------
// 1. desk shares/options trade at the live book-equity price (no stale once-a-round mark)
// 2. no new CDS or puts on a player who is already below $0 cash (protection can't be bought on a burning house)
// 3. swaps: receive-fixed pays curve - term premium (no free carry), and total swap notional <= 1x equity
const TERM_PREMIUM = { 5: 0.25, 10: 0.5, 20: 1.0 };
V.deskFix = {
  post: (g) => {
    const withLive = (fn) => (...args) => {
      const saved = {};
      for (const p of g.players) { const m = g.desk.marks[p.id]; saved[p.id] = m.price; m.price = Math.round(g.livePrice(p.id) * 100) / 100; }
      try { return fn(...args); } finally { for (const p of g.players) g.desk.marks[p.id].price = saved[p.id]; }
    };
    const buy = g.deskBuy.bind(g);
    g.deskBuy = withLive((p, o = {}) => {
      if ((o.product === 'cds' || o.product === 'put') && o.ref && g.players.some((r) => r.id === o.ref && r.cash < 0)) {
        const { GameError } = require('../src/engine'); throw new GameError('No protection on a player in distress');
      }
      if (o.product === 'swap') {
        const live = g.desk.positions.filter((x) => x.holder === p.id && x.type === 'swap').reduce((a, x) => a + x.notional, 0);
        if (live + Number(o.notional) > Math.max(0, g.bookEquity(p))) { const { GameError } = require('../src/engine'); throw new GameError('Total swap notional is capped at 1x equity'); }
      }
      return buy(p, o);
    });
    g.deskClose = withLive(g.deskClose.bind(g));
    const sr = g.swapRate.bind(g);
    g.swapRate = (term, side) => (side === 'receiveFixed' ? Math.round((sr(term, side) - TERM_PREMIUM[term]) * 100) / 100 : sr(term, side));
  },
};

V.lean = compose(V.noCashCards, V.noJail, V.noDoubles);
V.draftSmooth = compose(V.draft, V.smoothRent);
V.proposed = compose(V.draft, V.smoothRent, V.noCashCards, V.noJail, V.noDoubles);
V.proposedFix = compose(V.proposed, V.deskFix);
V.baseDup = V.dup;
V.proposedDup = compose(V.dup, V.proposed, V.deskFix);
V.baseFix = V.deskFix;

module.exports = { V, LAND, compose };

// ---- second-round candidates (risk kept in the game, luck removed from the comparison) ----
V.lev2 = { pre: (g) => { g.settings.maxLeverage = 2; } };
V.lev15 = { pre: (g) => { g.settings.maxLeverage = 1.5; } };
// Risk-priced credit: all bank debt re-prices every round at policy + 0.25% + a credit spread that is
// 3x steeper (+1.5% per unit of leverage), so over-levering has a running cost that grows with risk.
V.riskPricedCredit = {
  post: (g) => {
    g.creditSpread = (p, extra = 0) => { const eq = g.bookEquity(p); const lev = eq > 0 ? (g.assets(p) + extra) / eq : 10; return 1.5 * Math.max(0, lev - 1); };
    const nr = g.newRound.bind(g);
    g.newRound = () => {
      for (const p of g.active()) for (const l of p.loans) {
        l.kind = 'floating';
        l.margin = Math.round((0.25 + g.creditSpread(p)) * 100) / 100; // engine sets rate = new policy + margin
      }
      nr();
    };
  },
};
V.tight = compose(V.draft, V.noCashCards, V.noJail, V.noDoubles, V.deskFix);
V.tightDup = compose(V.dup, V.tight);
V.tightRiskDup = compose(V.dup, V.tight, V.riskPricedCredit);
V.tightLev2Dup = compose(V.dup, V.tight, V.lev2);
for (const r of [3, 5, 7, 9]) {
  V[`neutral${r}`] = { pre: (g) => { g.settings.neutralRate = r; } };
  V[`tightRiskDupN${r}`] = compose(V[`neutral${r}`], V.dup, V.tight, V.riskPricedCredit);
}
