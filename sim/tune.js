'use strict';
// node sim/tune.js [N] [variant]  — grid-search the AI's sizing parameters in a format (pro vs casual and vs random).
const { duel } = require('./formats');

(async () => {
  const N = Number(process.argv[2]) || 150; const variant = process.argv[3] || 'skill';
  const rows = [];
  for (const targetLeverage of [1.4, 1.8, 2.3, 3]) for (const roiMultiple of [1.5, 3]) for (const interestReserve of [0, 2]) {
    const bp = { targetLeverage, roiMultiple, interestReserve };
    const c = await duel(variant, 'pro', 'casual', N, { rotate: true, maxRounds: 40, botParams: bp });
    const r = await duel(variant, 'pro', 'random', N, { rotate: true, maxRounds: 40, botParams: bp });
    rows.push({ ...bp, dCasual: c.d, winCasual: c.xWinRate, dRandom: r.d, winRandom: r.xWinRate });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  rows.sort((a, b) => (b.dCasual + b.dRandom) - (a.dCasual + a.dRandom));
  console.log('best', JSON.stringify(rows.slice(0, 3)));
})();
