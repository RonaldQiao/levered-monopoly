'use strict';
// Model providers for AI players. Each provider runs one short tool-use conversation ("session") per
// decision and keeps the provider-native message history inside the session:
//
//   const s = provider.session({ system, tools });          // tools: [{ name, description, schema }]
//   let r = await s.send({ text: observation });            // first turn
//   r = await s.send({ results: [{ id, content, isError }] }); // after running r.calls
//   r: { calls: [{ id, name, input }], text, stop: 'tool'|'end'|'refused'|'truncated', usage }
//
// Providers:
//   anthropic — Claude models through the official SDK (@anthropic-ai/sdk). Key: ANTHROPIC_API_KEY.
//   deepseek  — DeepSeek's OpenAI-compatible chat-completions API over fetch. Key: DEEPSEEK_API_KEY.
//               Base URL: DEEPSEEK_BASE_URL (default https://api.deepseek.com).
//   mock      — scripted, offline (tests; or AGENT_MOCK=1 to try the UI without any key).
//
// Keys stay on the server (environment variables); browsers never see them.

// US$ per million tokens, used only for each seat's spending cap. Approximate list prices: check your
// provider's pricing page and override with AGENT_PRICES='{"model":{"in":..,"out":..,"cacheRead":..}}'.
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'deepseek-chat': { in: 0.28, out: 0.42, cacheRead: 0.028 },
  'deepseek-reasoner': { in: 0.28, out: 0.42, cacheRead: 0.028 },
  mock: { in: 0, out: 0 },
};
function prices() {
  try { return { ...PRICES, ...(process.env.AGENT_PRICES ? JSON.parse(process.env.AGENT_PRICES) : {}) }; } catch { return PRICES; }
}
function cost(model, u) {
  const p = prices()[model] || { in: 1, out: 5 }; // unknown model: assume expensive, so caps bite early
  return ((u.in || 0) * p.in + (u.out || 0) * p.out + (u.cacheRead || 0) * (p.cacheRead ?? p.in) + (u.cacheWrite || 0) * (p.cacheWrite ?? p.in)) / 1e6;
}

const list = (v, d) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : d);

// Which models this server can offer, from the keys in its environment.
function catalog(env = process.env) {
  const out = [];
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    for (const m of list(env.ANTHROPIC_MODELS, ['claude-haiku-5-5'])) out.push({ id: m, provider: 'anthropic', label: m === 'claude-haiku-5-5' ? 'Claude Haiku 5.5' : m });
  }
  if (env.DEEPSEEK_API_KEY) {
    for (const m of list(env.DEEPSEEK_MODELS, ['deepseek-chat', 'deepseek-reasoner'])) out.push({ id: m, provider: 'deepseek', label: m === 'deepseek-chat' ? 'DeepSeek Chat' : m === 'deepseek-reasoner' ? 'DeepSeek Reasoner' : m });
  }
  if (env.AGENT_MOCK === '1') out.push({ id: 'mock', provider: 'mock', label: 'Offline mock (no API)' });
  return out;
}

