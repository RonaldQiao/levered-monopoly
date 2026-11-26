// Find a full game where "You" hedges a floating loan with a player swap + desk swap, rates rise, the AIs blow up, You win.
const { play } = require('../swaps/game');
const rows = [];
const N = +(process.argv[2] || 150);
for (let seed = 1; seed <= N; seed++) for (const H of [10, 12, 14]) for (const cp of ['Keynes', 'Minsky', 'Volcker', 'Hayek']) for (const TERM of [15, 20]) {
  const { g, frames, info, me } = play({ seed, hedgeRound: H, until: 80, loan: 2000, notional: 1200, deskNotional: 800, cp, TERM });
  if (!info.hedged || info.error) continue;
  const ev = frames.flatMap((f) => f.events.map((e) => e.msg));
  const rates = frames.filter((f) => f.round >= info.round && f.round <= info.round + 15).map((f) => f.rate);
  const cpBust = frames.find((f) => f.events.some((e) => new RegExp(`☠ ${cp} `).test(e.msg)));
  const seized = ev.some((m) => /transfers .* → You/.test(m) && new RegExp(cp).test(m));
  rows.push({ seed, H, cp, TERM, fixed: info.fixed, r0: info.rate0, rMax: Math.max(...rates), rounds: g.round, status: g.status, winner: g.winner && g.player(g.winner).name,
    mc: ev.filter((m) => /MARGIN CALL/.test(m)).length, liq: ev.filter((m) => /liquidates/.test(m)).length, bk: ev.filter((m) => /☠/.test(m)).length,
    fire: ev.filter((m) => /up for a sealed-bid sale/.test(m)).length, cpBustR: cpBust ? cpBust.round : null, seized, youNW: Math.round(g.netWorth(me)) });
}
const good = rows.filter((r) => r.winner === 'You' && r.status === 'finished' && r.rMax - r.r0 >= 2 && r.rounds <= 70);
good.sort((a, b) => (b.seized - a.seized) * 10 + (b.mc + b.liq) - (a.mc + a.liq) + (a.rounds - b.rounds) * 0.1);
console.log('total', rows.length, 'good', good.length);
console.table(good.slice(0, 25));
