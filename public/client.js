/* Margin Call — browser client. Renders server state and sends actions over WebSocket. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? `<span class="neg">-$${Math.abs(Math.round(n)).toLocaleString()}</span>` : `$${Math.round(n).toLocaleString()}`);
const plain$ = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
const pct = (n, d = 2) => `${Number(n).toFixed(d)}%`;

const S = {
  ws: null, me: null, code: null, token: null, board: null, state: null,
  tab: 'players', clockSkew: 0, lastRollSeq: null, lastCardSeq: null, cardKey: null, lastTurnKey: null, charts: {},
};

const ICONS = { go: '💰', jail: '🔒', parking: '☕', gotojail: '👮', event: '📰', treasury: '🏛️', tax: '🧾' };
const transitIcon = (n) => (/airport/i.test(n) ? '✈️' : /ferry/i.test(n) ? '⛴️' : /tram/i.test(n) ? '🚋' : '🚉');
const utilIcon = (n) => (/power/i.test(n) ? '⚡' : '💧');

// ------------------------------------------------------------------ session storage (best effort)
const store = {
  get() { try { return JSON.parse(localStorage.getItem('mc-session') || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem('mc-session', JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem('mc-session'); } catch { /* ignore */ } },
  name() { try { return localStorage.getItem('mc-name') || ''; } catch { return ''; } },
  setName(n) { try { localStorage.setItem('mc-name', n); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ networking
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  S.ws = ws;
  ws.onopen = () => {
    const saved = store.get();
    if (saved) ws.send(JSON.stringify({ type: 'resume', code: saved.code, token: saved.token }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      Object.assign(S, { me: msg.playerId, code: msg.code, token: msg.token, board: msg.board });
      store.set({ code: msg.code, token: msg.token });
    } else if (msg.type === 'state') {
      S.state = msg.state;
      S.clockSkew = (msg.state.now || Date.now()) - Date.now();
      render();
    } else if (msg.type === 'error') toast(msg.message, 'err');
    else if (msg.type === 'resumeFailed') { store.clear(); showScreen('join'); }
  };
  ws.onclose = () => { setTimeout(connect, 1500); };
}
const send = (msg) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); else toast('Not connected — retrying…', 'err'); };
const act = (action, extra = {}) => send({ type: 'action', action, ...extra });

// ------------------------------------------------------------------ helpers
const st = () => S.state;
const meP = () => st()?.players.find((p) => p.id === S.me);
const pl = (id) => st().players.find((p) => p.id === id);
const pname = (id) => { const p = pl(id); return p ? `${p.token} ${esc(p.name)}` : '?'; };
const space = (i) => S.board.spaces[i];
const groupOf = (i) => S.board.groups[space(i).group];
const isMyTurn = () => st().status === 'playing' && st().players[st().turn.idx].id === S.me;
const ownable = (s) => ['street', 'transit', 'utility'].includes(s.type);
const ownedBy = (pid) => S.board.spaces.filter((s) => ownable(s) && st().spaceInfo[s.index].owner === pid).map((s) => s.index);
const propColor = (i) => (space(i).type === 'street' ? groupOf(i).color : space(i).type === 'transit' ? '#c9d1e3' : '#7fd8ff');

function toast(text, kind = 'ok') {
  for (const old of $$('#toasts .toast')) if (old.textContent === text) old.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 4500 : 3000);
}

function showScreen(id) {
  for (const s of ['join', 'lobby', 'game']) $(`#${s}`).classList.toggle('hidden', s !== id);
}

