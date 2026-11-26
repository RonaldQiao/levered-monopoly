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
  $('#roomTag').textContent = `room ${s.code} · round ${s.round}${s.settings.maxRounds ? ` of ${s.settings.maxRounds}` : ''}${s.settings.diceMode === 'seeded' ? ` · seed ${s.settings.seed}` : ''}`;
  renderBoard();
  renderTabs();
  renderTab();
  if (typeof renderTerminal === 'function') renderTerminal();
  const key = `${s.round}-${s.turn.idx}`;
  if (key !== S.lastTurnKey) {
    S.lastTurnKey = key;
    if (isMyTurn() && s.status === 'playing') { toast('🎲 Your turn!'); document.title = '🎲 Your turn — Margin Call'; } else document.title = 'Margin Call';
  }
}

// ------------------------------------------------------------------ AI speed (host control, any time)
const AI_SPEEDS = [[500, 'Very fast (0.5s)'], [1000, 'Fast (1s)'], [1500, 'Normal (1.5s)'], [2500, 'Relaxed (2.5s)'], [4000, 'Slow (4s)'], [6000, 'Very slow (6s)'], [10000, 'Crawl (10s)']];
function aiSpeedHTML(id = 'aiSpeed') {
  const s = st(); const me = meP();
  if (!s.players.some((p) => p.bot)) return '';
  const d = s.settings.botDelay || 1500; const paused = !!s.settings.botsPaused;
  const opts = AI_SPEEDS.some(([v]) => v === d) ? AI_SPEEDS : [...AI_SPEEDS, [d, `${(d / 1000).toFixed(1)}s`]].sort((x, y) => x[0] - y[0]);
  if (!me || !me.host) {
    return `<div class="ai-speed"><span class="muted">🤖 AI speed: <b>${paused ? 'paused' : `${(d / 1000).toFixed(1)}s per move`}</b> (set by the host)</div>`;
  }
  return `<div class="ai-speed">
    <label for="${id}">🤖 AI speed</label>
    <select id="${id}" class="ai-speed-select" title="Time between AI moves">${opts.map(([v, l]) => `<option value="${v}" ${v === d ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="small ${paused ? 'primary' : ''}" data-aipause="${paused ? '0' : '1'}" title="${paused ? 'Let the AI players move again' : 'AI players stop taking turns (they still answer auctions and offers)'}">${paused ? '▶ Resume AI' : '⏸ Pause AI'}</button>
  </div>`;
}

// ------------------------------------------------------------------ lobby
function renderLobby() {
  const s = st(); const me = meP();
  $('#lobbyCode').textContent = s.code;
  $('#lobbyUrl').textContent = location.host;
  const host = me && me.host; const set = s.settings;
  $('#lobbyPlayers').innerHTML = s.players.map((p) => `<li style="border-color:${p.color}"><span style="font-size:20px">${p.token}</span><span>${esc(p.name)}</span>${p.bot ? '<span class="badge">AI</span>' : ''}${p.host ? '<span class="badge">host</span>' : ''}${p.connected ? '' : '<span class="badge warn">offline</span>'}${p.id === S.me ? '<span class="badge good">you</span>' : ''}${set.realMoney ? `<span class="badge stake" title="Real-money stake">💵 ${window.Payout.dollars(p.stake || 0)}</span>` : ''}${p.bot && host ? `<button class="small link" data-act="removeBot" data-target="${p.id}" title="Remove this AI player">remove</button>` : ''}</li>`).join('')
    + (host && s.players.length < 8 ? '<li class="add-bot"><button data-act="addBot">+ Add AI player</button></li>' : '');
  const dis = host ? '' : 'disabled';
  const sel = (id, v, opts) => `<select id="${id}" ${dis}>${opts.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const onOff = (id, v, on = 'On', off = 'Off') => sel(id, v ? '1' : '0', [['1', on], ['0', off]]);
  const isSkill = set.acquisition === 'draft' && set.auctionFormat === 'sealed' && set.diceMode === 'seeded' && !set.moneyCards && !set.jail && !set.doubles && set.creditModel === 'riskPriced';
  $('#lobbyPresets').innerHTML = `<span class="muted">Rules preset:</span>
    <button class="small ${isSkill ? '' : 'primary'}" data-preset="classic" ${dis}>Classic</button>
    <button class="small ${isSkill ? 'primary' : ''}" data-preset="skill" ${dis} title="Draft + sealed bids, duplicate dice, no money cards / jail / doubles, costly risk-priced credit, 40 rounds">Skill test</button>
    <span class="muted" style="font-size:12px">${isSkill ? 'Skill test: faster, less luck — trading decisions decide the game. Replay the same seed with seats rotated for a duplicate match.' : 'Classic: the traditional game plus the central bank.'}</span>${aiSpeedHTML('aiSpeedLobby')}`;
  $('#lobbySettings').innerHTML = (`
    <label>Starting cash<input id="setCash" type="number" min="500" max="5000" step="100" value="${set.startingCash}" ${dis}></label>
    <label>PAYDAY salary<input id="setSalary" type="number" min="50" max="1000" step="10" value="${set.salary}" ${dis}></label>
    <label>Max leverage (assets ÷ equity)
      <select id="setLev" ${dis}>${[1, 1.5, 2, 3, 4, 5, 8].map((x) => `<option value="${x}" ${x === set.maxLeverage ? 'selected' : ''}>${x === 1 ? '1× — no bank borrowing' : `${x}×`}</option>`).join('')}</select></label>
    <label>Getting property${sel('setAcq', set.acquisition, [['land', 'Buy what you land on'], ['draft', 'Opening draft (all lots auctioned)']])}</label>
    <label>Auctions on declined property${onOff('setAuc', set.auctions, 'On (traditional)')}</label>
    <label>Auction format${sel('setAucFmt', set.auctionFormat, [['english', 'Open outcry (English)'], ['sealed', 'Sealed bid, second price']])}</label>
    <label>Dice${sel('setDice', set.diceMode, [['random', 'Random'], ['seeded', 'Seeded per seat (duplicate)']])}</label>
    ${set.diceMode === 'seeded' ? `<label>Seed (blank = random)<input id="setSeed" type="number" min="0" step="1" value="${set.seed ?? ''}" ${dis}></label>` : ''}
    <label>Money cards${onOff('setCards', set.moneyCards, 'On', 'Off (macro shocks only)')}</label>
    <label>Lockup (jail)${onOff('setJail', set.jail)}</label>
    <label>Doubles roll again${onOff('setDoubles', set.doubles)}</label>
    <label>Credit pricing${sel('setCredit', set.creditModel, [['classic', 'Classic (0.5%/unit leverage)'], ['riskPriced', 'Risk-priced (1.5%/unit, re-priced each round)']])}</label>
    <label>Neutral real rate %/round<input id="setNeutral" type="number" min="0" max="12" step="0.5" value="${set.neutralRate}" ${dis}></label>
    <label>Game length<input id="setRounds" type="number" min="0" max="500" step="5" value="${set.maxRounds}" ${dis} title="0 = play until one player is left"></label>
    <label>Distressed property${sel('setLiq', set.liquidation, [['auction', 'Auction to players (sealed bid)'], ['bank', 'Sell to the bank only']])}</label>`);
  for (const inp of $$('#lobbySettings input, #lobbySettings select')) {
    inp.onchange = () => act('settings', { settings: {
      startingCash: $('#setCash').value, salary: $('#setSalary').value, maxLeverage: $('#setLev').value, auctions: $('#setAuc').value === '1',
      acquisition: $('#setAcq').value, auctionFormat: $('#setAucFmt').value, diceMode: $('#setDice').value,
      ...($('#setSeed') ? { seed: $('#setSeed').value } : {}),
      moneyCards: $('#setCards').value === '1', jail: $('#setJail').value === '1', doubles: $('#setDoubles').value === '1',
      creditModel: $('#setCredit').value, neutralRate: $('#setNeutral').value, maxRounds: $('#setRounds').value, liquidation: $('#setLiq').value,
    } });
  }
  setHTML($('#lobbyPayout'), lobbyPayoutHTML());
  $('#startBtn').disabled = !host || s.players.length < 2;
  $('#startBtn').textContent = host ? (s.players.length < 2 ? 'Need 2+ players' : 'Start game') : 'Waiting for host…';
}

// ------------------------------------------------------------------ real-money payouts (src/payout.js)
// Host controls use data-pay (no id) so they always show the server's value; your stake input has an id
// so setHTML keeps what you are typing across broadcasts.
function lobbyPayoutHTML() {
  const s = st(); const me = meP(); const set = s.settings; const P = window.Payout;
  const dis = me && me.host ? '' : 'disabled';
  const mode = P.MODES[set.payoutMode] || P.MODES.winner;
  let h = `<h3>Real-money payouts</h3><div class="settings-grid">
    <label>Real-money payouts<select data-pay="realMoney" ${dis}><option value="0" ${set.realMoney ? '' : 'selected'}>Off</option><option value="1" ${set.realMoney ? 'selected' : ''}>On (everyone declares a stake)</option></select></label>`;
  if (set.realMoney) {
    h += `<label>Payout mode<select data-pay="payoutMode" ${dis}>${P.MODE_KEYS.map((k) => `<option value="${k}" ${k === set.payoutMode ? 'selected' : ''}>${P.MODES[k].label}</option>`).join('')}</select></label>`;
    if (me && !me.bot) h += `<label>Your stake ($)<input id="myStake" type="number" min="0" max="${P.MAX_STAKE}" step="1" value="${me.stake || 0}" title="$0 = play for fun: you can neither win nor lose money"></label>`;
  }
  h += '</div>';
  if (!set.realMoney) return h;
  const stakes = Object.fromEntries(s.players.map((p) => [p.id, p.stake || 0]));
  const pot = s.players.reduce((a, p) => a + (p.stake || 0), 0);
  const ex = me ? P.exposure(stakes, me.id) : null;
  return `${h}<p class="muted payout-note">${esc(mode.short)}${mode.needsCap ? ` Settled after round ${set.maxRounds}; if everyone else goes bankrupt first, the survivor takes the pot.` : ''}
    Pot <b>${P.dollars(pot)}</b>.${ex ? ` You can win at most <b>${P.dollars(ex.maxWin)}</b> and lose at most <b>${P.dollars(ex.maxLoss)}</b>.` : ''}
    Unequal stakes are settled with side pots, so nobody wins more from an opponent than they staked. AI players stake $0. Stakes lock when the game starts.</p>`;
}

// The settlement as a table: one row per player, plus the pot.
// compact: for narrow spaces (the sidebar, phones) drop the net-worth and share columns
// (shown on hover instead, and on each player's card) so the table fits without scrolling.
function payoutTableHTML(r, compact = false) {
  const P = window.Payout;
  const rows = r.rows.map((row) => {
    const p = pl(row.id);
    const detail = `Net worth ${money(row.netWorth).replace(/<[^>]+>/g, '')} · share ${(row.share * 100).toFixed(1)}%`;
    return `<tr class="${row.bankrupt ? 'dead' : ''}" ${compact ? `title="${esc(detail)}"` : ''}><td class="pname">${p ? p.token : ''} ${esc(row.name || (p && p.name))}${row.bankrupt ? ' ☠' : ''}</td>
      <td class="n">${P.dollars(row.stake)}</td><td>${P.placeLabel(row)}</td>${compact ? '' : `<td class="n">${money(row.netWorth)}</td>
      <td class="n">${(row.share * 100).toFixed(1)}%</td>`}<td class="n">${P.dollars(row.payout)}</td>
      <td class="n ${row.net < 0 ? 'neg' : row.net > 0 ? 'pos' : ''}">${P.signed(row.net)}</td></tr>`;
  }).join('');
  const paid = P.dollars(r.rows.reduce((a, x) => a + x.payoutCents, 0) / 100);
  return `<div class="payout-wrap"><table class="t payout-table${compact ? ' compact' : ''}">
    <tr><th>Player</th><th class="n">Stake</th><th>Place</th>${compact ? '' : '<th class="n">Net worth</th><th class="n">Share</th>'}<th class="n">Payout</th><th class="n">Net ±$</th></tr>
    ${rows}<tr class="total"><td><b>Pot</b></td><td class="n"><b>${P.dollars(r.pot)}</b></td><td></td>${compact ? '' : '<td></td><td></td>'}<td class="n"><b>${paid}</b></td><td></td></tr></table></div>`;
}

// During play: what the payout would be if the host ended the game now (same function as the server).
function livePayout() {
  const s = st();
  return window.Payout.settle({
    mode: s.settings.payoutMode, reason: 'host',
    players: s.players.map((p) => ({ id: p.id, name: p.name, stake: p.stake, netWorth: p.bankrupt ? 0 : p.netWorth, bankrupt: p.bankrupt, out: p.out })),
  });
}

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset && t.dataset.pay === 'realMoney') act('settings', { settings: { realMoney: t.value === '1' } });
  else if (t.dataset && t.dataset.pay === 'payoutMode') act('settings', { settings: { payoutMode: t.value } });
  else if (t.id === 'myStake') act('stake', { amount: t.value === '' ? 0 : Number(t.value) });
});

