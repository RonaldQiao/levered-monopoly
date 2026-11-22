'use strict';
// node sim/experiments.js <luck|ablate|matrix|caps|all> [gamesPerCell]
// Writes JSON to sim/results/ and prints tables.
const fs = require('node:fs');
const path = require('node:path');
const { runJobs } = require('./pool');
const { mean, corr, r2, gap } = require('./stats');

const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
const save = (name, obj) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 1));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

function jobs(variant, lineup, n, { maxRounds = 100, seed0 = 1, tag } = {}) {
  return Array.from({ length: n }, (_, k) => ({ variant, lineup, seed: seed0 + k * 7919, maxRounds, tag }));
}

// --------------------------------------------------------------------------- 1. luck audit
async function luck(N = 2000) {
  const R = await runJobs(jobs('base', ['pro', 'pro', 'pro', 'pro'], N));
  const seatWins = [0, 0, 0, 0];
  for (const r of R) seatWins[r.players.find((p) => p.win).seat]++;
  const rows = R.flatMap((r) => r.players);
  const vars = {
    cardsNet: (p) => p.tele.cards,
    landUnowned: (p) => p.tele.landUnowned,
    taxAndBail: (p) => -(p.tele.tax + p.tele.bail),
    biggestRentHit: (p) => -p.tele.peakRentHit,
    salaryLaps: (p) => p.tele.salary,
    firstSetRound: (p) => -(p.tele.firstSetRound ?? 101),
  };
  const y = rows.map((p) => p.share); const w = rows.map((p) => (p.win ? 1 : 0));
  const table = Object.fromEntries(Object.entries(vars).map(([k, fn]) => {
    const x = rows.map(fn);
    return [k, { corrShare: corr(x, y), corrWin: corr(x, w) }];
  }));
  const pure = ['cardsNet', 'landUnowned', 'taxAndBail', 'biggestRentHit', 'salaryLaps'];
  const X = rows.map((p) => pure.map((k) => vars[k](p)));
  const R2pure = r2(X, y);
  const R2withSet = r2(rows.map((p) => [...pure, 'firstSetRound'].map((k) => vars[k](p))), y);
  // Is the winner already the leader at round k?
  const lockIn = {};
  for (const k of [5, 10, 20, 30, 40]) {
    let hit = 0; let n = 0;
    for (const r of R) {
      const snap = r.players.map((p) => p.snaps[k]);
      if (snap.some((v) => v === undefined)) continue;
      const lead = r.players[snap.indexOf(Math.max(...snap))];
      n++; if (lead.win) hit++;
    }
    lockIn[k] = n ? hit / n : null;
  }
  // first player to complete a set
  let firstSetWins = 0; let firstSetGames = 0;
  for (const r of R) {
    const withSet = r.players.filter((p) => p.tele.firstSetRound !== null);
    if (!withSet.length) continue;
    const m = Math.min(...withSet.map((p) => p.tele.firstSetRound));
    const firsts = withSet.filter((p) => p.tele.firstSetRound === m);
    if (firsts.length !== 1) continue;
    firstSetGames++; if (firsts[0].win) firstSetWins++;
  }
  const out = {
    N, seatWinRate: seatWins.map((x) => x / N), table, R2pure, R2withSet, lockIn,
    firstSetWinRate: firstSetWins / firstSetGames,
    rounds: mean(R.map((r) => r.rounds)), finishedRate: mean(R.map((r) => (r.finished ? 1 : 0))),
    actions: mean(R.map((r) => r.actions)),
    tradesPerGame: mean(R.map((r) => r.players.reduce((a, p) => a + p.tele.tradesDone, 0) / 2)),
    auctionsWonPerGame: mean(R.map((r) => r.players.reduce((a, p) => a + p.tele.auctionWon, 0))),
    boughtPerGame: mean(R.map((r) => r.players.reduce((a, p) => a + p.tele.bought, 0))),
  };
  save('luck', out);
  console.log('\n=== LUCK AUDIT: 4 identical pro agents, base rules,', N, 'games ===');
  console.log('seat win rate', out.seatWinRate.map(pct).join(' '), '| rounds', f2(out.rounds), '| finished', pct(out.finishedRate), '| actions/game', out.actions.toFixed(0));
  console.log('trades/game', f2(out.tradesPerGame), 'auctions won/game', f2(out.auctionsWonPerGame), 'bought at list/game', f2(out.boughtPerGame));
  for (const [k, v] of Object.entries(table)) console.log(`  ${k.padEnd(16)} corr(share) ${f2(v.corrShare)}  corr(win) ${f2(v.corrWin)}`);
  console.log('R^2 of NW share on pure dice/card luck:', f2(R2pure), '| + first-set timing:', f2(R2withSet));
  console.log('P(winner = NW leader at round k):', Object.entries(lockIn).map(([k, v]) => `r${k}:${pct(v)}`).join(' '));
  console.log('P(win | first to complete a colour set):', pct(out.firstSetWinRate));
  return out;
}

