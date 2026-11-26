'use strict';
// node sim/round2.js [N]  — skill detection under candidate tournament formats (duplicate dice, rotated seats).
const fs = require('node:fs');
const path = require('node:path');
const { duel } = require('./formats');

const SK = [
  ['overall', 'pro', 'casual'], ['noise', 'pro', 'random'], ['valuation', 'pro', 'pro_overbid'], ['draftBudget', 'pro', 'pro_draftLoose'],
  ['negotiation', 'pro', 'pro_noTrade'], ['adverse', 'pro', 'pro_sucker'],
  ['sizing', 'pro', 'pro_reckless'], ['leverage', 'pro', 'pro_noLev'],
  ['credit', 'pro_distress', 'pro'], ['rates', 'pro_carry', 'pro'], ['stale', 'pro_stale', 'pro'],
];
const DEFAULT_FORMATS = [['base', 100, false], ['baseDup', 100, true], ['tightDup', 40, true], ['tightRiskDup', 40, true], ['tightLev2Dup', 40, true], ['proposedDup', 40, true]];

(async () => {
  const N = Number(process.argv[2]) || 250;
  const FORMATS = process.argv[3] ? process.argv[3].split(',').map((f) => { const [v, cap] = f.split(':'); return [v, Number(cap) || 40, /Dup|^skill/.test(v)]; }) : DEFAULT_FORMATS;
  const file = process.argv[4] || 'round2';
  const out = {};
  for (const [v, cap, rot] of FORMATS) {
    out[v] = {};
    for (const [k, x, y] of SK) {
      const r = await duel(v, x, y, N, { rotate: rot, maxRounds: cap });
      out[v][k] = r;
      console.log(`${v.padEnd(13)} cap${String(cap).padStart(3)} ${k.padEnd(12)} d=${r.d.toFixed(2).padStart(6)} gamesNeeded=${String(r.n80games).padStart(7)} xWin=${(100 * r.xWinRate).toFixed(1).padStart(5)}% rounds=${r.rounds.toFixed(0)}`);
    }
  }
  fs.writeFileSync(path.join(__dirname, 'results', `${file}.json`), JSON.stringify(out, null, 1));
})();
