const { play } = require('./game2');
const rows = [];
const [a, b] = [+(process.argv[2] || 1), +(process.argv[3] || 100)];
for (let seed = a; seed <= b; seed++) for (const cp of ['Keynes', 'Minsky', 'Volcker', 'Hayek']) for (const H of [10, 12]) {
  let r;
  try { r = play({ seed, cp, hedgeRound: H }); } catch (e) { continue; }
  const { g, frames, info, me } = r;
  if (!info.hedge || !info.equity || !info.equity.inv || info.error) continue;
  const ev = frames.flatMap((f) => f.events.map((e) => e.msg));
  const sum = (re) => ev.filter((m) => re.test(m)).reduce((s, m) => s + +/\$(\d+)/.exec(m)[1], 0);
  const rates = frames.filter((f) => f.round >= info.hedge.round && f.round <= info.hedge.round + 15).map((f) => f.rate);
  rows.push({ seed, cp, H, eqInv: info.equity.inv, eqUp: info.equity.up, fixed: info.hedge.fixed, r0: info.hedge.rate0, rMax: Math.max(...rates),
    credit: info.credit ? `${info.credit.ref}@R${info.credit.round}` : '-', cdsPay: sum(/CDS payout/), putPay: sum(/put pays out/),
    seized: ev.some((m) => /transfers .* → You/.test(m)), rounds: g.round, winner: g.winner && g.player(g.winner).name, mc: ev.filter((m) => /MARGIN CALL/.test(m)).length });
}
const good = rows.filter((r) => r.winner === 'You' && r.cdsPay > 0 && r.putPay > 0 && r.rMax - r.r0 >= 1.5 && r.rounds <= 55);
good.sort((x, y) => (y.seized - x.seized) * 5 + (y.rMax - y.r0) - (x.rMax - x.r0) + (y.mc - x.mc) * 0.3 + (x.fixed - x.r0 - (y.fixed - y.r0)) * 2);
console.log('rows', rows.length, 'good', good.length);
console.table(good.slice(0, 20));
