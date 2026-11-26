'use strict';
// Persona files: src/agents/personas/*.md. A small header between --- lines sets the knobs; the prose
// below it becomes part of that AI player's instructions. The host picks a persona and a model per seat.
//
// Header keys:
//   name, blurb                       shown in the lobby
//   risk: aggressive|balanced|conservative
//   dealing: seeking|neutral|averse
//   stance: exploitative|unexploitable|balanced|cooperative
//   calculating: true|false           false = no calculator tools (plays on feel)
//   bot.<param>: number               the rule-based fallback plays with these (src/bot.js params), so a
//                                     seat stays in character when its model is slow, fails or runs out of budget
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'personas');
const ENUMS = {
  risk: ['aggressive', 'balanced', 'conservative'],
  dealing: ['seeking', 'neutral', 'averse'],
  stance: ['exploitative', 'unexploitable', 'balanced', 'cooperative'],
};

function parse(id, text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) throw new Error(`persona ${id}: missing --- header`);
  const p = { id, name: id, blurb: '', risk: 'balanced', dealing: 'neutral', stance: 'balanced', calculating: true, bot: {}, prose: m[2].trim() };
  for (const line of m[1].split('\n')) {
    const kv = /^([\w.]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, k, v] = kv;
    if (k.startsWith('bot.')) { const n = Number(v); if (Number.isFinite(n)) p.bot[k.slice(4)] = n; continue; }
    if (k === 'calculating') { p.calculating = v.trim() === 'true'; continue; }
    if (ENUMS[k] && !ENUMS[k].includes(v.trim())) throw new Error(`persona ${id}: ${k} must be one of ${ENUMS[k].join(', ')}`);
    p[k] = v.trim();
  }
  return p;
}

let cache = null;
function loadPersonas(dir = DIR) {
  if (cache && dir === DIR) return cache;
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const id = f.slice(0, -3);
    out[id] = parse(id, fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  if (dir === DIR) cache = out;
  return out;
}

module.exports = { loadPersonas, parse };
