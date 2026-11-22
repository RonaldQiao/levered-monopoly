'use strict';
const { GROUPS, SPACES, OWNABLE, JAIL_INDEX, GROUP_MEMBERS, TRANSITS, UTILITIES } = require('./board');
const { EVENT_CARDS, TREASURY_CARDS } = require('./cards');

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round2 = (x) => Math.round(x * 100) / 100;
const toInt = (x, name = 'value') => {
  const n = Number(x);
  if (!Number.isFinite(n)) fail(`Invalid ${name}`);
  return Math.floor(n);
};
const toNum = (x, name = 'value') => {
  const n = Number(x);
  if (!Number.isFinite(n)) fail(`Invalid ${name}`);
  return n;
};

const TOKENS = [
  { token: '🐂', color: '#2ecc71' }, { token: '🐻', color: '#e74c3c' },
  { token: '🦈', color: '#3498db' }, { token: '🐋', color: '#9b59b6' },
  { token: '🦊', color: '#e67e22' }, { token: '🦉', color: '#f1c40f' },
  { token: '🐺', color: '#95a5a6' }, { token: '🦅', color: '#1abc9c' },
];

const DEFAULT_SETTINGS = {
  startingCash: 1500,
  maxLeverage: 3,      // assets / equity cap for central-bank borrowing (1 = no borrowing)
  auctions: true,
  salary: 200,
  neutralRate: 1.5,    // % per round, neutral REAL policy rate (nominal anchor = neutral + target inflation)
  inflationTarget: 0.5 // % per round
};

const LOAN_TERMS = [5, 10, 20];
const FLOAT_MARGIN = 0.25;                          // floating loans: policy rate + this + credit spread
const FIXED_PREMIUM = { 5: 0.25, 10: 0.35, 20: 0.5 }; // extra cost of locking a fixed rate
const BAIL = 50;
const AUCTION_START_MS = 25000;
const AUCTION_BID_MS = 12000;

