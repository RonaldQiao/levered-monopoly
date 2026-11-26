/* Margin Call — market UI: multi-party deal builder, bank axes, player market and the market terminal.
   Loaded after client.js and uses its helpers (S, st, pl, pname, esc, money, plain$, pct, space, ...). */
'use strict';

const tk = (id) => (st().market && st().market.tickers[id]) || '???';
const TRANSFERABLE_TYPES = ['shares', 'call', 'put', 'swap'];
function posLabel(x, shares) {
  if (!x) return 'a desk position';
  const n = shares ?? x.shares;
  if (x.type === 'shares') return `${n} × ${tk(x.ref)} shares`;
  if (x.type === 'short') return `short ${x.shares} × ${tk(x.ref)}`;
  if (x.type === 'call' || x.type === 'put') return `${tk(x.ref)} ${x.strike}${x.type === 'call' ? 'C' : 'P'} × ${x.shares} (exp. R${x.expiry})`;
  if (x.type === 'swap') return `${x.side === 'payFixed' ? 'pay' : 'receive'}-fixed swap ${pct(x.fixed)} on ${plain$(x.notional)}`;
  if (x.type === 'cdsSold') return `sold protection on ${tk(x.ref)} ${plain$(x.notional)}`;
  return x.type;
}

// ------------------------------------------------------------------ multi-party deals
function describeLeg(l) {
  const f = pname(l.from); const t = pname(l.to);
  if (l.kind === 'cash') return `${f} → ${t}: <b>${plain$(l.amount)}</b>`;
  if (l.kind === 'property') return `${f} → ${t}: <b>${esc(space(l.space).name)}</b>`;
  if (l.kind === 'card') return `${f} → ${t}: ${l.count} get-out card${l.count > 1 ? 's' : ''}`;
  const x = st().desk.positions.find((y) => y.id === l.position);
  return `${f} → ${t}: <b>${posLabel(x, l.shares)}</b>`;
}

function dealsHTML() {
  const m = st().market; if (!m) return '';
  const card = (d) => {
    const sigs = d.parties.map((id) => `<span class="sig ${d.accepted[id] ? 'ok' : ''}" title="${esc(pl(id).name)}">${pl(id).token}${d.accepted[id] ? '✓' : '…'}</span>`).join('');
    const mine = d.parties.includes(S.me);
    return `<div class="contract ${d.status === 'pending' ? 'proposed' : 'done'}">
      <div class="hdr"><b>🤝 ${d.parties.length}-party deal</b><span class="badge">${d.status}</span></div>
      ${d.note ? `<div class="muted" style="font-size:12px">${esc(d.note)}</div>` : ''}
      <ul>${d.legs.map((l) => `<li>${describeLeg(l)}</li>`).join('')}</ul>
      <div class="row">${sigs}</div>
      ${d.status === 'pending' && mine && !d.accepted[S.me] ? `<div class="row" style="margin-top:6px"><button class="primary small" data-act="acceptDeal" data-id="${d.id}">Sign</button><button class="small danger" data-act="rejectDeal" data-id="${d.id}">Reject</button></div>` : ''}
      ${d.status === 'pending' && d.proposer === S.me ? `<div class="row" style="margin-top:6px"><button class="small" data-act="cancelDeal" data-id="${d.id}">Withdraw</button></div>` : ''}</div>`;
  };
  const pend = m.deals.filter((d) => d.status === 'pending');
  const mine = pend.filter((d) => d.parties.includes(S.me));
  const other = pend.filter((d) => !d.parties.includes(S.me));
  const done = m.deals.filter((d) => d.status !== 'pending').slice(-5).reverse();
  let h = '<h3>Multi-party deals</h3>';
  h += mine.length ? mine.map(card).join('') : '<p class="muted">None pending.</p>';
  if (other.length) h += other.map(card).join('');
  if (done.length) h += `<details><summary class="muted" style="font-size:12px">Recent deals (${done.length})</summary>${done.map(card).join('')}</details>`;
  return h;
}

