const { play } = require('./game2');
const [seed, cp, H] = [+process.argv[2], process.argv[3], +process.argv[4]];
const { g, frames, info } = play({ seed, cp, hedgeRound: H });
console.log(JSON.stringify(info));
frames.forEach((f, i) => { for (const e of f.events) if (/MARGIN|liquidates|☠|Policy rate is now|transfers|Game over|HAWKISH|EMERGENCY|ACTIVE|bank-desk|writes off|CDS payout|put pays|Equity raise|terminated|You borrows/.test(e.msg) || (/rent on/.test(e.msg) && +(/\$(\d+)/.exec(e.msg) || [0, 0])[1] >= 900) || (/borrows/.test(e.msg) && +(/\$(\d+)/.exec(e.msg) || [0, 0])[1] >= 400)) console.log(`#${i} R${f.round} r${f.rate} ${e.msg.slice(0, 140)}`); });
console.log(g.players.map((p) => `${p.name} ${p.bankrupt ? 'BK' : Math.round(g.netWorth(p))}`).join(' | '));
