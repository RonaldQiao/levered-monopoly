const { play } = require('./play');
const seed = +process.argv[2];
const { g, frames } = play({ seed, n: 5 });
const names = Object.fromEntries(g.players.map((p) => [p.id, p.name]));
let lastRound = -1;
frames.forEach((f, i) => {
  if (f.round !== lastRound) { lastRound = f.round; console.log(`--- R${f.round} [#${i}] rate ${f.rate} nw: ${Object.entries(f.nw).map(([k, v]) => `${names[k]} ${v}`).join(' | ')}`); }
  for (const e of f.events) if (/MARGIN|liquidat|☠|Trade between|bank-desk|sealed-bid sale|borrows|rolled over|Policy rate is now|STIMULUS|SURTAX|Estate|writes off|Game over|draws/.test(e.msg) || (/rent on/.test(e.msg) && +(/\$(\d+)/.exec(e.msg)||[0,0])[1] >= 500) || /won liquidation|Sealed bids/.test(e.msg)) console.log(`  #${i} ${e.msg}`);
});
