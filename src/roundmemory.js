'use strict';
// Round-scoped, in-memory scratch space for talk and short-term memory:
//   - public chat (everyone sees it)
//   - direct messages (only the two players in a thread see them)
//   - agent notes about opponents (only the agent that wrote them sees them)
//   - agent event digests (what happened to an agent this round, for its next decision)
//
// It lives only in the server process's RAM: it is never written to disk, never put in the game log,
// never serialized with the game, and never fed to the simulator. When the round ends (scope 'round')
// or the game ends (scope 'game' or 'round'), every reference is dropped at once: the store is replaced
// by empty containers, so nothing from an earlier round can leak into a later prompt or screen.
//
// Hard caps keep it small: a busy room cannot grow it without bound inside one round.

const LIMITS = {
  text: 200,          // characters per message or note
  publicMessages: 200,
  dmPerThread: 100,
  notesPerAgent: 40,
  eventsPerAgent: 40,
};

class RoundMemory {
  constructor(scope = 'round') {
    this.scope = scope;
    this.round = 0;
    this.generation = 0; // bumps on every wipe; lets readers notice a wipe happened
    this.wipe();
  }

  wipe() {
    this.public = [];
    this.dms = new Map();     // "pA|pB" (sorted) -> [{ from, to, text, t, round }]
    this.notes = new Map();   // agentId -> [{ about, text, t, round }]
    this.events = new Map();  // agentId -> [{ text, t, round }]
    this.seq = 0;             // message ids within this generation
    this.generation++;
  }

  // Called by the engine after the round counter advances.
  onRound(round) {
    this.round = round;
    if (this.scope === 'round') this.wipe();
  }

  // Called by the engine when the game ends: nothing outlives the game.
  onFinish() { this.wipe(); }

  static clip(text) { return String(text || '').slice(0, LIMITS.text); }
  static key(a, b) { return [a, b].sort().join('|'); }

  postPublic(from, text, t) {
    const m = { id: ++this.seq, from, text: RoundMemory.clip(text), t, round: this.round };
    this.public.push(m);
    if (this.public.length > LIMITS.publicMessages) this.public.shift();
    return m;
  }

  postDM(from, to, text, t) {
    const k = RoundMemory.key(from, to);
    const thread = this.dms.get(k) || [];
    const m = { id: ++this.seq, from, to, text: RoundMemory.clip(text), t, round: this.round };
    thread.push(m);
    if (thread.length > LIMITS.dmPerThread) thread.shift();
    this.dms.set(k, thread);
    return m;
  }

  note(agentId, about, text, t) {
    const list = this.notes.get(agentId) || [];
    list.push({ about, text: RoundMemory.clip(text), t, round: this.round });
    if (list.length > LIMITS.notesPerAgent) list.shift();
    this.notes.set(agentId, list);
  }

  event(agentId, text, t) {
    const list = this.events.get(agentId) || [];
    list.push({ text: RoundMemory.clip(text), t, round: this.round });
    if (list.length > LIMITS.eventsPerAgent) list.shift();
    this.events.set(agentId, list);
  }

  // What one player may see: public chat plus only the DM threads they are in. Copies, never live arrays.
  chatFor(pid) {
    const dms = {};
    for (const [k, thread] of this.dms) {
      const [a, b] = k.split('|');
      if (a !== pid && b !== pid) continue;
      dms[a === pid ? b : a] = thread.map((m) => ({ ...m }));
    }
    return { scope: this.scope, round: this.round, generation: this.generation, public: this.public.map((m) => ({ ...m })), dms };
  }
  notesFor(agentId) { return (this.notes.get(agentId) || []).map((n) => ({ ...n })); }
  eventsFor(agentId) { return (this.events.get(agentId) || []).map((e) => ({ ...e })); }

  // Messages addressed to pid after message id `after`: DMs to them, or public messages naming them.
  newFor(pid, name, after = 0) {
    const out = [];
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu');
    for (const m of this.public) if (m.id > after && m.from !== pid && re.test(m.text)) out.push(m);
    for (const [k, thread] of this.dms) {
      if (!k.split('|').includes(pid)) continue;
      for (const m of thread) if (m.id > after && m.to === pid) out.push(m);
    }
    return out.sort((x, y) => x.id - y.id);
  }

  size() {
    let n = this.public.length;
    for (const v of this.dms.values()) n += v.length;
    for (const v of this.notes.values()) n += v.length;
    for (const v of this.events.values()) n += v.length;
    return n;
  }
}

module.exports = { RoundMemory, LIMITS };