// ------------------------------------------------------------------ board (CSS 3D)
// The board is a CSS 3D scene: a tilted slab with thickness, standing pawns that hop
// space-to-space, extruded houses/hotels, and tumbling dice cubes. The board is built
// once and patched in place so animations survive state broadcasts.
const TRACKS = [1.45, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.45];
const TRACK_SUM = TRACKS.reduce((a, b) => a + b, 0);
const trackCenter = (k) => ((TRACKS.slice(0, k - 1).reduce((a, b) => a + b, 0) + TRACKS[k - 1] / 2) / TRACK_SUM) * 100;

function gridPos(i) {
  if (i <= 10) return [11, 11 - i, i === 0 || i === 10 ? 'corner' : 'side-bottom'];
  if (i <= 20) return [11 - (i - 10), 1, i === 20 ? 'corner' : 'side-left'];
  if (i <= 30) return [1, 1 + (i - 20), i === 30 ? 'corner' : 'side-top'];
  return [1 + (i - 30), 11, 'side-right'];
}
const cellCenter = (i) => { const [r, c] = gridPos(i); return [trackCenter(c), trackCenter(r)]; };

const BLOCK = '<i class="tp"></i><i class="fr"></i><i class="lf"></i><i class="rt"></i>';
const buildingsHTML = (n) => (n === 5 ? `<div class="blk hotel">${BLOCK}</div>` : `<div class="blk house">${BLOCK}</div>`.repeat(n));

function cellParts(sp) {
  const s = st(); const i = sp.index; const info = s.spaceInfo[i];
  const side = gridPos(i)[2];
  let cls = `cell ${side}`; let strip = ''; let body = '';
  if (sp.type === 'street') strip = `<div class="strip" style="--c:${S.board.groups[sp.group].color}">${buildingsHTML(info.houses)}</div>`;
  const owner = info && info.owner ? pl(info.owner) : null;
  if (info && info.mortgaged) cls += ' mortgaged';
  if (side === 'corner') {
    cls += ` corner-${sp.type}`;
    if (sp.type === 'jail') {
      body = '<div class="jail"><div class="bars"><span>LOCK<br>UP</span></div><div class="jv jv-a">JUST</div><div class="jv jv-b">VISITING</div></div>';
    } else if (sp.type === 'go') {
      body = `<div class="body"><div class="corner-sub">collect ${plain$(s.econ.salary)} salary as you pass</div><div class="corner-title">PAYDAY</div><div class="go-arrow">⟵</div></div>`;
    } else {
      body = `<div class="body"><div class="ico">${ICONS[sp.type]}</div><div class="corner-title">${esc(sp.name)}</div></div>`;
    }
  } else {
    const ico = sp.type === 'transit' ? transitIcon(sp.name) : sp.type === 'utility' ? utilIcon(sp.name) : ICONS[sp.type] || '';
    let sub = '';
    if (ownable(sp)) sub = owner ? (info.mortgaged ? '' : info.rentNow != null ? `rent ${plain$(info.rentNow)}` : 'rent 4×/10×') : plain$(info.price);
    else if (sp.type === 'tax') sub = `pay ${plain$(info.tax)}`;
    body = `<div class="body"><div class="nm">${esc(sp.name)}</div>${ico && sp.type !== 'street' ? `<div class="ico">${ico}</div>` : ''}<div class="pr">${sub}</div></div>`;
  }
  const own = owner ? `<div class="owner-badge" style="--pc:${owner.color}" title="Owned by ${esc(owner.name)}">${owner.token}</div>` : '';
  const stamp = info && info.mortgaged ? '<div class="stamp">MORTGAGED</div>' : '';
  return { cls, html: `${strip}${body}${own}${stamp}` };
}

