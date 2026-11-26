const { play } = require('./play');
const settings = JSON.parse(process.argv[2] || '{}');
const N = Number(process.argv[3] || 60), n = Number(process.argv[4] || 5);
const rows = [];
for (let seed = 1; seed <= N; seed++) {
  const t0 = Date.now();
  const { g, frames } = play({ seed, n, settings });
  const ev = frames.flatMap((f) => f.events.map((e) => e.msg));
  const c = (re) => ev.filter((m) => re.test(m)).length;
  const rates = frames.map((f) => f.rate);
  // lead changes
  let leader = null, leads = 0;
  for (const f of frames) { const l = Object.entries(f.nw).sort((a, b) => b[1] - a[1])[0][0]; if (l !== leader) { leads++; leader = l; } }
  const bigRent = ev.map((m) => /\$(\d+) \(rent on/.exec(m)).filter(Boolean).map((m) => +m[1]);
  const r = { seed, rounds: g.round, actions: frames.length, status: g.status, winner: g.winner && g.player(g.winner).name,
    margin: c(/MARGIN CALL/), liq: c(/liquidates/), bk: c(/☠/), trades: c(/Trade between/), desk: c(/bank-desk/), distress: c(/up for a sealed-bid sale/),
    estate: c(/Estate sale/), borrow: c(/borrows \$/), rollover: c(/rolled over/), shocks: c(/Policy rate is now/), stim: c(/STIMULUS|SURTAX/),
    rateMax: Math.max(...rates), rateMin: Math.min(...rates), leads, maxRent: Math.max(0, ...bigRent), ms: Date.now() - t0 };
  rows.push(r);
}
rows.sort((a, b) => (b.bk * 3 + b.margin * 2 + b.liq + b.distress + b.trades * 0.5 + (b.status === 'finished' ? 5 : 0)) - (a.bk * 3 + a.margin * 2 + a.liq + a.distress + a.trades * 0.5 + (a.status === 'finished' ? 5 : 0)));
console.table(rows.slice(0, 25));
