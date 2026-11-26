'use strict';
// Runs the model-driven AI players in one room.
//
// Hybrid design: a model is woken only for decisions that need judgment — its strategic window each turn,
// buying, auctions, offers made to it, and messages addressed to it. Everything mechanical (rolling, ending
// the turn, paying, raising cash below $0, jail) is played by the rule-based AI (src/bot.js) with the
// persona's parameters, which also takes over whenever a model is slow, errors, refuses, or spends its budget.
//
// Server integration: before the rule-based scheduler moves an agent's seat, it asks control(pid):
//   { wait: true }        the model is thinking (or just got woken): skip this seat for now
//   { action }            a mechanical move on the model's behalf (e.g. bid up to its open-auction limit)
//   { params }            let the rule-based AI decide with these persona parameters
// poke() starts any wake-ups that are due; onChange() is called after every action so the room re-broadcasts.
const { systemPrompt, observation } = require('./view');
const { toolsFor, run } = require('./tools');
const { loadPersonas } = require('./personas');
const providers = require('./providers');
const { SPACES } = require('../board');

// Moves the rule-based AI may still make for a seat whose model is in charge (anything else is the model's call).
const MECHANICAL = new Set(['roll', 'endTurn', 'payBail', 'useJailCard', 'bid', 'passAuction', 'buy', 'decline', 'acceptTrade', 'rejectTrade', 'acceptContract', 'rejectContract', 'acceptDeal', 'rejectDeal', 'bankrupt']);

const LIMITS = {
  modelCalls: 5,        // model round-trips per wake-up
  toolCalls: 8,         // tool executions per wake-up
  wakeMs: 60000,        // whole wake-up
  auctionWakeMs: 15000, // auctions have deadlines
  chatWakesPerRound: 3, // messages addressed to an agent wake it at most this often per round
  errorsToAutopilot: 3, // consecutive failed wake-ups before the seat stays on autopilot
};

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

class AgentManager {
  constructor(game, { onChange = () => {}, catalog = providers.catalog(), personas = loadPersonas(), providerOpts = {}, makeProvider, limits = {}, log = console } = {}) {
    this.g = game;
    this.onChange = onChange;
    this.catalog = catalog;
    this.personas = personas;
    this.providerOpts = providerOpts;
    this.makeProvider = makeProvider || ((entry) => providers.createProvider(entry, providerOpts));
    this.limits = { ...LIMITS, ...limits };
    this.log = log;
    this.seats = new Map();
    this.running = new Set(); // wake-up promises (tests await them)
  }

  // ------------------------------------------------------------------ seats
  seat(pid) {
    const p = this.g.player(pid);
    if (!p.agent) return null;
    let s = this.seats.get(pid);
    if (s) return s;
    const persona = this.personas[p.agent.persona];
    const entry = this.catalog.find((m) => m.id === p.agent.model);
    s = { pid, persona: persona || null, entry: entry || null, provider: null, busy: false, spent: 0, calls: 0, errors: 0, disabled: null, handled: new Set(), chat: { gen: -1, seen: 0, round: -1, wakes: 0 }, auctionLimit: null, system: null };
    if (!persona) s.disabled = `unknown persona ${p.agent.persona}`;
    else if (!entry) s.disabled = `model ${p.agent.model} is not available on this server`;
    else {
      try { s.provider = this.makeProvider(entry); } catch (e) { s.disabled = `provider error: ${e.message}`; }
    }
    if (s.disabled) this.g.addLog(`🤖 ${p.name} plays on autopilot: ${s.disabled}.`, 'system');
    this.seats.set(pid, s);
    return s;
  }

  autopilot(s, why) {
    if (s.disabled) return;
    s.disabled = why;
    this.g.addLog(`🤖 ${this.g.player(s.pid).name} switches to autopilot: ${why}.`, 'system');
  }

  status() {
    const out = {};
    for (const p of this.g.players) {
      if (!p.agent) continue;
      const s = this.seat(p.id);
      out[p.id] = { persona: p.agent.persona, personaName: s.persona ? s.persona.name : p.agent.persona, model: p.agent.model, busy: s.busy, spent: Math.round(s.spent * 10000) / 10000, calls: s.calls, autopilot: s.disabled };
    }
    return out;
  }

