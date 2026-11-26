'use strict';
// The tools a model-driven AI player can call. Each maps onto one engine action (game.apply), so the
// model plays by exactly the same rules as a human; a rule violation comes back as "rejected: <why>".
//
// Capability limits (prompt-injection layer 3, see guard.js): there is no tool for anything outside the
// game, and the risk controls below refuse a trade or deal that hands an opponent far more value than it
// brings in — so even a model that has been sweet-talked can't give the game away.
const { GameError } = require('../engine');
const bot = require('../bot');
const { SPACES } = require('../board');

const S = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required, additionalProperties: false });
const int = (description) => ({ type: 'integer', description });
const str = (description) => ({ type: 'string', description });
const ints = (description) => ({ type: 'array', items: { type: 'integer' }, description });
const side = {
  give_cash: int('Cash you give'), give_spaces: ints('Space indices you give'),
  get_cash: int('Cash you get'), get_spaces: ints('Space indices you get'),
};

const TOOLS = [
  { name: 'done', description: 'Finish this decision. Call it when you have nothing more to do right now.', schema: S({}) },
  { name: 'buy_or_decline', description: 'You landed on an unowned property: buy it at list price, or decline (it then goes to auction).', schema: S({ buy: { type: 'boolean' } }) },
  { name: 'auction', description: 'Set your auction bid. Sealed auctions: this is your one bid. Open auctions: the most you will pay; you will be kept as high bidder up to this amount. 0 = pass.', schema: S({ max_bid: int('Dollars; 0 to pass') }) },
  { name: 'build', description: 'Build one house (or hotel after 4) on a space in a colour set you own; build evenly.', schema: S({ space: int('Space index') }) },
  { name: 'sell_building', description: 'Sell one building back to the bank for half its cost.', schema: S({ space: int('Space index') }) },
  { name: 'mortgage', description: 'Mortgage a property you own (no buildings in its set) for cash.', schema: S({ space: int('Space index') }) },
  { name: 'unmortgage', description: 'Lift a mortgage (repay it plus 10%).', schema: S({ space: int('Space index') }) },
  { name: 'borrow', description: 'Borrow from the central bank.', schema: S({ amount: int('Dollars'), term: { type: 'integer', enum: [5, 10, 20] }, kind: { type: 'string', enum: ['fixed', 'floating'] } }) },
  { name: 'repay', description: 'Repay part or all of a bank loan.', schema: S({ loan_id: str('Loan id, e.g. L12'), amount: int('Dollars') }) },
  { name: 'propose_trade', description: 'Offer a trade of cash and properties to another player. They answer later.', schema: S({ to: str('Player id'), ...side }) },
  { name: 'respond_offer', description: 'Accept or reject a pending trade (T...), contract (C...) or deal (X...) offered to you.', schema: S({ id: str('Offer id'), accept: { type: 'boolean' } }) },
  { name: 'cancel_offer', description: 'Withdraw a trade offer you made.', schema: S({ id: str('Your trade id') }) },
  {
    name: 'desk', description: 'Trade with the bank desk. product: shares | short | call | put | cds | insurance | swap. ref = player id the instrument is on (not for insurance/swap).',
    schema: S({
      product: { type: 'string', enum: ['shares', 'short', 'call', 'put', 'cds', 'insurance', 'swap'] },
      ref: str('Player id, or "" if not needed'), shares: int('Shares (shares/short/call/put), else 0'),
      strike: { type: 'number', description: 'Option strike per share, else 0' }, term: { type: 'integer', enum: [5, 10, 20] },
      notional: int('CDS/swap notional, else 0'), deductible: { type: 'integer', enum: [0, 100, 250, 500] },
      side: { type: 'string', enum: ['', 'payFixed', 'receiveFixed'] },
    }),
  },
  { name: 'desk_close', description: 'Close one of your desk positions with the bank.', schema: S({ id: str('Position id, e.g. D7') }) },
  { name: 'send_chat', description: 'Say something at the table (to = "") or privately to one player (to = player id). Under 200 characters, about the game.', schema: S({ text: str('Message'), to: str('Player id for a direct message, or "" for everyone') }) },
  { name: 'note', description: 'Remember something about an opponent until the end of this round (only you can see it).', schema: S({ about: str('Player id'), text: str('What to remember, under 200 characters') }) },
];
const CALCULATORS = [
  { name: 'value_trade', description: 'Estimate what a trade is worth to you and to the other player (strategic value of properties incl. set completion, plus cash).', schema: S({ to: str('Player id'), ...side }) },
  { name: 'property_value', description: 'Strategic value of a space to you (set completion, blocking, rents), vs its list price.', schema: S({ space: int('Space index') }) },
  { name: 'loan_cost', description: 'Rate and per-round interest for a loan you could take now.', schema: S({ amount: int('Dollars'), term: { type: 'integer', enum: [5, 10, 20] }, kind: { type: 'string', enum: ['fixed', 'floating'] } }) },
];

