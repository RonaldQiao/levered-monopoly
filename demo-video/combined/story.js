const { play } = require('../swaps/game');
const [seed, H, cp, TERM] = [+process.argv[2], +process.argv[3], process.argv[4], +process.argv[5]];
const { g, frames, info } = play({ seed, hedgeRound: H, until: 80, loan: 2000, notional: 1200, deskNotional: 800, cp, TERM });
console.log(JSON.stringify({ ...info, contract: undefined }));
let lr = -1; const nm = Object.fromEntries(g.players.map((p) => [p.id, p.name]));
frames.forEach((f, i) => {
  if (f.round !== lr) { lr = f.round; }
  for (const e of f.events) if (/MARGIN|liquidates|☠|Trade between|borrows|Policy rate is now|transfers|DEFAULT|matured|Game over|HAWKISH|EMERGENCY|ACTIVE|bank-desk pay|writes off/.test(e.msg) || (/rent on/.test(e.msg) && +(/\$(\d+)/.exec(e.msg) || [0, 0])[1] >= 700)) console.log(`#${i} R${f.round} r${f.rate} ${e.msg.slice(0, 140)}`);
});
