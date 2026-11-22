'use strict';
// node sim/formats.js <exploits|dup|draft|scoreboard|all> [N]
// Follow-up experiments: desk exploits, duplicate-dice format, draft valuation, final agent scoreboard.
const fs = require('node:fs');
const path = require('node:path');
const { runJobs } = require('./pool');
const { mean, sd } = require('./stats');

const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
const save = (name, obj) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 1));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

// Runs X,X,Y,Y. With rotate=true, the same seed is also played as Y,Y,X,X and the two are averaged
// (duplicate format: each side plays the other's dice). Returns per-unit gap stats where a unit is
// one game (rotate=false) or one rotated pair (rotate=true); n80 is always reported in GAMES.
async function duel(variant, x, y, N, { rotate = false, maxRounds = 100 } = {}) {
  const jobs = [];
  for (let k = 0; k < N; k++) {
    const seed = 1 + k * 7919;
    jobs.push({ variant, lineup: [x, x, y, y], seed, maxRounds, tag: `${seed}|a` });
    if (rotate) jobs.push({ variant, lineup: [y, y, x, x], seed, maxRounds, tag: `${seed}|b` });
  }
  const R = await runJobs(jobs);
  const D = (r) => mean(r.players.filter((p) => p.agent === x).map((p) => p.share)) - mean(r.players.filter((p) => p.agent === y).map((p) => p.share));
  const units = {};
  for (const r of R) (units[r.tag.split('|')[0]] ||= []).push(r);
  const vals = Object.values(units).map((rs) => mean(rs.map(D)));
  const m = mean(vals); const s = sd(vals); const d = s ? m / s : 0;
  const per = rotate ? 2 : 1;
  const xWin = mean(R.map((r) => (r.players.find((p) => p.win).agent === x ? 1 : 0)));
  const desk = (n) => mean(R.flatMap((r) => r.players.filter((p) => p.agent === n).map((p) => p.tele.desk)));
  return { variant, x, y, rotate, games: R.length, meanGap: m, d, n80games: d > 0 ? Math.ceil(7.85 / (d * d)) * per : Infinity, xWinRate: xWin, rounds: mean(R.map((r) => r.rounds)), deskX: desk(x), deskY: desk(y) };
}

const line = (r) => `${r.variant.padEnd(14)} ${r.x.padEnd(14)} vs ${r.y.padEnd(14)} d=${f2(r.d).padStart(6)}  gamesNeeded=${String(r.n80games).padStart(6)}  xWin=${pct(r.xWinRate).padStart(6)}  rounds=${r.rounds.toFixed(0).padStart(3)}  desk$ x=${r.deskX.toFixed(0).padStart(8)} y=${r.deskY.toFixed(0).padStart(6)}`;

async function exploits(N = 400) {
  const out = [];
  console.log('\n=== DESK EXPLOITS: specialist vs plain pro, current desk vs fixed desk ===');
  for (const v of ['base', 'baseFix']) {
    for (const x of ['pro_stale', 'pro_distress', 'pro_carry']) { const r = await duel(v, x, 'pro', N); out.push(r); console.log(line(r)); }
  }
  save('exploits', out);
}

async function dup(N = 300) {
  const out = [];
  console.log('\n=== DUPLICATE DICE: games needed to detect a skill gap, normal vs duplicate (rotated seats, same dice) ===');
  const pairs = [['pro', 'casual'], ['pro', 'pro_noTrade'], ['pro', 'pro_reckless'], ['pro', 'pro_noLev']];
  for (const [v, rot] of [['base', false], ['baseDup', true], ['proposedFix', false], ['proposedDup', true]]) {
    for (const [x, y] of pairs) { const r = await duel(v, x, y, N, { rotate: rot }); out.push(r); console.log(line(r)); }
  }
  save('dup', out);
}

async function draft(N = 400) {
  const out = [];
  console.log('\n=== DRAFT VALUATION: budget-aware bidding in an opening draft ===');
  const pairs = [['pro_draft', 'pro'], ['pro_draft', 'casual'], ['pro', 'casual'], ['pro_draft', 'pro_draftLoose'], ['pro_draft', 'pro_draftTight'], ['pro_draft', 'pro_overbid']];
  for (const v of ['draft', 'proposedFix']) for (const [x, y] of pairs) { const r = await duel(v, x, y, N); out.push(r); console.log(line(r)); }
  save('draft', out);
}

// Final: every agent seated against 3 copies of the reference pro, all 4 seat rotations on the same
// seeds (duplicate). Score = mean NW share (25% = par) and win rate.
async function scoreboard(N = 150, variants = ['base', 'proposedDup'], maxRounds = { base: 100, proposedDup: 30 }) {
  const agents = ['pro_quant', 'pro_stale', 'pro_distress', 'pro_carry', 'pro_draft', 'pro', 'pro_noDesk', 'pro_noTrade', 'pro_noLev', 'pro_sucker', 'pro_overbid', 'pro_reckless', 'casual', 'random'];
  const out = {};
  for (const v of variants) {
    const jobs = [];
    for (const a of agents) for (let k = 0; k < N; k++) for (let s = 0; s < 4; s++) {
      const lineup = ['pro', 'pro', 'pro', 'pro']; lineup[s] = a;
      if (a === 'pro') lineup[s] = 'pro';
      jobs.push({ variant: v, lineup, seed: 1 + k * 7919, maxRounds: maxRounds[v], tag: `${a}|${k}|${s}` });
    }
    const t0 = Date.now();
    const R = await runJobs(jobs);
    out[v] = {};
    for (const a of agents) {
      const rs = R.filter((r) => r.tag.startsWith(`${a}|`));
      const me = rs.map((r) => r.players[Number(r.tag.split('|')[2])]);
      const perSeed = {};
      rs.forEach((r, k) => { (perSeed[r.tag.split('|')[1]] ||= []).push(me[k].share); });
      const unit = Object.values(perSeed).map(mean);
      out[v][a] = { share: mean(me.map((p) => p.share)), se: sd(unit) / Math.sqrt(unit.length), win: mean(me.map((p) => (p.win ? 1 : 0))), bankrupt: mean(me.map((p) => (p.bankrupt ? 1 : 0))), desk: mean(me.map((p) => p.tele.desk)), rounds: mean(rs.map((r) => r.rounds)) };
    }
    console.log(`\n=== SCOREBOARD [${v}] each agent vs 3 x pro, all 4 seats, ${N} seeds (${((Date.now() - t0) / 1000).toFixed(0)}s). Par share = 25% ===`);
    for (const a of agents) { const s = out[v][a]; console.log(`${a.padEnd(14)} share ${pct(s.share).padStart(6)} ±${pct(1.96 * s.se).padStart(5)}  win ${pct(s.win).padStart(6)}  bust ${pct(s.bankrupt).padStart(6)}  desk$ ${s.desk.toFixed(0).padStart(8)}  rounds ${s.rounds.toFixed(0)}`); }
  }
  save('scoreboard', out);
}

module.exports = { duel, scoreboard };

if (require.main === module) (async () => {
  const cmd = process.argv[2] || 'all'; const n = Number(process.argv[3]) || undefined;
  if (cmd === 'exploits' || cmd === 'all') await exploits(n);
  if (cmd === 'dup' || cmd === 'all') await dup(n);
  if (cmd === 'draft' || cmd === 'all') await draft(n);
  if (cmd === 'scoreboard' || cmd === 'all') await scoreboard(n);
})();