function toolsFor(persona) { return persona.calculating ? [...TOOLS, ...CALCULATORS] : TOOLS.slice(); }

// Risk controls: the most value a trade/deal may hand away, as a share of the agent's net worth.
// Aggressive and gut-feel personas get more rope; nobody can be talked into giving the game away.
function giveawayLimit(g, me, persona) {
  const nw = Math.max(200, g.netWorth(me));
  const pct = persona.risk === 'aggressive' ? 0.15 : persona.risk === 'conservative' ? 0.05 : 0.1;
  return Math.round(nw * pct);
}

const ok = (content, extra = {}) => ({ content: `ok: ${content}`, ...extra });
const no = (content) => ({ content: `rejected: ${content}`, isError: true });
const sideOf = (x) => ({ cash: Math.max(0, x.give_cash | 0), spaces: (x.give_spaces || []).map(Number) });
const getOf = (x) => ({ cash: Math.max(0, x.get_cash | 0), spaces: (x.get_spaces || []).map(Number) });

// ctx: { g, pid, persona, seat, act(msg) }  — act() runs game.apply for this player and returns nothing.
function run(ctx, call) {
  const { g, pid, persona, seat } = ctx;
  const me = g.player(pid);
  const x = call.input || {};
  if (x.__invalid) return no('arguments were not valid JSON');
  const allowed = toolsFor(persona).some((t) => t.name === call.name);
  if (!allowed) return no(`unknown tool ${call.name}`);
  const act = (msg, what) => { ctx.act(msg); return ok(what, { changed: true }); };
  try {
    switch (call.name) {
      case 'done': return ok('finished', { done: true });
      case 'buy_or_decline': return act({ action: x.buy ? 'buy' : 'decline' }, x.buy ? 'bought' : 'declined');
      case 'auction': {
        const a = g.auction;
        if (!a || !a.active.includes(pid)) return no('you are not in an auction');
        const max = Math.max(0, Math.floor(Number(x.max_bid) || 0));
        if (max <= 0) return act({ action: 'passAuction' }, 'passed');
        if (a.sealed) return act({ action: 'bid', amount: max }, `sealed bid of $${max} submitted`);
        seat.auctionLimit = { key: `${a.lots.join(',')}-${a.kind}`, max };
        return ok(`you will bid up to $${max}`, { changed: true });
      }
      case 'build': return act({ action: 'build', space: x.space }, `built on ${SPACES[x.space]?.name}`);
      case 'sell_building': return act({ action: 'sell', space: x.space }, `sold a building on ${SPACES[x.space]?.name}`);
      case 'mortgage': return act({ action: 'mortgage', space: x.space }, `mortgaged ${SPACES[x.space]?.name}`);
      case 'unmortgage': return act({ action: 'unmortgage', space: x.space }, `unmortgaged ${SPACES[x.space]?.name}`);
      case 'borrow': return act({ action: 'borrow', amount: x.amount, term: x.term, kind: x.kind }, `borrowed $${x.amount}`);
      case 'repay': return act({ action: 'repay', loanId: x.loan_id, amount: x.amount }, `repaid $${x.amount}`);
      case 'propose_trade': {
        const t = { from: pid, to: String(x.to), give: { ...sideOf(x), jailCards: 0 }, get: { ...getOf(x), jailCards: 0 } };
        const { fromDelta, toDelta } = bot.tradeDeltas(g, t);
        const lim = giveawayLimit(g, me, persona);
        if (fromDelta < -lim) return no(`your risk controls stop this: by the numbers you would give away about $${Math.round(-fromDelta)} of value (limit $${lim})`);
        ctx.act({ action: 'proposeTrade', trade: { to: t.to, give: t.give, get: t.get } });
        return ok(`trade offered to ${t.to} (worth about $${Math.round(fromDelta)} to you, $${Math.round(toDelta)} to them)`, { changed: true });
      }
      case 'respond_offer': {
        const id = String(x.id);
        const accept = !!x.accept;
        if (id.startsWith('T')) {
          const t = g.trades.find((y) => y.id === id && y.status === 'pending' && y.to === pid);
          if (!t) return no('no such trade offered to you');
          if (accept) {
            const { toDelta } = bot.tradeDeltas(g, t);
            const lim = giveawayLimit(g, me, persona);
            if (toDelta < -lim) return no(`your risk controls stop this: by the numbers it costs you about $${Math.round(-toDelta)} of value (limit $${lim}). Reject it or ask for more.`);
          }
          return act({ action: accept ? 'acceptTrade' : 'rejectTrade', id }, accept ? 'trade accepted' : 'trade rejected');
        }
        if (id.startsWith('C')) return act({ action: accept ? 'acceptContract' : 'rejectContract', id }, accept ? 'contract accepted' : 'contract rejected');
        if (id.startsWith('X')) {
          const d = (g.deals || []).find((y) => y.id === id && y.status === 'pending');
          if (!d) return no('no such deal');
          if (accept) {
            const { delta } = bot.dealDeltas(g, d, pid);
            const lim = giveawayLimit(g, me, persona);
            if (delta[pid] < -lim) return no(`your risk controls stop this: it costs you about $${Math.round(-delta[pid])} of value (limit $${lim})`);
          }
          return act({ action: accept ? 'acceptDeal' : 'rejectDeal', id }, accept ? 'deal accepted' : 'deal rejected');
        }
        return no('unknown offer id');
      }
      case 'cancel_offer': return act({ action: 'cancelTrade', id: String(x.id) }, 'offer withdrawn');
      case 'desk': {
        const order = { product: x.product };
        if (x.ref) order.ref = x.ref;
        for (const k of ['shares', 'strike', 'term', 'notional', 'deductible']) if (x[k]) order[k] = x[k];
        if (x.side) order.side = x.side;
        return act({ action: 'deskBuy', order }, `desk trade done: ${x.product}`);
      }
      case 'desk_close': return act({ action: 'deskClose', id: String(x.id) }, 'position closed');
      case 'send_chat': {
        if ((seat.chatsThisWake = (seat.chatsThisWake || 0) + 1) > 2) return no('at most two messages per decision');
        return act({ action: 'chat', text: String(x.text || ''), ...(x.to ? { to: String(x.to) } : {}) }, x.to ? `message sent to ${x.to}` : 'said at the table');
      }
      case 'note': {
        g.memory.note(pid, String(x.about || ''), String(x.text || ''), g.now());
        return ok('noted until the end of the round');
      }
      case 'value_trade': {
        const t = { from: pid, to: String(x.to), give: { ...sideOf(x), jailCards: 0 }, get: { ...getOf(x), jailCards: 0 } };
        g.player(t.to);
        const { fromDelta, toDelta } = bot.tradeDeltas(g, t);
        return ok(`value to you about $${Math.round(fromDelta)}, to ${t.to} about $${Math.round(toDelta)}`);
      }
      case 'property_value': {
        const i = Number(x.space);
        if (!SPACES[i] || !g.props[i]) return no('not a property');
        return ok(`${SPACES[i].name}: worth about $${Math.round(bot.worth(g, pid, i))} to you; list price $${g.price(i)}; owner ${g.props[i].owner || 'none'}`);
      }
      case 'loan_cost': {
        const rate = g.quote(me, Number(x.term) || 10, 0, x.kind === 'floating' ? 'floating' : 'fixed');
        return ok(`${x.kind || 'fixed'} ${x.term}-round loan of $${x.amount}: ${rate}%/round, about $${Math.round(((Number(x.amount) || 0) * rate) / 100)} interest per round; you can borrow up to $${g.borrowHeadroom(me)} more`);
      }
      default: return no(`unknown tool ${call.name}`);
    }
  } catch (e) {
    if (e instanceof GameError) return no(e.message);
    throw e;
  }
}

module.exports = { TOOLS, CALCULATORS, toolsFor, run, giveawayLimit };
