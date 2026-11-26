// Record seed 81: "You" vs 4 AI agents; at round 12 You borrows $2,000 floating and hedges it with a swap
// with Hayek (collateral: Harbour Walk, 20 rounds) plus a pay-fixed desk swap. Plays to the end.
const fs = require('fs'); const path = require('path');
const { play } = require('../swaps/game');
const { SPACES, GROUPS } = require('../../src/board');
const { g, frames, info } = play({ seed: 81, hedgeRound: 12, until: 80, loan: 2000, notional: 1200, deskNotional: 800, cp: 'Hayek', TERM: 20, record: true });
const tags = Object.fromEntries(frames.map((f, i) => [f.tag, i]).filter(([t]) => t));
console.log('frames', frames.length, 'winner', g.player(g.winner).name, JSON.stringify({ ...info, contract: undefined }), tags);
// per-round hedge accounting
const per = {};
for (const f of frames) for (const e of f.events) {
  const m = /\$(\d+)/.exec(e.msg); if (!m) continue; const v = +m[1]; const o = (per[f.round] ||= { i: 0, s: 0 });
  if (/^You → Bank: .*interest on floating bank loan @/.test(e.msg)) o.i += v;
  if (/^(Hayek|Bank) → You: .*(Rate hedge|swap settlement)/.test(e.msg)) o.s += v;
  if (/^You → (Hayek|Bank): .*(Rate hedge|swap settlement)/.test(e.msg)) o.s -= v;
}
console.log(Object.entries(per).filter(([, o]) => o.i || o.s).map(([r, o]) => `R${r}: int ${o.i} swaps ${o.s}`).join(' | '));
fs.writeFileSync(path.join(__dirname, 'frames81.json'), JSON.stringify({ board: { spaces: SPACES, groups: GROUPS }, me: g.players.find((p) => p.name === 'You').id,
  players: g.players.map((p) => ({ id: p.id, name: p.name, token: p.token, color: p.color })), info: { ...info, contract: info.contract }, tags, frames }));