// ------------------------------------------------------------------ Anthropic (official SDK)
function anthropicProvider(model, { client, timeoutMs = 25000, effort = 'low', maxTokens = 8000 } = {}) {
  let sdk = client;
  const getClient = () => {
    if (sdk) return sdk;
    const Anthropic = require('@anthropic-ai/sdk').default;
    sdk = new Anthropic(); // reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) from the environment
    return sdk;
  };
  return {
    model, provider: 'anthropic',
    session({ system, tools }) {
      const messages = [];
      const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
      return {
        async send(input) {
          if (input.text !== undefined) messages.push({ role: 'user', content: input.text });
          else messages.push({ role: 'user', content: input.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
          const res = await getClient().messages.create({
            model,
            max_tokens: maxTokens,
            // Stable for the whole game (rules + persona), so it is cached: tools render first, then this.
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            tools: apiTools,
            messages,
            output_config: { effort },
          }, { timeout: timeoutMs, maxRetries: 1 });
          // Keep the whole assistant turn (thinking blocks included) for the next request.
          messages.push({ role: 'assistant', content: res.content });
          const u = res.usage || {};
          const usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
          const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (res.stop_reason === 'refusal') return { calls: [], text, stop: 'refused', usage };
          if (res.stop_reason === 'max_tokens') return { calls: [], text, stop: 'truncated', usage }; // never run a cut-off call
          const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
          return { calls, text, stop: calls.length ? 'tool' : 'end', usage };
        },
      };
    },
  };
}

// ------------------------------------------------------------------ DeepSeek (OpenAI-compatible HTTP)
function deepseekProvider(model, { fetchImpl = globalThis.fetch, apiKey = process.env.DEEPSEEK_API_KEY, baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', timeoutMs = 30000 } = {}) {
  const reasoner = /reasoner/.test(model);
  let keepReasoning = reasoner; // some API versions want reasoning_content echoed during tool calls, others reject it
  return {
    model, provider: 'deepseek',
    session({ system, tools }) {
      const messages = [{ role: 'system', content: system }];
      const apiTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
      const post = async () => {
        const body = (keep) => JSON.stringify({
          model, messages: keep ? messages : messages.map(({ reasoning_content: _r, ...m }) => m),
          tools: apiTools, tool_choice: 'auto', max_tokens: reasoner ? 8000 : 2000, stream: false,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
          let res;
          try {
            res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST', signal: ctl.signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: body(keepReasoning),
            });
          } finally { clearTimeout(timer); }
          if (res.ok) return res.json();
          const err = await res.text().catch(() => '');
          if (res.status === 400 && /reasoning_content/i.test(err) && attempt === 0) { keepReasoning = !keepReasoning; continue; }
          throw new Error(`DeepSeek HTTP ${res.status}: ${err.slice(0, 200)}`);
        }
        throw new Error('DeepSeek request failed');
      };
      return {
        async send(input) {
          if (input.text !== undefined) messages.push({ role: 'user', content: input.text });
          else for (const r of input.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
          const data = await post();
          const choice = (data.choices || [])[0] || {};
          const msg = choice.message || {};
          const toolCalls = msg.tool_calls || [];
          const echo = { role: 'assistant', content: msg.content || '' };
          if (toolCalls.length) echo.tool_calls = toolCalls;
          if (msg.reasoning_content) echo.reasoning_content = msg.reasoning_content;
          messages.push(echo);
          const u = data.usage || {};
          const hit = u.prompt_cache_hit_tokens || 0;
          const usage = { in: (u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens || 0) - hit)), out: u.completion_tokens || 0, cacheRead: hit };
          if (choice.finish_reason === 'length') return { calls: [], text: msg.content || '', stop: 'truncated', usage };
          if (choice.finish_reason === 'content_filter') return { calls: [], text: '', stop: 'refused', usage };
          const calls = [];
          for (const c of toolCalls) {
            let args = {};
            try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = { __invalid: true }; }
            calls.push({ id: c.id, name: c.function?.name, input: args });
          }
          return { calls, text: msg.content || '', stop: calls.length ? 'tool' : 'end', usage };
        },
      };
    },
  };
}

// ------------------------------------------------------------------ Mock (offline, scripted)
// script(ctx) -> { calls: [{ name, input }] } | { text }. ctx = { turn, system, first, history }.
// The default script reads the wake-up reason from the observation and answers sensibly but simply.
function defaultScript(ctx) {
  if (ctx.turn > 0) return { text: 'Done for now.' };
  const t = ctx.first;
  const offer = /"id":"(T\d+|C\d+|X\d+)"/.exec(t.split('PENDING OFFERS TO YOU')[1] || '');
  if (/WAKE: offer/.test(t) && offer) return { calls: [{ name: 'respond_offer', input: { id: offer[1], accept: false } }, { name: 'send_chat', input: { text: 'Thanks, but that one does not work for me.', to: '' } }] };
  if (/WAKE: buy/.test(t)) return { calls: [{ name: 'buy_or_decline', input: { buy: true } }] };
  if (/WAKE: auction/.test(t)) return { calls: [{ name: 'auction', input: { max_bid: 0 } }] };
  if (/WAKE: chat/.test(t)) return { calls: [{ name: 'send_chat', input: { text: 'Noted. Make me a concrete offer.', to: '' } }] };
  return { calls: [{ name: 'done', input: {} }] };
}
function mockProvider(model = 'mock', { script = defaultScript, delayMs = 0 } = {}) {
  return {
    model, provider: 'mock',
    session({ system }) {
      let turn = 0; let first = ''; const history = [];
      return {
        async send(input) {
          if (input.text !== undefined) first = input.text;
          history.push(input);
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const out = await script({ turn: turn++, system, first, history, input });
          const calls = (out.calls || []).map((c, k) => ({ id: `m${turn}_${k}`, name: c.name, input: c.input || {} }));
          return { calls, text: out.text || '', stop: out.stop || (calls.length ? 'tool' : 'end'), usage: out.usage || { in: 0, out: 0 } };
        },
      };
    },
  };
}

function createProvider(entry, opts = {}) {
  if (entry.provider === 'anthropic') return anthropicProvider(entry.id, opts.anthropic);
  if (entry.provider === 'deepseek') return deepseekProvider(entry.id, opts.deepseek);
  if (entry.provider === 'mock') return mockProvider(entry.id, { delayMs: Number(process.env.AGENT_MOCK_DELAY) || 0, ...opts.mock });
  throw new Error(`Unknown provider ${entry.provider}`);
}

module.exports = { catalog, createProvider, anthropicProvider, deepseekProvider, mockProvider, cost, prices, PRICES };
