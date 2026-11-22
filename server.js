'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, GameError } = require('./src/engine');
const { SPACES, GROUPS } = require('./src/board');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/** rooms: code -> { game, sockets: Set<ws>, tokens: Map<token, playerId>, timer } */
const rooms = new Map();
const BOARD = { spaces: SPACES, groups: GROUPS };

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcast(room) {
  room.game.version++;
  const state = room.game.serialize();
  const data = JSON.stringify({ type: 'state', state });
  for (const ws of room.sockets) if (ws.readyState === 1) ws.send(data);
  scheduleTick(room);
}

function scheduleTick(room) {
  clearTimeout(room.timer);
  const a = room.game.auction;
  if (!a) return;
  room.timer = setTimeout(() => { if (room.game.tick()) broadcast(room); else scheduleTick(room); }, Math.max(50, a.deadline - Date.now() + 20));
}

function attach(ws, room, playerId, token) {
  ws.room = room; ws.playerId = playerId;
  clearTimeout(room.expire);
  room.sockets.add(ws);
  const p = room.game.player(playerId);
  p.connected = true;
  send(ws, { type: 'joined', code: room.game.code, playerId, token, board: BOARD });
  broadcast(room);
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'create') {
        const code = newCode();
        const room = { game: new Game(code), sockets: new Set(), tokens: new Map(), timer: null };
        rooms.set(code, room);
        const p = room.game.addPlayer(msg.name);
        const token = crypto.randomBytes(16).toString('hex');
        room.tokens.set(token, p.id);
        return attach(ws, room, p.id, token);
      }
      if (msg.type === 'join') {
        const room = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) throw new GameError('Room not found');
        const p = room.game.addPlayer(msg.name);
        const token = crypto.randomBytes(16).toString('hex');
        room.tokens.set(token, p.id);
        return attach(ws, room, p.id, token);
      }
      if (msg.type === 'resume') {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        const pid = room && room.tokens.get(msg.token);
        if (!pid) return send(ws, { type: 'resumeFailed' });
        return attach(ws, room, pid, msg.token);
      }
      if (msg.type === 'leave') {
        const room = ws.room;
        if (room && room.game.status === 'lobby') {
          room.game.removeLobbyPlayer(ws.playerId);
          room.sockets.delete(ws);
          ws.room = null;
          broadcast(room);
        }
        return;
      }
      if (msg.type === 'action') {
        const room = ws.room;
        if (!room) throw new GameError('Not in a room');
        room.game.apply(ws.playerId, msg);
        return broadcast(room);
      }
    } catch (e) {
      if (e instanceof GameError) return send(ws, { type: 'error', message: e.message });
      console.error(e);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.sockets.delete(ws);
    const still = [...room.sockets].some((s) => s.playerId === ws.playerId);
    try { if (!still) room.game.player(ws.playerId).connected = false; } catch { /* removed */ }
    if (room.sockets.size === 0) {
      // Keep empty rooms for 2 hours so players can reconnect.
      room.expire = setTimeout(() => { if (room.sockets.size === 0) rooms.delete(room.game.code); }, 2 * 3600 * 1000);
    } else broadcast(room);
  });
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  MARGIN CALL server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}   <- share this with players on your network`);
  console.log('');
});
