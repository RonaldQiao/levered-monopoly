// Record seed 133: You vs 4 AI agents with four scripted finance moves (see ../combined/game2.js):
// equity raise to Keynes (R6), floating loan hedged with a Volcker swap + desk swap (R12), CDS + put on Minsky (R14).
const fs = require('fs'); const path = require('path');
const { play } = require('../combined/game2');
const { SPACES, GROUPS } = require('../../src/board');
const { g, frames, info } = play({ seed: 133, cp: 'Volcker', hedgeRound: 12, record: true });
const tags = Object.fromEntries(frames.map((f, i) => [f.tag, i]).filter(([t]) => t));
console.log('frames', frames.length, 'winner', g.player(g.winner).name, JSON.stringify(info), tags);
fs.writeFileSync(path.join(__dirname, 'frames133.json'), JSON.stringify({ board: { spaces: SPACES, groups: GROUPS }, me: g.players.find((p) => p.name === 'You').id,
  players: g.players.map((p) => ({ id: p.id, name: p.name, token: p.token, color: p.color })), info, tags, frames }));