// Dice: face n is placed with FACE_XF[n]; the cube shows n on top after rotateX/rotateY of SHOW[n].
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const FACE_XF = { 1: 'rotateY(0deg)', 6: 'rotateY(180deg)', 2: 'rotateY(90deg)', 5: 'rotateY(-90deg)', 3: 'rotateX(90deg)', 4: 'rotateX(-90deg)' };
const SHOW = { 1: [0, 0], 6: [0, 180], 2: [0, -90], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };
const faceHTML = (n) => `<div class="face" style="transform:${FACE_XF[n]} translateZ(var(--h))">${Array.from({ length: 9 }, (_, k) => `<i${PIPS[n].includes(k) ? '' : ' class="off"'}></i>`).join('')}</div>`;
const dieSlot = (k) => `<div class="dslot"><div class="dshadow"></div><div class="die3d" id="die${k}"><div class="cube">${[1, 2, 3, 4, 5, 6].map(faceHTML).join('')}</div></div></div>`;

function ensureBoard() {
  const board = $('#board');
  if (board.dataset.built) return board;
  let h = '';
  for (const sp of S.board.spaces) {
    const [r, c] = gridPos(sp.index);
    h += `<div class="cell" data-space="${sp.index}" style="grid-row:${r};grid-column:${c}"></div>`;
  }
  h += `<div class="center">
      <div class="spot event"></div><div class="spot treasury"></div>
      <div class="deck event"><i></i><i></i><i></i><i><b>?</b>MARKET EVENT</i></div>
      <div class="deck treasury"><i></i><i></i><i></i><i><b>§</b>TOWN TREASURY</i></div>
      <div class="seal">
        <div class="seal-top">Central Bank &amp; Exchange</div>
        <div class="felt-logo">MARGIN CALL</div>
        <div class="seal-rule"></div>
        <div class="felt-sub">Property · Leverage · Swaps</div>
      </div>
      <div class="dice-row">${dieSlot(0)}${dieSlot(1)}</div>
    </div>
    <div class="edge front"></div><div class="edge left"></div><div class="edge right"></div>
    <div class="pawns" id="pawns"></div>`;
  board.innerHTML = h;
  board.dataset.built = '1';
  S.cellCache = {}; S.disp = {}; S.target = {}; S.anim = {};
  setDice([3, 4], false);
  return board;
}

function setDice(vals, animate) {
  vals.forEach((v, k) => {
    const die = $(`#die${k}`); if (!die) return;
    const cube = die.firstElementChild;
    const [ax, ay] = SHOW[v];
    const rz = (k ? 9 : -7) + Math.round(Math.random() * 24 - 12);
    const spin = (n) => (Math.random() < 0.5 ? -1 : 1) * 360 * n;
    cube.style.setProperty('--rx1', `${ax}deg`); cube.style.setProperty('--ry1', `${ay}deg`); cube.style.setProperty('--rz1', `${rz}deg`);
    cube.style.setProperty('--rx0', `${ax + spin(2)}deg`); cube.style.setProperty('--ry0', `${ay + spin(1)}deg`); cube.style.setProperty('--rz0', `${rz + spin(1) / 2}deg`);
    if (animate) { die.classList.remove('tumble'); void die.offsetWidth; die.classList.add('tumble'); }
  });
}

function placePawns() {
  const groups = {};
  for (const el of $$('#pawns .pawn')) (groups[S.disp[el.dataset.pid]] ||= []).push(el);
  for (const [pos, els] of Object.entries(groups)) {
    const [x, y] = cellCenter(Number(pos));
    const cols = Math.min(els.length, 3); const rows = Math.ceil(els.length / 3);
    els.forEach((el, k) => {
      const dx = ((k % 3) - (cols - 1) / 2) * 2.3; const dy = (Math.floor(k / 3) - (rows - 1) / 2) * 2.6 + 1.2;
      el.style.left = `${x + dx}%`; el.style.top = `${y + dy}%`;
    });
  }
}

function hop(el) { const lift = el.firstElementChild.nextElementSibling; lift.classList.remove('hop'); void lift.offsetWidth; lift.classList.add('hop'); }

function movePawn(p, el) {
  const target = p.pos;
  if (S.target[p.id] === target) return;
  S.target[p.id] = target;
  clearInterval(S.anim[p.id]);
  const d = (target - S.disp[p.id] + 40) % 40;
  if (d > 0 && d <= 12 && !p.inJail) {
    el.style.transitionDuration = '.16s';
    S.anim[p.id] = setInterval(() => {
      S.disp[p.id] = (S.disp[p.id] + 1) % 40;
      hop(el); placePawns();
      if (S.disp[p.id] === target) {
        clearInterval(S.anim[p.id]);
        const cell = $(`#board [data-space="${target}"]`);
        if (cell) { cell.classList.remove('flash'); void cell.offsetWidth; cell.classList.add('flash'); }
      }
    }, 190);
  } else {
    el.style.transitionDuration = '.8s';
    S.disp[p.id] = target; hop(el); placePawns();
  }
}

