'use strict';
// node sim/tuneDraft.js [N] — tune the AI's opening-draft bidding for robustness against a mixed field.
const { duel } = require('./formats');
const FIELD = ['casual', 'random', 'pro_draftLoose', 'pro_draftTight'];
(async () => {
  const N = Number(process.argv[2]) || 120; const rows = [];
  const grid = [{ draftMode: 'value' }];
  for (const draftKeyMult of [1.2, 1.6, 2.2]) for (const draftMult of [0.8, 1.0]) for (const draftKeep of [0.15, 0.3, 0.45]) grid.push({ draftMode: 'budget', draftKeyMult, draftMult, draftKeep });
  for (const bp of grid) {
    const ds = [];
    for (const y of FIELD) ds.push((await duel('skill', 'pro', y, N, { rotate: true, maxRounds: 40, botParams: bp })).d);
    rows.push({ ...bp, mean: ds.reduce((a, b) => a + b, 0) / ds.length, worst: Math.min(...ds), ds: ds.map((d) => +d.toFixed(2)) });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  rows.sort((a, b) => b.mean - a.mean);
  console.log('best', JSON.stringify(rows.slice(0, 4)));
})();
