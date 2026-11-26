'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, GameError } = require('./src/engine');
const { SPACES, GROUPS } = require('./src/board');
const bot = require('./src/bot');
const { AgentManager } = require('./src/agents/manager');
const { catalog } = require('./src/agents/providers');
const { loadPersonas } = require('./src/agents/personas');

// Model-driven AI players: which models this server can run (from API keys in its environment) and the
// personas a host can pick. Keys never leave the server.
const MODELS = catalog();
const PERSONAS = loadPersonas();
const AGENT_CATALOG = {
  models: MODELS.map(({ id, label, provider }) => ({ id, label, provider })),
  personas: Object.values(PERSONAS).map(({ id, name, blurb, risk, dealing, stance, calculating }) => ({ id, name, blurb, risk, dealing, stance, calculating })),
};
if (MODELS.length) console.log(`AI models available: ${MODELS.map((m) => m.id).join(', ')}`);
else console.log('No AI model keys set (ANTHROPIC_API_KEY / DEEPSEEK_API_KEY): only rule-based AI players are available.');

// Default ms between AI moves for new rooms; the host changes it per room from the game screen.
const BOT_DELAY = Number(process.env.BOT_DELAY) || 0;
// While AI players are paused they still answer these (so auctions and offers never stall).
const PASSIVE = new Set(['bid', 'passAuction', 'acceptTrade', 'rejectTrade', 'acceptContract', 'rejectContract']);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const SHARED = new Set(['/pricing.js', '/payout.js']); // served from src/
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  // Shared modules (same code the server uses): bank-desk pricing and real-money payouts.
  const shared = SHARED.has(file);
  const full = shared ? path.join(__dirname, 'src', file.slice(1)) : path.normalize(path.join(PUBLIC, file));
  if (!shared && !full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
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
  if (room.agents) state.agentStatus = room.agents.status();
  const sealed = state.auction && state.auction.sealed;
  for (const ws of room.sockets) {
    if (ws.readyState !== 1) continue;
    // Sealed bids are private: each player is sent only their own bid. Chat is per player too: public
    // messages plus only the direct-message threads that player is in (all held in RAM for this round).
    let chat = null;
    try { chat = room.game.memory.chatFor(ws.playerId); } catch { chat = null; }
    ws.send(JSON.stringify({ type: 'state', state: { ...state, chat, ...(sealed ? { auction: room.game.auctionView(ws.playerId) } : {}) } }));
  }
  if (room.agents && !room.poking) { room.poking = true; try { room.agents.poke(); } finally { room.poking = false; } }
  scheduleTick(room);
  scheduleBots(room);
}

// One bot action per tick: ask the bots in a random order (a fixed order would hand every tied
// auction bid to the same seat), apply the first action anyone wants.
function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (g.status !== 'playing' || !g.players.some((p) => p.bot && !p.bankrupt)) return;
  room.botTimer = setTimeout(() => {
    room.botFails ||= {};
    const order = g.players.slice();
    for (let k = order.length - 1; k > 0; k--) { const j = crypto.randomInt(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
    for (const p of order) {
      if (!p.bot || p.bankrupt) continue;
      let a = null;
      if (p.agent && room.agents) {
        // Model-driven seat: the model decides strategy; the rule-based AI (in character) does the rest.
        const ctl = room.agents.control(p.id);
        if (ctl.wait) continue;
        if (ctl.action) a = ctl.action;
        else { try { a = room.agents.fallback(p.id, bot.decideWith(g, p.id, ctl.params)); } catch (e) { console.error('bot decide error', e); } }
      } else {
        try { a = bot.decide(g, p.id); } catch (e) { console.error('bot decide error', e); }
      }
      if (!a) continue;
      if (g.settings.botsPaused && !PASSIVE.has(a.action)) continue;
      try {
        g.apply(p.id, a);
        room.botFails[p.id] = 0;
      } catch (e) {
        if (!(e instanceof GameError)) console.error(e);
        bot.markFailed(g, p.id, a);
        room.botFails[p.id] = (room.botFails[p.id] || 0) + 1;
        if (room.botFails[p.id] > 25) { console.error(`bot ${p.name} stuck on`, a, e.message); continue; }
      }
      return broadcast(room);
    }
  }, botDelay(g));
}

// Sealed bids are private, so AI players submit them quickly; in open auctions they keep a pace that
// still fits inside the 12s bidding window; everything else follows the host's speed setting.
function botDelay(g) {
  const d = g.settings.botDelay || 1500;
  if (g.auction) return g.auction.sealed ? Math.min(250, d) : Math.min(d, 3000) + 250;
  return d;
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
  send(ws, { type: 'joined', code: room.game.code, playerId, token, board: BOARD, agents: AGENT_CATALOG });
  broadcast(room);
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Keepalive: hosting proxies (Render, Cloudflare, nginx...) drop WebSockets that are idle for ~60s, and a
// dead connection would otherwise linger. Ping every 25s; a socket that missed the last ping is closed, and
// the browser reconnects and resumes its seat.
const keepalive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 25000);
wss.on('close', () => clearInterval(keepalive));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'create') {
        const code = newCode();
        const room = { game: new Game(code), sockets: new Set(), tokens: new Map(), timer: null };
        room.agents = new AgentManager(room.game, { onChange: () => broadcast(room), catalog: MODELS, personas: PERSONAS });
        if (BOT_DELAY) room.game.settings.botDelay = BOT_DELAY;
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
        if (msg.action === 'addBot' && msg.agent) {
          if (room.game.status !== 'lobby') throw new GameError('Bots join in the lobby');
          const persona = PERSONAS[String(msg.agent.persona)];
          const model = MODELS.find((m) => m.id === String(msg.agent.model));
          if (!persona) throw new GameError('Unknown persona');
          if (!model) throw new GameError('That model is not available on this server (no API key set)');
          room.game.addBot(ws.playerId, { persona: persona.id, model: model.id, label: persona.name });
          return broadcast(room);
        }
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