// --------------------------------------------------------------------------- 2/3. skill matrix
const SKILLS = [
  { key: 'overall', label: 'Overall play (pro vs casual)', x: 'pro', y: 'casual' },
  { key: 'valuation', label: 'Valuation (pro vs over-bidder)', x: 'pro', y: 'pro_overbid' },
  { key: 'negotiation', label: 'Negotiation (pro vs no-trade)', x: 'pro', y: 'pro_noTrade' },
  { key: 'adverse', label: 'Adverse selection (pro vs accepts-all)', x: 'pro', y: 'pro_sucker' },
  { key: 'sizing', label: 'Position sizing (pro vs reckless leverage)', x: 'pro', y: 'pro_reckless' },
  { key: 'leverage', label: 'Using leverage (pro vs never-borrow)', x: 'pro', y: 'pro_noLev' },
  { key: 'credit', label: 'Credit-event trading (distress vs pro)', x: 'pro_distress', y: 'pro' },
  { key: 'rates', label: 'Rates carry (carry vs pro)', x: 'pro_carry', y: 'pro' },
  { key: 'stale', label: 'Stale-quote arbitrage (stale vs pro)', x: 'pro_stale', y: 'pro' },
];

async function matrix(N = 400, variants, name = 'matrix', maxRounds = 100) {
  variants ||= ['base', 'noCards', 'noMacroCards', 'noJail', 'noDoubles', 'lowVarDice', 'noAuction', 'lev1', 'lev5', 'cash3000', 'baseFix', 'draft', 'smoothRent', 'proposed', 'proposedFix'];
  const all = [];
  for (const v of variants) {
    all.push(...jobs(v, ['pro', 'pro', 'pro', 'pro'], N, { maxRounds, tag: `${v}|mirror` }));
    for (const s of SKILLS) all.push(...jobs(v, [s.x, s.x, s.y, s.y], N, { maxRounds, tag: `${v}|${s.key}` }));
  }
  const t0 = Date.now();
  const R = await runJobs(all);
  const by = {};
  for (const r of R) (by[r.tag] ||= []).push(r);
  const out = { N, maxRounds, variants, skills: SKILLS, cells: {}, mirror: {} };
  for (const v of variants) {
    const m = by[`${v}|mirror`];
    const seat = [0, 0, 0, 0]; for (const r of m) seat[r.players.find((p) => p.win).seat]++;
    out.mirror[v] = {
      rounds: mean(m.map((r) => r.rounds)), finished: mean(m.map((r) => (r.finished ? 1 : 0))), actions: mean(m.map((r) => r.actions)),
      seatSpread: (Math.max(...seat) - Math.min(...seat)) / m.length, deskPnl: mean(m.map((r) => r.deskPnl)),
      maxShare: mean(m.map((r) => Math.max(...r.players.map((p) => p.share)))),
    };
    for (const s of SKILLS) out.cells[`${v}|${s.key}`] = gap(by[`${v}|${s.key}`], s.x, s.y);
  }
  save(name, out);
  console.log(`\n=== SKILL x RULES MATRIX (${N} games/cell, 2v2 lineups, cap ${maxRounds} rounds, ${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
  console.log('cell = Cohen d of NW-share gap per game (higher = skill shows more, negative = the "skill" loses)');
  const head = 'skill'.padEnd(44) + variants.map((v) => v.slice(0, 11).padStart(12)).join('');
  console.log(head);
  for (const s of SKILLS) console.log(s.label.padEnd(44) + variants.map((v) => f2(out.cells[`${v}|${s.key}`].d).padStart(12)).join(''));
  console.log('win rate of skilled side (base 50%)');
  for (const s of SKILLS) console.log(s.label.padEnd(44) + variants.map((v) => pct(out.cells[`${v}|${s.key}`].xWinRate).padStart(12)).join(''));
  console.log('mirror (4x pro) game shape');
  for (const k of ['rounds', 'finished', 'actions', 'seatSpread', 'maxShare']) console.log(k.padEnd(44) + variants.map((v) => f2(out.mirror[v][k]).padStart(12)).join(''));
  return out;
}

async function caps(N = 400) {
  const out = {};
  for (const cap of [15, 25, 40, 60, 100]) out[cap] = await matrix(N, ['base', 'proposedFix'], `caps_${cap}`, cap);
  save('caps', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.cells])));
  return out;
}

(async () => {
  const cmd = process.argv[2] || 'all'; const n = Number(process.argv[3]) || undefined;
  if (cmd === 'luck' || cmd === 'all') await luck(n);
  if (cmd === 'matrix' || cmd === 'all') await matrix(n);
  if (cmd === 'caps' || cmd === 'all') await caps(n);
})();