  // ------------------------------------------------------------------ what needs a decision
  trigger(pid) {
    const g = this.g; const s = this.seat(pid);
    if (!s || s.disabled || s.busy || g.status !== 'playing') return null;
    const me = g.player(pid);
    if (me.bankrupt) return null;
    const paused = g.settings.botsPaused;
    const a = g.auction;
    if (a && a.active.includes(pid)) {
      const key = `auc:${g.round}:${a.kind}:${a.lots.join(',')}`;
      const limitSet = s.auctionLimit && s.auctionLimit.key === `${a.lots.join(',')}-${a.kind}`;
      if (!s.handled.has(key) && !limitSet) return { key, kind: 'auction', why: `${a.sealed ? 'submit your sealed bid' : 'set the most you will bid'} for ${a.lots.map((i) => SPACES[i].name).join(' + ')}` };
    }
    for (const t of g.trades) if (t.status === 'pending' && t.to === pid && !s.handled.has(`offer:${t.id}`)) return { key: `offer:${t.id}`, kind: 'offer', why: `${g.player(t.from).name} offered you trade ${t.id}` };
    for (const c of g.contracts) if (c.status === 'proposed' && c.parties[1] === pid && !s.handled.has(`offer:${c.id}`)) return { key: `offer:${c.id}`, kind: 'offer', why: `contract ${c.id} offered to you` };
    for (const d of g.deals || []) if (d.status === 'pending' && d.parties.includes(pid) && !d.accepted[pid] && !s.handled.has(`offer:${d.id}`)) return { key: `offer:${d.id}`, kind: 'offer', why: `deal ${d.id} needs your answer` };
    const mine = g.current().id === pid;
    if (mine && g.turn.phase === 'buy' && g.turn.pendingBuy !== null && g.turn.pendingBuy !== undefined) {
      const key = `buy:${g.round}:${g.turn.idx}:${g.turn.pendingBuy}`;
      if (!s.handled.has(key)) return { key, kind: 'buy', why: 'you landed on an unowned property' };
    }
    if (paused) return null;
    if (mine && g.turn.phase === 'done' && me.cash >= 0 && !g.auction) {
      const key = `turn:${g.round}:${g.turn.idx}:${g.turn.doubles}`;
      if (!s.handled.has(key)) return { key, kind: 'turn', why: 'your move: build, borrow, trade, use the desk or talk before your turn ends' };
    }
    // Messages to this agent (DMs, or public messages naming it), a few times a round.
    const mem = g.memory;
    if (s.chat.gen !== mem.generation) s.chat = { gen: mem.generation, seen: 0, round: g.round, wakes: 0 };
    if (s.chat.round !== g.round) { s.chat.round = g.round; s.chat.wakes = 0; }
    if (s.chat.wakes < this.limits.chatWakesPerRound) {
      const name = me.name.replace(/\s*\(AI\)$/, '');
      const fresh = mem.newFor(pid, name, s.chat.seen);
      if (fresh.length) return { key: `chat:${mem.generation}:${fresh[fresh.length - 1].id}`, kind: 'chat', why: `${fresh.length} new message(s) addressed to you`, chatUpTo: fresh[fresh.length - 1].id };
    }
    return null;
  }

  // Mechanical moves made on an agent's behalf between wake-ups.
  mechanical(pid) {
    const g = this.g; const s = this.seat(pid); const me = g.player(pid);
    const a = g.auction;
    if (a && !a.sealed && a.active.includes(pid) && s.auctionLimit && s.auctionLimit.key === `${a.lots.join(',')}-${a.kind}`) {
      if (a.highBidder === pid) return { wait: true };
      const price = a.lots.reduce((x, i) => x + g.price(i), 0);
      const next = a.highBid === 0 ? Math.max(1, Math.min(s.auctionLimit.max, Math.round(price * 0.5))) : a.highBid + Math.max(5, Math.round(price * 0.05));
      return { action: next <= s.auctionLimit.max && next <= me.cash ? { action: 'bid', amount: next } : { action: 'passAuction' } };
    }
    // After its strategic window the model is done for this turn: end it instead of letting the
    // rule-based AI make strategic moves of its own.
    if (g.current().id === pid && g.turn.phase === 'done' && me.cash >= 0 && !g.auction && s.handled.has(`turn:${g.round}:${g.turn.idx}:${g.turn.doubles}`)) return { action: { action: 'endTurn' } };
    return null;
  }

