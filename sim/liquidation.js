'use strict';
// node sim/liquidation.js [N] — distressed-sale auctions vs bank-only liquidation.
const fs = require('node:fs');
const path = require('node:path');
const { runJobs } = require('./pool');
const { duel } = require('./formats');
const { mean } = require('./stats');

(async () => {
  const N = Number(process.argv[2]) || 300; const out = {};
  for (const [v, cap, rot] of [['classicBankLiq', 100, false], ['classic', 100, false], ['skillBankLiq', 40, true], ['skill', 40, true]]) {
    const jobs = [];
    for (let k = 0; k < N; k++) jobs.push({ variant: v, lineup: ['pro', 'pro', 'pro', 'pro'], seed: 1 + k * 7919, maxRounds: cap });
    const R = await runJobs(jobs);
    const sum = (f) => mean(R.map((r) => r.players.reduce((a, p) => a + (p.tele[f] || 0), 0)));
    const row = {
      rounds: mean(R.map((r) => r.rounds)), finished: mean(R.map((r) => (r.finished ? 1 : 0))), busts: mean(R.map((r) => r.players.filter((p) => p.bankrupt).length)),
      distressSales: sum('distressSales'), distressProceeds: sum('distressProceeds'), estateBuys: sum('estateBuys'),
    };
    for (const [k, x, y] of [['overall', 'pro', 'casual'], ['negotiation', 'pro', 'pro_noTrade'], ['leverage', 'pro', 'pro_noLev'], ['sizing', 'pro', 'pro_reckless'], ['distress', 'pro', 'pro_noLiq']]) {
      const r = await duel(v, x, y, N, { rotate: rot, maxRounds: cap });
      row[k] = { d: +r.d.toFixed(2), win: +r.xWinRate.toFixed(3), games: r.n80games };
    }
    out[v] = row;
    console.log(v.padEnd(15), JSON.stringify(row));
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'liquidation.json'), JSON.stringify(out, null, 1));
})();