function openDealModal() {
  const s = st();
  const alive = s.players.filter((p) => !p.bankrupt);
  const others = alive.filter((p) => p.id !== S.me);
  if (!others.length) return toast('No one to deal with', 'err');
  const d = { parties: [S.me, others[0].id], legs: [{ from: S.me, to: others[0].id, kind: 'cash', amount: 100 }], note: '' };
  const tradeableProps = (pid) => ownedBy(pid).filter((i) => !(space(i).group && S.board.spaces.some((x) => x.group === space(i).group && st().spaceInfo[x.index].houses > 0)) && !st().spaceInfo[i].encumbered);
  const positionsOf = (pid) => st().desk.positions.filter((x) => x.holder === pid && TRANSFERABLE_TYPES.includes(x.type));
  const opt = (id, sel) => `<option value="${id}" ${id === sel ? 'selected' : ''}>${pl(id).token} ${esc(pl(id).name)}</option>`;
  const legHTML = (l, k) => {
    let val = '';
    if (l.kind === 'cash') val = `<label>Amount $<input type="number" min="1" data-lf="amount" value="${l.amount ?? ''}"></label>`;
    if (l.kind === 'card') val = `<label>Cards<input type="number" min="1" max="2" data-lf="count" value="${l.count ?? 1}"></label>`;
    if (l.kind === 'property') {
      const props = tradeableProps(l.from);
      if (!props.includes(l.space)) l.space = props[0];
      val = `<label>Property<select data-ls="space">${props.map((i) => `<option value="${i}" ${i === l.space ? 'selected' : ''}>${esc(space(i).name)}</option>`).join('') || '<option value="">— none tradeable —</option>'}</select></label>`;
    }
    if (l.kind === 'position') {
      const ps = positionsOf(l.from);
      if (!ps.some((x) => x.id === l.position)) l.position = ps[0]?.id;
      const x = ps.find((y) => y.id === l.position);
      val = `<label>Position<select data-ls="position">${ps.map((y) => `<option value="${y.id}" ${y.id === l.position ? 'selected' : ''}>${posLabel(y)}</option>`).join('') || '<option value="">— none —</option>'}</select></label>`
        + (x && x.type === 'shares' ? `<label>Shares (of ${x.shares})<input type="number" min="1" max="${x.shares}" data-lf="shares" value="${l.shares ?? x.shares}"></label>` : '');
    }
    return `<div class="clause" data-li="${k}"><div class="fields">
      <label>From<select data-ls="from">${d.parties.map((id) => opt(id, l.from)).join('')}</select></label>
      <label>To<select data-ls="to">${d.parties.map((id) => opt(id, l.to)).join('')}</select></label>
      <label>What<select data-ls="kind">${[['cash', 'Cash'], ['property', 'Property'], ['card', 'Get-out card'], ['position', 'Desk position']].map(([v, t]) => `<option value="${v}" ${l.kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${val}<button class="small danger" data-lrm style="align-self:end">remove</button></div></div>`;
  };
  const summary = () => {
    const net = Object.fromEntries(d.parties.map((id) => [id, { cash: 0, gets: [], gives: [] }]));
    for (const l of d.legs) {
      if (!net[l.from] || !net[l.to]) continue;
      if (l.kind === 'cash') { net[l.from].cash -= Number(l.amount) || 0; net[l.to].cash += Number(l.amount) || 0; } else {
        const label = l.kind === 'property' ? (l.space !== undefined ? space(l.space).name : '?') : l.kind === 'card' ? `${l.count || 1} card(s)` : posLabel(st().desk.positions.find((y) => y.id === l.position), l.shares);
        net[l.from].gives.push(label); net[l.to].gets.push(label);
      }
    }
    return `<table class="t"><tr><th>Player</th><th class="n">Net cash</th><th>Gets</th><th>Gives</th></tr>${d.parties.map((id) => `<tr><td>${pname(id)}</td><td class="n ${net[id].cash > 0 ? 'pos' : net[id].cash < 0 ? 'neg' : ''}">${net[id].cash >= 0 ? '+' : ''}${plain$(net[id].cash)}</td><td>${esc(net[id].gets.join(', ')) || '—'}</td><td>${esc(net[id].gives.join(', ')) || '—'}</td></tr>`).join('')}</table>`;
  };
  const draw = () => {
    $('#modalBody').innerHTML = `<h2>🤝 New multi-party deal</h2>
      <p class="muted" style="font-size:12.5px">Add any number of players and legs. Nothing moves until every party signs; then all legs execute at once. Properties follow the usual rule (no buildings in the group); desk positions — shares, options, swaps — can change hands too.</p>
      <h3>Parties</h3><div class="row">${alive.map((p) => `<label class="pill"><input type="checkbox" data-party="${p.id}" ${d.parties.includes(p.id) ? 'checked' : ''} ${p.id === S.me ? 'disabled' : ''}> ${p.token} ${esc(p.name)}</label>`).join('')}</div>
      <h3>Legs</h3><div>${d.legs.map(legHTML).join('')}</div>
      <div class="row"><button data-ladd>+ Add leg</button><input data-note placeholder="Note to the other parties (optional)" maxlength="80" style="flex:1" value="${esc(d.note)}"></div>
      <h3>Who ends up with what</h3><div class="preview" id="dealSum">${summary()}</div>
      <div class="row end"><button data-close>Cancel</button><button class="primary" data-senddeal>Send for signatures</button></div>`;
    for (const cb of $$('[data-party]')) cb.onchange = () => {
      const id = cb.dataset.party;
      d.parties = cb.checked ? [...d.parties, id] : d.parties.filter((x) => x !== id);
      d.legs = d.legs.filter((l) => d.parties.includes(l.from) && d.parties.includes(l.to));
      draw();
    };
    $('[data-ladd]').onclick = () => { const to = d.parties.find((x) => x !== S.me) || S.me; d.legs.push({ from: S.me, to, kind: 'cash', amount: 100 }); draw(); };
    $('[data-note]').oninput = (e) => { d.note = e.target.value; };
    for (const el of $$('[data-li]')) {
      const l = d.legs[Number(el.dataset.li)];
      el.querySelector('[data-lrm]').onclick = () => { d.legs.splice(Number(el.dataset.li), 1); draw(); };
      for (const sel of $$('[data-ls]', el)) sel.onchange = () => { const k = sel.dataset.ls; l[k] = k === 'space' ? Number(sel.value) : sel.value; if (k === 'kind' || k === 'from') { delete l.space; delete l.position; delete l.shares; } draw(); };
      for (const inp of $$('[data-lf]', el)) inp.oninput = () => { l[inp.dataset.lf] = Number(inp.value); $('#dealSum').innerHTML = summary(); };
    }
    $('[data-senddeal]').onclick = () => {
      act('proposeDeal', { deal: { parties: d.parties, note: d.note, legs: d.legs } });
      closeModal(); S.tab = 'trades'; render();
    };
  };
  openModal(); draw();
}

// ------------------------------------------------------------------ bank axes & player market (desk tab)
function axesHTML() {
  const axes = (st().desk.axes || []).filter((a) => a.ref !== S.me);
  if (!axes.length) return '';
  return `<div class="box axes"><h4>The bank wants to trade</h4><p class="muted" style="font-size:12px;margin-top:0">The bank offers these to cut its own risk — usually better terms than its normal quotes.</p>
    ${axes.map((a) => a.kind === 'shares'
      ? `<div class="axe"><div><b>Sell ${a.shares} × ${tk(a.ref)}</b> at $${a.priceEach.toFixed(2)} <span class="muted">(${esc(a.why)})</span></div><button class="small primary" data-act="takeAxe" data-id="${a.id}" data-shares="${a.shares}">Buy ${plain$(Math.ceil(a.priceEach * a.shares))}</button></div>`
      : `<div class="axe"><div><b>Take up to ${plain$(a.notionalMax)} of credit risk on ${tk(a.ref)}</b>: the bank pays you ${pct(a.rate * 100, 2)} of notional a round; you pay the notional if ${esc(pl(a.ref).name)} goes bankrupt <span class="muted">(${esc(a.why)})</span></div>
         <div class="row" style="flex-wrap:nowrap"><input id="axn-${a.id}" type="number" min="50" step="50" value="${Math.min(500, a.notionalMax)}" style="width:80px"><button class="small primary" data-act="takeAxe" data-id="${a.id}" data-cds="1">Take</button></div></div>`).join('')}</div>`;
}

function playerMarketHTML() {
  const m = st().market; if (!m) return '';
  const lst = m.listings; const bids = m.bids;
  if (!lst.length && !bids.length) return '';
  let h = '<div class="box"><h4>Player market</h4>';
  if (lst.length) h += `<table class="t"><tr><th>For sale</th><th>Seller</th><th class="n">Price</th><th></th></tr>${lst.map((l) => {
    const x = st().desk.positions.find((y) => y.id === l.position);
    return `<tr><td>${posLabel(x, l.shares)}</td><td>${pname(l.seller)}</td><td class="n">${plain$(l.price)}</td><td>${l.seller === S.me ? `<button class="small" data-act="cancelListing" data-id="${l.id}">withdraw</button>` : `<button class="small primary" data-act="buyListing" data-id="${l.id}">buy</button>`}</td></tr>`;
  }).join('')}</table>`;
  if (bids.length) h += `<table class="t" style="margin-top:8px"><tr><th>Wanted</th><th>Buyer</th><th class="n">$/share</th><th></th></tr>${bids.map((b) => {
    const iHold = st().desk.positions.some((x) => x.holder === S.me && x.type === 'shares' && x.ref === b.ref);
    return `<tr><td>${b.shares} × ${tk(b.ref)}</td><td>${pname(b.buyer)}</td><td class="n">$${b.priceEach.toFixed(2)}</td><td>${b.buyer === S.me ? `<button class="small" data-act="cancelBid" data-id="${b.id}">withdraw</button>` : iHold ? `<button class="small primary" data-act="fillBid" data-id="${b.id}">sell</button>` : ''}</td></tr>`;
  }).join('')}</table>`;
  return h + '</div>';
}

// ------------------------------------------------------------------ market terminal
S.term = { open: false, sel: null, T: 10 };

function tmChart(values, fmt) {
  const W = 520; const H = 150; const P = 6;
  if (values.length < 2) return `<svg viewBox="0 0 ${W} ${H}" class="tm-chart"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="tm-dim">history builds each round</text></svg>`;
  let lo = Math.min(...values); let hi = Math.max(...values);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (i) => P + (i / (values.length - 1)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P - 14);
  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const up = values.at(-1) >= values[0];
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="${P}" x2="${W - P}" y1="${(P + f * (H - 2 * P)).toFixed(1)}" y2="${(P + f * (H - 2 * P)).toFixed(1)}" class="tm-grid"/>`).join('');
  const dots = values.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="7" fill="transparent"><title>${fmt(v)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="tm-chart ${up ? 'up' : 'down'}" preserveAspectRatio="none">
    <defs><linearGradient id="tmg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="tm-g0"/><stop offset="1" class="tm-g1"/></linearGradient></defs>
    ${grid}<polygon points="${P},${H - P} ${pts.join(' ')} ${W - P},${H - P}" fill="url(#tmg)"/>
    <polyline points="${pts.join(' ')}" class="tm-line" fill="none" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(values.length - 1)}" cy="${Y(values.at(-1))}" r="3.5" class="tm-dot"/>
    <text x="${W - P}" y="12" text-anchor="end" class="tm-dim">hi ${fmt(hi)}</text><text x="${W - P}" y="${H - P - 2}" text-anchor="end" class="tm-dim">lo ${fmt(lo)}</text>${dots}</svg>`;
}

function chg(m) { const h = m.history; const prev = h.length > 1 ? h[h.length - 2] : m.price; return prev ? (m.price / prev - 1) * 100 : 0; }
const arrow = (v) => `<span class="${v > 0 ? 'tm-up' : v < 0 ? 'tm-down' : 'tm-dim'}">${v > 0 ? '▲' : v < 0 ? '▼' : '■'} ${Math.abs(v).toFixed(1)}%</span>`;

function terminalHTML() {
  const s = st(); const desk = s.desk; const e = s.econ; const P = window.Pricing;
  const alive = s.players.filter((p) => !p.bankrupt);
  if (!S.term.sel || (S.term.sel.ref && !alive.some((p) => p.id === S.term.sel.ref))) S.term.sel = { kind: 'eq', ref: (alive.find((p) => p.id !== S.me) || alive[0]).id };
  const sel = S.term.sel;
  const tape = s.market.tape.slice().reverse();
  // --- header ticker
  const tickerItems = [`POLICY ${pct(e.policyRate)}`, `CPI ${pct(e.inflation)}/RD`, `HEAT ${Math.round(e.heat)}`,
    ...alive.map((p) => { const m = desk.marks[p.id]; return `${tk(p.id)} $${m.price.toFixed(2)} ${chg(m) >= 0 ? '▲' : '▼'}${Math.abs(chg(m)).toFixed(1)}%`; }),
    ...tape.slice(0, 6).map((t) => `${t.sym} ${t.side.toUpperCase()} ${t.qty}@${t.px.toFixed(2)}`)];
  let h = `<div class="tm-head"><span class="tm-logo">MC//TERMINAL</span><span class="tm-live">● LIVE</span><span class="tm-dim">ROUND ${s.round}</span>
    <div class="tm-marquee"><div>${tickerItems.map((x) => `<span>${esc(x)}</span>`).join('')}${tickerItems.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
    <button class="tm-x" data-close-terminal>✕ CLOSE</button></div><div class="tm-grid">`;
  // --- left: instruments
  const row = (k, ref, a, b, c) => `<div class="tm-row ${sel.kind === k && sel.ref === ref ? 'sel' : ''}" data-tsel="${k}:${ref || ''}"><span>${a}</span><span>${b}</span><span>${c}</span></div>`;
  h += `<div class="tm-panel tm-list"><div class="tm-title">EQUITY</div>${alive.map((p) => { const m = desk.marks[p.id]; return row('eq', p.id, `${tk(p.id)}${p.id === S.me ? ' ◆' : ''}`, `$${m.price.toFixed(2)}`, arrow(chg(m))); }).join('')}
    <div class="tm-title">CREDIT · CDS</div>${alive.map((p) => row('cds', p.id, `${tk(p.id)} CDS`, `${(desk.hazards[p.id] * 130).toFixed(2)}%`, `<span class="tm-dim">${Math.round((100 * Math.max(0, desk.equity[p.id].cdsExposure)) / Math.max(1, desk.equity[p.id].cdsCap))}% full</span>`)).join('')}
    <div class="tm-title">RATES</div>${row('rates', '', 'POLICY', pct(e.policyRate), `<span class="tm-dim">${e.fiscal.toUpperCase()}</span>`)}
    ${[5, 10, 20].map((t) => row('rates', '', `CURVE ${t}R`, pct(e.curve[t]), '')).join('')}</div>`;
  // --- center: detail
  h += '<div class="tm-panel tm-main">';
  if (sel.kind === 'eq') {
    const r = pl(sel.ref); const m = desk.marks[r.id]; const eq = desk.equity[r.id]; const hz = desk.hazards[r.id];
    const ask1 = P.shareAskCost(m.price, 1, eq.inv, eq.outside); const bid1 = P.shareBidProceeds(m.price, 1, eq.inv, eq.outside, hz);
    h += `<div class="tm-big"><span class="tm-sym">${tk(r.id)}</span><span class="tm-name">${r.token} ${esc(r.name)}</span><span class="tm-px">$${m.price.toFixed(2)}</span>${arrow(chg(m))}</div>
      <div class="tm-stats">
        <div><span>BID/ASK</span>$${bid1.toFixed(2)} / $${ask1.toFixed(2)}</div><div><span>VOL/RD</span>${(m.vol * 100).toFixed(0)}%</div><div><span>DEFAULT RISK</span>${(hz * 100).toFixed(1)}%</div>
        <div><span>BOOK EQUITY</span>${money(r.equity)}</div><div><span>SHARES OUT</span>${eq.outstanding}</div><div><span>FLOAT LEFT</span>${eq.inv}/${eq.outside}</div>
        <div><span>SHORT INT.</span>${eq.shortInterest}/${eq.float}</div><div><span>INSIDER</span>${Math.round((100 * eq.insider) / eq.outstanding)}%</div><div><span>OPT BOOK</span>${eq.optionExposure}/100</div></div>
      <div class="tm-sub">PRICE · MARKED EACH ROUND</div>${tmChart(m.history, (v) => `$${v.toFixed(2)}`)}`;
    // order book
    const axe = (desk.axes || []).find((a) => a.kind === 'shares' && a.ref === r.id);
    const asks = [{ src: 'BANK', qty: eq.inv, px: ask1, act: r.id !== S.me && eq.inv ? `<button class="tm-btn" data-tm-desk='{"product":"shares","ref":"${r.id}"}'>BUY</button>` : '' }];
    if (axe && r.id !== S.me) asks.push({ src: 'BANK AXE', qty: axe.shares, px: axe.priceEach, act: `<button class="tm-btn hot" data-act="takeAxe" data-id="${axe.id}" data-shares="${axe.shares}">TAKE</button>` });
    for (const l of s.market.listings.filter((x) => x.type === 'shares' && x.ref === r.id)) asks.push({ src: tk(l.seller), qty: l.shares, px: l.price / l.shares, act: l.seller === S.me ? '' : `<button class="tm-btn" data-act="buyListing" data-id="${l.id}">LIFT</button>` });
    const iHold = s.desk.positions.some((x) => x.holder === S.me && x.type === 'shares' && x.ref === r.id);
    const bids = [{ src: 'BANK', qty: '—', px: bid1, act: r.id !== S.me ? `<button class="tm-btn" data-tm-desk='{"product":"short","ref":"${r.id}"}'>SHORT</button>` : '' }];
    for (const b of s.market.bids.filter((x) => x.ref === r.id)) bids.push({ src: tk(b.buyer), qty: b.shares, px: b.priceEach, act: iHold && b.buyer !== S.me ? `<button class="tm-btn" data-act="fillBid" data-id="${b.id}">HIT</button>` : '' });
    asks.sort((a, b) => a.px - b.px); bids.sort((a, b) => b.px - a.px);
    const book = (rows, cls) => rows.map((x) => `<tr class="${cls}"><td>${x.src}</td><td class="n">${x.qty}</td><td class="n">$${x.px.toFixed(2)}</td><td>${x.act}</td></tr>`).join('');
    h += `<div class="tm-cols"><div><div class="tm-sub">BIDS</div><table class="tm-t">${book(bids, 'tm-bid')}</table>
        ${r.id !== S.me ? `<div class="tm-form"><input id="tmBidN" type="number" min="1" max="50" placeholder="qty"><input id="tmBidPx" type="number" step="0.05" placeholder="$/sh ${bid1.toFixed(2)}"><button class="tm-btn" data-act="postBid" data-ref="${r.id}">POST BID</button></div>` : ''}</div>
      <div><div class="tm-sub">ASKS</div><table class="tm-t">${book(asks, 'tm-ask')}</table></div></div>`;
    // option chain
    if (m.price > 0 && r.id !== S.me) {
      const T = S.term.T; const rate = e.policyRate;
      const strikes = [...new Set([0.7, 0.85, 1, 1.15, 1.3].map((f) => Math.max(0.5, Math.round(m.price * f * 2) / 2)))];
      const q = (kind, K) => { const fair = P.fairOption(kind, m.price, K, T, rate, m.vol, 1); const intr = Math.max(0, kind === 'call' ? m.price - K : K - m.price); return [Math.max(intr, fair * 0.9), fair * 1.1]; };
      h += `<div class="tm-sub">OPTION CHAIN · ${[5, 10, 20].map((t) => `<button class="tm-tab ${T === t ? 'on' : ''}" data-tterm="${t}">${t}R</button>`).join('')} <span class="tm-dim">per share · click an ask to trade</span></div>
        <table class="tm-t tm-chain"><tr><th class="n">CALL BID</th><th class="n">CALL ASK</th><th class="n">STRIKE</th><th class="n">PUT BID</th><th class="n">PUT ASK</th></tr>
        ${strikes.map((K) => { const [cb, ca] = q('call', K); const [pb, pa] = q('put', K); const atm = Math.abs(K - m.price) < m.price * 0.08;
          return `<tr class="${atm ? 'atm' : ''}"><td class="n tm-bid">${cb.toFixed(2)}</td><td class="n tm-ask"><a data-tm-desk='{"product":"call","ref":"${r.id}","strike":${K},"term":${T}}'>${ca.toFixed(2)}</a></td><td class="n"><b>${K.toFixed(2)}</b></td><td class="n tm-bid">${pb.toFixed(2)}</td><td class="n tm-ask"><a data-tm-desk='{"product":"put","ref":"${r.id}","strike":${K},"term":${T}}'>${pa.toFixed(2)}</a></td></tr>`; }).join('')}</table>`;
    }
  } else if (sel.kind === 'cds') {
    const r = pl(sel.ref); const eq = desk.equity[r.id]; const hz = desk.hazards[r.id];
    const used = Math.max(0, eq.cdsExposure); const axe = (desk.axes || []).find((a) => a.kind === 'cdsSell' && a.ref === r.id);
    h += `<div class="tm-big"><span class="tm-sym">${tk(r.id)} CDS</span><span class="tm-name">${r.token} ${esc(r.name)} · credit protection</span><span class="tm-px">${(hz * 130).toFixed(2)}%</span><span class="tm-dim">PER ROUND</span></div>
      <div class="tm-stats"><div><span>DEFAULT RISK/RD</span>${(hz * 100).toFixed(1)}%</div><div><span>BANK SELLS AT</span>${plain$(hz * 1300)}/$1k/rd</div><div><span>BANK BUYS AT</span>${plain$(hz * 1150)}/$1k/rd</div>
        <div><span>LEVERAGE</span>${r.leverage == null ? '∞' : `${r.leverage.toFixed(2)}×`}</div><div><span>CASH</span>${money(r.cash)}</div><div><span>BOOK EQUITY</span>${money(r.equity)}</div></div>
      <div class="tm-sub">BANK PROTECTION BOOK</div><div class="tm-bar"><i style="width:${Math.min(100, (100 * used) / Math.max(1, eq.cdsCap))}%"></i><span>${plain$(used)} / ${plain$(eq.cdsCap)} cap</span></div>
      <p class="tm-dim">The bank stops selling protection above 20% default risk a round, and caps its book at about 1.5× the player's equity. When the book passes half full, it pays players to take risk off it.</p>
      ${r.id !== S.me ? `<div class="tm-form"><button class="tm-btn" data-tm-desk='{"product":"cds","ref":"${r.id}"}'>BUY PROTECTION AT THE DESK</button>${axe ? `<input id="axn-${axe.id}" type="number" step="50" value="${Math.min(500, axe.notionalMax)}"><button class="tm-btn hot" data-act="takeAxe" data-id="${axe.id}" data-cds="1">SELL PROTECTION TO BANK @ ${(axe.rate * 100).toFixed(2)}%/RD</button>` : ''}</div>` : ''}`;
  } else {
    const me = pl(S.me);
    h += `<div class="tm-big"><span class="tm-sym">RATES</span><span class="tm-name">Central bank policy & yield curve</span><span class="tm-px">${pct(e.policyRate)}</span><span class="tm-dim">POLICY / RD</span></div>
      <div class="tm-stats"><div><span>INFLATION</span>${pct(e.inflation)}</div><div><span>HEAT</span>${Math.round(e.heat)}</div><div><span>PRICE LEVEL</span>${e.priceLevel.toFixed(3)}</div><div><span>FISCAL</span>${e.fiscal}</div></div>
      <div class="tm-sub">POLICY RATE · BY ROUND</div>${tmChart(e.history.map((x) => x.policyRate), (v) => pct(v))}
      <table class="tm-t"><tr><th>TERM</th><th class="n">CURVE</th><th class="n">YOUR FLOAT</th><th class="n">YOUR FIXED</th><th class="n">SWAP RCV</th><th class="n">SWAP PAY</th></tr>
      ${[5, 10, 20].map((t) => `<tr><td>${t}R</td><td class="n">${pct(e.curve[t])}</td><td class="n">${pct(me.floatQuotes[t])}</td><td class="n">${pct(me.quotes[t])}</td><td class="n">${pct(desk.swapRates[t].receiveFixed)}</td><td class="n">${pct(desk.swapRates[t].payFixed)}</td></tr>`).join('')}</table>
      <div class="tm-form"><button class="tm-btn" data-tm-desk='{"product":"swap"}'>TRADE A SWAP</button><button class="tm-btn" data-tm-bank>BORROW</button></div>`;
  }
  h += '</div>';
  // --- right: axes, bank risk, my book, tape
  const axes = (desk.axes || []).filter((a) => a.ref !== S.me);
  h += `<div class="tm-panel tm-side"><div class="tm-title">BANK AXES</div>${axes.length ? axes.map((a) => `<div class="tm-axe" data-tsel="${a.kind === 'shares' ? 'eq' : 'cds'}:${a.ref}">${a.kind === 'shares' ? `SELLS ${a.shares} ${tk(a.ref)} @ $${a.priceEach.toFixed(2)}` : `PAYS ${(a.rate * 100).toFixed(2)}%/RD FOR ${tk(a.ref)} RISK ≤ ${plain$(a.notionalMax)}`}<span class="tm-dim">${esc(a.why)}</span></div>`).join('') : '<div class="tm-dim">No axes — the bank is comfortable.</div>'}
    <div class="tm-title">BANK RISK</div>${alive.map((p) => { const q = desk.equity[p.id]; const inv = Math.round(q.inv * desk.marks[p.id].price);
      return `<div class="tm-risk"><span>${tk(p.id)}</span><span>INV ${q.inv} · ${plain$(inv)}</span><div class="tm-bar sm"><i style="width:${Math.min(100, (100 * Math.max(0, q.cdsExposure)) / Math.max(1, q.cdsCap))}%"></i></div><div class="tm-bar sm alt"><i style="width:${q.optionExposure}%"></i></div></div>`; }).join('')}
    <div class="tm-dim" style="font-size:10px">bars: CDS book vs cap · option book vs 100 shares</div>
    <div class="tm-title">BANK P&L ${money(desk.totalPnl)}</div>
    <div class="tm-title">MY BOOK</div>${desk.positions.filter((x) => x.holder === S.me).map((x) => `<div class="tm-pos"><span>${posLabel(x)}</span><span>${x.type === 'short' ? `-${plain$(x.coverCost)}` : x.type === 'cds' || x.type === 'insurance' || x.type === 'cdsSold' ? `${x.type === 'cdsSold' ? '+' : '-'}${plain$(x.premium)}/rd` : x.type === 'swap' ? '' : plain$(positionQuote(x))}</span></div>`).join('') || '<div class="tm-dim">No positions.</div>'}
    <div class="tm-title">TAPE</div><div class="tm-tape">${tape.slice(0, 25).map((t) => `<div><span class="tm-dim">R${t.round}</span> <b>${esc(t.sym)}</b> <span class="${t.side === 'buy' || t.side === 'cover' ? 'tm-up' : t.side === 'sell' || t.side === 'short' ? 'tm-down' : ''}">${t.side.toUpperCase()}</span> ${t.qty}${t.px ? ` @ ${t.px.toFixed(2)}` : ''} <span class="tm-dim">${esc(t.venue)} · ${esc(tk(t.who))}</span></div>`).join('') || '<div class="tm-dim">No trades yet.</div>'}</div></div>`;
  return `${h}</div>`;
}

function renderTerminal() {
  const el = $('#terminal');
  if (!el) return;
  if (!S.term.open || !st() || st().status === 'lobby') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  setHTML(el, terminalHTML());
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-tsel], [data-tterm], [data-tm-desk], [data-tm-bank], [data-close-terminal], [data-open-terminal], [data-open-deal]');
  if (!t) return;
  if (t.dataset.openTerminal !== undefined) { S.term.open = true; renderTerminal(); return; }
  if (t.dataset.closeTerminal !== undefined) { S.term.open = false; renderTerminal(); return; }
  if (t.dataset.openDeal !== undefined) { openDealModal(); return; }
  if (t.dataset.tsel) { const [kind, ref] = t.dataset.tsel.split(':'); S.term.sel = { kind, ref: ref || null }; renderTerminal(); return; }
  if (t.dataset.tterm) { S.term.T = Number(t.dataset.tterm); renderTerminal(); return; }
  if (t.dataset.tmBank !== undefined) { S.term.open = false; S.tab = 'bank'; renderTerminal(); render(); return; }
  if (t.dataset.tmDesk) {
    const o = JSON.parse(t.dataset.tmDesk);
    Object.assign(S.dk, o, o.strike !== undefined ? { strike: String(o.strike) } : { strike: '' });
    S.term.open = false; S.tab = 'desk'; renderTerminal(); render();
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.term.open) { S.term.open = false; renderTerminal(); } });