  control(pid) {
    const s = this.seat(pid);
    if (!s) return { params: null };
    const params = s.persona ? s.persona.bot : null;
    if (s.disabled) return { params };
    if (s.busy) return { wait: true };
    const trig = this.trigger(pid);
    if (trig) { this.start(s, trig); return { wait: true }; }
    const m = this.mechanical(pid);
    if (m) return m;
    return { params };
  }

  // The rule-based AI's choice for a seat whose model is in charge: mechanical moves pass; strategic ones
  // (building, borrowing, trading, desk...) are the model's job, so they become "roll" / "end turn" instead.
  // Below $0 anything goes: raising cash is mechanical.
  fallback(pid, a) {
    if (!a) return a;
    const s = this.seat(pid);
    if (!s || s.disabled) return a;
    const g = this.g; const me = g.player(pid);
    if (me.cash < 0 || MECHANICAL.has(a.action)) return a;
    if (g.current().id === pid && !g.auction) {
      if (g.turn.phase === 'roll') return { action: 'roll' };
      if (g.turn.phase === 'done') return { action: 'endTurn' };
    }
    return null;
  }

  poke() {
    if (this.g.status !== 'playing') return;
    for (const p of this.g.players) {
      if (!p.agent || p.bankrupt) continue;
      const s = this.seat(p.id);
      if (!s || s.busy || s.disabled) continue;
      const trig = this.trigger(p.id);
      if (trig) this.start(s, trig);
    }
  }

  start(s, trig) {
    s.busy = true;
    s.handled.add(trig.key);
    if (trig.kind === 'chat') { s.chat.seen = trig.chatUpTo; s.chat.wakes++; }
    const p = this.wake(s, trig).catch((e) => this.log.error('agent wake error', e)).finally(() => { this.running.delete(p); });
    this.running.add(p);
    this.onChange();
  }

  async idle() { while (this.running.size) await Promise.all([...this.running]); }

  // ------------------------------------------------------------------ one decision
  async wake(s, trig) {
    const g = this.g; const pid = s.pid; const me = g.player(pid);
    const done = [];
    let budgetHit = false;
    try {
      s.chatsThisWake = 0;
      s.system ||= systemPrompt(s.persona, { name: me.name, memoryScope: g.settings.memoryScope });
      const tools = toolsFor(s.persona);
      const session = s.provider.session({ system: s.system, tools });
      const deadline = Date.now() + (trig.kind === 'auction' ? this.limits.auctionWakeMs : this.limits.wakeMs);
      let input = { text: observation(g, pid, trig) };
      let toolRuns = 0;
      for (let call = 0; call < this.limits.modelCalls; call++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('decision took too long');
        const res = await timeout(session.send(input), left, 'model call');
        s.calls++;
        s.spent += providers.cost(s.entry.id, res.usage || {});
        if (s.spent >= (g.settings.agentBudget ?? 0.5)) budgetHit = true;
        if (res.stop === 'refused') { done.push('(model declined)'); break; }
        if (!res.calls.length || g.status !== 'playing' || me.bankrupt) break;
        const results = [];
        let finished = false;
        for (const c of res.calls) {
          if (toolRuns++ >= this.limits.toolCalls) { results.push({ id: c.id, content: 'rejected: too many moves this decision', isError: true }); continue; }
          const r = run({ g, pid, persona: s.persona, seat: s, act: (msg) => { g.apply(pid, msg); this.onChange(); } }, c);
          if (c.name !== 'done') done.push(`${c.name} → ${r.content}`);
          if (r.done) finished = true;
          results.push({ id: c.id, content: r.content, isError: !!r.isError });
        }
        if (finished || budgetHit) break;
        input = { results };
      }
      s.errors = 0;
    } catch (e) {
      s.errors++;
      done.push(`(decision failed: ${String(e.message || e).slice(0, 80)})`);
      if (s.errors >= this.limits.errorsToAutopilot) this.autopilot(s, `${s.errors} failed decisions in a row (${String(e.message || e).slice(0, 60)})`);
    } finally {
      s.busy = false;
      if (done.length) g.memory.event(pid, `R${g.round} ${trig.kind}: ${done.join('; ')}`, g.now());
      if (budgetHit) this.autopilot(s, `spent its $${(g.settings.agentBudget ?? 0.5).toFixed(2)} API budget`);
      this.onChange();
    }
  }
}

module.exports = { AgentManager, LIMITS, MECHANICAL };
