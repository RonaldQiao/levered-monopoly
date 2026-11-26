const { play } = require('./game');
const rows = [];
for (let seed = 1; seed <= +(process.argv[2] || 80); seed++) for (const H of [8, 10, 12, 14]) {
  const { g, frames, info, me } = play({ seed, hedgeRound: H, until: H + 18, loan: 2000, notional: 1200, deskNotional: 800 });
  if (!info.hedged || info.error) continue;
  const at = (r) => { const f = frames.find((x) => x.round === r); return f ? f.rate : null; };
  const rates = frames.filter((f) => f.round >= info.round && f.round <= info.round + 15).map((f) => f.rate);
  const ev = frames.flatMap((f) => f.events.map((e) => e.msg));
  const swapIn = ev.filter((m) => /Rate hedge: periodic/.test(m) && /Keynes → You/.test(m)).reduce((a, m) => a + +/\$(\d+)/.exec(m)[1], 0);
  const swapOut = ev.filter((m) => /Rate hedge: periodic/.test(m) && /You → Keynes/.test(m)).reduce((a, m) => a + +/\$(\d+)/.exec(m)[1], 0);
  const desk = ev.filter((m) => /swap settlement/.test(m)).reduce((a, m) => a + (/You/.test(m.split('→')[1] || '') ? 1 : -1) * +/\$(\d+)/.exec(m)[1], 0);
  rows.push({ seed, H, r0: info.rate0, fixed: info.fixed, deskFx: info.deskFixed, coll: info.coll, rMax: Math.max(...rates), rEnd: at(info.round + 15), swapNet: swapIn - swapOut, desk,
    mc: ev.filter((m) => /MARGIN CALL/.test(m)).length, bk: ev.filter((m) => /☠/.test(m)).length, youNW: me.bankrupt ? 'BK' : Math.round(g.netWorth(me)), def: ev.filter((m) => /DEFAULTS/.test(m)).length });
}
rows.splice(0, rows.length, ...rows.filter((r) => r.youNW !== 'BK' && r.def === 0)); rows.sort((a, b) => (b.swapNet + b.desk) - (a.swapNet + a.desk));
console.table(rows.slice(0, 15));