const CLAUSE_KINDS = ['upfront', 'fixed', 'rate', 'rentShare', 'equity', 'maturity', 'default', 'call', 'put', 'collateral'];

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor(code, opts = {}) {
    this.code = code;
    this.rng = opts.rng || Math.random;
    this.now = opts.now || (() => Date.now());
    this.status = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = [];
    this.props = {};
    this.trades = [];
    this.contracts = [];
    this.log = [];
    this.nextId = 1;
    this.version = 0;
    this.round = 0;
    this.turn = null;
    this.auction = null;
    this.lastRoll = null;
    this.lastCard = null;
    this.winner = null;
  }

  id(prefix) { return `${prefix}${this.nextId++}`; }

  addLog(msg, kind = 'info') {
    this.log.push({ t: this.now(), round: this.round, msg, kind });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  // ---------------------------------------------------------------- lobby
  addPlayer(name, opts = {}) {
    if (this.status !== 'lobby') fail('Game already started');
    if (this.players.length >= 8) fail('Room is full (8 players)');
    name = String(name || '').trim().slice(0, 20) || `Player ${this.players.length + 1}`;
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('Name already taken');
    const used = new Set(this.players.map((p) => p.token));
    const t = TOKENS.find((x) => !used.has(x.token));
    const p = {
      id: this.id('p'), name, token: t.token, color: t.color,
      host: !opts.bot && !this.players.some((x) => x.host),
      bot: !!opts.bot,
      cash: 0, pos: 0, inJail: false, jailTurns: 0, jailCards: [],
      loans: [], bankrupt: false, marginCall: false, connected: true,
    };
    this.players.push(p);
    this.addLog(`${p.name} ${p.bot ? '(AI) ' : ''}joined the room.`);
    return p;
  }

  addBot(pid) {
    this.requireHost(pid);
    const names = ['Ada', 'Keynes', 'Fisher', 'Minsky', 'Volcker', 'Ricardo', 'Hayek', 'Samuelson'];
    const name = names.map((n) => `${n} (AI)`).find((n) => !this.players.some((p) => p.name === n));
    return this.addPlayer(name || `Bot ${this.players.length + 1}`, { bot: true });
  }

  removeBot(pid, target) {
    this.requireHost(pid);
    const b = this.player(target);
    if (!b.bot) fail('That player is not a bot');
    this.removeLobbyPlayer(b.id);
  }

  removeLobbyPlayer(pid) {
    if (this.status !== 'lobby') return;
    const i = this.players.findIndex((p) => p.id === pid);
    if (i < 0) return;
    const [p] = this.players.splice(i, 1);
    const heir = this.players.find((x) => !x.bot);
    if (p.host && heir) heir.host = true;
    this.addLog(`${p.name} left the room.`);
  }

  updateSettings(pid, s) {
    this.requireHost(pid);
    if (this.status !== 'lobby') fail('Settings are locked once the game starts');
    if (s.startingCash !== undefined) this.settings.startingCash = clamp(toInt(s.startingCash), 500, 5000);
    if (s.maxLeverage !== undefined) this.settings.maxLeverage = clamp(toNum(s.maxLeverage), 1, 10);
    if (s.auctions !== undefined) this.settings.auctions = !!s.auctions;
    if (s.salary !== undefined) this.settings.salary = clamp(toInt(s.salary), 50, 1000);
  }

  start(pid) {
    this.requireHost(pid);
    if (this.status !== 'lobby') fail('Already started');
    if (this.players.length < 2) fail('Need at least 2 players');
    this.players = shuffle(this.players, this.rng);
    for (const p of this.players) p.cash = this.settings.startingCash;
    SPACES.forEach((s) => {
      if (OWNABLE.has(s.type)) this.props[s.index] = { owner: null, houses: 0, mortgaged: false, mortgageAmt: 0 };
    });
    this.decks = {
      event: shuffle(EVENT_CARDS.map((_, i) => i), this.rng),
      treasury: shuffle(TREASURY_CARDS.map((_, i) => i), this.rng),
    };
    this.bankHouses = 32;
    this.bankHotels = 12;
    this.econ = {
      priceLevel: 1, policyRate: this.settings.neutralRate + this.settings.inflationTarget, inflation: this.settings.inflationTarget,
      heat: 50, heatShock: 0, roundSpending: 0, prevCredit: 0, fiscal: 'neutral',
      components: { velocity: 50, creditGrowth: 50, creditLevel: 0, development: 0 },
      bankLosses: 0, history: [],
    };
    this.status = 'playing';
    this.initDesk();
    this.round = 0;
    this.recordHistory(); // round 0 = opening conditions
    this.round = 1;
    this.turn = this.freshTurn(0);
    this.addLog(`Game started! Turn order: ${this.players.map((p) => p.name).join(' → ')}.`, 'system');
    this.addLog(`Central bank policy rate opens at ${this.econ.policyRate.toFixed(2)}% per round.`, 'econ');
  }

  freshTurn(idx) {
    return { idx, phase: 'roll', doubles: 0, extraRoll: false, pendingBuy: null };
  }

  // ---------------------------------------------------------------- helpers
  player(pid) {
    const p = this.players.find((x) => x.id === pid);
    if (!p) fail('Unknown player');
    return p;
  }
  current() { return this.players[this.turn.idx]; }
  active() { return this.players.filter((p) => !p.bankrupt); }
  requireHost(pid) { if (!this.player(pid).host) fail('Only the host can do that'); }
  requirePlaying() { if (this.status !== 'playing') fail('Game is not in progress'); }
  requireAlive(p) { if (p.bankrupt) fail('You are bankrupt'); }
  requireTurn(p) { if (this.current().id !== p.id) fail('Not your turn'); }

  get P() { return this.econ ? this.econ.priceLevel : 1; }
  scale(n) { return Math.round(n * this.P); }
  price(i) { return this.scale(SPACES[i].price); }
  houseCost(i) { return this.scale(GROUPS[SPACES[i].group].houseCost); }
  salary() { return Math.round(this.settings.salary * this.P * (this.econ.fiscal === 'stimulus' ? 1.25 : 1)); }
  taxAmount(i) { return Math.round(SPACES[i].amount * this.P * (this.econ.fiscal === 'surtax' ? 1.5 : 1)); }
  bail() { return this.scale(BAIL); }
  mortgageValue(i) { return Math.round(this.price(i) / 2); }

  ownsGroup(pid, group) { return GROUP_MEMBERS[group].every((i) => this.props[i].owner === pid); }
  groupHasBuildings(group) { return GROUP_MEMBERS[group].some((i) => this.props[i].houses > 0); }
  ownedBy(pid) { return Object.keys(this.props).map(Number).filter((i) => this.props[i].owner === pid); }

  rentFor(i, diceTotal, opts = {}) {
    const s = SPACES[i]; const pr = this.props[i];
    if (!pr.owner || pr.mortgaged) return 0;
    if (s.type === 'street') {
      let base = s.rent[pr.houses];
      if (pr.houses === 0 && this.ownsGroup(pr.owner, s.group)) base *= 2;
      return this.scale(base);
    }
    if (s.type === 'transit') {
      const n = TRANSITS.filter((t) => this.props[t].owner === pr.owner).length;
      return this.scale(25 * 2 ** (n - 1)) * (opts.transitMult || 1);
    }
    if (s.type === 'utility') {
      const n = UTILITIES.filter((u) => this.props[u].owner === pr.owner).length;
      const mult = opts.utilityTenX ? 10 : (n === 2 ? 10 : 4);
      return this.scale(mult * diceTotal);
    }
    return 0;
  }

  // ---------------------------------------------------------------- balance sheet
  propertyValue(pid) {
    let v = 0;
    for (const i of this.ownedBy(pid)) {
      v += this.price(i);
      if (SPACES[i].type === 'street') v += this.props[i].houses * this.houseCost(i);
    }
    return v;
  }
  mortgageDebt(pid) { return this.ownedBy(pid).reduce((a, i) => a + (this.props[i].mortgaged ? this.props[i].mortgageAmt : 0), 0); }
  bankDebt(p) { return p.loans.reduce((a, l) => a + l.principal, 0); }
  assets(p) { return p.cash + this.propertyValue(p.id); }
  bookEquity(p) { return this.assets(p) - this.bankDebt(p) - this.mortgageDebt(p.id); }
  leverage(p) {
    const eq = this.bookEquity(p);
    if (eq <= 0) return Infinity;
    return Math.max(0, this.assets(p)) / eq;
  }
  maxLoan(p) {
    const eq = this.bookEquity(p);
    if (eq <= 0) return 0;
    return Math.floor((this.settings.maxLeverage - 1) * eq);
  }
  borrowHeadroom(p) { return Math.max(0, this.maxLoan(p) - this.bankDebt(p)); }
  inBreach(p) { return this.bankDebt(p) > this.maxLoan(p); }

  // Equity stakes shift economic net worth between players (scored on book equity of issuer).
  netWorth(p) {
    let nw = this.bookEquity(p);
    for (const c of this.contracts) {
      if (c.status !== 'active') continue;
      for (const cl of c.clauses) {
        if (cl.kind !== 'equity') continue;
        if (cl.to === p.id) nw += (cl.pct / 100) * Math.max(0, this.bookEquity(this.player(cl.from)));
        if (cl.from === p.id) nw -= (cl.pct / 100) * Math.max(0, this.bookEquity(p));
      }
    }
    if (this.desk) nw += this.deskValue(p);
    return Math.round(nw);
  }

  // Central-bank yield curve: short end = policy rate, long end anchored to neutral + term premium.
  curveRate(term) {
    const w = 5 / term;
    const premium = { 5: 0.25, 10: 0.5, 20: 1.0 }[term];
    return w * this.econ.policyRate + (1 - w) * (this.settings.neutralRate + this.settings.inflationTarget) + premium;
  }
  creditSpread(p, extra = 0) {
    const eq = this.bookEquity(p);
    const lev = eq > 0 ? (this.assets(p) + extra) / eq : 10;
    return 0.5 * Math.max(0, lev - 1);
  }
  // Floating = policy + 0.25% + credit spread, reset every round.
  // Fixed = max(curve, floating base) + a lock-in premium + credit spread, so fixed always costs more at signing.
  quote(p, term, extra = 0, kind = 'fixed') {
    const spread = this.creditSpread(p, extra);
    const base = this.econ.policyRate + FLOAT_MARGIN;
    const r = kind === 'floating' ? base : Math.max(this.curveRate(term), base) + FIXED_PREMIUM[term];
    return Math.round((r + spread) * 20) / 20;
  }

  // ---------------------------------------------------------------- money movement
  pay(fromId, toId, amount, reason, { spending = false } = {}) {
    amount = Math.round(amount);
    if (amount <= 0) return 0;
    if (fromId) this.player(fromId).cash -= amount;
    if (toId) this.player(toId).cash += amount;
    if (spending && this.econ) this.econ.roundSpending += amount;
    const f = fromId ? this.player(fromId).name : 'Bank';
    const t = toId ? this.player(toId).name : 'Bank';
    if (reason) this.addLog(`${f} → ${t}: $${amount} (${reason})`, 'money');
    return amount;
  }

  onRentReceived(ownerId, space, amount) {
    for (const c of this.contracts) {
      if (c.status !== 'active') continue;
      for (const cl of c.clauses) {
        if (cl.from !== ownerId) continue;
        if (cl.kind === 'rentShare' && (cl.spaces.length === 0 || cl.spaces.includes(space))) {
          this.pay(ownerId, cl.to, amount * cl.pct / 100, `${c.name}: ${cl.pct}% rent share`);
        } else if (cl.kind === 'equity') {
          this.pay(ownerId, cl.to, amount * cl.pct / 100, `${c.name}: ${cl.pct}% equity dividend`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- movement
  moveBy(p, n) {
    const dest = (p.pos + n) % 40;
    if (dest < p.pos || dest === 0) this.collectSalary(p);
    p.pos = dest;
    this.addLog(`${p.name} moves to ${SPACES[dest].name}.`, 'move');
    this.resolveLanding(p);
  }

  moveTo(p, dest, opts = {}) {
    if (dest <= p.pos || dest === 0) this.collectSalary(p);
    p.pos = dest;
    this.addLog(`${p.name} moves to ${SPACES[dest].name}.`, 'move');
    this.resolveLanding(p, opts);
  }

  collectSalary(p) {
    const s = this.salary();
    this.pay(null, p.id, s, this.econ.fiscal === 'stimulus' ? 'PAYDAY salary + fiscal stimulus' : 'PAYDAY salary');
  }

  sendToJail(p) {
    p.pos = JAIL_INDEX; p.inJail = true; p.jailTurns = 0;
    if (this.turn && this.current().id === p.id) this.turn.extraRoll = false;
    this.addLog(`${p.name} is sent to Lockup!`, 'warn');
  }

  resolveLanding(p, opts = {}) {
    const i = p.pos; const s = SPACES[i];
    if (OWNABLE.has(s.type)) {
      const pr = this.props[i];
      if (!pr.owner) {
        this.turn.phase = 'buy';
        this.turn.pendingBuy = i;
        return;
      }
      if (pr.owner === p.id) return;
      if (pr.mortgaged) { this.addLog(`${s.name} is mortgaged — no rent due.`); return; }
      let dice = this.lastRoll ? this.lastRoll.dice[0] + this.lastRoll.dice[1] : 7;
      if (opts.utilityTenX) {
        const d = [this.die(), this.die()];
        dice = d[0] + d[1];
        this.addLog(`${p.name} rolls ${d[0]}+${d[1]} for the utility bill.`);
      }
      const rent = this.rentFor(i, dice, opts);
      this.pay(p.id, pr.owner, rent, `rent on ${s.name}`, { spending: true });
      this.onRentReceived(pr.owner, i, rent);
      this.onRentPaid(p.id, rent);
      return;
    }
    if (s.type === 'tax') { this.pay(p.id, null, this.taxAmount(i), s.name, { spending: true }); return; }
    if (s.type === 'gotojail') { this.sendToJail(p); return; }
    if (s.type === 'event' || s.type === 'treasury') { this.drawCard(p, s.type); }
  }

  drawCard(p, deck) {
    const list = deck === 'event' ? EVENT_CARDS : TREASURY_CARDS;
    const order = this.decks[deck];
    const idx = order.shift();
    const card = list[idx];
    if (card.type !== 'jailCard') order.push(idx);
    this.lastCard = { deck, text: card.text, player: p.id, seq: this.nextId++ };
    this.addLog(`${p.name} draws ${deck === 'event' ? 'Market Event' : 'Town Treasury'}: “${card.text}”`, 'card');
    switch (card.type) {
      case 'advance': this.moveTo(p, card.to); break;
      case 'nearest': {
        const list2 = card.kind === 'transit' ? TRANSITS : UTILITIES;
        const dest = list2.find((x) => x > p.pos) ?? list2[0];
        this.moveTo(p, dest, card.kind === 'transit' ? { transitMult: 2 } : { utilityTenX: true });
        break;
      }
      case 'back': p.pos = (p.pos + 37) % 40; this.addLog(`${p.name} moves back to ${SPACES[p.pos].name}.`, 'move'); this.resolveLanding(p); break;
      case 'jail': this.sendToJail(p); break;
      case 'collect': this.pay(null, p.id, this.scale(card.amount), 'card'); break;
      case 'pay': this.pay(p.id, null, this.scale(card.amount), 'card', { spending: true }); break;
      case 'jailCard': p.jailCards.push({ deck, idx }); break;
      case 'repairs': {
        let h = 0, ht = 0;
        for (const i of this.ownedBy(p.id)) { const n = this.props[i].houses; if (n === 5) ht++; else h += n; }
        this.pay(p.id, null, this.scale(card.house) * h + this.scale(card.hotel) * ht, 'repairs', { spending: true });
        break;
      }
      case 'payEach': for (const o of this.active()) if (o.id !== p.id) this.pay(p.id, o.id, this.scale(card.amount), 'card', { spending: true }); break;
      case 'collectEach': for (const o of this.active()) if (o.id !== p.id) this.pay(o.id, p.id, this.scale(card.amount), 'card', { spending: true }); break;
      case 'macro': this.applyMacro(card); break;
      case 'macroAll':
        for (const o of this.active()) this.pay(null, o.id, this.scale(card.amount), 'fiscal stimulus');
        this.applyMacro(card);
        break;
      default: break;
    }
  }

  applyMacro(card) {
    const e = this.econ;
    if (card.rate) { e.policyRate = clamp(round2(e.policyRate + card.rate), 0, 15); this.addLog(`Policy rate is now ${e.policyRate.toFixed(2)}%.`, 'econ'); }
    if (card.price) { e.priceLevel = Math.round(e.priceLevel * (1 + card.price) * 1000) / 1000; this.addLog(`Price level is now ${e.priceLevel.toFixed(3)}.`, 'econ'); }
    if (card.heat) { e.heatShock += card.heat; }
  }

  die() { return 1 + Math.floor(this.rng() * 6); }

  // ---------------------------------------------------------------- turn actions
  roll(p) {
    this.requireTurn(p);
    if (this.turn.phase !== 'roll') fail('You cannot roll right now');
    if (p.cash < 0) fail('You have negative cash — raise funds or declare bankruptcy first');
    const d = [this.die(), this.die()];
    const doubles = d[0] === d[1];
    this.lastRoll = { dice: d, player: p.id, seq: this.nextId++ };
    this.addLog(`${p.name} rolls ${d[0]} + ${d[1]}${doubles ? ' (doubles!)' : ''}.`, 'roll');
    this.turn.extraRoll = false;
    if (p.inJail) {
      if (doubles) {
        p.inJail = false; p.jailTurns = 0;
        this.addLog(`${p.name} rolled doubles and walks out of Lockup.`);
      } else {
        p.jailTurns++;
        if (p.jailTurns >= 3) {
          this.pay(p.id, null, this.bail(), 'bail after third attempt', { spending: true });
          p.inJail = false; p.jailTurns = 0;
        } else {
          this.turn.phase = 'done';
          return;
        }
      }
    } else if (doubles) {
      this.turn.doubles++;
      if (this.turn.doubles >= 3) {
        this.addLog(`${p.name} rolled three doubles in a row — speeding!`);
        this.sendToJail(p);
        this.turn.phase = 'done';
        return;
      }
      this.turn.extraRoll = true;
    }
    this.turn.phase = 'moving';
    this.moveBy(p, d[0] + d[1]);
    this.finishResolution();
  }

  finishResolution() {
    if (['buy', 'auction'].includes(this.turn.phase)) return;
    const p = this.current();
    this.turn.phase = this.turn.extraRoll && !p.inJail && !p.bankrupt ? 'roll' : 'done';
  }

  buy(p) {
    this.requireTurn(p);
    if (this.turn.phase !== 'buy') fail('Nothing to buy');
    const i = this.turn.pendingBuy; const cost = this.price(i);
    if (p.cash < cost) fail(`You need $${cost} in cash (borrow from the central bank or mortgage first)`);
    this.pay(p.id, null, cost, `bought ${SPACES[i].name}`, { spending: true });
    this.props[i].owner = p.id;
    this.turn.pendingBuy = null;
    this.turn.phase = 'resolving';
    this.finishResolution();
  }

  decline(p) {
    this.requireTurn(p);
    if (this.turn.phase !== 'buy') fail('Nothing to decline');
    const i = this.turn.pendingBuy;
    this.turn.pendingBuy = null;
    if (this.settings.auctions && this.active().length > 1) {
      this.auction = { space: i, highBid: 0, highBidder: null, active: this.active().map((x) => x.id), deadline: this.now() + AUCTION_START_MS };
      this.turn.phase = 'auction';
      this.addLog(`${SPACES[i].name} goes to auction!`, 'system');
    } else {
      this.turn.phase = 'resolving';
      this.finishResolution();
    }
  }

  bid(p, amount) {
    const a = this.auction;
    if (!a) fail('No auction running');
    if (!a.active.includes(p.id)) fail('You have left this auction');
    amount = toInt(amount, 'bid');
    if (amount <= a.highBid) fail(`Bid must exceed $${a.highBid}`);
    if (amount > p.cash) fail('You do not have that much cash');
    a.highBid = amount; a.highBidder = p.id;
    a.deadline = Math.max(a.deadline, this.now() + AUCTION_BID_MS);
    this.addLog(`${p.name} bids $${amount} for ${SPACES[a.space].name}.`, 'money');
    this.checkAuctionEnd();
  }

  passAuction(p) {
    const a = this.auction;
    if (!a) fail('No auction running');
    if (a.highBidder === p.id) fail('You are the high bidder');
    a.active = a.active.filter((x) => x !== p.id);
    this.addLog(`${p.name} drops out of the auction.`);
    this.checkAuctionEnd();
  }

  checkAuctionEnd() {
    const a = this.auction;
    if (a.active.length === 0 || (a.active.length === 1 && a.active[0] === a.highBidder)) this.closeAuction();
  }

  closeAuction() {
    const a = this.auction;
    this.auction = null;
    if (a.highBidder && this.player(a.highBidder).cash >= a.highBid) {
      this.pay(a.highBidder, null, a.highBid, `won auction for ${SPACES[a.space].name}`, { spending: true });
      this.props[a.space].owner = a.highBidder;
    } else {
      this.addLog(`Auction for ${SPACES[a.space].name} ended with no sale.`);
    }
    if (this.status === 'playing' && this.turn.phase === 'auction') {
      this.turn.phase = 'resolving';
      this.finishResolution();
    }
  }

  tick() {
    if (this.auction && this.now() >= this.auction.deadline) { this.closeAuction(); return true; }
    return false;
  }

  payBail(p) {
    this.requireTurn(p);
    if (!p.inJail || this.turn.phase !== 'roll') fail('You can only post bail before rolling while in Lockup');
    if (p.cash < this.bail()) fail('Not enough cash');
    this.pay(p.id, null, this.bail(), 'bail', { spending: true });
    p.inJail = false; p.jailTurns = 0;
  }

  useJailCard(p) {
    this.requireTurn(p);
    if (!p.inJail || this.turn.phase !== 'roll') fail('Not in Lockup');
    const c = p.jailCards.pop();
    if (!c) fail('You have no get-out-of-Lockup card');
    this.decks[c.deck].push(c.idx);
    p.inJail = false; p.jailTurns = 0;
    this.addLog(`${p.name} uses a get-out-of-Lockup card.`);
  }

  endTurn(p) {
    this.requireTurn(p);
    if (this.turn.phase !== 'done') fail(this.turn.phase === 'roll' ? 'You still need to roll' : 'Finish the current action first');
    if (p.cash < 0) fail('You have negative cash — raise funds or declare bankruptcy');
    if (this.inBreach(p)) this.forcedLiquidation(p);
    this.advanceTurn();
  }

  advanceTurn() {
    if (this.status !== 'playing') return;
    const n = this.players.length;
    let idx = this.turn.idx;
    for (let k = 0; k < n; k++) {
      idx = (idx + 1) % n;
      if (idx === 0) this.newRound();
      if (this.status !== 'playing') return;
      if (!this.players[idx].bankrupt) break;
    }
    this.turn = this.freshTurn(idx);
    const p = this.current();
    if (this.inBreach(p)) this.addLog(`⚠ ${p.name} is in MARGIN CALL — cut bank debt below $${this.maxLoan(p)} before ending this turn or the bank will liquidate assets.`, 'warn');
    if (p.cash < 0) this.addLog(`⚠ ${p.name} has negative cash and must raise funds or declare bankruptcy.`, 'warn');
  }

  // ---------------------------------------------------------------- economy / central bank
  recordHistory() {
    const e = this.econ;
    const money = this.active().reduce((a, p) => a + Math.max(0, p.cash), 0);
    const credit = this.active().reduce((a, p) => a + this.bankDebt(p), 0);
    e.history.push({ round: this.round, heat: Math.round(e.heat), inflation: round2(e.inflation), policyRate: e.policyRate, priceLevel: e.priceLevel, spending: e.roundSpending, money, credit });
    if (e.history.length > 80) e.history.shift();
  }

  closeRoundEconomy() {
    const e = this.econ;
    const live = this.active();
    const money = Math.max(1, live.reduce((a, p) => a + Math.max(0, p.cash), 0));
    const credit = live.reduce((a, p) => a + this.bankDebt(p), 0);
    const built = (32 - this.bankHouses) + 4 * (12 - this.bankHotels);
    const velocity = e.roundSpending / money;
    // Each indicator is scored 0-100 with ~50 meaning "normal activity".
    const comp = {
      velocity: clamp((velocity / 0.06) * 50, 0, 100),                           // spending ÷ money supply
      creditGrowth: clamp(50 + ((credit - e.prevCredit) / money) * 250, 0, 100), // new bank lending this round
      creditLevel: clamp(30 + (credit / money) * 80, 0, 100),                     // stock of credit vs money
      development: clamp(30 + (built / 80) * 100, 0, 100),                        // share of buildings in use
    };
    const raw = 0.45 * comp.velocity + 0.25 * comp.creditGrowth + 0.15 * comp.creditLevel + 0.15 * comp.development + e.heatShock;
    e.components = Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v)]));
    e.heat = clamp(0.5 * e.heat + 0.5 * raw, 0, 100);
    // Phillips-curve style: heat drives inflation (% per round), plus a little noise.
    const noise = (this.rng() - 0.5) * 0.3;
    e.inflation = round2(clamp(this.settings.inflationTarget + (e.heat - 50) * 0.04 + noise, -2, 3));
    e.priceLevel = Math.max(0.5, Math.round(e.priceLevel * (1 + e.inflation / 100) * 1000) / 1000);
    // Taylor rule with smoothing, quantised to 25bp.
    const target = this.settings.neutralRate + e.inflation + 0.5 * (e.inflation - this.settings.inflationTarget) + 0.02 * (e.heat - 50);
    const prev = e.policyRate;
    e.policyRate = clamp(Math.round((0.6 * prev + 0.4 * target) * 4) / 4, 0, 15);
    // Fiscal rule.
    const prevFiscal = e.fiscal;
    e.fiscal = e.heat < 30 ? 'stimulus' : e.heat > 75 ? 'surtax' : 'neutral';
    e.prevCredit = credit;
    this.addLog(`📈 Round ${this.round} economy: heat ${Math.round(e.heat)}/100, inflation ${e.inflation.toFixed(2)}%, price level ${e.priceLevel.toFixed(3)}. Policy rate ${prev.toFixed(2)}% → ${e.policyRate.toFixed(2)}%.`, 'econ');
    if (e.fiscal !== prevFiscal) {
      const msg = { stimulus: 'Economy is cold — treasury launches STIMULUS (PAYDAY salary +25%).', surtax: 'Economy is overheating — treasury imposes a SURTAX (taxes +50%).', neutral: 'Fiscal policy returns to neutral.' }[e.fiscal];
      this.addLog(`🏛 ${msg}`, 'econ');
    }
  }

  newRound() {
    this.closeRoundEconomy();
    this.recordHistory();
    this.round++;
    this.econ.roundSpending = 0;
    this.econ.heatShock = 0;
    // Central-bank loans: interest then maturities.
    for (const p of this.active()) {
      for (const l of p.loans.slice()) {
        if (l.kind === 'floating') l.rate = round2(this.econ.policyRate + l.margin);
        const interest = Math.max(1, Math.round(l.principal * l.rate / 100));
        this.pay(p.id, null, interest, `interest on ${l.kind || 'fixed'} bank loan @${l.rate.toFixed(2)}%`);
        if (this.round >= l.maturity) {
          if (p.cash >= l.principal) {
            this.pay(p.id, null, l.principal, 'bank loan matured — principal repaid');
            p.loans = p.loans.filter((x) => x !== l);
          } else {
            if (l.kind === 'floating') { l.margin = round2(l.margin + 2); l.rate = round2(this.econ.policyRate + l.margin); } else l.rate = round2(this.curveRate(5) + 2);
            l.maturity = this.round + 5;
            l.term = 5;
            this.addLog(`⚠ ${p.name} could not repay a $${l.principal} loan — rolled over at a penalty rate of ${l.rate.toFixed(2)}%.`, 'warn');
          }
        }
      }
    }
    this.settleContracts();
    this.settleDesk();
    this.markEquity();
  }

  borrow(p, amount, term, kind = 'fixed') {
    this.requireAlive(p);
    amount = toInt(amount, 'amount'); term = toInt(term, 'term');
    kind = kind === 'floating' ? 'floating' : 'fixed';
    if (this.settings.maxLeverage <= 1) fail('Central-bank borrowing is disabled in this game');
    if (!LOAN_TERMS.includes(term)) fail('Loan term must be 5, 10 or 20 rounds');
    if (amount < 10) fail('Minimum loan is $10');
    const room = this.borrowHeadroom(p);
    if (amount > room) fail(`Leverage cap: you can borrow at most $${room} more`);
    const rate = this.quote(p, term, amount, kind);
    const loan = { id: this.id('L'), kind, principal: amount, rate, term, start: this.round, maturity: this.round + term };
    if (kind === 'floating') loan.margin = round2(rate - this.econ.policyRate);
    p.loans.push(loan);
    p.cash += amount;
    this.addLog(`🏦 ${p.name} borrows $${amount} from the central bank for ${term} rounds at ${kind === 'floating' ? `a floating ${rate.toFixed(2)}%/round (policy + ${loan.margin.toFixed(2)}%)` : `a fixed ${rate.toFixed(2)}%/round`}.`, 'bank');
  }

  repay(p, loanId, amount) {
    this.requireAlive(p);
    const l = p.loans.find((x) => x.id === loanId);
    if (!l) fail('Unknown loan');
    amount = Math.min(toInt(amount, 'amount'), l.principal);
    if (amount <= 0) fail('Invalid amount');
    if (amount > p.cash) fail('Not enough cash');
    p.cash -= amount; l.principal -= amount;
    if (l.principal <= 0) p.loans = p.loans.filter((x) => x !== l);
    this.addLog(`🏦 ${p.name} repays $${amount} of bank debt.`, 'bank');
  }

  repayHighestRate(p, amount) {
    const loans = p.loans.slice().sort((a, b) => b.rate - a.rate);
    for (const l of loans) {
      if (amount <= 0) break;
      const x = Math.min(amount, l.principal);
      l.principal -= x; p.cash -= x; amount -= x;
    }
    p.loans = p.loans.filter((l) => l.principal > 0);
  }

  forcedLiquidation(p) {
    this.addLog(`🔨 Margin call not met — the central bank liquidates ${p.name}'s assets.`, 'warn');
    for (let guard = 0; guard < 300 && this.inBreach(p); guard++) {
      const excess = this.bankDebt(p) - this.maxLoan(p);
      if (p.cash > 0) {
        const amt = Math.min(p.cash, excess);
        this.repayHighestRate(p, amt);
        this.addLog(`🔨 $${amt} of ${p.name}'s cash seized to repay bank debt.`, 'warn');
        continue;
      }
      const built = this.ownedBy(p.id).filter((i) => this.props[i].houses > 0).sort((a, b) => this.props[b].houses - this.props[a].houses);
      if (built.length) { this.sellBuilding(p, built[0], true); continue; }
      const m = this.ownedBy(p.id).find((i) => !this.props[i].mortgaged && !(SPACES[i].group && this.groupHasBuildings(SPACES[i].group)));
      if (m !== undefined) { this.mortgage(p, m, true); continue; }
      break;
    }
    if (this.inBreach(p)) this.addLog(`${p.name} is still over the leverage cap after liquidation (distressed).`, 'warn');
  }

  // ---------------------------------------------------------------- property management
  requireOwner(p, i) {
    i = toInt(i, 'space');
    if (!this.props[i]) fail('Not a property');
    if (this.props[i].owner !== p.id) fail('You do not own that');
    return i;
  }

  build(p, i) {
    this.requirePlaying(); this.requireAlive(p);
    i = this.requireOwner(p, i);
    const s = SPACES[i]; const pr = this.props[i];
    if (s.type !== 'street') fail('You can only build on streets');
    if (!this.ownsGroup(p.id, s.group)) fail(`You need the whole ${GROUPS[s.group].name} group`);
    const members = GROUP_MEMBERS[s.group];
    if (members.some((m) => this.props[m].mortgaged)) fail('Lift all mortgages in the group first');
    if (pr.houses >= 5) fail('Already has a hotel');
    if (pr.houses > Math.min(...members.map((m) => this.props[m].houses))) fail('Build evenly across the group');
    if (pr.houses === 4 ? this.bankHotels < 1 : this.bankHouses < 1) fail('The bank has run out of that building type');
    const cost = this.houseCost(i);
    if (p.cash < cost) fail(`Need $${cost} cash`);
    this.pay(p.id, null, cost, pr.houses === 4 ? `hotel on ${s.name}` : `house on ${s.name}`, { spending: true });
    if (pr.houses === 4) { this.bankHotels--; this.bankHouses += 4; } else this.bankHouses--;
    pr.houses++;
  }

  sellBuilding(p, i, forced = false) {
    this.requireAlive(p);
    i = this.requireOwner(p, i);
    const s = SPACES[i]; const pr = this.props[i];
    if (pr.houses <= 0) fail('No buildings there');
    const members = GROUP_MEMBERS[s.group];
    if (!forced && pr.houses < Math.max(...members.map((m) => this.props[m].houses))) fail('Sell evenly across the group');
    const half = Math.round(this.houseCost(i) / 2);
    if (pr.houses === 5) {
      this.bankHotels++;
      if (this.bankHouses >= 4) { this.bankHouses -= 4; pr.houses = 4; this.pay(null, p.id, half, `sold hotel on ${s.name}`); }
      else { pr.houses = 0; this.pay(null, p.id, half * 5, `sold hotel on ${s.name} (no houses left in bank)`); }
    } else {
      this.bankHouses++; pr.houses--;
      this.pay(null, p.id, half, `sold house on ${s.name}`);
    }
  }

  mortgage(p, i, forced = false) {
    this.requireAlive(p);
    i = this.requireOwner(p, i);
    const s = SPACES[i]; const pr = this.props[i];
    if (pr.mortgaged) fail('Already mortgaged');
    if (s.group && this.groupHasBuildings(s.group)) fail('Sell all buildings in the group first');
    pr.mortgaged = true; pr.mortgageAmt = this.mortgageValue(i);
    this.pay(null, p.id, pr.mortgageAmt, `${forced ? 'forced ' : ''}mortgage on ${s.name}`);
  }

  unmortgage(p, i) {
    this.requireAlive(p);
    i = this.requireOwner(p, i);
    const pr = this.props[i];
    if (!pr.mortgaged) fail('Not mortgaged');
    const cost = Math.ceil(pr.mortgageAmt * 1.1);
    if (p.cash < cost) fail(`Need $${cost}`);
    this.pay(p.id, null, cost, `lifted mortgage on ${SPACES[i].name}`);
    pr.mortgaged = false; pr.mortgageAmt = 0;
  }

  liquidateGroupBuildings(ownerId, group) {
    if (!group) return;
    for (const m of GROUP_MEMBERS[group]) {
      const pr = this.props[m];
      if (pr.houses > 0) {
        const half = Math.round(this.houseCost(m) / 2);
        this.pay(null, ownerId, half * pr.houses, `buildings on ${SPACES[m].name} sold to bank`);
        if (pr.houses === 5) this.bankHotels++; else this.bankHouses += pr.houses;
        pr.houses = 0;
      }
    }
  }

  transferProperty(i, fromId, toId) {
    this.liquidateGroupBuildings(fromId, SPACES[i].group);
    this.props[i].owner = toId;
    this.addLog(`${SPACES[i].name} transfers ${this.player(fromId).name} → ${this.player(toId).name}.`, 'money');
  }

  encumbrances(i) {
    const out = [];
    for (const c of this.contracts) {
      if (c.status !== 'active') continue;
      for (const cl of c.clauses) {
        if (cl.kind === 'collateral' && cl.spaces.includes(i)) out.push(c);
        if (cl.kind === 'call' && !cl.exercised && cl.space === i) out.push(c);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- trades (traditional)
  normalizeSide(side = {}) {
    return {
      cash: Math.max(0, toInt(side.cash || 0, 'cash')),
      spaces: [...new Set((side.spaces || []).map((x) => toInt(x, 'space')))],
      jailCards: clamp(toInt(side.jailCards || 0, 'cards'), 0, 2),
    };
  }

  checkTradeSide(p, side) {
    // Only cash actually being handed over has to be on hand: a player below $0 may still trade property away.
    if (side.cash > 0 && side.cash > p.cash) fail(`${p.name} does not have $${side.cash}`);
    if (side.jailCards > p.jailCards.length) fail(`${p.name} lacks that many get-out-of-Lockup cards`);
    for (const i of side.spaces) {
      if (!this.props[i] || this.props[i].owner !== p.id) fail(`${p.name} does not own ${SPACES[i]?.name || i}`);
      if (SPACES[i].group && this.groupHasBuildings(SPACES[i].group)) fail(`Sell buildings in ${GROUPS[SPACES[i].group].name} before trading ${SPACES[i].name}`);
      if (this.encumbrances(i).length) fail(`${SPACES[i].name} is pledged under a contract`);
    }
  }

  proposeTrade(p, { to, give, get }) {
    this.requirePlaying(); this.requireAlive(p);
    const q = this.player(to);
    if (q.id === p.id || q.bankrupt) fail('Invalid trade partner');
    const t = { id: this.id('T'), from: p.id, to: q.id, give: this.normalizeSide(give), get: this.normalizeSide(get), status: 'pending', round: this.round };
    if (!t.give.cash && !t.give.spaces.length && !t.give.jailCards && !t.get.cash && !t.get.spaces.length && !t.get.jailCards) fail('Empty trade');
    this.checkTradeSide(p, t.give); this.checkTradeSide(q, t.get);
    this.trades.push(t);
    this.addLog(`🤝 ${p.name} proposes a trade to ${q.name}.`);
  }

  respondTrade(p, tradeId, accept) {
    const t = this.trades.find((x) => x.id === tradeId && x.status === 'pending');
    if (!t) fail('Trade not found');
    if (t.to !== p.id) fail('Not your trade to answer');
    if (!accept) { t.status = 'rejected'; this.addLog(`${p.name} rejects a trade.`); return; }
    const a = this.player(t.from);
    this.checkTradeSide(a, t.give); this.checkTradeSide(p, t.get);
    const move = (from, to, side) => {
      if (side.cash) this.pay(from.id, to.id, side.cash, 'trade');
      for (const i of side.spaces) { this.props[i].owner = to.id; this.addLog(`${SPACES[i].name} → ${to.name}`); }
      for (let k = 0; k < side.jailCards; k++) to.jailCards.push(from.jailCards.pop());
    };
    move(a, p, t.give); move(p, a, t.get);
    t.status = 'accepted';
    this.addLog(`🤝 Trade between ${a.name} and ${p.name} completed.`);
  }

  cancelTrade(p, tradeId) {
    const t = this.trades.find((x) => x.id === tradeId && x.status === 'pending');
    if (!t || t.from !== p.id) fail('Trade not found');
    t.status = 'cancelled';
  }

  // ---------------------------------------------------------------- financial contracts
  normalizeClause(raw, parties) {
    const kind = String(raw.kind);
    if (!CLAUSE_KINDS.includes(kind)) fail(`Unknown clause type ${kind}`);
    const party = (x) => { if (!parties.includes(x)) fail('Clause parties must be the two contract parties'); return x; };
    const pos = (x, name) => { const n = toInt(x, name); if (n <= 0) fail(`${name} must be positive`); return n; };
    const c = { kind };
    if (['call', 'put'].includes(kind)) {
      c.holder = party(raw.holder); c.writer = party(raw.writer);
      if (c.holder === c.writer) fail('Option holder and writer must differ');
      c.space = toInt(raw.space, 'property');
      if (!this.props[c.space]) fail('Option must reference a property');
      c.strike = Math.max(0, toInt(raw.strike, 'strike'));
      c.exercised = false;
      return c;
    }
    c.from = party(raw.from); c.to = party(raw.to);
    if (c.from === c.to) fail('Payer and receiver must differ');
    switch (kind) {
      case 'upfront': case 'fixed': case 'maturity': c.amount = pos(raw.amount, 'amount'); break;
      case 'rate':
        c.notional = pos(raw.notional, 'notional');
        c.rateType = raw.rateType === 'floating' ? 'floating' : 'fixed';
        if (c.rateType === 'fixed') c.rate = clamp(toNum(raw.rate, 'rate'), 0, 50);
        else c.spread = clamp(toNum(raw.spread || 0, 'spread'), -10, 20);
        break;
      case 'rentShare':
        c.pct = clamp(toNum(raw.pct, 'percent'), 1, 100);
        c.spaces = [...new Set((raw.spaces || []).map((x) => toInt(x, 'space')))].filter((i) => this.props[i]);
        break;
      case 'equity': c.pct = clamp(toNum(raw.pct, 'percent'), 1, 100); break;
      case 'default':
        c.amount = pos(raw.amount, 'amount');
        c.ref = this.player(raw.ref).id;
        if (c.ref === c.from) fail('The protection seller cannot be the reference entity');
        break;
      case 'collateral':
        c.spaces = [...new Set((raw.spaces || []).map((x) => toInt(x, 'space')))];
        if (!c.spaces.length) fail('Collateral needs at least one property');
        break;
      default: break;
    }
    return c;
  }

  checkContractFeasible(c) {
    const who = (id) => this.player(id);
    for (const p of c.parties) if (who(p).bankrupt) fail('A party is bankrupt');
    const upfront = {};
    for (const cl of c.clauses) {
      if (cl.kind === 'upfront') upfront[cl.from] = (upfront[cl.from] || 0) + cl.amount;
      if (cl.kind === 'call' && this.props[cl.space].owner !== cl.writer) fail(`Call writer must own ${SPACES[cl.space].name}`);
      if (cl.kind === 'put' && this.props[cl.space].owner !== cl.holder) fail(`Put holder must own ${SPACES[cl.space].name}`);
      if (cl.kind === 'rentShare') for (const i of cl.spaces) if (this.props[i].owner !== cl.from) fail(`Rent share payer must own ${SPACES[i].name}`);
      if (cl.kind === 'collateral') for (const i of cl.spaces) {
        if (!this.props[i] || this.props[i].owner !== cl.from) fail(`Pledger must own ${SPACES[i]?.name || i}`);
      }
      if ((cl.kind === 'collateral' || cl.kind === 'call')) {
        for (const i of (cl.spaces || [cl.space])) if (this.encumbrances(i).some((x) => x.id !== c.id)) fail(`${SPACES[i].name} is already pledged/optioned in another contract`);
      }
      if (cl.kind === 'equity') {
        const issued = this.contracts.filter((x) => x.status === 'active').flatMap((x) => x.clauses).filter((y) => y.kind === 'equity' && y.from === cl.from).reduce((a, y) => a + y.pct, 0);
        if (issued + cl.pct > 100) fail('Cannot issue more than 100% equity');
      }
    }
    for (const [pid, amt] of Object.entries(upfront)) if (who(pid).cash < amt) fail(`${who(pid).name} needs $${amt} cash for the upfront payment`);
  }

  proposeContract(p, { to, name, term, clauses }) {
    this.requirePlaying(); this.requireAlive(p);
    const q = this.player(to);
    if (q.id === p.id || q.bankrupt) fail('Invalid counterparty');
    if (!Array.isArray(clauses) || !clauses.length) fail('Add at least one clause');
    if (clauses.length > 16) fail('Too many clauses');
    const parties = [p.id, q.id];
    const c = {
      id: this.id('C'), name: String(name || 'Contract').trim().slice(0, 40) || 'Contract',
      parties, proposer: p.id, term: clamp(toInt(term ?? 0, 'term'), 0, 100),
      clauses: clauses.map((cl) => this.normalizeClause(cl, parties)),
      status: 'proposed', created: this.round, start: null, periods: 0, history: [],
    };
    if (c.term === 0 && c.clauses.some((cl) => cl.kind === 'maturity')) fail('A maturity payment needs a term');
    this.checkContractFeasible(c);
    this.contracts.push(c);
    this.addLog(`📜 ${p.name} offers ${q.name} a contract: “${c.name}”.`, 'contract');
  }

  respondContract(p, cid, accept) {
    const c = this.contracts.find((x) => x.id === cid && x.status === 'proposed');
    if (!c) fail('Contract not found');
    if (c.parties[1] !== p.id) fail('Only the counterparty can respond');
    if (!accept) { c.status = 'rejected'; this.addLog(`${p.name} rejects “${c.name}”.`, 'contract'); return; }
    this.checkContractFeasible(c);
    for (const cl of c.clauses) if (cl.kind === 'upfront') this.pay(cl.from, cl.to, cl.amount, `${c.name}: upfront`);
    c.status = 'active'; c.start = this.round;
    this.addLog(`📜 “${c.name}” is now ACTIVE between ${this.player(c.parties[0]).name} and ${p.name}.`, 'contract');
  }

  cancelContract(p, cid) {
    const c = this.contracts.find((x) => x.id === cid && x.status === 'proposed');
    if (!c || c.proposer !== p.id) fail('Contract not found');
    c.status = 'cancelled';
  }

  clauseFlow(cl) {
    if (cl.kind === 'fixed') return cl.amount;
    if (cl.kind === 'rate') {
      const r = cl.rateType === 'fixed' ? cl.rate : this.econ.policyRate + cl.spread;
      return Math.max(0, Math.round(cl.notional * r / 100));
    }
    return 0;
  }

  // Pays an obligation; if the payer is short and has pledged collateral in this contract, it defaults instead.
  obligation(c, from, to, amount, reason) {
    if (amount <= 0) return true;
    const payer = this.player(from);
    const coll = c.clauses.filter((cl) => cl.kind === 'collateral' && cl.from === from);
    if (payer.cash < amount && coll.length) {
      this.defaultContract(c, from, reason);
      return false;
    }
    this.pay(from, to, amount, `${c.name}: ${reason}`);
    c.history.push({ round: this.round, from, to, amount, reason });
    return true;
  }

  defaultContract(c, defaulter, reason) {
    this.addLog(`💥 ${this.player(defaulter).name} DEFAULTS on “${c.name}” (${reason}). Collateral is seized.`, 'warn');
    for (const cl of c.clauses) {
      if (cl.kind === 'collateral' && cl.from === defaulter) {
        for (const i of cl.spaces) if (this.props[i].owner === defaulter) this.transferProperty(i, defaulter, cl.to);
      }
    }
    c.status = 'defaulted';
  }

  settleContracts() {
    for (const c of this.contracts) {
      if (c.status !== 'active' || c.start >= this.round) continue;
      const [a, b] = c.parties;
      let ab = 0;
      for (const cl of c.clauses) {
        const f = this.clauseFlow(cl);
        if (!f) continue;
        ab += cl.from === a ? f : -f;
      }
      if (ab > 0 && !this.obligation(c, a, b, ab, 'periodic net payment')) continue;
      if (ab < 0 && !this.obligation(c, b, a, -ab, 'periodic net payment')) continue;
      c.periods++;
      if (c.term > 0 && c.periods >= c.term) {
        let ok = true;
        for (const cl of c.clauses) if (cl.kind === 'maturity' && ok) ok = this.obligation(c, cl.from, cl.to, cl.amount, 'maturity payment');
        if (ok) { c.status = 'matured'; this.addLog(`📜 “${c.name}” has matured.`, 'contract'); }
      }
    }
  }

  exercise(p, cid, clauseIdx) {
    this.requirePlaying(); this.requireAlive(p);
    const c = this.contracts.find((x) => x.id === cid && x.status === 'active');
    if (!c) fail('Contract not active');
    const cl = c.clauses[toInt(clauseIdx, 'clause')];
    if (!cl || !['call', 'put'].includes(cl.kind)) fail('Not an option clause');
    if (cl.holder !== p.id) fail('You do not hold this option');
    if (cl.exercised) fail('Already exercised');
    const i = cl.space;
    if (cl.kind === 'call') {
      if (this.props[i].owner !== cl.writer) fail('Writer no longer owns the property');
      if (p.cash < cl.strike) fail(`You need $${cl.strike} to exercise`);
      this.pay(p.id, cl.writer, cl.strike, `${c.name}: call exercised`);
      this.transferProperty(i, cl.writer, p.id);
    } else {
      if (this.props[i].owner !== p.id) fail('You must own the property to exercise the put');
      this.transferProperty(i, p.id, cl.writer);
      this.pay(cl.writer, p.id, cl.strike, `${c.name}: put exercised`);
    }
    cl.exercised = true;
    this.addLog(`📜 ${p.name} exercises a ${cl.kind.toUpperCase()} on ${SPACES[i].name} at $${cl.strike}.`, 'contract');
    const live = c.clauses.some((x) => ['fixed', 'rate', 'rentShare', 'equity', 'maturity', 'default', 'collateral'].includes(x.kind) || (['call', 'put'].includes(x.kind) && !x.exercised));
    if (!live) c.status = 'exercised';
  }

  // ---------------------------------------------------------------- bankruptcy & end
  declareBankruptcy(p, reason = 'declared bankruptcy') {
    this.requirePlaying();
    if (p.bankrupt) return;
    this.addLog(`☠ ${p.name} ${reason}!`, 'warn');
    this.deskOnBankrupt(p);
    // Credit-default clauses referencing this player trigger first.
    for (const c of this.contracts) {
      if (c.status !== 'active' || c.parties.includes(p.id)) continue;
      const trig = c.clauses.filter((cl) => cl.kind === 'default' && cl.ref === p.id);
      if (!trig.length) continue;
      for (const cl of trig) this.obligation(c, cl.from, cl.to, cl.amount, `credit event on ${p.name}`);
      if (c.status === 'active') c.status = 'triggered';
    }
    // Contracts the bankrupt is party to: collateral goes to the counterparty, everything else is void.
    for (const c of this.contracts) {
      if (!c.parties.includes(p.id)) continue;
      if (c.status === 'active') {
        for (const cl of c.clauses) {
          if (cl.kind === 'collateral' && cl.from === p.id) {
            for (const i of cl.spaces) if (this.props[i].owner === p.id) this.transferProperty(i, p.id, cl.to);
          }
        }
        c.status = 'terminated';
      } else if (c.status === 'proposed') c.status = 'cancelled';
    }
    for (const t of this.trades) if (t.status === 'pending' && (t.from === p.id || t.to === p.id)) t.status = 'cancelled';
    for (const i of this.ownedBy(p.id)) {
      const pr = this.props[i];
      if (pr.houses === 5) this.bankHotels++; else this.bankHouses += pr.houses;
      Object.assign(pr, { owner: null, houses: 0, mortgaged: false, mortgageAmt: 0 });
    }
    const loss = this.bankDebt(p);
    if (loss) { this.econ.bankLosses += loss; this.addLog(`🏦 Central bank writes off $${loss} of ${p.name}'s debt.`, 'bank'); }
    p.loans = [];
    for (const c of p.jailCards) this.decks[c.deck].push(c.idx);
    p.jailCards = [];
    p.cash = 0; p.bankrupt = true; p.inJail = false;
    if (this.auction) {
      this.auction.active = this.auction.active.filter((x) => x !== p.id);
      if (this.auction.highBidder === p.id) { this.auction.highBidder = null; this.auction.highBid = 0; }
    }
    const alive = this.active();
    if (alive.length <= 1) { this.finish(alive[0] || null); return; }
    if (this.current().id === p.id) {
      this.auction = null;
      this.advanceTurn();
    } else if (this.auction) this.checkAuctionEnd();
  }

  finish(winner) {
    this.status = 'finished';
    this.auction = null;
    this.winner = winner ? winner.id : null;
    this.addLog(`🏆 Game over! ${winner ? winner.name : 'Nobody'} wins.`, 'system');
  }

  endNow(pid) {
    this.requireHost(pid); this.requirePlaying();
    const best = this.active().slice().sort((a, b) => this.netWorth(b) - this.netWorth(a))[0];
    this.addLog('Host ended the game — highest net worth wins.', 'system');
    this.finish(best);
  }

  // ---------------------------------------------------------------- dispatch
  apply(pid, msg) {
    const p = this.player(pid);
    const a = msg.action;
    if (a === 'settings') return this.updateSettings(pid, msg.settings || {});
    if (a === 'start') return this.start(pid);
    if (a === 'addBot') { if (this.status !== 'lobby') fail('Bots join in the lobby'); this.addBot(pid); return; }
    if (a === 'removeBot') { if (this.status !== 'lobby') fail('Bots leave in the lobby'); return this.removeBot(pid, msg.target); }
    if (a === 'chat') { const text = String(msg.text || '').slice(0, 200).trim(); if (text) this.addLog(`${p.name}: ${text}`, 'chat'); return; }
    this.requirePlaying();
    if (a !== 'kick' && a !== 'endNow') this.requireAlive(p);
    switch (a) {
      case 'roll': return this.roll(p);
      case 'buy': return this.buy(p);
      case 'decline': return this.decline(p);
      case 'bid': return this.bid(p, msg.amount);
      case 'passAuction': return this.passAuction(p);
      case 'payBail': return this.payBail(p);
      case 'useJailCard': return this.useJailCard(p);
      case 'endTurn': return this.endTurn(p);
      case 'build': return this.build(p, msg.space);
      case 'sell': return this.sellBuilding(p, msg.space);
      case 'mortgage': return this.mortgage(p, msg.space);
      case 'unmortgage': return this.unmortgage(p, msg.space);
      case 'borrow': return this.borrow(p, msg.amount, msg.term, msg.kind);
      case 'deskBuy': return this.deskBuy(p, msg.order || {});
      case 'deskClose': return this.deskClose(p, msg.id);
      case 'repay': return this.repay(p, msg.loanId, msg.amount);
      case 'proposeTrade': return this.proposeTrade(p, msg.trade || {});
      case 'acceptTrade': return this.respondTrade(p, msg.id, true);
      case 'rejectTrade': return this.respondTrade(p, msg.id, false);
      case 'cancelTrade': return this.cancelTrade(p, msg.id);
      case 'proposeContract': return this.proposeContract(p, msg.contract || {});
      case 'acceptContract': return this.respondContract(p, msg.id, true);
      case 'rejectContract': return this.respondContract(p, msg.id, false);
      case 'cancelContract': return this.cancelContract(p, msg.id);
      case 'exercise': return this.exercise(p, msg.id, msg.clause);
      case 'bankrupt': return this.declareBankruptcy(p);
      case 'kick': this.requireHost(pid); return this.declareBankruptcy(this.player(msg.target), 'was removed by the host');
      case 'endNow': return this.endNow(pid);
      default: fail(`Unknown action ${a}`);
    }
  }

  // ---------------------------------------------------------------- client view
  serialize() {
    const playing = this.status !== 'lobby';
    const players = this.players.map((p) => {
      const base = { id: p.id, name: p.name, token: p.token, color: p.color, host: p.host, bot: p.bot, connected: p.connected, bankrupt: p.bankrupt };
      if (!playing) return base;
      const lev = this.leverage(p);
      return {
        ...base, cash: p.cash, pos: p.pos, inJail: p.inJail, jailTurns: p.jailTurns, jailCards: p.jailCards.length,
        loans: p.loans, bankDebt: this.bankDebt(p), mortgageDebt: this.mortgageDebt(p.id),
        propertyValue: this.propertyValue(p.id), equity: this.bookEquity(p), netWorth: this.netWorth(p),
        leverage: Number.isFinite(lev) ? round2(lev) : null, maxLoan: this.maxLoan(p), headroom: this.borrowHeadroom(p),
        marginCall: this.inBreach(p),
        quotes: Object.fromEntries(LOAN_TERMS.map((t) => [t, this.quote(p, t)])),
        floatQuotes: Object.fromEntries(LOAN_TERMS.map((t) => [t, this.quote(p, t, 0, 'floating')])),
        deskValue: this.deskValue(p),
      };
    });
    const view = {
      code: this.code, status: this.status, settings: this.settings, players, version: this.version,
      log: this.log.slice(-150), winner: this.winner,
    };
    if (!playing) return view;
    const spaceInfo = SPACES.map((s, i) => {
      if (!OWNABLE.has(s.type)) return s.type === 'tax' ? { tax: this.taxAmount(i) } : null;
      const info = { ...this.props[i], price: this.price(i), mortgageValue: this.mortgageValue(i), unmortgageCost: Math.ceil((this.props[i].mortgageAmt || this.mortgageValue(i)) * 1.1) };
      if (s.type === 'street') { info.houseCost = this.houseCost(i); info.rentTable = s.rent.map((r) => this.scale(r)); }
      info.rentNow = s.type === 'utility' ? null : this.rentFor(i, 7);
      info.encumbered = this.encumbrances(i).length > 0;
      return info;
    });
    return {
      ...view, round: this.round, turn: this.turn, auction: this.auction, lastRoll: this.lastRoll, lastCard: this.lastCard,
      spaceInfo, bankHouses: this.bankHouses, bankHotels: this.bankHotels,
      econ: {
        ...this.econ, salary: this.salary(), bail: this.bail(),
        curve: Object.fromEntries(LOAN_TERMS.map((t) => [t, round2(this.curveRate(t))])),
        neutralRate: this.settings.neutralRate, inflationTarget: this.settings.inflationTarget,
      },
      trades: this.trades.filter((t) => t.status === 'pending' || t.round >= this.round - 3).slice(-40),
      contracts: this.contracts,
      desk: this.deskView(),
      now: this.now(),
    };
  }
}

require('./desk')(Game, { fail, toInt, toNum, clamp, round2 });

module.exports = { Game, GameError, DEFAULT_SETTINGS, LOAN_TERMS, CLAUSE_KINDS };
