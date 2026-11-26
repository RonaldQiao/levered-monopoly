'use strict';
// Prompt-injection ban. Margin Call's table rule: talk is for negotiating with players, never for
// instructing the AI players' models. Every chat message, direct message, player name and contract name
// passes through check() before anyone (human or AI) sees it; a hit is rejected with a GameError and
// counts as a strike against the sender (three strikes and they are muted for the rest of the game).
//
// This is the first of three layers (see src/agents/view.js and src/agents/manager.js for the others):
//   1. Ban at the door: obvious injection attempts never reach any player or model.
//   2. Quarantine: whatever text does get through reaches a model only as JSON-escaped data inside a
//      randomly-named <untrusted_*> block, under a system prompt that says it is never instructions.
//   3. Capability limits: a model can only act through game tools the engine validates, and the agent
//      runner refuses trades that give away much more value than they bring in, so talking an AI into a
//      "gift" fails even if the words get through.

// Invisible / direction-changing characters used to hide payloads: rejected outright.
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]|[\u{E0000}-\u{E007F}]/u;

// Patterns on the normalized text (lowercase, NFKC, look-alike digits mapped, spacing collapsed).
const PATTERNS = [
  ['override', /\b(ignore|disregard|forget|override|bypass|skip|drop|abandon)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the|these|those|original|initial|system)\b[^.!?\n]{0,25}\b(instructions?|rules?|prompts?|guidelines?|directions?|directives?|programming|persona|constraints?|guardrails?|policy|policies|messages?)\b/],
  ['override', /\b(ignore|disregard|forget)\s+(everything|all)\b/],
  ['new-instructions', /\b(new|updated|real|actual|true|hidden|secret|special|admin|developer|override)\s+(instructions?|system\s*prompt|prompt|directives?|orders|rules\s+for\s+you)\b/],
  ['role', /\b(system|developer)\s*(prompt|message|instructions?|note|override)\b/],
  ['role', /(^|\n)\s*(system|assistant|developer|user|human|tool)\s*:/],
  ['role-change', /\byou\s+are\s+(now|no\s+longer|actually|really)\b/],
  ['role-change', /\bfrom\s+now\s+on,?\s+(you|your)\b/],
  ['role-change', /\b(pretend|roleplay|role-play|imagine)\s+(to\s+be|you\s+are|that\s+you|you're)\b/],
  ['role-change', /\b(your|the)\s+(new\s+)?(persona|personality|character|role)\s+(is|will\s+be|=)\b/],
  ['jailbreak', /\b(jailbreak|jail\s*broken|dan\s+mode|developer\s+mode|god\s+mode|prompt\s*injection|do\s+anything\s+now)\b/],
  ['model-talk', /\b(as\s+an?\s+)?(ai|a\.i\.|llm|language\s+model|chatbot|assistant|model)\b[^.!?\n]{0,30}\b(you\s+must|you\s+should|you\s+have\s+to|you\s+need\s+to|you\s+will|instructed|required)\b/],
  ['model-talk', /\b(you\s+must|you\s+have\s+to|you\s+are\s+required\s+to|you\s+are\s+instructed\s+to)\b[^.!?\n]{0,30}\b(as\s+an?\s+)?(ai|llm|language\s+model|assistant|model)\b/],
  ['model-talk', /\b(chatgpt|openai|anthropic|claude|deepseek|gpt-?\d|haiku|sonnet|opus)\b/],
  ['model-talk', /\b(tool[_\s-]?(call|use|result)s?|function[_\s-]?calls?|tool_choice|max_tokens|temperature|context\s+window)\b/],
  ['model-talk', /\b(call|use|invoke|run|trigger)\s+(the\s+|your\s+|a\s+)?(tool|function|command)\b/],
  // The AI players' own tool names, and API-style identifiers (names like "cool_guy" are fine).
  ['markup', /\b(buy_or_decline|sell_building|propose_trade|respond_offer|cancel_offer|desk_close|send_chat|value_trade|property_value|loan_cost)\b/],
  ['markup', /\b[a-z]+_(calls?|use|results?|choice|tokens|prompts?|messages?|instructions?|roles?|content|schema|args|arguments)\b/],
  ['reveal', /\b(reveal|print|show|repeat|output|tell\s+me|what\s+(is|are))\b[^.!?\n]{0,25}\b(your|the)\s+(system\s+)?(prompt|instructions|rules\s+you|hidden|persona\s+file)\b/],
  ['markup', /<\s*\/?\s*(system|assistant|user|human|tool|developer|instructions?|untrusted[\w-]*|im_start|im_end|s|inst|sys|prompt|context|data|message|chat|function[\w-]*)\b[^>]*>/],
  ['markup', /<\|[^|>]{0,40}\|>/],
  ['markup', /\[\s*\/?\s*(inst|sys|system|assistant|user)\s*\]/],
  ['markup', /```|~~~/],
  ['markup', /\{\s*"(name|tool|function|action|arguments|role|content|type)"\s*:/],
  ['encoded', /[a-z0-9+/]{48,}={0,2}/],
  ['encoded', /(\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|&#x?[0-9a-f]+;|%[0-9a-f]{2}){4,}/],
];

// Same ideas with all spacing and punctuation removed, to catch "i g n o r e  a l l . . ." tricks.
const COLLAPSED = [
  /ignore(all|any)?(the|your|my)?(previous|prior|above|earlier|system|original)?(instructions|rules|prompt|prompts|guidelines)/,
  /disregard(all|any)?(the|your)?(previous|prior|above|earlier|system)?(instructions|rules|prompt)/,
  /forget(all|everything|your)(previous|prior|instructions|rules)/,
  /systemprompt|newinstructions|developermode|jailbreak|promptinjection|youarenow/,
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[01345@7$](?=[a-z])|(?<=[a-z])[01345@7$]/g, (c) => LEET[c] || c)
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ');
}

// Returns { ok: true } or { ok: false, reason } — reason is a short category, safe to show.
function check(text) {
  const raw = String(text || '');
  if (HIDDEN.test(raw)) return { ok: false, reason: 'hidden or control characters' };
  const n = normalize(raw);
  for (const [why, re] of PATTERNS) if (re.test(n)) return { ok: false, reason: why };
  const collapsed = n.replace(/[^a-z]/g, '');
  for (const re of COLLAPSED) if (re.test(collapsed)) return { ok: false, reason: 'override' };
  return { ok: true };
}

const REASONS = {
  override: 'tries to override instructions',
  'new-instructions': 'claims to give new instructions',
  role: 'imitates a system or role message',
  'role-change': 'tries to change who a player is',
  jailbreak: 'jailbreak wording',
  'model-talk': 'addresses the AI model instead of the player',
  reveal: 'asks for hidden instructions',
  markup: 'prompt or code markup',
  encoded: 'encoded payload',
  'hidden or control characters': 'hidden characters',
};
const explain = (reason) => REASONS[reason] || reason;

// For text that has passed check() but still goes into a prompt: strip anything structural, cap length.
// (JSON.stringify of the result is what a model sees, so quotes and newlines are escaped as well.)
function sanitize(text, max = 200) {
  return String(text || '').normalize('NFKC').replace(HIDDEN, '').replace(/[<>`{}[\]|\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = { check, sanitize, normalize, explain, STRIKES_TO_MUTE: 3 };