function updatePawns() {
  const layer = $('#pawns'); const live = st().players.filter((p) => !p.bankrupt);
  for (const el of $$('.pawn', layer)) if (!live.some((p) => p.id === el.dataset.pid)) el.remove();
  for (const p of live) {
    let el = layer.querySelector(`[data-pid="${p.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = `pawn${p.id === S.me ? ' me' : ''}`; el.dataset.pid = p.id;
      el.style.setProperty('--pc', p.color);
      el.innerHTML = `<div class="pshadow"></div><div class="lift"><div class="stand" title="${esc(p.name)}"><div class="disc">${p.token}</div><div class="post"></div><div class="base"></div></div></div>`;
      layer.appendChild(el);
      S.disp[p.id] = p.pos; S.target[p.id] = p.pos;
      placePawns();
    }
    el.classList.toggle('jailed', p.inJail);
    movePawn(p, el);
  }
}

function hudTopHTML() {
  const s = st(); const e = s.econ; const cur = s.players[s.turn.idx];
  const heatLbl = e.heat < 30 ? 'cold' : e.heat > 70 ? 'hot' : 'steady';
  const banner = s.status === 'finished' ? '🏆 Game over'
    : `<span class="tok" style="border-color:${cur.color}">${cur.token}</span>${cur.id === S.me ? 'Your turn' : `${esc(cur.name)}'s turn`} <span class="muted ph">· ${phaseLabel(s.turn.phase, cur)}</span>`;
  return `<div class="turn-banner">${banner}</div>
    <div class="ticker">
      <div class="tick"><small>Round</small><b>${s.round}</b></div>
      <div class="tick"><small>Policy rate</small><b>${pct(e.policyRate)}</b></div>
      <div class="tick"><small>Inflation</small><b>${pct(e.inflation)}</b></div>
      <div class="tick"><small>Heat</small><b>${Math.round(e.heat)} · ${heatLbl}</b></div>
      <div class="tick"><small>Price level</small><b>${e.priceLevel.toFixed(3)}</b></div>
      <div class="tick"><small>Fiscal</small><b>${e.fiscal}</b></div>
    </div>`;
}

function hudBottomHTML() {
  const s = st(); const me = meP();
  if (s.status === 'finished') return '<div class="muted">The game has ended — see the final standings above.</div>';
  let h = '';
  if (me && !me.bankrupt) {
    if (me.cash < 0) h += `<div class="alert">You have negative cash (${plain$(me.cash)}). Sell buildings, mortgage, borrow or trade to get back above $0 — or declare bankruptcy.</div>`;
    if (me.marginCall) h += `<div class="alert warn">⚠ MARGIN CALL: bank debt ${plain$(me.bankDebt)} exceeds your limit of ${plain$(me.maxLoan)}. Repay before you end your turn or the bank liquidates assets.</div>`;
  }
  h += `<div class="actions">${actionButtons()}</div>`;
  h += `<div class="mini-log">${s.log.slice(-3).reverse().map((l) => `<div>${esc(l.msg)}</div>`).join('')}</div>`;
  return h;
}

function overlayHTML() {
  const s = st();
  if (s.status === 'finished') {
    const w = s.winner && pl(s.winner);
    return `<div class="final"><h2>🏆 ${w ? `${w.token} ${esc(w.name)} wins!` : 'Game over'}</h2>
      ${s.payout ? `<h3 class="payout-head">💵 Real-money payout · ${esc(s.payout.label)}</h3>${payoutTableHTML(s.payout, window.innerWidth < 700)}`
    : `<table class="t"><tr><th>Player</th><th class="n">Net worth</th></tr>${s.players.slice().sort((a, b) => b.netWorth - a.netWorth).map((p) => `<tr><td>${p.token} ${esc(p.name)}${p.bankrupt ? ' ☠' : ''}</td><td class="n">${money(p.netWorth)}</td></tr>`).join('')}</table>`}</div>`;
  }
  let h = '';
  if (s.lastCard && s.lastCard.seq !== S.lastCardSeq) { S.lastCardSeq = s.lastCard.seq; S.cardKey = `${s.round}-${s.turn.idx}`; }
  if (s.lastCard && S.cardKey === `${s.round}-${s.turn.idx}`) {
    h += `<div class="card-pop ${s.lastCard.deck}" data-seq="${s.lastCard.seq}"><h4>${s.lastCard.deck === 'event' ? '📰 Market Event' : '🏛️ Town Treasury'} · ${pname(s.lastCard.player)}</h4>${esc(s.lastCard.text)}</div>`;
  }
  if (s.auction) h += auctionHTML();
  return h;
}

function phaseLabel(ph, p) {
  if (ph === 'roll') return p.inJail ? 'in Lockup — roll for doubles, pay bail or use a card' : 'ready to roll';
  if (ph === 'buy') return `deciding whether to buy ${esc(space(st().turn.pendingBuy).name)}`;
  if (ph === 'auction') return 'auction in progress';
  if (ph === 'draft') return 'opening draft in progress';
  if (ph === 'done') return 'managing / about to end turn';
  return ph;
}

function sealedAuctionHTML(a, me, left) {
  const s = st(); const inIt = a.active.includes(S.me);
  const total = s.spaceInfo.filter(Boolean).filter((x) => x.price !== undefined).length;
  const lots = a.lots || [a.space];
  const names = lots.map((i) => { const h = s.spaceInfo[i].houses; return `${esc(space(i).name)}${h === 5 ? ' (hotel)' : h ? ` (${h} house${h > 1 ? 's' : ''})` : ''}${s.spaceInfo[i].mortgaged ? ' (mortgaged)' : ''}`; }).join(' + ');
  const list = lots.reduce((x, i) => x + s.spaceInfo[i].price, 0);
  const title = a.kind === 'draft' ? `📋 Draft lot ${total - s.draftLeft}/${total}: ${names}`
    : a.kind === 'liquidation' ? `🔨 Distressed sale by ${pname(a.seller)}: ${names}`
      : a.kind === 'estate' ? `🏛 Estate sale (${esc(a.from)}): ${names}` : `🔨 Sealed-bid auction: ${names}`;
  const sub = a.kind === 'liquidation' ? `Reserve ${plain$(a.reserve)} (what the bank would pay). Proceeds go to the seller.`
    : a.kind === 'estate' ? `From a bankrupt player; proceeds go to the bank.${s.salesQueued ? ` ${s.salesQueued} more lot(s) to follow.` : ''}` : '';
  return `<div class="auction-box">
    <div><b>${title}</b> <span class="muted">(list ${plain$(list)})</span> <button class="link" data-deed="${a.space}">deed</button></div>
    <div class="muted" style="margin:4px 0">Highest bid wins and pays the <b>second-highest</b> bid, so bid what it is worth to you. Bids stay secret until the lot closes. ${sub}</div>
    <div class="muted">closes in <b id="auctionTimer">${left}</b>s · bid: ${a.submitted.map((id) => pl(id).token).join(' ') || '—'} · waiting: ${a.active.map((id) => pl(id).token).join(' ') || '—'}</div>
    ${inIt && me && !me.bankrupt ? `<div class="row" style="margin-top:8px">
      <input id="bidAmt" type="number" min="${a.reserve || 1}" max="${me.cash}" placeholder="your max" style="width:110px">
      <button class="primary" data-act="bid">Submit sealed bid</button>
      <button class="danger" data-act="passAuction">Pass</button>
    </div>` : `<div class="muted" style="margin-top:6px">${a.seller === S.me ? 'This is your sale — you cannot bid on it.' : a.myBid !== undefined ? `Your sealed bid: <b>${plain$(a.myBid)}</b>` : 'You passed on this lot.'}</div>`}
  </div>`;
}

function auctionHTML() {
  const a = st().auction; const me = meP();
  const inIt = a.active.includes(S.me);
  const left = Math.max(0, Math.ceil((a.deadline - (Date.now() + S.clockSkew)) / 1000));
  if (a.sealed) return sealedAuctionHTML(a, me, left);
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
      } else b += `<button class="primary big" data-act="roll" ${s.auction ? 'disabled title="Wait for the auction to close"' : ''}>🎲 Roll dice${s.turn.doubles ? ' again' : ''}</button>`;
    } else if (ph === 'buy') {
      const i = s.turn.pendingBuy; const price = s.spaceInfo[i].price;
      b += `<button class="primary big" data-act="buy" ${me.cash < price ? 'disabled' : ''}>Buy ${esc(space(i).name)} for ${plain$(price)}</button>`;
      b += `<button data-act="decline">${s.settings.auctions ? 'Decline → auction' : 'Decline'}</button>`;
      b += `<button data-deed="${i}" class="link">view deed</button>`;
      if (me.cash < price) b += `<div class="muted" style="width:100%;text-align:center">Short ${plain$(price - me.cash)}? <button class="link" data-tab-go="bank">Borrow from the central bank</button> or mortgage something.</div>`;
    } else if (ph === 'done') {
      b += `<button class="primary big" data-act="endTurn">End turn ➜</button>`;
    } else if (ph === 'draft') {
      b += '<span class="muted">Opening draft — bid on each lot above. Rolling starts when the draft ends.</span>';
    }
  } else if (s.turn.phase === 'draft') {
    b += '<span class="muted">Opening draft — bid on each lot above. You can borrow before you bid.</span>';
  } else {
    b += `<span class="muted">Waiting for ${esc(s.players[s.turn.idx].name)}… you can still trade, borrow, build and write contracts.</span>`;
  }
  if (me.cash < 0) b += '<button class="danger" data-act="bankrupt" data-confirm="Declare bankruptcy? Your properties return to the bank and you are out of the game.">Declare bankruptcy</button>';
  return b;
}

function renderBoard() {
  const s = st();
  const board = ensureBoard();
  const cells = board.children;
  for (const sp of S.board.spaces) {
    const { cls, html } = cellParts(sp);
    const key = cls + html;
    if (S.cellCache[sp.index] !== key) {
      const el = cells[sp.index];
      const flashing = el.classList.contains('flash');
      el.className = cls + (flashing ? ' flash' : ''); el.innerHTML = html;
      S.cellCache[sp.index] = key;
    }
  }
  updatePawns();
  if (s.lastRoll && s.lastRoll.seq !== S.lastRollSeq) {
    const first = S.lastRollSeq === null;
    S.lastRollSeq = s.lastRoll.seq;
    setDice(s.lastRoll.dice, !first);
  }
  setHTML($('#hudTop'), hudTopHTML());
  setHTML($('#hudBottom'), hudBottomHTML());
  const ov = overlayHTML();
  if (ov !== S.overlayCache) { S.overlayCache = ov; setHTML($('#overlay'), ov); }
}

setInterval(() => {
  const el = $('#auctionTimer'); const a = st()?.auction;
  if (el && a) el.textContent = Math.max(0, Math.ceil((a.deadline - (Date.now() + S.clockSkew)) / 1000));
}, 500);

// ------------------------------------------------------------------ tabs
const TABS = [
  ['players', 'Players'], ['assets', 'My Assets'], ['bank', 'Central Bank'], ['desk', 'Bank Desk'], ['economy', 'Economy'],
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
  const fn = { players: tabPlayers, assets: tabAssets, bank: tabBank, desk: tabDesk, economy: tabEconomy, trades: tabTrades, contracts: tabContracts, log: tabLog }[S.tab];
  setHTML($('#tabBody'), fn());
  if (S.tab === 'economy') bindCharts();
}

function tabPlayers() {
  const s = st(); const me = meP();
  let h = '';
  if (s.status === 'playing') h += `<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">${aiSpeedHTML()}${me && me.host ? '<button class="small" data-act="endNow" data-confirm="End the game now? Highest net worth wins.">End game now (net worth wins)</button>' : ''}</div>`;
  for (const p of s.players) {
    const turn = s.status === 'playing' && s.players[s.turn.idx].id === p.id;
    const props = ownedBy(p.id);
    h += `<div class="pcard ${turn ? 'turn' : ''} ${p.bankrupt ? 'dead' : ''}" style="border-left-color:${p.color}">
      <div class="top"><span style="font-size:22px">${p.token}</span><span class="nm">${esc(p.name)}</span>
        ${p.id === S.me ? '<span class="badge good">you</span>' : ''}${p.bot ? '<span class="badge">AI</span>' : ''}${p.host ? '<span class="badge">host</span>' : ''}
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
        <div><span>Share price · stake</span>${s.desk.marks[p.id] ? `${s.desk.marks[p.id].price.toFixed(2)} · ${Math.round((100 * s.desk.equity[p.id].insider) / s.desk.equity[p.id].outstanding)}%` : '—'}</div>
        <div><span>Desk positions</span>${money(p.deskValue || 0)}</div>
        <div><span>Default risk</span>${p.bankrupt ? '—' : pct((s.desk.hazards[p.id] || 0) * 100, 1)}</div>
      </div>
      <div class="chips">${props.map((i) => `<span class="chip ${s.spaceInfo[i].mortgaged ? 'm' : ''}" data-deed="${i}" title="${esc(space(i).name)}" style="background:${propColor(i)}"></span>`).join('')}${p.jailCards ? `<span class="badge">🎫×${p.jailCards}</span>` : ''}</div>
      ${me && me.host && p.id !== S.me && !p.bankrupt && s.status === 'playing' ? `<div class="row" style="justify-content:flex-end;margin-top:6px"><button class="small danger" data-act="kick" data-target="${p.id}" data-confirm="Remove ${esc(p.name)} from the game? Their assets return to the bank.">Remove player</button></div>` : ''}
    </div>`;
  }
  h += `<div class="muted" style="font-size:12px">Bank supply: ${s.bankHouses} houses · ${s.bankHotels} hotels. Net worth = book equity ± equity stakes held/issued.</div>`;
  if (s.settings.realMoney) {
    const r = s.payout || livePayout();
    h += `<h3 class="payout-head">💵 Real-money payout · ${esc(r.label)}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:4px">${s.payout ? 'Final settlement.' : 'If the game ended now (the host ending it).'}</div>${payoutTableHTML(r, true)}`;
  }
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
  const canLiq = s.settings.liquidation === 'auction' && (me.cash < 0 || me.marginCall) && !s.auction;
  if (canLiq) h += '<p class="muted" style="font-size:12.5px">You are underwater. Besides selling to the bank, you can <b>auction</b> property to the other players: a sealed-bid sale with the bank\'s price as the reserve. A lot in a built colour group sells as the whole group with its buildings.</p>';
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
      if (canLiq && !info.encumbered) {
        const built = sp.type === 'street' && S.board.spaces.some((x) => x.group === sp.group && s.spaceInfo[x.index].houses > 0);
        acts.push(`<button class="small" data-act="liquidate" data-space="${i}" data-confirm="${built ? 'Auction the whole colour group with its buildings?' : `Auction ${esc(sp.name)}?`} The bank's price is the reserve.">auction${built ? ' set' : ''}</button>`);
      }
      const bld = info.houses === 5 ? '<span class="mini-hotel" title="hotel"></span>' : '<span class="mini-house"></span>'.repeat(info.houses);
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
    h += `<div class="box"><h4>Borrow from the central bank</h4>
      <div class="row"><input id="bankAmt" type="number" min="10" step="10" placeholder="amount" style="width:110px">
      <select id="bankKind"><option value="floating">Floating</option><option value="fixed">Fixed</option></select>
      <select id="bankTerm">${[5, 10, 20].map((t) => `<option value="${t}">${t} rounds</option>`).join('')}</select>
      <button class="small" data-bankmax>max</button><button class="primary" data-act="borrow">Borrow</button></div>
      <p class="muted" style="font-size:12px;margin-bottom:0"><b>Floating</b> loans pay the policy rate + 0.25% + your credit spread, reset every round. <b>Fixed</b> loans lock today's rate for the whole term but cost more up front. Principal is due at maturity; if you can't repay, the loan rolls over for 5 rounds at +2%. Credit spread = 0.5% per unit of leverage.</p></div>`;
  }
  h += `<div class="box"><h4>Your rate quotes</h4><table class="t"><tr><th>Term</th><th class="n">Bank curve</th><th class="n">Floating now</th><th class="n">Fixed</th><th class="n">Lock-in cost</th></tr>
    ${[5, 10, 20].map((t) => `<tr><td>${t} rounds</td><td class="n">${pct(e.curve[t])}</td><td class="n">${pct(me.floatQuotes[t])}</td><td class="n">${pct(me.quotes[t])}</td><td class="n">+${pct(me.quotes[t] - me.floatQuotes[t])}</td></tr>`).join('')}</table>
    <p class="muted" style="font-size:12px;margin-bottom:0">Policy rate today: ${pct(e.policyRate)}. A fixed loan pays off if the policy rate rises more than the lock-in cost over the loan's life; floating wins if rates hold or fall.</p></div>`;
  h += '<div class="box"><h4>Your loans</h4>';
  if (!me.loans.length) h += '<p class="muted">No outstanding loans.</p>';
  else {
    h += `<table class="t"><tr><th class="n">Principal</th><th>Type</th><th class="n">Rate</th><th class="n">Interest/rd</th><th>Matures</th><th class="n">Repay $100 costs</th><th></th></tr>${me.loans.map((l) => `
      <tr><td class="n">${plain$(l.principal)}</td><td>${l.kind === 'floating' ? 'floating' : 'fixed'}</td><td class="n">${pct(l.rate)}</td><td class="n">${plain$(Math.max(1, Math.round(l.principal * l.rate / 100)))}</td><td>round ${l.maturity}</td><td class="n ${l.prepay100 < 100 ? 'pos' : l.prepay100 > 101 ? 'neg' : ''}">${plain$(l.prepay100)}</td>
      <td><div class="row" style="flex-wrap:nowrap"><input id="rp-${l.id}" type="number" style="width:80px" placeholder="${l.principal}"><button class="small" data-act="repay" data-loan="${l.id}">repay</button></div></td></tr>`).join('')}</table>`;
  }
  h += `<p class="muted" style="font-size:12px;margin-bottom:0">Floating loans repay at par. Fixed loans repay at <b>market value + 0.5%</b>: below par if rates have risen since you borrowed (a real gain), above par (a make-whole premium) if they have fallen. Market gain on your fixed loans right now: <b>${money(me.loanMtmGain || 0)}</b>, counted in net worth but not in your borrowing limit.</p></div>`;
  return h;
}

// ------------------------------------------------------------------ bank desk
const DESK_PRODUCTS = {
  shares: 'Buy shares (from the float)', short: 'Short shares', issue: 'Issue my own shares', call: 'Call option', put: 'Put option',
  cds: 'Credit default swap', insurance: 'Rent insurance', swap: 'Interest-rate swap',
};
S.dk = { product: 'shares', ref: null, shares: 10, strike: '', term: 10, notional: 500, deductible: 250, side: 'payFixed' };

// The desk deals at the worse of the round mark and the live price (same rule as the server).
const dealPx = (pid, side) => { const d = st().desk; const m = d.marks[pid]; return m ? Math.round(window.Pricing.dealPrice(m.price, d.live[pid] ?? m.price, side) * 100) / 100 : 0; };
function deskQuote() {
  const s = st(); const d = S.dk; const P = window.Pricing; const desk = s.desk;
  const mark = d.ref && desk.marks[d.ref];
  const n = Math.max(0, Math.floor(Number(d.shares) || 0));
  switch (d.product) {
    case 'shares': {
      if (!mark) return '';
      const e = desk.equity[d.ref];
      if (n > e.inv) return `Only ${e.inv} of ${pl(d.ref).name}'s shares are available from the bank. More exist only if ${esc(pl(d.ref).name)} issues them.`;
      const px = dealPx(d.ref, 'ask');
      const cost = P.shareAskCost(px, n, e.inv, e.outside);
      return `Cost ${plain$(cost)} for ${n} shares (dealt at ${px.toFixed(2)}, the higher of mark and live; avg $${(cost / Math.max(1, n)).toFixed(2)} incl. spread and scarcity) · ${e.inv - n} left in the float afterwards`;
    }
    case 'short': {
      if (!mark) return '';
      const e = desk.equity[d.ref]; const left = e.float - e.shortInterest;
      if (n > left) return `Only ${left} ${esc(pl(d.ref).name)} shares are left to borrow.`;
      const proceeds = P.shareBidProceeds(dealPx(d.ref, 'bid'), n, e.inv, e.outside, mark.hazard || 0);
      const cover = P.shareAskCost(dealPx(d.ref, 'ask'), n, e.inv, e.outside);
      const fee = Math.max(1, Math.round(n * mark.price * (P.DESK.shortFeeBase + P.DESK.shortFeeHazard * (mark.hazard || 0))));
      return `You receive ${plain$(proceeds)} now · covering today would cost ${plain$(cover)} · borrow fee about ${plain$(fee)} a round · ${left - n} left to borrow`;
    }
    case 'issue': {
      const m = desk.marks[S.me]; const e = desk.equity[S.me];
      const proceeds = P.issueProceeds(m.price, n, e.outstanding, desk.hazards[S.me]);
      return `The bank pays ${plain$(proceeds)} for ${n} new shares (mark $${m.price.toFixed(2)}, $${(proceeds / Math.max(1, n)).toFixed(2)} each) · you'd own ${e.insider} of ${e.outstanding + n} shares (${((100 * e.insider) / (e.outstanding + n)).toFixed(1)}%)`;
    }
    case 'call': case 'put': {
      if (!mark) return '';
      const S0 = dealPx(d.ref, d.product === 'call' ? 'ask' : 'bid');
      const K = Number(d.strike || mark.price.toFixed(2));
      const T = Number(d.term);
      const ask = P.optionAsk(d.product, S0, K, T, s.econ.policyRate, mark.vol, n);
      const fair = P.fairOption(d.product, S0, K, T, s.econ.policyRate, mark.vol, n);
      const bid = P.optionBid(d.product, dealPx(d.ref, d.product === 'call' ? 'bid' : 'ask'), K, T, s.econ.policyRate, mark.vol, n);
      const be = d.product === 'call' ? K + ask / Math.max(1, n) : K - ask / Math.max(1, n);
      return `Premium ${plain$(ask)} (fair ${plain$(fair)}, bank buys back today at ${plain$(bid)}) · vol ${(mark.vol * 100).toFixed(0)}%/round · breakeven $${be.toFixed(2)}/share`;
    }
    case 'cds': {
      if (!d.ref) return '';
      const e = desk.equity[d.ref]; const h = desk.hazards[d.ref];
      return `Premium ${plain$(P.cdsPremium(Number(d.notional) || 0, h))} per round, fixed (first one now) · pays ${plain$(Number(d.notional) || 0)} if ${esc(pl(d.ref).name)} goes bankrupt · default risk ${(h * 100).toFixed(1)}%/round · bank capacity left ${plain$(Math.max(0, e.cdsCap - e.cdsExposure))}`;
    }
    case 'insurance': { const q = desk.insurance[S.me] && desk.insurance[S.me][d.deductible]; return `This round's premium ${plain$(q || 0)} (re-priced every round from where you stand) · covers 80% of any rent above ${plain$(d.deductible)}, up to $1,500 a claim`; }
    case 'swap': {
      const fx = desk.swapRates[d.term][d.side]; const net = Math.round((Number(d.notional) || 0) * (s.econ.policyRate - fx) * (d.side === 'payFixed' ? 1 : -1) / 100);
      return `${d.side === 'payFixed' ? 'You pay' : 'You receive'} fixed ${pct(fx)} and ${d.side === 'payFixed' ? 'receive' : 'pay'} the policy rate (${pct(s.econ.policyRate)}) on ${plain$(Number(d.notional) || 0)} · net today ${net >= 0 ? '+' : ''}${plain$(net)}/round`;
    }
    default: return '';
  }
}

function positionQuote(x) {
  const s = st(); const P = window.Pricing; const desk = s.desk; const m = x.ref && desk.marks[x.ref];
  if (x.type === 'shares') { const e = desk.equity[x.ref]; return P.shareBidProceeds(dealPx(x.ref, 'bid'), x.shares, e.inv, e.outside, m.hazard || 0); }
  if (x.type === 'call' || x.type === 'put') return P.optionBid(x.type, dealPx(x.ref, x.type === 'call' ? 'bid' : 'ask'), x.strike, Math.max(0, x.expiry - s.round), s.econ.policyRate, m.vol, x.shares);
  return 0;
}

function tabDesk() {
  const s = st(); const me = meP(); const desk = s.desk;
  if (!me) return '';
  const rivals = s.players.filter((p) => !p.bankrupt && p.id !== S.me);
  if (!S.dk.ref || !rivals.some((p) => p.id === S.dk.ref)) S.dk.ref = rivals[0]?.id || null;
  const d = S.dk;
  const myEq = desk.equity[S.me];
  let h = `<div class="row" style="margin-bottom:8px"><button class="primary" data-open-terminal>📈 Open market terminal</button></div><p class="muted" style="font-size:12.5px;margin-top:0">The central bank makes the market. It values each player at book equity plus about 8 rounds of expected rent, less a discount for default risk, re-marks once a round, and quotes around that with a spread. It deals at the <b>worse of the round's mark and the live price</b> for you, so stale quotes and intra-round pumps don't pay. Every player has <b>100 shares of their own plus ${myEq.float} in a float</b> the bank holds; once the float is bought up, more shares exist only if that player issues them.</p>`;
  h += `<div class="box"><h4>Equity board</h4><table class="t"><tr><th>Player</th><th class="n">Mark</th><th class="n">Live</th><th class="n">Δ round</th><th class="n">Float left</th><th class="n">Vol</th><th class="n">Default risk</th></tr>
    ${s.players.map((p) => { const m = desk.marks[p.id]; const e = desk.equity[p.id]; if (!m) return ''; const prev = m.history.length > 1 ? m.history[m.history.length - 2] : m.price; const ch = prev ? (m.price / prev - 1) * 100 : 0;
      return `<tr class="${p.bankrupt ? 'dead' : ''}"><td>${p.token} ${esc(p.name)}</td><td class="n">${m.price.toFixed(2)}</td><td class="n">${(desk.live[p.id] ?? m.price).toFixed(2)}</td><td class="n ${ch > 0 ? 'pos' : ch < 0 ? 'neg' : ''}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</td><td class="n">${e.inv}/${e.outside}</td><td class="n">${(m.vol * 100).toFixed(0)}%</td><td class="n">${p.bankrupt ? 'defaulted' : pct((desk.hazards[p.id] || 0) * 100, 1)}</td></tr>`; }).join('')}</table>
    <p class="muted" style="font-size:12px;margin:6px 0 0">You own ${myEq.insider} of your ${myEq.outstanding} shares (${((100 * myEq.insider) / myEq.outstanding).toFixed(1)}%); net worth counts only your share of your own equity.</p></div>`;
  const needsRef = ['shares', 'short', 'call', 'put', 'cds'].includes(d.product);
  const f = [];
  f.push(`<label>Product<select id="dkProduct">${Object.entries(DESK_PRODUCTS).map(([k, l]) => `<option value="${k}" ${d.product === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`);
  if (needsRef) f.push(`<label>On player<select id="dkRef">${rivals.map((p) => `<option value="${p.id}" ${d.ref === p.id ? 'selected' : ''}>${p.token} ${esc(p.name)}</option>`).join('')}</select></label>`);
  if (['shares', 'short', 'call', 'put', 'issue'].includes(d.product)) f.push(`<label>Shares (max ${d.product === 'issue' ? 25 : 50})<input id="dkShares" type="number" min="1" max="50" value="${d.shares}"></label>`);
  if (['call', 'put'].includes(d.product)) f.push(`<label>Strike $/share<input id="dkStrike" type="number" min="0" step="0.5" placeholder="${desk.marks[d.ref] ? desk.marks[d.ref].price.toFixed(2) : ''}" value="${d.strike}"></label>`);
  if (['cds', 'swap'].includes(d.product)) f.push(`<label>Notional $<input id="dkNotional" type="number" min="50" step="50" value="${d.notional}"></label>`);
  if (d.product === 'swap') f.push(`<label>Side<select id="dkSide"><option value="payFixed" ${d.side === 'payFixed' ? 'selected' : ''}>Pay fixed, receive floating</option><option value="receiveFixed" ${d.side === 'receiveFixed' ? 'selected' : ''}>Receive fixed, pay floating</option></select></label>`);
  if (d.product === 'insurance') f.push(`<label>Deductible<select id="dkDeductible">${[100, 250, 500].map((x) => `<option value="${x}" ${Number(d.deductible) === x ? 'selected' : ''}>$${x}</option>`).join('')}</select></label>`);
  if (!['shares', 'short', 'issue'].includes(d.product)) f.push(`<label>Term<select id="dkTerm">${[5, 10, 20].map((t) => `<option value="${t}" ${Number(d.term) === t ? 'selected' : ''}>${t} rounds</option>`).join('')}</select></label>`);
  const help = {
    shares: 'Buy part of a rival from the bank\'s float. The ask rises as the float runs out; the bank buys back below the mark, and pays less for a player in distress. Worthless if they go bankrupt.',
    short: 'Bet against a rival: borrow their shares from the bank and sell them now; buy them back later to close. You pay a borrow fee every round (higher for riskier players), the short counts as a liability in your equity — so a rising price can bring a margin call — and if they go bankrupt it closes for free. At most 25 shares per player, and only as many as the float allows.',
    issue: 'Raise cash by selling new shares of yourself to the bank. It is not debt, so it doesn\'t use up borrowing room, but you own a smaller slice of yourself. The bank pays below the mark, less for bigger issues, and nothing at all once your default risk passes 12% a round. Up to 25 shares a round.',
    call: 'Pays (price − strike) × shares. Priced with Black-Scholes using the player\'s share history plus the rent shocks the board implies. Sell it back to the bank any time at fair value less 10%.',
    put: 'Pays (strike − price) × shares, and the full strike if the player goes bankrupt. Sell it back any time at fair value less 10%. Not sold on a player already below $0.',
    cds: 'The bank pays the notional if that player goes bankrupt. The premium is fixed when you buy. Not sold on a player already below $0. The bank stops selling protection once default risk passes 20% a round, and caps total protection on one player at about 1.5× their equity.',
    insurance: 'Covers a ruinous rent bill. Re-priced every round from the square you stand on and the rents ahead, so it\'s cheap in quiet stretches and expensive in front of hotels.',
    swap: 'Bet on (or hedge) the policy rate. The fixed rate is the bank\'s forecast of the average policy rate (no term premium, so neither side earns free carry) ± 0.1%. Settled every round; total swap notional is capped at your desk limit; close early at mark-to-market − 1%.',
  }[d.product];
  h += axesHTML() + playerMarketHTML();
  h += `<div class="box"><h4>New order</h4><div class="fields-grid">${f.join('')}</div>
    <p class="muted" style="font-size:12px">${help}</p>
    <div class="quote" id="dkQuote">${deskQuote()}</div>
    <div class="row end" style="margin-top:8px"><button class="primary" data-act="deskBuy" ${needsRef && !d.ref ? 'disabled' : ''}>Place order</button></div></div>`;
  const mine = desk.positions.filter((x) => x.holder === S.me);
  h += '<div class="box"><h4>Your desk positions</h4>';
  if (!mine.length) h += '<p class="muted">None.</p>';
  else {
    h += `<table class="t"><tr><th>Position</th><th class="n">Bank pays / flow</th><th></th></tr>${mine.map((x) => {
      const ref = x.ref ? `${pl(x.ref).token} ${esc(pl(x.ref).name)}` : '';
      let desc = ''; let val = ''; let btn = 'close'; let confirmTxt = '';
      if (x.type === 'shares') { desc = `${x.shares} shares of ${ref} (cost ${plain$(x.cost)})`; val = plain$(positionQuote(x)); btn = 'sell'; }
      if (x.type === 'call' || x.type === 'put') { const v = positionQuote(x); desc = `${x.type} · ${x.shares} × ${ref} @ $${x.strike} · exp. R${x.expiry}`; val = plain$(v); btn = 'sell back'; if (!v) confirmTxt = 'Close this option for $0? The bank values it at nothing right now.'; }
      if (x.type === 'cds') { desc = `CDS on ${ref} · ${plain$(x.notional)} · exp. R${x.expiry}`; val = `−${plain$(x.premium)}/rd`; btn = 'cancel'; confirmTxt = 'Cancel this protection? Premiums already paid are not refunded.'; }
      if (x.type === 'insurance') { desc = `Rent insurance · $${x.deductible} deductible · exp. R${x.expiry}`; val = `−${plain$(x.premium)}/rd`; btn = 'cancel'; confirmTxt = 'Cancel this policy? Premiums already paid are not refunded.'; }
      if (x.type === 'swap') { const net = Math.round(x.notional * (s.econ.policyRate - x.fixed) * (x.side === 'payFixed' ? 1 : -1) / 100); desc = `${x.side === 'payFixed' ? 'Pay' : 'Receive'} fixed ${pct(x.fixed)} on ${plain$(x.notional)} · exp. R${x.expiry}`; val = `${net >= 0 ? '+' : ''}${plain$(net)}/rd`; }
      if (x.type === 'short') { desc = `Short ${x.shares} × ${ref} (received ${plain$(x.proceeds)}) · fee ~${plain$(x.fee)}/rd`; val = `−${plain$(x.coverCost)}`; btn = 'cover'; confirmTxt = `Cover this short for ${plain$(x.coverCost)}?`; }
      if (x.type === 'cdsSold') { desc = `Sold protection on ${ref} · ${plain$(x.notional)} · exp. R${x.expiry}`; val = `+${plain$(x.premium)}/rd`; btn = ''; }
      const listBtn = ['shares', 'call', 'put', 'swap'].includes(x.type) && !st().market.listings.some((l) => l.position === x.id) ? `<button class="small" data-act="listPosition" data-id="${x.id}" data-shares="${x.shares || ''}" data-hint="${x.type === 'swap' ? 0 : positionQuote(x)}">list</button>` : '';
      return `<tr><td>${desc}</td><td class="n">${val}</td><td><div class="row" style="flex-wrap:nowrap;gap:4px">${btn ? `<button class="small" data-act="deskClose" data-id="${x.id}" ${confirmTxt ? `data-confirm="${confirmTxt}"` : ''}>${btn}</button>` : ''}${listBtn}</div></td></tr>`;
    }).join('')}</table>`;
  }
  h += `</div><p class="muted" style="font-size:12px">Bank desk P&L so far: ${money(desk.totalPnl)} (cash ${money(desk.pnl)}, share inventory worth ${money(desk.inventoryValue)}) · open positions across all players: ${desk.positions.length}. Desk positions count toward net worth at what the bank would pay for them now, but not toward your borrowing limit.</p>`;
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
  const zero = lo < 0 && hi > 0 ? `<line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>` : '';
  S.charts[key] = { pts: hist.map((x, i) => ({ x: X(i), y: Y(x[key]), label: `Round ${x.round}: ${fmt(x[key])}` })), W };
  return `<svg viewBox="0 0 ${W} ${H}" data-chart="${key}" preserveAspectRatio="none">
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--line)"/>${zero}
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <line class="xh" x1="0" x2="0" y1="${P}" y2="${H - P}" stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
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
  let h = '<div class="row" style="margin-bottom:10px"><button class="primary" data-open="trade">+ Two-player trade</button><button class="primary" data-open-deal>+ Multi-party deal</button></div><p class="muted" style="font-size:12px;margin-top:0">Two-player trades swap property, cash and get-out cards (traditional rules: no buildings in the traded group). Multi-party deals add any number of players and can move bank-desk positions too.</p>';
  h += dealsHTML();
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
  const col = sp.type === 'street' ? propColor(i) : '#f4eedc';
  const line = (a, b) => `<div class="dl"><span>${a}</span><span>${b}</span></div>`;
  let body = '';
  if (sp.type === 'street') {
    const r = info.rentTable;
    body = `<div class="rent-main">RENT ${plain$(r[0])}</div>
      ${line('With 1 House', plain$(r[1]))}${line('With 2 Houses', plain$(r[2]))}${line('With 3 Houses', plain$(r[3]))}${line('With 4 Houses', plain$(r[4]))}${line('With HOTEL', plain$(r[5]))}
      <div class="dfine">Mortgage Value ${plain$(info.mortgageValue)}<br>Houses cost ${plain$(info.houseCost)} each<br>Hotels, ${plain$(info.houseCost)} plus 4 houses</div>
      <div class="dfine small">If a player owns ALL the lots of any colour group, the rent is doubled on unimproved lots in that group.</div>`;
  } else if (sp.type === 'transit') {
    body = `<div class="deed-ico">${transitIcon(sp.name)}</div>${[1, 2, 3, 4].map((k) => line(k === 1 ? 'Rent' : `If ${k} hubs are owned`, plain$(Math.round(25 * 2 ** (k - 1) * s.econ.priceLevel)))).join('')}
      <div class="dfine">Mortgage Value ${plain$(info.mortgageValue)}</div>`;
  } else {
    body = `<div class="deed-ico">${utilIcon(sp.name)}</div><div class="dfine">If one utility is owned, rent is 4 times the amount shown on the dice.<br><br>If both utilities are owned, rent is 10 times the amount shown on the dice.</div>
      <div class="dfine">Mortgage Value ${plain$(info.mortgageValue)}</div>`;
  }
  openModal(`<div class="deed-wrap"><div class="deed2">
      <div class="dh ${sp.type === 'street' ? '' : 'plain'}" style="--c:${col}"><small>TITLE DEED</small><b>${esc(sp.name)}</b></div>
      <div class="db">${body}</div>
    </div>
    <div class="deed-meta kv">
      <span>Price today</span><span>${plain$(info.price)}</span>
      <span>Owner</span><span>${owner ? `${owner.token} ${esc(owner.name)}` : 'Bank (for sale)'}</span>
      ${sp.type === 'street' ? `<span>Colour group</span><span>${esc(groupOf(i).name)}</span>` : ''}
      ${info.mortgaged ? `<span>Status</span><span class="neg">Mortgaged (${plain$(info.mortgageAmt)})</span>` : ''}
      ${info.houses ? `<span>Buildings</span><span>${info.houses === 5 ? 'hotel' : `${info.houses} house(s)`}</span>` : ''}
      ${info.encumbered ? '<span>Contracts</span><span>pledged / under option</span>' : ''}
      <span>Price level</span><span>${s.econ.priceLevel.toFixed(3)} (scales all amounts)</span>
    </div></div>`);
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
<li><b>Distressed sales</b> (lobby option, on by default): when you are below $0 or in a margin call you can auction property to the other players by sealed bid, with the bank's price as the reserve. A lot in a built colour group sells as the whole group with its buildings. A bankrupt player's estate is auctioned the same way, with the proceeds going to the bank.</li>
<li>Trade property, cash and cards at any time. Can't pay? Raise cash or declare <b>bankruptcy</b>. Last player standing wins (or the host can end the game: highest net worth wins).</li>
</ul>
<h3>The central bank</h3>
<ul>
<li>Borrow any time for 5, 10 or 20 rounds, <b>floating</b> (policy rate + 0.25%, reset every round) or <b>fixed</b> (locked for the term, always quoted above floating). Interest is charged each round; principal is due at maturity (or rolls over at a penalty rate). Repay early any time: floating at par, fixed at <b>market value + 0.5%</b> (below par if rates have risen since you borrowed, above par if they have fallen).</li>
<li>The bank prices fixed loans and swaps off its <b>forecast</b> of the policy rate, not just today's rate.</li>
<li>Every quote adds a <b>credit spread</b> of 0.5% per unit of leverage.</li>
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
</ul>
<h3>The bank desk</h3>
<ul>
<li>The central bank is a <b>market maker</b>: it values each player at book equity plus about 8 rounds of expected rent, less a discount for default risk, re-marks once a round, and quotes around that value with a spread, dealing at the worse of the round's mark and the live price for you.</li>
<li><b>Shares</b>: each player owns 100 shares of themselves, plus 25 more in a float held by the bank. Others can buy from the float (the price rises as it runs out); after that, more shares exist only if the player <b>issues</b> them to raise cash. Net worth counts only your own share of your equity.</li>
<li><b>Calls and puts</b> on rivals' shares: priced with Black-Scholes using share history plus the rent shocks the board implies; sold at fair value + 10% and bought back any time at fair value − 10%.</li>
<li><b>Credit default swaps</b>, <b>rent insurance</b> (re-priced every round from where you stand) and <b>rate swaps</b>.</li>
<li>The bank <b>refuses</b> trades it can't price or that invite abuse: no protection or puts on a player below $0, no protection, options or new equity on players close to default, and caps on total protection and options per player.</li>
<li>You can't trade instruments on yourself. Desk positions count toward net worth but not toward your borrowing limit.</li>
</ul>
<h3>Skill-test settings (lobby)</h3>
<ul>
<li><b>Opening draft</b>: every property is auctioned before round 1, so who owns what depends on valuation, not on where the dice land.</li>
<li><b>Sealed bids, second price</b>: everyone bids once in secret; the highest bid wins and pays the second-highest bid. Bid what the lot is worth to you; reaction speed doesn't matter.</li>
<li><b>Seeded dice</b>: each seat has its own dice and card stream from the seed. Replay the same seed with players rotated through the seats and everyone has faced the same luck (a duplicate match).</li>
<li><b>Money cards / Lockup / doubles</b> can be switched off: they add noise but no decisions.</li>
<li><b>Risk-priced credit</b>: the credit spread is 1.5% per unit of leverage and re-prices on all your bank debt every round. With a higher <b>neutral rate</b>, borrowing costs about what property earns, so sizing your leverage matters.</li>
<li><b>Game length</b>: the game ends after that round and the highest net worth wins.</li>
<li>The <b>Skill test</b> preset sets all of these (draft, sealed bids, seeded dice, no money cards/jail/doubles, risk-priced credit, neutral rate 8%, 40 rounds). The choices come from simulating hundreds of thousands of AI games (sim/REPORT.md).</li>
</ul>
<h3>Real-money payouts (lobby option)</h3>
<ul>
<li>Every human declares a stake in the lobby ($0 = play for fun). AI players stake $0. Stakes lock when the game starts.</li>
<li>The host picks a mode: <b>Winner take all</b>; <b>Order of bankruptcy</b> (weights n−1, n−2, …, 0 by finishing place); <b>Share</b> (your share of total net worth at the round cap) or <b>Share³</b> (share³ ÷ Σshare³). Share modes need a round cap; if everyone else goes bankrupt first the survivor takes the pot.</li>
<li>Unequal stakes are settled with side pots, like poker: each slice of the pot is split only among players who staked at least that much. Nobody wins more from an opponent than they risked themselves.</li>
</ul>
<h3>AI players</h3>
<ul><li>The host can add AI players in the lobby. They play by exactly the same rules, trade, bid, build, borrow and use the bank desk.</li></ul></div>`;

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
  if (t.dataset.preset) { act('settings', { settings: { preset: t.dataset.preset } }); return; }
  if (t.dataset.aipause) { act('botSpeed', { paused: t.dataset.aipause === '1' }); return; }
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
    if (a === 'borrow') { extra.amount = Number($('#bankAmt').value); extra.term = Number($('#bankTerm').value); extra.kind = $('#bankKind').value; if (!extra.amount) return toast('Enter an amount', 'err'); $('#bankAmt').value = ''; }
    if (a === 'takeAxe') {
      extra.axe = { id: t.dataset.id };
      if (t.dataset.cds) { const inp = $(`#axn-${CSS.escape(t.dataset.id)}`); extra.axe.notional = Number(inp && inp.value) || undefined; extra.axe.term = 10; } else extra.axe.shares = Number(t.dataset.shares);
    }
    if (a === 'listPosition') {
      let shares;
      if (t.dataset.shares) { shares = Number(prompt(`How many shares to offer? (you hold ${t.dataset.shares})`, t.dataset.shares)); if (!shares) return; }
      const price = Number(prompt(`Total asking price? (the bank would pay about ${plain$(Number(t.dataset.hint) * (shares ? shares / Number(t.dataset.shares) : 1))})`, ''));
      if (!price) return;
      extra.listing = { position: t.dataset.id, shares, price };
      delete extra.id;
    }
    if (a === 'postBid') {
      extra.bid = { ref: t.dataset.ref, shares: Number($('#tmBidN').value), priceEach: Number($('#tmBidPx').value) };
      if (!extra.bid.shares || !extra.bid.priceEach) return toast('Enter a quantity and a price', 'err');
    }
    if (a === 'fillBid') { const b = st().market.bids.find((x) => x.id === t.dataset.id); extra.shares = b ? b.shares : undefined; }
    if (a === 'deskBuy') {
      const d = S.dk; const m = d.ref && st().desk.marks[d.ref];
      extra.order = { product: d.product, ref: d.ref, shares: Number(d.shares), strike: d.strike === '' && m ? m.price : Number(d.strike), term: Number(d.term), notional: Number(d.notional), deductible: Number(d.deductible), side: d.side };
    }
    if (a === 'repay') { extra.loanId = t.dataset.loan; const inp = $(`#rp-${CSS.escape(t.dataset.loan)}`); extra.amount = Number(inp.value) || Number(inp.placeholder); inp.value = ''; }
    act(a, extra);
    return;
  }
  if (t.dataset.space !== undefined && t.classList.contains('cell')) openDeed(Number(t.dataset.space));
});
// Bank-desk order form: keep its state in S.dk; re-render on structural changes, refresh the quote while typing.
const DK_FIELDS = { dkProduct: 'product', dkRef: 'ref', dkShares: 'shares', dkStrike: 'strike', dkTerm: 'term', dkNotional: 'notional', dkDeductible: 'deductible', dkSide: 'side' };
const onDeskField = (ev) => {
  const k = DK_FIELDS[ev.target.id];
  if (!k) return;
  S.dk[k] = ev.target.value;
  if (ev.type === 'change' && ev.target.tagName === 'SELECT') { if (k === 'product' || k === 'ref') S.dk.strike = ''; renderTab(); } else { const q = $('#dkQuote'); if (q) q.innerHTML = deskQuote(); }
};
document.addEventListener('input', onDeskField);
document.addEventListener('change', onDeskField);
document.addEventListener('change', (ev) => { if (ev.target.classList.contains('ai-speed-select')) act('botSpeed', { delay: Number(ev.target.value) }); });

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
