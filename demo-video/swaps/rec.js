// Record seed 59: "You" borrows floating at round 14 and hedges it with a player swap (Keynes) and a desk swap.
const fs = require('fs'); const path = require('path');
const { play } = require('./game');
const { SPACES, GROUPS } = require('../../src/board');
const { g, frames, info } = play({ seed: 59, hedgeRound: 14, until: 27, loan: 2000, notional: 1200, deskNotional: 800, TERM: 15, record: true });
console.log('frames', frames.length, JSON.stringify({ ...info, contract: undefined }));
const tags = Object.fromEntries(frames.map((f, i) => [f.tag, i]).filter(([t]) => t));
console.log('tags', tags);
fs.writeFileSync(path.join(__dirname, 'frames59.json'), JSON.stringify({ board: { spaces: SPACES, groups: GROUPS }, me: g.players.find((p) => p.name === 'You').id,
  players: g.players.map((p) => ({ id: p.id, name: p.name, token: p.token, color: p.color })), info: { ...info, contract: info.contract }, tags, frames }));
