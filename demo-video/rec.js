const fs = require('fs');
const { play } = require('./play');
const { SPACES, GROUPS } = require('../src/board');
const seed = +process.argv[2];
const { g, frames } = play({ seed, n: 5, record: true });
console.log('frames', frames.length, 'winner', g.player(g.winner).name);
fs.writeFileSync(`frames${seed}.json`, JSON.stringify({ board: { spaces: SPACES, groups: GROUPS }, players: g.players.map((p) => ({ id: p.id, name: p.name, token: p.token, color: p.color })), frames }));