/** Replace innerHTML but keep typed values and focus of inputs that have ids. */
function setHTML(el, html) {
  const vals = {};
  for (const inp of $$('input[id], select[id], textarea[id]', el)) vals[inp.id] = inp.type === 'checkbox' ? inp.checked : inp.value;
  const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
  let sel = null;
  try { if (focus) sel = [document.activeElement.selectionStart, document.activeElement.selectionEnd]; } catch { /* ignore */ }
  el.innerHTML = html;
  for (const [id, v] of Object.entries(vals)) {
    const inp = el.querySelector(`#${CSS.escape(id)}`);
    if (!inp) continue;
    if (inp.type === 'checkbox') inp.checked = v; else inp.value = v;
  }
  if (focus) {
    const f = el.querySelector(`#${CSS.escape(focus)}`);
    if (f) { f.focus(); try { if (sel && sel[0] != null) f.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
  }
}

// ------------------------------------------------------------------ top-level render
function render() {
  const s = st();
  if (!s) return;
  if (s.status === 'lobby') { showScreen('lobby'); renderLobby(); return; }
  showScreen('game');
  $('#roomTag').textContent = `room ${s.code} · round ${s.round}`;
  renderBoard();
  renderTabs();
  renderTab();
  const key = `${s.round}-${s.turn.idx}`;
  if (key !== S.lastTurnKey) {
    S.lastTurnKey = key;
    if (isMyTurn() && s.status === 'playing') { toast('🎲 Your turn!'); document.title = '🎲 Your turn — Margin Call'; } else document.title = 'Margin Call';
  }
}

// ------------------------------------------------------------------ lobby
function renderLobby() {
  const s = st(); const me = meP();
  $('#lobbyCode').textContent = s.code;
  $('#lobbyUrl').textContent = location.host;
  $('#lobbyPlayers').innerHTML = s.players.map((p) => `<li style="border-color:${p.color}"><span style="font-size:20px">${p.token}</span><span>${esc(p.name)}</span>${p.host ? '<span class="badge">host</span>' : ''}${p.connected ? '' : '<span class="badge warn">offline</span>'}${p.id === S.me ? '<span class="badge good">you</span>' : ''}</li>`).join('');
  const host = me && me.host; const set = s.settings;
  const dis = host ? '' : 'disabled';
  $('#lobbySettings').innerHTML = (`
    <label>Starting cash<input id="setCash" type="number" min="500" max="5000" step="100" value="${set.startingCash}" ${dis}></label>
    <label>PAYDAY salary<input id="setSalary" type="number" min="50" max="1000" step="10" value="${set.salary}" ${dis}></label>
    <label>Max leverage (assets ÷ equity)
      <select id="setLev" ${dis}>${[1, 1.5, 2, 3, 4, 5, 8].map((x) => `<option value="${x}" ${x === set.maxLeverage ? 'selected' : ''}>${x === 1 ? '1× — no bank borrowing' : `${x}×`}</option>`).join('')}</select></label>
    <label>Auctions on declined property<select id="setAuc" ${dis}><option value="1" ${set.auctions ? 'selected' : ''}>On (traditional)</option><option value="0" ${set.auctions ? '' : 'selected'}>Off</option></select></label>`);
  for (const inp of $$('#lobbySettings input, #lobbySettings select')) {
    inp.onchange = () => act('settings', { settings: { startingCash: $('#setCash').value, salary: $('#setSalary').value, maxLeverage: $('#setLev').value, auctions: $('#setAuc').value === '1' } });
  }
  $('#startBtn').disabled = !host || s.players.length < 2;
  $('#startBtn').textContent = host ? (s.players.length < 2 ? 'Need 2+ players' : 'Start game') : 'Waiting for host…';
}

// ------------------------------------------------------------------ board
function gridPos(i) {
  if (i <= 10) return [11, 11 - i, i === 0 || i === 10 ? 'corner' : 'side-bottom'];
  if (i <= 20) return [11 - (i - 10), 1, i === 20 ? 'corner' : 'side-left'];
  if (i <= 30) return [1, 1 + (i - 20), i === 30 ? 'corner' : 'side-top'];
  return [1 + (i - 30), 11, 'side-right'];
}

function cellHTML(sp) {
  const s = st(); const i = sp.index; const info = s.spaceInfo[i];
  const [r, c, side] = gridPos(i);
  const here = s.players.filter((p) => !p.bankrupt && p.pos === i);
  const toks = here.length ? `<div class="tokens">${here.map((p) => `<div class="tok ${p.id === S.me ? 'me' : ''}" style="border-color:${p.color}" title="${esc(p.name)}">${p.token}</div>`).join('')}</div>` : '';
  let cls = `cell ${side}`; let strip = ''; let body = '';
  if (sp.type === 'street') {
    const g = S.board.groups[sp.group];
    const bld = info.houses === 5 ? '<div class="hotel"></div>' : '<div class="house"></div>'.repeat(info.houses);
    strip = `<div class="strip" style="background:${g.color}">${bld}</div>`;
  }
  const owner = info && info.owner ? pl(info.owner) : null;
  if (info && info.mortgaged) cls += ' mortgaged';
  if (side === 'corner') {
    const label = sp.type === 'jail' ? 'LOCKUP<br><small class="muted">just visiting</small>' : esc(sp.name);
    body = `<div class="body"><div class="ico">${ICONS[sp.type]}</div><div class="nm">${label}</div>${sp.type === 'go' ? `<div class="pr">collect ${plain$(s.econ.salary)}</div>` : ''}</div>`;
  } else {
    const ico = sp.type === 'transit' ? transitIcon(sp.name) : sp.type === 'utility' ? utilIcon(sp.name) : ICONS[sp.type] || '';
    let sub = '';
    if (ownable(sp)) sub = owner ? (info.mortgaged ? 'mortgaged' : info.rentNow != null ? `rent ${plain$(info.rentNow)}` : 'rent 4×/10×') : plain$(info.price);
    else if (sp.type === 'tax') sub = `pay ${plain$(info.tax)}`;
    body = `<div class="body"><div class="nm">${esc(sp.name)}</div>${ico && sp.type !== 'street' ? `<div class="ico">${ico}</div>` : ''}<div class="pr">${sub}</div></div>`;
  }
  const own = owner ? `<div class="owner" style="background:${owner.color}"></div><div class="owner-tok">${owner.token}</div>` : '';
  return `<div class="${cls}" data-space="${i}" style="grid-row:${r};grid-column:${c}">${strip}${body}${own}${toks}</div>`;
}

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const dieHTML = (n, anim) => `<div class="die ${anim ? 'roll' : ''}">${Array.from({ length: 9 }, (_, k) => `<i style="${PIPS[n].includes(k) ? '' : 'visibility:hidden'}"></i>`).join('')}</div>`;

function centerHTML() {
  const s = st(); const e = s.econ; const me = meP(); const cur = s.players[s.turn.idx];
  const newRoll = s.lastRoll && s.lastRoll.seq !== S.lastRollSeq;
  const dice = s.lastRoll ? s.lastRoll.dice : [1, 1];
  const heatLbl = e.heat < 30 ? 'cold' : e.heat > 70 ? 'hot' : 'steady';
  let h = `<h1 class="logo">MARGIN<span>CALL</span></h1>
  <div class="ticker">
    <div class="tick"><small>Round</small><b>${s.round}</b></div>
    <div class="tick"><small>Policy rate</small><b>${pct(e.policyRate)}</b></div>
    <div class="tick"><small>Inflation</small><b>${pct(e.inflation)}</b></div>
    <div class="tick"><small>Heat</small><b>${Math.round(e.heat)} · ${heatLbl}</b></div>
    <div class="tick"><small>Price level</small><b>${e.priceLevel.toFixed(3)}</b></div>
    <div class="tick"><small>Fiscal</small><b>${e.fiscal}</b></div>
  </div>`;
  if (s.status === 'finished') {
    const w = s.winner && pl(s.winner);
    h += `<div class="turn-banner">🏆 ${w ? `${w.token} ${esc(w.name)} wins!` : 'Game over'}</div>`;
    h += `<table class="t" style="max-width:420px"><tr><th>Player</th><th class="n">Net worth</th></tr>${s.players.slice().sort((a, b) => b.netWorth - a.netWorth).map((p) => `<tr><td>${p.token} ${esc(p.name)}${p.bankrupt ? ' ☠' : ''}</td><td class="n">${money(p.netWorth)}</td></tr>`).join('')}</table>`;
    return h;
  }
  h += `<div class="turn-banner"><span class="tok" style="border-color:${cur.color}">${cur.token}</span>${cur.id === S.me ? 'Your turn' : `${esc(cur.name)}'s turn`} <span class="muted" style="font-weight:400;font-size:13px">· ${phaseLabel(s.turn.phase, cur)}</span></div>`;
  h += `<div class="dice">${dieHTML(dice[0], newRoll)}${dieHTML(dice[1], newRoll)}</div>`;
  if (me && !me.bankrupt) {
    if (me.cash < 0) h += `<div class="alert">You have negative cash (${plain$(me.cash)}). Sell buildings, mortgage, borrow or trade to get back above $0 — or declare bankruptcy.</div>`;
    if (me.marginCall) h += `<div class="alert warn">⚠ MARGIN CALL: bank debt ${plain$(me.bankDebt)} exceeds your limit of ${plain$(me.maxLoan)}. Repay before you end your next turn or the bank liquidates assets.</div>`;
  }
  // Card display for the current turn
  if (s.lastCard && s.lastCard.seq !== S.lastCardSeq) { S.lastCardSeq = s.lastCard.seq; S.cardKey = `${s.round}-${s.turn.idx}`; }
  if (s.lastCard && S.cardKey === `${s.round}-${s.turn.idx}`) {
    h += `<div class="card-pop ${s.lastCard.deck}"><h4>${s.lastCard.deck === 'event' ? '📰 Market Event' : '🏛️ Town Treasury'} · ${pname(s.lastCard.player)}</h4>${esc(s.lastCard.text)}</div>`;
  }
  if (s.auction) h += auctionHTML();
  h += `<div class="actions">${actionButtons()}</div>`;
  h += `<div class="mini-log">${s.log.slice(-6).reverse().map((l) => `<div>${esc(l.msg)}</div>`).join('')}</div>`;
  return h;
}

function phaseLabel(ph, p) {
  if (ph === 'roll') return p.inJail ? 'in Lockup — roll for doubles, pay bail or use a card' : 'ready to roll';
  if (ph === 'buy') return `deciding whether to buy ${esc(space(st().turn.pendingBuy).name)}`;
  if (ph === 'auction') return 'auction in progress';
  if (ph === 'done') return 'managing / about to end turn';
  return ph;
}

function auctionHTML() {
  const a = st().auction; const me = meP();
  const inIt = a.active.includes(S.me);
  const left = Math.max(0, Math.ceil((a.deadline - (Date.now() + S.clockSkew)) / 1000));
  return `<div class="auction-box">
    <div><b>🔨 Auction: ${esc(space(a.space).name)}</b> <span class="muted">(list ${plain$(st().spaceInfo[a.space].price)})</span></div>
    <div style="font-size:20px;margin:6px 0">${a.highBidder ? `${plain$(a.highBid)} — ${pname(a.highBidder)}` : 'No bids yet'}</div>
    <div class="muted">closes in <b id="auctionTimer">${left}</b>s · still bidding: ${a.active.map((id) => pl(id).token).join(' ')}</div>
    ${inIt && me && !me.bankrupt ? `<div class="row" style="margin-top:8px">
      <input id="bidAmt" type="number" min="${a.highBid + 1}" placeholder="${a.highBid + 10}" style="width:100px">
      <button data-act="bid">Bid</button>
      <button class="small" data-bidplus="10">+10</button><button class="small" data-bidplus="50">+50</button><button class="small" data-bidplus="100">+100</button>
      ${a.highBidder === S.me ? '' : '<button class="danger" data-act="passAuction">Drop out</button>'}
    </div>` : '<div class="muted" style="margin-top:6px">You are out of this auction.</div>'}
  </div>`;
}

function actionButtons() {
  const s = st(); const me = meP();
  if (!me || me.bankrupt) return '<span class="muted">You are bankrupt — spectating.</span>';
  let b = '';
  if (isMyTurn()) {
    const ph = s.turn.phase;
    if (ph === 'roll') {
      if (me.inJail) {
        b += `<button class="primary big" data-act="roll">🎲 Roll for doubles (try ${me.jailTurns + 1}/3)</button>`;
        b += `<button data-act="payBail" ${me.cash < s.econ.bail ? 'disabled' : ''}>Pay ${plain$(s.econ.bail)} bail</button>`;
        if (me.jailCards) b += '<button data-act="useJailCard">Use get-out card</button>';
      } else b += `<button class="primary big" data-act="roll">🎲 Roll dice${s.turn.doubles ? ' again' : ''}</button>`;
    } else if (ph === 'buy') {
      const i = s.turn.pendingBuy; const price = s.spaceInfo[i].price;
      b += `<button class="primary big" data-act="buy" ${me.cash < price ? 'disabled' : ''}>Buy ${esc(space(i).name)} for ${plain$(price)}</button>`;
      b += `<button data-act="decline">${s.settings.auctions ? 'Decline → auction' : 'Decline'}</button>`;
      b += `<button data-deed="${i}" class="link">view deed</button>`;
      if (me.cash < price) b += `<div class="muted" style="width:100%;text-align:center">Short ${plain$(price - me.cash)}? <button class="link" data-tab-go="bank">Borrow from the central bank</button> or mortgage something.</div>`;
    } else if (ph === 'done') {
      b += `<button class="primary big" data-act="endTurn">End turn ➜</button>`;
    }
  } else {
    b += `<span class="muted">Waiting for ${esc(s.players[s.turn.idx].name)}… you can still trade, borrow, build and write contracts.</span>`;
  }
  if (me.cash < 0) b += '<button class="danger" data-act="bankrupt" data-confirm="Declare bankruptcy? Your properties return to the bank and you are out of the game.">Declare bankruptcy</button>';
  return b;
}

function renderBoard() {
  const s = st();
  const board = $('#board');
  setHTML(board, S.board.spaces.map(cellHTML).join('') + `<div class="center" id="center">${centerHTML()}</div>`);
  if (s.lastRoll && s.lastRoll.seq !== S.lastRollSeq) {
    S.lastRollSeq = s.lastRoll.seq;
    const p = pl(s.lastRoll.player);
    const cell = board.querySelector(`[data-space="${p.pos}"]`);
    if (cell) cell.classList.add('flash');
  }
}

setInterval(() => {
  const el = $('#auctionTimer'); const a = st()?.auction;
  if (el && a) el.textContent = Math.max(0, Math.ceil((a.deadline - (Date.now() + S.clockSkew)) / 1000));
}, 500);

// ------------------------------------------------------------------ tabs
const TABS = [
  ['players', 'Players'], ['assets', 'My Assets'], ['bank', 'Central Bank'], ['economy', 'Economy'],
  ['trades', 'Trades'], ['contracts', 'Contracts'], ['log', 'Log & Chat'],
];

function renderTabs() {
  const s = st();
  const tradeN = s.trades.filter((t) => t.status === 'pending' && t.to === S.me).length;
  const conN = s.contracts.filter((c) => c.status === 'proposed' && c.parties[1] === S.me).length;
  const me = meP();
  const bankN = me && (me.marginCall || me.cash < 0) ? '!' : 0;
  const dots = { trades: tradeN, contracts: conN, bank: bankN };
  $('#tabs').innerHTML = TABS.map(([id, lbl]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${lbl}${dots[id] ? `<span class="dot">${dots[id]}</span>` : ''}</button>`).join('');
}

function renderTab() {
  const fn = { players: tabPlayers, assets: tabAssets, bank: tabBank, economy: tabEconomy, trades: tabTrades, contracts: tabContracts, log: tabLog }[S.tab];
  setHTML($('#tabBody'), fn());
  if (S.tab === 'economy') bindCharts();
}

function tabPlayers() {
  const s = st(); const me = meP();
  let h = '';
  if (me && me.host && s.status === 'playing') h += `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="small" data-act="endNow" data-confirm="End the game now? Highest net worth wins.">End game now (net worth wins)</button></div>`;
  for (const p of s.players) {
    const turn = s.status === 'playing' && s.players[s.turn.idx].id === p.id;
    const props = ownedBy(p.id);
    h += `<div class="pcard ${turn ? 'turn' : ''} ${p.bankrupt ? 'dead' : ''}" style="border-left-color:${p.color}">
      <div class="top"><span style="font-size:22px">${p.token}</span><span class="nm">${esc(p.name)}</span>
        ${p.id === S.me ? '<span class="badge good">you</span>' : ''}${p.host ? '<span class="badge">host</span>' : ''}
        ${p.connected ? '' : '<span class="badge warn">offline</span>'}${p.inJail ? '<span class="badge warn">lockup</span>' : ''}
        ${p.marginCall && !p.bankrupt ? '<span class="badge bad">margin call</span>' : ''}${p.bankrupt ? '<span class="badge bad">bankrupt</span>' : ''}
        <span class="cash">${money(p.cash)}</span></div>
      <div class="stats">
        <div><span>Net worth</span>${money(p.netWorth)}</div>
        <div><span>Book equity</span>${money(p.equity)}</div>
        <div><span>Property value</span>${money(p.propertyValue)}</div>
        <div><span>Bank debt</span>${money(p.bankDebt)}</div>
        <div><span>Mortgages</span>${money(p.mortgageDebt)}</div>
        <div><span>Leverage</span>${p.leverage == null ? '∞' : `${p.leverage.toFixed(2)}×`}</div>
      </div>
      <div class="chips">${props.map((i) => `<span class="chip ${s.spaceInfo[i].mortgaged ? 'm' : ''}" data-deed="${i}" title="${esc(space(i).name)}" style="background:${propColor(i)}"></span>`).join('')}${p.jailCards ? `<span class="badge">🎫×${p.jailCards}</span>` : ''}</div>
      ${me && me.host && p.id !== S.me && !p.bankrupt && s.status === 'playing' ? `<div class="row" style="justify-content:flex-end;margin-top:6px"><button class="small danger" data-act="kick" data-target="${p.id}" data-confirm="Remove ${esc(p.name)} from the game? Their assets return to the bank.">Remove player</button></div>` : ''}
    </div>`;
  }
  h += `<div class="muted" style="font-size:12px">Bank supply: ${s.bankHouses} houses · ${s.bankHotels} hotels. Net worth = book equity ± equity stakes held/issued.</div>`;
  return h;
}

function tabAssets() {
  const s = st(); const me = meP();
  if (!me) return '';
  const mine = ownedBy(S.me);
  if (!mine.length) return '<p class="muted">You don\'t own any property yet. Land on an unowned space to buy it, win it at auction, trade for it, or exercise a call option.</p>';
  const byGroup = {};
  for (const i of mine) { const k = space(i).type === 'street' ? space(i).group : space(i).type; (byGroup[k] ||= []).push(i); }
  let h = '';
  for (const [k, list] of Object.entries(byGroup)) {
    const g = S.board.groups[k];
    const full = g && S.board.spaces.filter((x) => x.group === k).every((x) => s.spaceInfo[x.index].owner === S.me);
    h += `<h3>${g ? esc(g.name) : k === 'transit' ? 'Transit' : 'Utilities'} ${full ? '<span class="badge good">full set</span>' : ''}</h3>`;
    for (const i of list) {
      const sp = space(i); const info = s.spaceInfo[i];
      const acts = [];
      if (sp.type === 'street' && full && !info.mortgaged && info.houses < 5) acts.push(`<button class="small" data-act="build" data-space="${i}">+${info.houses === 4 ? 'hotel' : 'house'} ${plain$(info.houseCost)}</button>`);
      if (info.houses > 0) acts.push(`<button class="small" data-act="sell" data-space="${i}">sell bldg +${plain$(info.houseCost / 2)}</button>`);
      if (!info.mortgaged && info.houses === 0) acts.push(`<button class="small" data-act="mortgage" data-space="${i}">mortgage +${plain$(info.mortgageValue)}</button>`);
      if (info.mortgaged) acts.push(`<button class="small" data-act="unmortgage" data-space="${i}">lift −${plain$(info.unmortgageCost)}</button>`);
      const bld = info.houses === 5 ? '🏨 hotel' : info.houses ? `${'🏠'.repeat(info.houses)}` : '';
      h += `<div class="prop-row"><div class="sw" style="background:${propColor(i)}"></div>
        <div><a href="#" data-deed="${i}">${esc(sp.name)}</a> ${bld} ${info.mortgaged ? '<span class="badge warn">mortgaged</span>' : ''} ${info.encumbered ? '<span class="badge">pledged</span>' : ''}
        <div class="sub">value ${plain$(info.price)} · rent now ${info.rentNow != null ? plain$(info.rentNow) : '4×/10× dice'}</div></div>
        <div class="acts">${acts.join('')}</div></div>`;
    }
  }
  return h;
}

function tabBank() {
  const s = st(); const me = meP(); const e = s.econ;
  if (!me) return '';
  const cap = s.settings.maxLeverage;
  const disabled = cap <= 1;
  let h = `<div class="box"><h4>🏦 Your balance sheet</h4><div class="kv">
    <span>Cash</span><span>${money(me.cash)}</span>
    <span>Property & buildings (market)</span><span>${money(me.propertyValue)}</span>
    <span class="tot">Total assets</span><span class="tot">${money(me.cash + me.propertyValue)}</span>
    <span>Central-bank loans</span><span>${money(me.bankDebt)}</span>
    <span>Mortgages</span><span>${money(me.mortgageDebt)}</span>
    <span class="tot">Book equity</span><span class="tot">${money(me.equity)}</span>
    <span>Leverage (assets ÷ equity)</span><span>${me.leverage == null ? '∞' : `${me.leverage.toFixed(2)}×`} / cap ${cap}×</span>
    <span>Bank borrowing limit</span><span>${money(me.maxLoan)}</span>
    <span>Headroom</span><span>${money(me.headroom)}</span>
  </div>${me.marginCall ? '<div class="alert warn" style="margin-top:8px">⚠ Margin call — repay bank debt or raise equity before ending your turn.</div>' : ''}</div>`;
  if (disabled) h += '<p class="muted">Central-bank borrowing is disabled in this game (leverage cap 1×).</p>';
  else {
    h += `<div class="box"><h4>Borrow at a fixed rate</h4>
      <div class="row"><input id="bankAmt" type="number" min="10" step="10" placeholder="amount" style="width:120px">
      <select id="bankTerm">${[5, 10, 20].map((t) => `<option value="${t}">${t} rounds @ ${pct(me.quotes[t])}</option>`).join('')}</select>
      <button class="small" data-bankmax>max</button><button class="primary" data-act="borrow">Borrow</button></div>
      <p class="muted" style="font-size:12px;margin-bottom:0">Interest is charged every round at the rate locked today; principal is due at maturity. If you can't repay, the loan rolls over at the 5-round rate +2% penalty. Quotes include a credit spread of 0.5% per turn of leverage.</p></div>`;
  }
  h += `<div class="box"><h4>Central-bank yield curve</h4><table class="t"><tr><th>Term</th><th class="n">Bank curve</th><th class="n">Your quote</th></tr>
    ${[5, 10, 20].map((t) => `<tr><td>${t} rounds</td><td class="n">${pct(e.curve[t])}</td><td class="n">${pct(me.quotes[t])}</td></tr>`).join('')}</table>
    <p class="muted" style="font-size:12px;margin-bottom:0">Short loans track today's policy rate (${pct(e.policyRate)}); long loans are anchored to the long-run neutral rate (${pct(e.neutralRate + e.inflationTarget)}). When the bank is hiking, long money is cheaper (inverted curve) — and lock in before rates rise!</p></div>`;
  h += '<div class="box"><h4>Your loans</h4>';
  if (!me.loans.length) h += '<p class="muted">No outstanding loans.</p>';
  else {
    h += `<table class="t"><tr><th class="n">Principal</th><th class="n">Rate</th><th class="n">Interest/rd</th><th>Matures</th><th></th></tr>${me.loans.map((l) => `
      <tr><td class="n">${plain$(l.principal)}</td><td class="n">${pct(l.rate)}</td><td class="n">${plain$(Math.max(1, Math.round(l.principal * l.rate / 100)))}</td><td>round ${l.maturity}</td>
      <td><div class="row" style="flex-wrap:nowrap"><input id="rp-${l.id}" type="number" style="width:80px" placeholder="${l.principal}"><button class="small" data-act="repay" data-loan="${l.id}">repay</button></div></td></tr>`).join('')}</table>`;
  }
  h += '</div>';
  return h;
}

function tabEconomy() {
  const s = st(); const e = s.econ; const c = e.components;
  const hist = e.history;
  const charts = [
    ['policyRate', 'Policy rate', (v) => pct(v)],
    ['inflation', 'Inflation per round', (v) => pct(v)],
    ['heat', 'Economy heat (0–100)', (v) => `${Math.round(v)}`],
    ['priceLevel', 'Price level', (v) => Number(v).toFixed(3)],
    ['credit', 'Total bank credit', (v) => plain$(v)],
    ['spending', 'Spending per round', (v) => plain$(v)],
  ];
  let h = `<div class="box"><h4>Economy heat: ${Math.round(e.heat)} / 100 — ${e.heat < 30 ? 'cold ❄️' : e.heat > 70 ? 'overheating 🔥' : 'steady'}</h4>
    <div class="gauge"><div class="mk" style="left:${clampN(e.heat, 0, 100)}%"></div><div class="lbls"><span>0 · stimulus</span><span>30</span><span>50</span><span>75 · surtax</span><span>100</span></div></div>
    ${[['velocity', 'Spending velocity', 40], ['creditGrowth', 'Credit growth', 30], ['creditLevel', 'Credit / money', 15], ['development', 'Development', 15]].map(([k, l, w]) => `<div class="cbar"><span>${l} <span class="muted">${w}%</span></span><div class="track"><div class="fill" style="width:${c[k]}%"></div></div><span>${c[k]}</span></div>`).join('')}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Heat is recomputed at the end of every round from the indicators above (then smoothed 50/50 with last round), plus any shocks from cards. This round so far: spending ${plain$(e.roundSpending)}.</p></div>`;
  h += `<div class="charts">${charts.map(([k, label, f]) => {
    const last = hist.length ? hist[hist.length - 1][k] : 0;
    return `<div class="chart"><h5>${label}</h5><div class="v">${f(last)}</div>${lineSVG(k, hist, f)}</div>`;
  }).join('')}</div>`;
  h += `<div class="box" style="margin-top:10px"><h4>How the central bank & treasury work</h4><ul class="muted" style="font-size:12.5px;padding-left:18px;margin:0">
    <li><b>Inflation</b> = ${pct(e.inflationTarget)} target + 0.04 × (heat − 50), plus noise. The price level compounds by inflation each round and scales property prices, building costs, rents, salary, taxes and card amounts. Existing debts and contracts stay nominal — inflation erodes them.</li>
    <li><b>Policy rate</b> follows a Taylor rule: neutral ${pct(e.neutralRate)} + inflation + 0.5 × (inflation − target) + 0.02 × (heat − 50), smoothed 60/40 and rounded to 0.25%.</li>
    <li><b>Fiscal rule</b>: heat below 30 → stimulus (PAYDAY salary +25%); above 75 → surtax (taxes +50%). Currently <b>${e.fiscal}</b>; salary ${plain$(e.salary)}.</li>
    <li><b>Bank losses</b> written off from bankruptcies: ${plain$(e.bankLosses)}.</li></ul></div>`;
  return h;
}
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));

function lineSVG(key, hist, fmt) {
  const W = 200, H = 70, P = 4;
  if (hist.length < 2) return '<svg viewBox="0 0 200 70"><text x="100" y="40" text-anchor="middle" fill="#8d99b6" font-size="11">waiting for round 2…</text></svg>';
  const vals = hist.map((x) => x[key]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (i) => P + (i / (hist.length - 1)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const zero = lo < 0 && hi > 0 ? `<line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" stroke="#3a4766" stroke-dasharray="3 3"/>` : '';
  S.charts[key] = { pts: hist.map((x, i) => ({ x: X(i), y: Y(x[key]), label: `Round ${x.round}: ${fmt(x[key])}` })), W };
  return `<svg viewBox="0 0 ${W} ${H}" data-chart="${key}" preserveAspectRatio="none">
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="#26324f"/>${zero}
    <path d="${d}" fill="none" stroke="#39d0c0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <line class="xh" x1="0" x2="0" y1="${P}" y2="${H - P}" stroke="#8d99b6" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/></svg>`;
}

function bindCharts() {
  const tip = $('#tooltip');
  for (const svg of $$('svg[data-chart]')) {
    const c = S.charts[svg.dataset.chart]; if (!c) continue;
    const xh = svg.querySelector('.xh');
    svg.onmousemove = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * c.W;
      let best = c.pts[0];
      for (const p of c.pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
      xh.setAttribute('x1', best.x); xh.setAttribute('x2', best.x); xh.setAttribute('visibility', 'visible');
      tip.textContent = best.label; tip.classList.remove('hidden');
      tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY - 28}px`;
    };
    svg.onmouseleave = () => { xh.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
  }
}

// ------------------------------------------------------------------ trades
function tradeSide(side) {
  const parts = [];
  if (side.cash) parts.push(plain$(side.cash));
  for (const i of side.spaces) parts.push(esc(space(i).name));
  if (side.jailCards) parts.push(`${side.jailCards} get-out card(s)`);
  return parts.join(', ') || 'nothing';
}

function tabTrades() {
  const s = st();
  let h = '<div class="row" style="margin-bottom:10px"><button class="primary" data-open="trade">+ New trade</button><span class="muted" style="font-size:12px">Swap property, cash and get-out cards (traditional rules: no buildings in the traded group).</span></div>';
  const pending = s.trades.filter((t) => t.status === 'pending');
  const mine = pending.filter((t) => t.to === S.me || t.from === S.me);
  const others = pending.filter((t) => t.to !== S.me && t.from !== S.me);
  const card = (t) => `<div class="contract ${t.status === 'pending' ? 'proposed' : 'done'}">
    <div class="hdr"><b>${pname(t.from)} → ${pname(t.to)}</b><span class="badge">${t.status}</span></div>
    <div style="font-size:13px;margin-top:4px"><b>${esc(pl(t.from).name)} gives:</b> ${tradeSide(t.give)}<br><b>${esc(pl(t.to).name)} gives:</b> ${tradeSide(t.get)}</div>
    ${t.status === 'pending' && t.to === S.me ? `<div class="row" style="margin-top:6px"><button class="primary small" data-act="acceptTrade" data-id="${t.id}">Accept</button><button class="small danger" data-act="rejectTrade" data-id="${t.id}">Reject</button></div>` : ''}
    ${t.status === 'pending' && t.from === S.me ? `<div class="row" style="margin-top:6px"><button class="small" data-act="cancelTrade" data-id="${t.id}">Cancel</button></div>` : ''}</div>`;
  h += '<h3>Your pending trades</h3>' + (mine.length ? mine.map(card).join('') : '<p class="muted">None.</p>');
  if (others.length) h += '<h3>Other pending trades</h3>' + others.map(card).join('');
  const done = s.trades.filter((t) => t.status !== 'pending').slice(-8).reverse();
  if (done.length) h += '<h3>Recent</h3>' + done.map(card).join('');
  return h;
}

function openTradeModal() {
  const s = st();
  const others = s.players.filter((p) => !p.bankrupt && p.id !== S.me);
  if (!others.length) return toast('No one to trade with', 'err');
  const d = { to: others[0].id, give: { cash: 0, spaces: [], jailCards: 0 }, get: { cash: 0, spaces: [], jailCards: 0 } };
  const tradeable = (pid) => ownedBy(pid).filter((i) => !(space(i).group && S.board.spaces.some((x) => x.group === space(i).group && st().spaceInfo[x.index].houses > 0)) && !st().spaceInfo[i].encumbered);
  const sideHTML = (pid, key) => {
    const p = pl(pid); const side = d[key];
    return `<div><h3>${key === 'give' ? 'You give' : `${esc(p.name)} gives`}</h3>
      <label>Cash (has ${plain$(p.cash)})<input type="number" min="0" data-tf="${key}.cash" value="${side.cash || ''}"></label>
      ${p.jailCards ? `<label>Get-out cards<input type="number" min="0" max="${p.jailCards}" data-tf="${key}.jailCards" value="${side.jailCards || ''}"></label>` : ''}
      <div class="checks" style="margin-top:8px">${tradeable(pid).map((i) => `<label><input type="checkbox" data-tp="${key}" value="${i}" ${side.spaces.includes(i) ? 'checked' : ''}><span class="chip" style="background:${propColor(i)}"></span>${esc(space(i).name)}${st().spaceInfo[i].mortgaged ? ' (M)' : ''}</label>`).join('') || '<span class="muted">No tradeable property</span>'}</div></div>`;
  };
  const draw = () => {
    $('#modalBody').innerHTML = `<h2>🤝 New trade</h2>
      <label>Trade with<select data-tto>${others.map((p) => `<option value="${p.id}" ${p.id === d.to ? 'selected' : ''}>${p.token} ${esc(p.name)}</option>`).join('')}</select></label>
      <div class="cols">${sideHTML(S.me, 'give')}${sideHTML(d.to, 'get')}</div>
      <div class="row end"><button data-close>Cancel</button><button class="primary" data-sendtrade>Send offer</button></div>`;
    $('[data-tto]').onchange = (e) => { d.to = e.target.value; d.get = { cash: 0, spaces: [], jailCards: 0 }; draw(); };
    for (const inp of $$('[data-tf]')) inp.oninput = () => { const [k, f] = inp.dataset.tf.split('.'); d[k][f] = Number(inp.value) || 0; };
    for (const cb of $$('[data-tp]')) cb.onchange = () => { const side = d[cb.dataset.tp]; const v = Number(cb.value); side.spaces = cb.checked ? [...side.spaces, v] : side.spaces.filter((x) => x !== v); };
    $('[data-sendtrade]').onclick = () => { act('proposeTrade', { trade: d }); closeModal(); S.tab = 'trades'; render(); };
  };
  openModal(); draw();
}

// ------------------------------------------------------------------ contracts
function clauseFlow(cl) {
  if (cl.kind === 'fixed') return cl.amount;
  if (cl.kind === 'rate') return Math.max(0, Math.round(cl.notional * (cl.rateType === 'fixed' ? cl.rate : st().econ.policyRate + cl.spread) / 100));
  return 0;
}

function propList(spaces) { return spaces.length ? spaces.map((i) => esc(space(i).name)).join(', ') : 'ALL their properties'; }

function describeClause(cl) {
  const n = (id) => (id === S.me ? '<b>You</b>' : pname(id));
  switch (cl.kind) {
    case 'upfront': return `${n(cl.from)} pay${cl.from === S.me ? '' : 's'} ${n(cl.to)} <b>${plain$(cl.amount)}</b> at signing`;
    case 'fixed': return `${n(cl.from)} → ${n(cl.to)}: <b>${plain$(cl.amount)}</b> every round`;
    case 'rate': return `${n(cl.from)} → ${n(cl.to)}: ${cl.rateType === 'fixed' ? `<b>fixed ${pct(cl.rate)}</b>` : `<b>floating</b> (policy rate ${cl.spread >= 0 ? '+' : ''}${pct(cl.spread)})`} on ${plain$(cl.notional)} notional per round (now ≈ ${plain$(clauseFlow(cl))})`;
    case 'rentShare': return `${n(cl.from)} → ${n(cl.to)}: <b>${cl.pct}%</b> of rent collected on ${cl.spaces.length ? propList(cl.spaces) : 'all properties'}`;
    case 'equity': return `${n(cl.to)} own${cl.to === S.me ? '' : 's'} <b>${cl.pct}% equity</b> in ${n(cl.from)}: ${cl.pct}% of all rent income as dividends + ${cl.pct}% of book equity in net worth`;
    case 'maturity': return `${n(cl.from)} → ${n(cl.to)}: <b>${plain$(cl.amount)}</b> at maturity`;
    case 'default': return `${n(cl.from)} pay${cl.from === S.me ? '' : 's'} ${n(cl.to)} <b>${plain$(cl.amount)}</b> if ${pname(cl.ref)} goes bankrupt (credit event)`;
    case 'call': return `${n(cl.holder)} may <b>buy</b> ${esc(space(cl.space).name)} from ${n(cl.writer)} for <b>${plain$(cl.strike)}</b> (call option)${cl.exercised ? ' — <i>exercised</i>' : ''}`;
    case 'put': return `${n(cl.holder)} may <b>sell</b> ${esc(space(cl.space).name)} to ${n(cl.writer)} for <b>${plain$(cl.strike)}</b> (put option)${cl.exercised ? ' — <i>exercised</i>' : ''}`;
    case 'collateral': return `${n(cl.from)} pledge${cl.from === S.me ? '' : 's'} ${cl.spaces.map((i) => esc(space(i).name)).join(', ')} as collateral — seized by ${n(cl.to)} if a payment is missed`;
    default: return cl.kind;
  }
}

function myNetPerRound(c) {
  let net = 0;
  for (const cl of c.clauses) { const f = clauseFlow(cl); if (cl.to === S.me) net += f; if (cl.from === S.me) net -= f; }
  return net;
}

function contractCard(c) {
  const s = st();
  const mine = c.parties.includes(S.me);
  const cls = c.status === 'proposed' ? 'proposed' : c.status === 'active' ? '' : 'done';
  const net = myNetPerRound(c);
  let h = `<div class="contract ${cls}"><div class="hdr"><b>📜 ${esc(c.name)}</b><span class="badge ${c.status === 'active' ? 'good' : c.status === 'defaulted' ? 'bad' : ''}">${c.status}</span></div>
    <div class="muted" style="font-size:12px">${pname(c.parties[0])} ⇄ ${pname(c.parties[1])} · ${c.term ? `term ${c.term} rounds` : 'perpetual'}${c.status === 'active' ? ` · ${c.periods} settled` : ''}</div>
    <ul>${c.clauses.map((cl) => `<li>${describeClause(cl)}</li>`).join('')}</ul>`;
  if (mine && net) h += `<div style="font-size:12.5px">Your periodic net at today's rates: <b class="${net > 0 ? 'pos' : 'neg'}">${net > 0 ? '+' : ''}${plain$(net)}/round</b></div>`;
  if (c.status === 'active') {
    const opts = c.clauses.map((cl, k) => [cl, k]).filter(([cl]) => ['call', 'put'].includes(cl.kind) && cl.holder === S.me && !cl.exercised);
    if (opts.length) h += `<div class="row" style="margin-top:6px">${opts.map(([cl, k]) => `<button class="primary small" data-act="exercise" data-id="${c.id}" data-clause="${k}" data-confirm="Exercise the ${cl.kind} on ${esc(space(cl.space).name)} at ${plain$(cl.strike)}?">Exercise ${cl.kind} on ${esc(space(cl.space).name)}</button>`).join('')}</div>`;
  }
  if (c.status === 'proposed' && c.parties[1] === S.me) h += `<div class="row" style="margin-top:6px"><button class="primary small" data-act="acceptContract" data-id="${c.id}">Accept & sign</button><button class="small danger" data-act="rejectContract" data-id="${c.id}">Reject</button></div>`;
  if (c.status === 'proposed' && c.proposer === S.me) h += `<div class="row" style="margin-top:6px"><button class="small" data-act="cancelContract" data-id="${c.id}">Withdraw offer</button></div>`;
  if (c.history.length) h += `<details style="font-size:12px;margin-top:4px"><summary class="muted">Payment history (${c.history.length})</summary>${c.history.slice(-10).reverse().map((x) => `<div>R${x.round}: ${esc(pl(x.from).name)} → ${esc(pl(x.to).name)} ${plain$(x.amount)} (${esc(x.reason)})</div>`).join('')}</details>`;
  void s;
  return h + '</div>';
}

function tabContracts() {
  const cs = st().contracts;
  let h = `<div class="row" style="margin-bottom:10px"><button class="primary" data-open="contract">+ New contract</button><span class="muted" style="font-size:12px">Loans, bonds, swaps, equity stakes, options, credit default swaps — or build your own.</span></div>`;
  const inbox = cs.filter((c) => c.status === 'proposed' && c.parties[1] === S.me);
  const outbox = cs.filter((c) => c.status === 'proposed' && c.proposer === S.me);
  const myActive = cs.filter((c) => c.status === 'active' && c.parties.includes(S.me));
  const otherActive = cs.filter((c) => c.status === 'active' && !c.parties.includes(S.me));
  const closed = cs.filter((c) => !['active', 'proposed'].includes(c.status) && !['rejected', 'cancelled'].includes(c.status)).slice(-10).reverse();
  if (inbox.length) h += '<h3>Awaiting your signature</h3>' + inbox.map(contractCard).join('');
  if (outbox.length) h += '<h3>Your offers</h3>' + outbox.map(contractCard).join('');
  h += '<h3>Your active contracts</h3>' + (myActive.length ? myActive.map(contractCard).join('') : '<p class="muted">None yet.</p>');
  if (otherActive.length) h += '<h3>Other players\' contracts (public record)</h3>' + otherActive.map(contractCard).join('');
  if (closed.length) h += '<h3>Closed</h3>' + closed.map(contractCard).join('');
  return h;
}

const CLAUSE_DEFAULTS = {
  upfront: { dir: 'in', amount: 500 }, fixed: { dir: 'out', amount: 40 },
  rate: { dir: 'out', notional: 1000, rateType: 'fixed', rate: 3, spread: 0 },
  rentShare: { dir: 'in', pct: 50, spaces: [] }, equity: { dir: 'out', pct: 20 },
  maturity: { dir: 'out', amount: 500 }, default: { dir: 'in', amount: 500, ref: null },
  call: { dir: 'in', space: null, strike: 200 }, put: { dir: 'in', space: null, strike: 200 },
  collateral: { dir: 'out', spaces: [] },
};
const CLAUSE_NAMES = {
  upfront: 'Upfront payment', fixed: 'Fixed payment / round', rate: 'Interest leg (fixed or floating)', rentShare: 'Rent share',
  equity: 'Equity stake', maturity: 'Payment at maturity', default: 'Credit-event payment', call: 'Call option', put: 'Put option', collateral: 'Collateral pledge',
};
const DIR_LABELS = {
  upfront: ['I pay them', 'They pay me'], fixed: ['I pay them', 'They pay me'], maturity: ['I pay them', 'They pay me'],
  rate: ['I pay this leg', 'They pay this leg'], rentShare: ['I share my rent with them', 'They share their rent with me'],
  equity: ['I issue equity to them', 'They issue equity to me'],
  default: ['I pay if the reference goes bust (sell protection)', 'They pay me if the reference goes bust (buy protection)'],
  call: ['They hold it (they may buy MY property)', 'I hold it (I may buy THEIR property)'],
  put: ['They hold it (they may sell THEIR property to me)', 'I hold it (I may sell MY property to them)'],
  collateral: ['I pledge my property', 'They pledge their property'],
};
const TEMPLATES = {
  loan: { label: 'Loan / bond', desc: 'Borrow from a player: cash now, coupons, principal back', name: 'Bond', term: 8, clauses: [{ kind: 'upfront', dir: 'in', amount: 500 }, { kind: 'fixed', dir: 'out', amount: 25 }, { kind: 'maturity', dir: 'out', amount: 500 }] },
  secured: { label: 'Secured loan', desc: 'A loan backed by property collateral', name: 'Secured loan', term: 8, clauses: [{ kind: 'upfront', dir: 'in', amount: 500 }, { kind: 'rate', dir: 'out', notional: 500, rateType: 'fixed', rate: 4, spread: 0 }, { kind: 'maturity', dir: 'out', amount: 500 }, { kind: 'collateral', dir: 'out', spaces: [] }] },
  irs: { label: 'Interest-rate swap', desc: 'Pay fixed, receive floating on a notional', name: 'Rate swap', term: 10, clauses: [{ kind: 'rate', dir: 'out', notional: 1000, rateType: 'fixed', rate: 2.5, spread: 0 }, { kind: 'rate', dir: 'in', notional: 1000, rateType: 'floating', rate: 0, spread: 0 }] },
  rentswap: { label: 'Rent swap', desc: 'Pay a fixed amount, receive the rent from their property', name: 'Rent swap', term: 10, clauses: [{ kind: 'fixed', dir: 'out', amount: 40 }, { kind: 'rentShare', dir: 'in', pct: 100, spaces: [] }] },
  equity: { label: 'Equity investment', desc: 'Investor pays now for a % of the issuer\'s income & net worth', name: 'Equity stake', term: 0, clauses: [{ kind: 'upfront', dir: 'in', amount: 300 }, { kind: 'equity', dir: 'out', pct: 20 }] },
  call: { label: 'Call option', desc: 'Pay a premium for the right to buy their property', name: 'Call option', term: 10, clauses: [{ kind: 'upfront', dir: 'out', amount: 50 }, { kind: 'call', dir: 'in', space: null, strike: 250 }] },
  put: { label: 'Put option', desc: 'Insurance: right to sell your property at a set price', name: 'Put option', term: 10, clauses: [{ kind: 'upfront', dir: 'out', amount: 40 }, { kind: 'put', dir: 'in', space: null, strike: 150 }] },
  cds: { label: 'Credit default swap', desc: 'Pay a premium; get paid if a player goes bankrupt', name: 'CDS', term: 10, clauses: [{ kind: 'fixed', dir: 'out', amount: 15 }, { kind: 'default', dir: 'in', amount: 500, ref: null }] },
  custom: { label: 'Custom', desc: 'Start blank and add any clauses', name: 'Custom contract', term: 10, clauses: [] },
};

function openContractModal() {
  const s = st();
  const others = s.players.filter((p) => !p.bankrupt && p.id !== S.me);
  if (!others.length) return toast('No counterparty available', 'err');
  const d = { tpl: 'loan', to: others[0].id, name: '', term: 8, clauses: [] };
  const applyTpl = (k) => { const t = TEMPLATES[k]; d.tpl = k; d.name = t.name; d.term = t.term; d.clauses = t.clauses.map((c) => ({ ...CLAUSE_DEFAULTS[c.kind], ...c, spaces: [...(c.spaces || [])] })); };
  applyTpl('loan');
  const them = () => d.to;
  const relevantOwner = (cl) => {
    if (cl.kind === 'rentShare' || cl.kind === 'collateral') return cl.dir === 'out' ? S.me : them();
    if (cl.kind === 'call') return cl.dir === 'in' ? them() : S.me;
    if (cl.kind === 'put') return cl.dir === 'in' ? S.me : them();
    return null;
  };
  const toServer = (cl) => {
    const me = S.me; const t = them();
    const out = { kind: cl.kind };
    if (cl.kind === 'call' || cl.kind === 'put') { out.holder = cl.dir === 'in' ? me : t; out.writer = cl.dir === 'in' ? t : me; out.space = cl.space; out.strike = cl.strike; return out; }
    out.from = cl.dir === 'out' ? me : t; out.to = cl.dir === 'out' ? t : me;
    for (const k of ['amount', 'notional', 'rateType', 'rate', 'spread', 'pct', 'ref']) if (cl[k] !== undefined) out[k] = cl[k];
    if (cl.spaces) out.spaces = cl.spaces;
    if (cl.kind === 'default' && !out.ref) out.ref = s.players.find((p) => !p.bankrupt && p.id !== out.from)?.id;
    return out;
  };
  const num = (k, v, label, step = 1) => `<label>${label}<input type="number" step="${step}" data-cf="${k}" value="${v ?? ''}"></label>`;
  const clauseHTML = (cl, idx) => {
    let f = `<label>Direction<select data-cs="dir">${DIR_LABELS[cl.kind].map((l, k) => `<option value="${k ? 'in' : 'out'}" ${(k ? 'in' : 'out') === cl.dir ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    if (['upfront', 'fixed', 'maturity', 'default'].includes(cl.kind)) f += num('amount', cl.amount, 'Amount ($)');
    if (cl.kind === 'rate') {
      f += num('notional', cl.notional, 'Notional ($)');
      f += `<label>Rate type<select data-cs="rateType"><option value="fixed" ${cl.rateType === 'fixed' ? 'selected' : ''}>Fixed</option><option value="floating" ${cl.rateType === 'floating' ? 'selected' : ''}>Floating (policy rate)</option></select></label>`;
      f += cl.rateType === 'fixed' ? num('rate', cl.rate, 'Fixed rate % / round', 0.05) : num('spread', cl.spread, 'Spread over policy %', 0.05);
    }
    if (cl.kind === 'rentShare' || cl.kind === 'equity') f += num('pct', cl.pct, cl.kind === 'equity' ? 'Equity stake %' : 'Percent of rent');
    if (cl.kind === 'default') {
      const refs = s.players.filter((p) => !p.bankrupt);
      if (!cl.ref) cl.ref = refs.find((p) => p.id !== (cl.dir === 'out' ? S.me : them()))?.id;
      f +=`<label>Reference player<select data-cs="ref">${refs.map((p) => `<option value="${p.id}" ${cl.ref === p.id ? 'selected' : ''}>${p.token} ${esc(p.name)}</option>`).join('')}</select></label>`;
    }
    if (cl.kind === 'call' || cl.kind === 'put') {
      const props = ownedBy(relevantOwner(cl));
      if (cl.space == null || !props.includes(cl.space)) cl.space = props[0] ?? null;
      f += `<label>Property<select data-cs="space">${props.map((i) => `<option value="${i}" ${cl.space === i ? 'selected' : ''}>${esc(space(i).name)} (value ${plain$(s.spaceInfo[i].price)})</option>`).join('') || '<option value="">— owner has no property —</option>'}</select></label>`;
      f += num('strike', cl.strike, 'Strike price ($)');
    }
    let checks = '';
    if (cl.kind === 'rentShare' || cl.kind === 'collateral') {
      const props = ownedBy(relevantOwner(cl));
      cl.spaces = cl.spaces.filter((x) => props.includes(x));
      checks = `<div class="checks" style="margin-top:8px">${cl.kind === 'rentShare' ? '<span class="muted" style="font-size:12px">Tick properties (none ticked = ALL properties):</span>' : ''}${props.map((i) => `<label><input type="checkbox" data-cp value="${i}" ${cl.spaces.includes(i) ? 'checked' : ''}><span class="chip" style="background:${propColor(i)}"></span>${esc(space(i).name)}</label>`).join('') || '<span class="muted">No properties</span>'}</div>`;
    }
    return `<div class="clause" data-ci="${idx}"><div class="ch"><b>${idx + 1}. ${CLAUSE_NAMES[cl.kind]}</b><button class="small danger" data-rm>remove</button></div><div class="fields">${f}</div>${checks}</div>`;
  };
  const previewHTML = () => {
    const sc = d.clauses.map(toServer);
    const tmp = { clauses: sc };
    const net = myNetPerRound(tmp);
    const upfront = sc.filter((c) => c.kind === 'upfront').reduce((a, c) => a + (c.to === S.me ? c.amount : -c.amount), 0);
    const mat = sc.filter((c) => c.kind === 'maturity').reduce((a, c) => a + (c.to === S.me ? c.amount : -c.amount), 0);
    let lines = '';
    try { lines = sc.map((c) => `<li>${describeClause(c)}</li>`).join(''); } catch { lines = '<li>…</li>'; }
    return `<b>Term sheet</b><ul>${lines || '<li class="muted">No clauses yet</li>'}</ul>
      <div>At signing: <b class="${upfront >= 0 ? 'pos' : 'neg'}">${upfront >= 0 ? '+' : ''}${plain$(upfront)}</b> · Periodic net now: <b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${plain$(net)}/round</b>${d.term ? ` (≈ ${plain$(net * d.term)} over ${d.term} rounds)` : ''} · At maturity: <b class="${mat >= 0 ? 'pos' : 'neg'}">${mat >= 0 ? '+' : ''}${plain$(mat)}</b></div>`;
  };
  const draw = () => {
    $('#modalBody').innerHTML = `<h2>📜 New financial contract</h2>
      <div class="tpls">${Object.entries(TEMPLATES).map(([k, t]) => `<button data-tpl="${k}" class="${d.tpl === k ? 'on' : ''}"><b>${t.label}</b><small>${t.desc}</small></button>`).join('')}</div>
      <div class="fields" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
        <label>Counterparty<select data-cto>${others.map((p) => `<option value="${p.id}" ${p.id === d.to ? 'selected' : ''}>${p.token} ${esc(p.name)}</option>`).join('')}</select></label>
        <label>Contract name<input data-cname maxlength="40" value="${esc(d.name)}"></label>
        <label>Term (rounds, 0 = perpetual)<input type="number" min="0" max="100" data-cterm value="${d.term}"></label>
      </div>
      <h3>Clauses</h3><div id="clauses">${d.clauses.map(clauseHTML).join('')}</div>
      <div class="row"><select data-addkind>${Object.entries(CLAUSE_NAMES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button data-add>+ Add clause</button>
        <button class="small" data-flip title="Swap every direction — e.g. turn 'borrow' into 'lend'">⇄ Flip all directions</button></div>
      <h3>Preview</h3><div class="preview" id="cprev">${previewHTML()}</div>
      <p class="muted" style="font-size:12px">Periodic legs are netted and settled at the start of every round, starting next round. A party that is short of cash on a payment and has pledged collateral in this contract <b>defaults</b> and loses the collateral; without collateral, the payment is forced (cash can go negative). Contract amounts are nominal — not indexed to inflation.</p>
      <div class="row end"><button data-close>Cancel</button><button class="primary" data-sendc>Send to counterparty</button></div>`;
    const refreshPrev = () => { $('#cprev').innerHTML = previewHTML(); };
    for (const b of $$('[data-tpl]')) b.onclick = () => { applyTpl(b.dataset.tpl); draw(); };
    $('[data-cto]').onchange = (e) => { d.to = e.target.value; draw(); };
    $('[data-cname]').oninput = (e) => { d.name = e.target.value; };
    $('[data-cterm]').oninput = (e) => { d.term = Number(e.target.value) || 0; refreshPrev(); };
    $('[data-add]').onclick = () => { const k = $('[data-addkind]').value; d.clauses.push({ kind: k, ...structuredClone(CLAUSE_DEFAULTS[k]) }); d.tpl = 'custom'; draw(); };
    $('[data-flip]').onclick = () => { for (const c of d.clauses) c.dir = c.dir === 'in' ? 'out' : 'in'; draw(); };
    for (const el of $$('.clause')) {
      const cl = d.clauses[Number(el.dataset.ci)];
      el.querySelector('[data-rm]').onclick = () => { d.clauses.splice(Number(el.dataset.ci), 1); draw(); };
      for (const inp of $$('[data-cf]', el)) inp.oninput = () => { cl[inp.dataset.cf] = Number(inp.value); refreshPrev(); };
      for (const sel of $$('[data-cs]', el)) sel.onchange = () => { const k = sel.dataset.cs; cl[k] = k === 'space' ? Number(sel.value) : sel.value; if (k === 'dir') { cl.spaces = cl.spaces ? [] : cl.spaces; cl.space = cl.space === undefined ? undefined : null; } draw(); };
      for (const cb of $$('[data-cp]', el)) cb.onchange = () => { const v = Number(cb.value); cl.spaces = cb.checked ? [...cl.spaces, v] : cl.spaces.filter((x) => x !== v); refreshPrev(); };
    }
    $('[data-sendc]').onclick = () => {
      act('proposeContract', { contract: { to: d.to, name: d.name, term: d.term, clauses: d.clauses.map(toServer) } });
      closeModal(); S.tab = 'contracts'; render();
    };
  };
  openModal(); draw();
}

// ------------------------------------------------------------------ log
function tabLog() {
  const s = st();
  return `<div class="row" style="margin-bottom:10px"><input id="chatIn" placeholder="Say something…" maxlength="200" style="flex:1"><button data-chat>Send</button></div>
    <div class="log-list">${s.log.slice().reverse().map((l) => `<div class="l-${l.kind}"><span class="muted">R${l.round}</span> ${l.kind === 'chat' ? `<b>${esc(l.msg.split(':')[0])}:</b>${esc(l.msg.slice(l.msg.indexOf(':') + 1))}` : esc(l.msg)}</div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ modals
function openModal(html) { if (html !== undefined) $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }

function openDeed(i) {
  const s = st(); const sp = space(i);
  if (!s || s.status === 'lobby' || !ownable(sp)) return;
  const info = s.spaceInfo[i];
  const owner = info.owner ? pl(info.owner) : null;
  const col = propColor(i);
  let rows = '';
  if (sp.type === 'street') {
    const r = info.rentTable;
    rows = `<span>Rent</span><span>${plain$(r[0])}</span><span>Rent with full set</span><span>${plain$(r[0] * 2)}</span>
      ${[1, 2, 3, 4].map((k) => `<span>With ${k} house${k > 1 ? 's' : ''}</span><span>${plain$(r[k])}</span>`).join('')}<span>With hotel</span><span>${plain$(r[5])}</span>
      <span>Building cost</span><span>${plain$(info.houseCost)} each</span>`;
  } else if (sp.type === 'transit') rows = [1, 2, 3, 4].map((k) => `<span>Own ${k} hub${k > 1 ? 's' : ''}</span><span>${plain$(Math.round(25 * 2 ** (k - 1) * s.econ.priceLevel))}</span>`).join('');
  else rows = '<span>Own 1 utility</span><span>4 × dice</span><span>Own both</span><span>10 × dice</span>';
  openModal(`<div class="deed"><div class="hd" style="background:${col}">${sp.type === 'street' ? `<small>${esc(groupOf(i).name)}</small>` : ''}${esc(sp.name)}</div>
    <div class="bd"><div class="kv">${rows}
      <span class="tot">Price today</span><span class="tot">${plain$(info.price)}</span>
      <span>Mortgage value</span><span>${plain$(info.mortgageValue)}</span>
      <span>Owner</span><span>${owner ? `${owner.token} ${esc(owner.name)}` : 'Bank (for sale)'}</span>
      ${info.mortgaged ? `<span>Status</span><span class="neg">Mortgaged (${plain$(info.mortgageAmt)})</span>` : ''}
      ${info.houses ? `<span>Buildings</span><span>${info.houses === 5 ? 'hotel' : `${info.houses} house(s)`}</span>` : ''}
      ${info.encumbered ? '<span>Contracts</span><span>pledged / under option</span>' : ''}
    </div><p class="muted" style="font-size:12px;margin-bottom:0">All prices & rents scale with the price level (${s.econ.priceLevel.toFixed(3)}).</p></div></div>`);
}

const RULES_HTML = `<div class="rules"><h2>How to play Margin Call</h2>
<h3>The classic game</h3>
<ul>
<li>2–8 players start with the same cash. On your turn roll two dice and move. Passing or landing on <b>PAYDAY</b> pays your salary.</li>
<li><b>Doubles</b> let you roll again; three doubles in a row sends you to <b>Lockup</b>.</li>
<li>Land on an unowned property: <b>buy it</b> at its price or decline, and it is <b>auctioned</b> to all players.</li>
<li>Land on someone's property: pay <b>rent</b>. Owning a whole colour group doubles unimproved rent. Transit hubs pay 25/50/100/200 by how many the owner has; utilities charge 4× or 10× the dice.</li>
<li>With a full group (and no mortgages in it) you can build <b>houses</b> evenly, then a <b>hotel</b>. Buildings sell back at half price. The bank has 32 houses and 12 hotels.</li>
<li><b>Mortgage</b> unimproved property for half its value; lifting a mortgage costs +10%. Mortgaged property earns no rent.</li>
<li><b>Lockup</b>: pay bail, use a get-out card, or roll doubles (max 3 tries, then pay and move).</li>
<li>Draw <b>Market Event</b> and <b>Town Treasury</b> cards — some are macro shocks hitting the whole economy.</li>
<li>Trade property, cash and cards at any time. Can't pay? Raise cash or declare <b>bankruptcy</b>. Last player standing wins (or the host can end the game: highest net worth wins).</li>
</ul>
<h3>The central bank</h3>
<ul>
<li>Borrow any time at a <b>fixed rate locked when you borrow</b>, for 5, 10 or 20 rounds. Interest is charged each round; principal is due at maturity (or rolls over at a penalty rate).</li>
<li>Your quote = the bank's yield curve for that term + a <b>credit spread</b> of 0.5% per unit of leverage.</li>
<li>Borrowing is capped so that <b>assets ÷ equity ≤ the leverage cap</b>. If losses push you over the cap you get a <b>margin call</b>: fix it before you end your turn or the bank seizes cash, sells buildings and mortgages property to pay down your loans.</li>
</ul>
<h3>The economy</h3>
<ul>
<li>Each round the game measures spending velocity, credit growth, credit-to-money and development to compute an <b>economy heat</b> index (0–100).</li>
<li>Heat drives <b>inflation</b>. The <b>price level</b> scales prices, rents, salary, taxes and building costs — but debts stay nominal, so inflation helps borrowers and hurts lenders.</li>
<li>The central bank sets its <b>policy rate</b> by a Taylor rule: hot economy → higher rates, cold → cuts. The treasury runs <b>stimulus</b> when cold and a <b>surtax</b> when overheating.</li>
</ul>
<h3>Financial contracts between players</h3>
<ul>
<li>Combine clauses: upfront cash, fixed payments, fixed/floating interest legs on a notional, rent shares, equity stakes, maturity payments, credit-event payments, call & put options on property, and collateral pledges.</li>
<li>Templates: <b>bond</b>, <b>secured loan</b>, <b>interest-rate swap</b>, <b>rent swap</b>, <b>equity investment</b>, <b>call</b>, <b>put</b>, <b>credit default swap</b>.</li>
<li>Periodic legs are netted and settled at the start of every round. Miss a payment with collateral pledged and you <b>default</b> — the collateral transfers. When a party goes bankrupt their collateral transfers, CDS contracts on them pay out, and their other contracts are void.</li>
<li>Options are exercised from the Contracts tab; any buildings in that colour group are sold to the bank first.</li>
</ul></div>`;

// ------------------------------------------------------------------ events
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('button, [data-deed], [data-space], a');
  if (!t) return;
  if (t.dataset.openRules !== undefined) { openModal(RULES_HTML); return; }
  if (t.classList.contains('modal-x') || t.dataset.close !== undefined) { closeModal(); return; }
  if (t.dataset.tab) { S.tab = t.dataset.tab; render(); return; }
  if (t.dataset.tabGo) { S.tab = t.dataset.tabGo; render(); return; }
  if (t.dataset.open === 'trade') return openTradeModal();
  if (t.dataset.open === 'contract') return openContractModal();
  if (t.dataset.deed !== undefined) { ev.preventDefault(); openDeed(Number(t.dataset.deed)); return; }
  if (t.dataset.bidplus) { const a = st().auction; const inp = $('#bidAmt'); const base = Math.max(a.highBid, Number(inp.value) || 0); inp.value = base + Number(t.dataset.bidplus); return; }
  if (t.dataset.bankmax !== undefined) { $('#bankAmt').value = meP().headroom; return; }
  if (t.dataset.chat !== undefined) { const i = $('#chatIn'); if (i.value.trim()) { act('chat', { text: i.value }); i.value = ''; } return; }
  if (t.dataset.act) {
    if (t.dataset.confirm && !confirm(t.dataset.confirm)) return;
    const a = t.dataset.act; const extra = {};
    if (t.dataset.space) extra.space = Number(t.dataset.space);
    if (t.dataset.id) extra.id = t.dataset.id;
    if (t.dataset.clause) extra.clause = Number(t.dataset.clause);
    if (t.dataset.target) extra.target = t.dataset.target;
    if (a === 'bid') { extra.amount = Number($('#bidAmt').value); if (!extra.amount) return toast('Enter a bid', 'err'); $('#bidAmt').value = ''; }
    if (a === 'borrow') { extra.amount = Number($('#bankAmt').value); extra.term = Number($('#bankTerm').value); if (!extra.amount) return toast('Enter an amount', 'err'); $('#bankAmt').value = ''; }
    if (a === 'repay') { extra.loanId = t.dataset.loan; const inp = $(`#rp-${CSS.escape(t.dataset.loan)}`); extra.amount = Number(inp.value) || Number(inp.placeholder); inp.value = ''; }
    act(a, extra);
    return;
  }
  if (t.dataset.space !== undefined && t.classList.contains('cell')) openDeed(Number(t.dataset.space));
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeModal();
  if (ev.key === 'Enter' && ev.target.id === 'chatIn') $('[data-chat]').click();
  if (ev.key === 'Enter' && ev.target.id === 'bidAmt') $('[data-act="bid"]').click();
});
$('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });

$('#nameInput').value = store.name();
$('#createBtn').onclick = () => { const name = $('#nameInput').value.trim(); if (!name) return toast('Enter your name', 'err'); store.setName(name); send({ type: 'create', name }); };
$('#joinBtn').onclick = () => { const name = $('#nameInput').value.trim(); const code = $('#codeInput').value.trim(); if (!name || !code) return toast('Enter your name and the room code', 'err'); store.setName(name); send({ type: 'join', name, code }); };
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#leaveBtn').onclick = () => { send({ type: 'leave' }); store.clear(); S.state = null; showScreen('join'); };
$('#startBtn').onclick = () => act('start');
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('#codeInput').value = urlCode.toUpperCase();

connect();
