// Real-money payouts. A pure settlement function, loaded by the server (require) and the browser
// (window.Payout), so the lobby preview, the live "if it ended now" table and the game-over table all
// use the same arithmetic.
//
// Every player declares a stake ($0 = not playing for money). The pot is the sum of the stakes. Each
// payout mode gives every player a weight; unequal stakes are settled with poker-style side pots:
//   sort the distinct stake levels L1 < L2 < ...; layer k is (Lk - Lk-1) from every player whose stake
//   reaches Lk, and is split only among those players by their weights, renormalised among them.
// So a $0 player can neither win nor lose, and nobody wins more from an opponent than they risked.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Payout = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const MODES = {
    winner: { label: 'Winner take all', short: 'The last player standing takes the pot, or the highest net worth if the round cap ends the game.', needsCap: false },
    order: { label: 'Order of bankruptcy', short: 'Split by finishing place with weights n−1, n−2, …, 0 (survivors at the cap ranked by net worth, then the bankrupt in reverse order of going out).', needsCap: false },
    share: { label: 'Share payout, capped rounds', short: 'Split by share of total net worth at the cap (bankrupt = 0).', needsCap: true },
    share3: { label: 'Share³ payout, capped rounds', short: 'Split by share³ ÷ Σshare³ at the cap: rewards the leader much more steeply.', needsCap: true },
  };
  const MODE_KEYS = Object.keys(MODES);
  const DEFAULT_CAP = 40;   // rounds, when a share mode is picked with no round cap set
  const MAX_STAKE = 1e6;    // dollars

  const toCents = (x) => Math.round(Number(x) * 100);
  const EPS = 1e-6; // cents: absorbs floating-point error before rounding down

  // Finishing places. Survivors first, by net worth (equal net worth = tied place); then the bankrupt,
  // the last one out placing highest. `out` is the bankruptcy sequence number (1 = first out).
  // Returns a new array of { ...player, place, tie } sorted best first. Places use competition ranking
  // (1, 1, 3): a tie takes the best place of the positions it occupies.
  function rank(players) {
    const alive = players.filter((p) => !p.bankrupt).sort((a, b) => b.netWorth - a.netWorth);
    const dead = players.filter((p) => p.bankrupt).sort((a, b) => (b.out || 0) - (a.out || 0));
    const order = [...alive, ...dead];
    const key = (p) => (p.bankrupt ? `out:${p.out || 0}:${p.id}` : `nw:${p.netWorth}`);
    const out = [];
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && key(order[j + 1]) === key(order[i])) j++;
      for (let k = i; k <= j; k++) out.push({ ...order[k], place: i + 1, tie: j > i, span: [i, j] });
      i = j + 1;
    }
    return out;
  }

  // Net-worth share: max(0, net worth) / the sum over all players, bankrupt = 0.
  function shares(players) {
    const pos = (p) => (p.bankrupt ? 0 : Math.max(0, Number(p.netWorth) || 0));
    const total = players.reduce((a, p) => a + pos(p), 0);
    return Object.fromEntries(players.map((p) => [p.id, total > 0 ? pos(p) / total : 0]));
  }

  // Raw (unnormalised) weight of every player under `mode`. `reason` is how the game ended:
  // 'lastStanding' (everyone else went bankrupt), 'cap' (round cap) or 'host' (the host ended it).
  function weights(mode, ranked, share, reason) {
    const n = ranked.length;
    const w = {};
    const survivors = ranked.filter((p) => !p.bankrupt);
    const sole = reason === 'lastStanding' && survivors.length === 1 ? survivors[0].id : null;
    for (const p of ranked) {
      if (mode === 'winner') w[p.id] = p.place === 1 ? 1 : 0;
      else if (mode === 'order') {
        // Average the weights n-1-i over the positions a tie occupies.
        const [i, j] = p.span;
        let sum = 0;
        for (let k = i; k <= j; k++) sum += n - 1 - k;
        w[p.id] = sum / (j - i + 1);
      } else if (mode === 'share') w[p.id] = share[p.id];
      else if (mode === 'share3') w[p.id] = share[p.id] ** 3;
      else throw new Error(`Unknown payout mode ${mode}`);
    }
    // A share game that ends by bankruptcy before the cap: the sole survivor's weight is 1.
    if (sole && (mode === 'share' || mode === 'share3')) for (const p of ranked) w[p.id] = p.id === sole ? 1 : 0;
    return w;
  }

  /**
   * Settle the pot.
   * @param {object} o
   * @param {string} o.mode       one of MODE_KEYS
   * @param {Array}  o.players    [{ id, name?, stake ($), netWorth, bankrupt, out? }]
   * @param {string} [o.reason]   'lastStanding' | 'cap' | 'host'
   * @returns {{ mode, label, reason, pot, potCents, rows }} rows best place first:
   *   { id, name, stake, place, tie, netWorth, share, weight, payout, net, stakeCents, payoutCents, netCents }
   */
  function settle({ mode, players, reason = 'cap' }) {
    if (!MODES[mode]) throw new Error(`Unknown payout mode ${mode}`);
    const ranked = rank(players.map((p) => ({ ...p, netWorth: Number(p.netWorth) || 0, stakeCents: Math.max(0, toCents(p.stake || 0)) })));
    const share = shares(ranked);
    const w = weights(mode, ranked, share, reason);
    const placeIdx = Object.fromEntries(ranked.map((p, i) => [p.id, i]));

    // Side pots: layer by layer, split by weight among the layer's funders, in whole cents. Each share
    // is rounded down and the layer's leftover cents go to its top finisher (ranked is best first), so
    // the payouts sum to the pot exactly, a $0 player never gets a stray cent, and nobody gains more
    // from an opponent than they risked, even by a cent. (Every staked player funds the first layer,
    // so its top finisher is the top finisher with money in the game.)
    const cents = Object.fromEntries(ranked.map((p) => [p.id, 0]));
    const levels = [...new Set(ranked.map((p) => p.stakeCents).filter((c) => c > 0))].sort((a, b) => a - b);
    let prev = 0;
    for (const L of levels) {
      const funders = ranked.filter((p) => p.stakeCents >= L);
      const amount = (L - prev) * funders.length;
      prev = L;
      let total = funders.reduce((a, p) => a + w[p.id], 0);
      let lw = (p) => w[p.id];
      if (!(total > EPS)) {
        // Nobody who funded this layer has any weight (e.g. the winner staked less): poker rule, the
        // best-placed funder(s) take it.
        const best = Math.min(...funders.map((p) => p.place));
        lw = (p) => (p.place === best ? 1 : 0);
        total = funders.filter((p) => p.place === best).length;
      }
      let paid = 0;
      for (const p of funders) {
        const c = Math.floor((amount * lw(p)) / total + EPS);
        cents[p.id] += c; paid += c;
      }
      cents[funders[0].id] += amount - paid;
    }
    const potCents = ranked.reduce((a, p) => a + p.stakeCents, 0);

    const wTotal = ranked.reduce((a, p) => a + w[p.id], 0);
    const rows = ranked.map((p) => ({
      id: p.id, name: p.name, stake: p.stakeCents / 100, place: p.place, tie: p.tie, bankrupt: !!p.bankrupt,
      netWorth: p.netWorth, share: share[p.id], weight: wTotal > 0 ? w[p.id] / wTotal : 0,
      payout: cents[p.id] / 100, net: (cents[p.id] - p.stakeCents) / 100,
      stakeCents: p.stakeCents, payoutCents: cents[p.id], netCents: cents[p.id] - p.stakeCents,
    }));
    rows.sort((a, b) => placeIdx[a.id] - placeIdx[b.id]);
    return { mode, label: MODES[mode].label, reason, pot: potCents / 100, potCents, rows };
  }

  // Lobby preview: the most a player can win is what each opponent risked, up to their own stake.
  function exposure(stakes, id) {
    const mine = Math.max(0, toCents(stakes[id] || 0));
    let win = 0;
    for (const [k, v] of Object.entries(stakes)) if (k !== id) win += Math.min(mine, Math.max(0, toCents(v || 0)));
    return { maxWin: win / 100, maxLoss: mine / 100 };
  }

  // Validate a declared stake: dollars, rounded to cents, 0..MAX_STAKE. Returns null if invalid.
  function parseStake(x) {
    const n = Number(x);
    if (x === '' || x === null || !Number.isFinite(n) || n < 0 || n > MAX_STAKE) return null;
    return toCents(n) / 100;
  }

  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };
  const dollars = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (x) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${dollars(Math.abs(x))}`;
  const placeLabel = (r) => `${r.tie ? '=' : ''}${ordinal(r.place)}`;

  return { MODES, MODE_KEYS, DEFAULT_CAP, MAX_STAKE, rank, shares, weights, settle, exposure, parseStake, ordinal, dollars, signed, placeLabel };
}));
