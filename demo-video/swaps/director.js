/* Feature-tour director: "You" vs 4 AI agents. A scripted cursor drives the real UI (Central Bank, Contracts,
   Bank Desk, Economy) to borrow floating and hedge it with a player swap and a desk swap, then the recorded game
   plays on while rates rise. The UI's outgoing actions are checked against the recorded ones. */
(async () => {
  'use strict';
  const D = await (await fetch('/__frames59.json')).json();
  const F = D.frames; const T = D.tags; const ME = D.me;
  const byName = Object.fromEntries(D.players.map((p) => [p.name, p]));
  const tok = (n) => byName[n].token;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const log = (...a) => console.log('[director]', ...a);

  __ws.onmessage({ data: JSON.stringify({ type: 'joined', playerId: ME, code: 'DEMO', token: 'x', board: D.board }) });
  const push = (i) => __ws.onmessage({ data: JSON.stringify({ type: 'state', state: F[i].state }) });

  // ---------------------------------------------------------------- graphics (shared look with the main video)
  const capBox = el('div'); capBox.id = 'dCap'; document.body.appendChild(capBox);
  const stampBox = el('div'); stampBox.id = 'dStamp'; document.body.appendChild(stampBox);
  const cap = (html) => { capBox.innerHTML = html ? `<div class="c">${html}</div>` : ''; };
  const stamp = (icon, kicker, title, sub = '', color = 'red') => { stampBox.innerHTML = `<div class="a ${color}"><div class="ic">${icon}</div><div class="tx"><div class="k">${kicker}</div><div class="t">${title}</div>${sub ? `<div class="sb">${sub}</div>` : ''}</div></div>`; };
  const cursor = el('div', '', '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5 L4 19.5 L8.6 15.3 L11.6 21.8 L14.6 20.4 L11.7 14.1 L18 14.1 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>');
  cursor.id = 'dCursor'; cursor.style.left = '900px'; cursor.style.top = '760px'; document.body.appendChild(cursor);
  const track = el('div', 'off'); track.id = 'dTrack'; document.body.appendChild(track);

  // ---------------------------------------------------------------- cursor-driven UI helpers
  async function find(sel, root = document) { for (let k = 0; k < 40; k++) { const e = typeof sel === 'string' ? $(sel, root) : sel(); if (e) return e; await sleep(50); } throw new Error(`not found: ${sel}`); }
  async function reveal(e) {
    const r = e.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 40) { e.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(650); }
  }
  async function point(sel, { hl = true, dwell = 250 } = {}) {
    const e = await find(sel); await reveal(e);
    const r = e.getBoundingClientRect();
    cursor.style.left = `${r.left + Math.min(r.width * 0.5, 60)}px`; cursor.style.top = `${r.top + r.height * 0.55}px`;
    await sleep(650);
    if (hl) { e.classList.add('dHL'); setTimeout(() => e.classList.remove('dHL'), 1300); }
    await sleep(dwell);
    return e;
  }
  function ripple() { const r = el('div', 'dRipple'); r.style.left = cursor.style.left; r.style.top = cursor.style.top; document.body.appendChild(r); setTimeout(() => r.remove(), 600); }
  async function click(sel, opts) { const e = await point(sel, { hl: false, ...opts }); ripple(); e.click(); await sleep(350); return e; }
  async function choose(sel, value, opts) {
    const e = await point(sel, opts); ripple();
    e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(450); return e;
  }
  async function type(sel, text, opts) {
    const e = await point(sel, opts); ripple(); e.focus();
    e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); await sleep(120);
    let acc = '';
    for (const ch of String(text)) { acc += ch; if (!acc.endsWith('.')) { e.value = acc; e.dispatchEvent(new Event('input', { bubbles: true })); } await sleep(85); }
    await sleep(300); e.blur(); return e;
  }
  const tab = (name) => click(`#tabs [data-tab="${name}"]`);
  const clause = (k, sel) => () => $(`.clause[data-ci="${k}"] ${sel}`);
  async function scrollTo(sel, top) { const e = await find(sel); e.scrollTo({ top, behavior: 'smooth' }); await sleep(700); }
  const hideCursor = (h) => { cursor.style.opacity = h ? 0 : 1; };

  // ---------------------------------------------------------------- hedge accounting from the recorded log
  const per = {}; // round -> { interest, swapKeynes, swapDesk }
  F.forEach((f) => {
    for (const e of f.events) {
      const m = /\$(\d+)/.exec(e.msg); if (!m) continue; const v = +m[1];
      const o = (per[f.round] ||= { interest: 0, keynes: 0, desk: 0 });
      if (/^You → Bank: .*interest on floating bank loan/.test(e.msg)) o.interest += v;
      else if (/^Keynes → You: .*Rate hedge/.test(e.msg)) o.keynes += v;
      else if (/^You → Keynes: .*Rate hedge/.test(e.msg)) o.keynes -= v;
      else if (/^Bank → You: .*swap settlement/.test(e.msg)) o.desk += v;
      else if (/^You → Bank: .*swap settlement/.test(e.msg)) o.desk -= v;
    }
  });
  const loan0 = Math.round(2000 * 2.35 / 100);
  function updateTrack(i) {
    const f = F[i]; const o = per[f.round] || {}; const r0 = F[T.borrow].rate;
    const interest = o.interest || loan0; const sw = (o.keynes || 0) + (o.desk || 0);
    track.innerHTML = `<h6>Your hedge · round ${f.round}</h6>
      <div class="r"><span>Policy rate<small>was ${r0.toFixed(2)}% at signing</small></span><b class="${f.rate > r0 ? 'bad' : ''}">${f.rate.toFixed(2)}%</b></div>
      <div class="r"><span>Loan interest<small>$2,000 floating · was ${fmt(loan0)}</small></span><b class="${interest > loan0 ? 'bad' : ''}">−${fmt(interest)}/rd</b></div>
      <div class="r"><span>Swaps pay you<small>Keynes + bank desk</small></span><b class="${sw > 0 ? 'good' : sw < 0 ? 'bad' : ''}">${sw >= 0 ? '+' : '−'}${fmt(Math.abs(sw))}/rd</b></div>`;
  }

  // ---------------------------------------------------------------- the script
  const START = 204;
  async function play(from, to, ms, cues = {}) {
    for (let i = from; i <= to; i++) {
      push(i); if (!track.classList.contains('off')) updateTrack(i);
      const hold = cues[i] ? (await cues[i]()) || 0 : 0;
      await sleep(ms + hold);
    }
  }
  function check(kind, recorded) {
    const sent = (window.__sent || []).filter((m) => m.action === kind).pop();
    const norm = (c) => JSON.stringify(c, (k, v) => (k === 'spaces' && Array.isArray(v) && !v.length ? undefined : v));
    const ok = sent && norm(sent.contract) === norm(recorded);
    log(kind, ok ? 'matches the recorded action' : `sent ${JSON.stringify(sent)} vs recorded ${JSON.stringify(recorded)}`);
  }

  async function run() {
    // --- Hook
    cap('<em>You</em> vs 4 AI agents. Round 14: you want to borrow <em>$2,000</em> to build.');
    await play(START, T.borrow - 1, 230);
    await sleep(500);

    // --- Central Bank tab: borrow floating
    await tab('bank');
    cap('<em>Central Bank</em> tab: your balance sheet and live loan quotes.');
    await sleep(1700);
    await type('#bankAmt', 2000);
    await choose('#bankKind', 'floating');
    await choose('#bankTerm', '20');
    cap('Borrow <em>$2,000 floating</em>: the policy rate + a spread, reset every round.');
    await sleep(1300);
    await click('[data-act="borrow"]');
    const b = (window.__sent || []).filter((m) => m.action === 'borrow').pop(); log('borrow sent', JSON.stringify(b), 'recorded', JSON.stringify(F[T.borrow].action));
    push(T.borrow);
    await sleep(500);
    await point(() => [...document.querySelectorAll('.tab-body .box h4')].find((h) => /Your loans/.test(h.textContent)).parentElement, { dwell: 300 });
    cap('Cheap today. But if rates rise, so does your bill. <span class="r">Time to hedge.</span>');
    await sleep(2200);

    // --- Contracts tab: build a swap with Keynes
    await tab('contracts');
    cap('<em>Contracts</em> tab: write a deal with another player, clause by clause.');
    await sleep(900);
    await click('[data-open="contract"]');
    await sleep(500);
    await click('[data-tpl="irs"]');
    cap('Start from the <em>interest-rate swap</em> template…');
    await choose('[data-cto]', byName.Keynes.id);
    await type('[data-cname]', 'Rate hedge');
    await type('[data-cterm]', 15);
    cap(`Leg 1: <em>you pay</em> ${tok('Keynes')} Keynes a <em>fixed 2.75%</em> on $1,200.`);
    await type(clause(0, '[data-cf="notional"]'), 1200);
    await type(clause(0, '[data-cf="rate"]'), 2.75);
    cap(`Leg 2: ${tok('Keynes')} Keynes <em>pays you the floating</em> policy rate.`);
    await type(clause(1, '[data-cf="notional"]'), 1200);
    await sleep(500);
    cap('Then a custom clause: Keynes pledges <em>Canal Street</em> as collateral.');
    await choose('[data-addkind]', 'collateral');
    await click('[data-add]');
    await choose(clause(2, '[data-cs="dir"]'), 'in');
    await click(clause(2, '[data-cp][value="8"]'));
    await sleep(300);
    await point('#cprev', { dwell: 200 });
    cap('The term sheet shows the cash flows at today’s rates.');
    await sleep(2600);
    await click('[data-sendc]');
    check('proposeContract', F[T.propose].action.contract);
    push(T.propose);
    hideCursor(true);
    cap(`${tok('Keynes')} Keynes’s AI prices it: discounted cash flows, minus your credit risk…`);
    await sleep(2300);
    push(T.accept);
    stamp('📜', 'Contract signed · round 14', 'Keynes accepts “Rate hedge”', '15 rounds · $1,200 notional · Canal Street pledged', 'gold');
    cap('…and signs.');
    await sleep(2600);

    // --- Bank Desk: pay-fixed swap with the central bank
    hideCursor(false);
    await tab('desk');
    cap('<em>Bank Desk</em>: trade with the central bank. Shares, options, CDS… and rate swaps.');
    await sleep(1600);
    await choose('#dkProduct', 'swap');
    await choose('#dkSide', 'payFixed');
    await type('#dkNotional', 800);
    await choose('#dkTerm', '20');
    await point('#dkQuote', { dwell: 300 });
    cap('Hedge the other <em>$800</em>: pay a fixed <em>2.04%</em>, receive the policy rate.');
    await sleep(2200);
    await click('[data-act="deskBuy"]');
    const o = (window.__sent || []).filter((m) => m.action === 'deskBuy').pop(); log('desk sent', JSON.stringify(o && o.order));
    push(T.desk);
    await sleep(400);
    await point(() => [...document.querySelectorAll('.tab-body .box h4')].find((h) => /Your desk positions/.test(h.textContent)).parentElement, { dwell: 300 });
    cap('Your whole $2,000 loan is now hedged.');
    await sleep(1800);
    hideCursor(true);

    // --- Payoff: rates rise
    track.classList.remove('off'); updateTrack(T.desk);
    S.tab = 'economy'; render();
    cap('Now fast-forward and watch the economy…');
    const hawk = F.findIndex((f, i) => i > T.desk && f.events.some((e) => /HAWKISH SURPRISE/.test(e.msg)));
    const peak = F.findIndex((f, i) => i > T.desk && f.rate >= 4.5);
    await play(T.desk + 1, hawk - 1, 70);
    await play(hawk, hawk, 0, { [hawk]: () => { stamp('📈', `Rate shock · round ${F[hawk].round}`, 'Policy rate <span class="num">+1.00%</span>', '“Hawkish surprise” card: the central bank hikes', 'amber'); cap('One round later: <span class="r">a surprise rate hike</span>.'); return 2600; } });
    cap(null);
    const toContracts = F.findIndex((f) => f.round === F[hawk].round + 3);
    await play(hawk + 1, toContracts, 60);
    S.tab = 'contracts'; render(); await sleep(200);
    cap(`Each round the contract settles: ${tok('Keynes')} Keynes now pays <em>you</em>.`);
    await play(toContracts + 1, peak - 1, 75);
    const pk = per[F[peak].round];
    await play(peak, peak, 0, { [peak]: () => { cap(`Round ${F[peak].round}: policy rate <span class="r">4.5%</span>. Your loan costs <span class="r">${fmt(pk.interest)}</span>/round, up from ${fmt(loan0)}…`); return 2600; } });
    cap(`…and your swaps pay you <span class="g">+${fmt(pk.keynes + pk.desk)}</span>/round.`);
    await play(peak + 1, peak + 14, 120);
    cap(null);
    await play(peak + 15, F.length - 1, 45);
    await sleep(400);
    await outro();
    window.__done = true;
  }

  async function outro() {
    const rounds = Object.keys(per).map(Number).filter((r) => r > F[T.desk].round && per[r].interest).sort((a, b) => a - b);
    const rows = rounds.map((r) => ({ r, gross: per[r].interest, net: per[r].interest - per[r].keynes - per[r].desk }));
    const paid = rows.reduce((a, x) => a + x.gross, 0); const back = rows.reduce((a, x) => a + (x.gross - x.net), 0);
    const W = 400, H = 220;
    const lo = Math.max(0, Math.min(...rows.map((x) => Math.min(x.gross, x.net))) - 15); const hi = Math.max(...rows.map((x) => x.gross)) + 12;
    const X = (k) => 12 + (k / (rows.length - 1)) * (W - 70); const Y = (v) => H - 10 - ((v - lo) / (hi - lo)) * (H - 24);
    const line = (key) => rows.map((x, k) => `${k ? 'L' : 'M'}${X(k).toFixed(1)},${Y(x[key]).toFixed(1)}`).join('');
    const area = `${line('gross')}${rows.slice().reverse().map((x, k) => `L${X(rows.length - 1 - k).toFixed(1)},${Y(x.net).toFixed(1)}`).join('')}Z`;
    const nets = rows.slice(1).map((x) => x.net); const flat = Math.round(nets.reduce((a, v) => a + v, 0) / nets.length);
    const g0 = rows[0].gross; const gMax = Math.max(...rows.map((x) => x.gross));
    const pct = (v) => `${((Y(v) / H) * 100).toFixed(1)}%`; const last = rows[rows.length - 1];
    cap(null); track.classList.add('off'); hideCursor(true);
    const c = el('div', 'dCard', `<div>
      <div class="kick fade">Policy rate ${F[T.borrow].rate.toFixed(2)}% → ${Math.max(...F.map((f) => f.rate)).toFixed(2)}% · swaps paid you ${fmt(back)}</div>
      <h1 class="fade" style="animation-delay:.1s;font-size:60px">Rates went up. <em>Your cost didn’t.</em></h1>
      <p class="fade" style="animation-delay:.4s">Unhedged, the loan’s interest rose from <b style="color:#ff8a80">${fmt(loan0)}</b> at signing to <b style="color:#ff8a80">${fmt(gMax)}</b> a round. With both swaps you paid a flat <b style="color:var(--gold)">≈${fmt(flat)}</b>.</p>
      <div class="outroChart fade" style="animation-delay:.6s;width:860px;position:relative"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:860px;height:270px">
        <defs><clipPath id="rev"><rect x="0" y="0" width="0" height="${H}"><animate attributeName="width" from="0" to="${W}" begin="0.7s" dur="2.2s" fill="freeze" calcMode="spline" keySplines=".3 .1 .2 1" keyTimes="0;1"/></rect></clipPath></defs>
        <g clip-path="url(#rev)"><path d="${area}" fill="#5ccb8c30"/>
        <path d="${line('gross')}" fill="none" stroke="#ff7a70" stroke-width="3.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        <path d="${line('net')}" fill="none" stroke="#e8c76c" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></g></svg>
        <div class="fade" style="animation-delay:2.6s;position:absolute;left:${((X(rows.length - 1) + 8) / W * 100).toFixed(1)}%;top:${pct(last.net)};transform:translateY(-50%);font:800 18px var(--disp);color:var(--gold);white-space:nowrap">hedged ${fmt(last.net)}</div>
        <div class="fade" style="animation-delay:1.8s;position:absolute;left:${((X(rows.indexOf(rows.find((x) => x.gross === gMax))) - 30) / W * 100).toFixed(1)}%;top:calc(${pct(gMax)} - 30px);font:800 18px var(--disp);color:#ff8a80;white-space:nowrap">unhedged ${fmt(gMax)}</div>
        <div class="legend"><span><i style="background:#ff7a70"></i>Floating-loan interest per round</span><span><i style="background:#e8c76c"></i>After swap payments</span><span><i style="background:#5ccb8c66;height:10px"></i>Paid by the swaps</span></div></div>
      <div class="kick fade" style="animation-delay:1.2s;margin:16px 0 0;color:#cfd8c6;letter-spacing:.2em">MARGIN<span style="color:var(--gold)"> CALL</span> · contracts · rate swaps · options · CDS</div></div>`);
    document.body.appendChild(c);
    await sleep(6500);
  }

  push(START); hideCursor(false);
  cap('<em>You</em> vs 4 AI agents. Round 14: you want to borrow <em>$2,000</em> to build.');
  setInterval(() => document.body.classList.toggle('mOpen', !$('#modal').classList.contains('hidden')), 100);
  window.__dbg = { push, F, T, run, outro, updateTrack, track };
  window.__ready = true;
  window.__start = () => run().catch((e) => { log('ERROR', e.message); window.__done = true; });
})();
