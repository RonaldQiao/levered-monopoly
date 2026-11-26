/* Demo-video director: replays a recorded all-AI game through the real client at a scripted pace,
   with broadcast graphics (panel, captions, stamps, zooms) on top. */
(async () => {
  'use strict';
  const D = await (await fetch(`/__${window.__FRAMES || 'frames30.json'}`)).json();
  const F = D.frames; const N = F.length;
  const P = D.players; const byName = Object.fromEntries(P.map((p) => [p.name, p]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const tok = (n) => byName[n].token;

  // ---------------------------------------------------------------- boot the real client
  __ws.onmessage({ data: JSON.stringify({ type: 'joined', playerId: 'spectator', code: 'DEMO', token: 'x', board: D.board }) });
  const push = (i) => __ws.onmessage({ data: JSON.stringify({ type: 'state', state: F[i].state }) });

  // ---------------------------------------------------------------- right panel
  const panel = el('div', '', ''); panel.id = 'dPanel';
  panel.innerHTML = `<div class="hd"><span class="logo tiny">MARGIN<span>CALL</span></span><span class="rd">AI vs AI · Round <b id="dRound">1</b></span></div>
    <div class="sub" id="dSub"></div>
    <div class="dRows" id="dRows"></div>
    <div class="dChart" id="dNwC"><h5>Net worth <b></b></h5><svg viewBox="0 0 400 120" preserveAspectRatio="none" height="112"></svg></div>
    <div class="dChart" id="dRateC"><h5>Central bank policy rate <b id="dRate"></b></h5><svg viewBox="0 0 400 60" preserveAspectRatio="none" height="58"></svg></div>`;
  document.body.appendChild(panel);
  const rows = {};
  for (const p of P) {
    const r = el('div', 'dRow'); r.style.setProperty('--pc', p.color);
    r.innerHTML = `<div class="l1"><span class="tk">${p.token}</span><span class="nm">${p.name}</span><span class="bd"></span><span class="nw"></span></div>
      <div class="bar"><i></i></div><div class="l3"><span>Cash <b class="cs"></b></span><span>Bank debt <b class="db"></b></span><span>Leverage <b class="lv"></b></span></div>`;
    $('#dRows').appendChild(r); rows[p.id] = r;
  }
  const prevNw = {};
  const W = 400;
  const X = (i) => (i / (N - 1)) * W;
  function nwPaths(upto, H, maxY, sw) {
    let h = '';
    for (const p of P) {
      let d = ''; let started = false;
      for (let i = 0; i <= upto; i += (upto > 300 ? 2 : 1)) {
        const v = F[i].nw[p.id];
        const y = H - 3 - (Math.max(0, v) / maxY) * (H - 8);
        d += `${started ? 'L' : 'M'}${X(i).toFixed(1)},${y.toFixed(1)}`; started = true;
      }
      const v = F[upto].nw[p.id]; const y = H - 3 - (Math.max(0, v) / maxY) * (H - 8);
      d += `L${X(upto).toFixed(1)},${y.toFixed(1)}`;
      h += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      h += `<circle cx="${X(upto).toFixed(1)}" cy="${y.toFixed(1)}" r="0" />`;
    }
    return h;
  }
  let maxSoFar = 2500;
  function updatePanel(i) {
    const s = F[i].state; const f = F[i];
    $('#dRound').textContent = s.round;
    const top = Math.max(2500, ...s.players.map((p) => p.netWorth));
    for (const p of s.players) {
      const r = rows[p.id];
      const nw = p.bankrupt ? 0 : p.netWorth;
      r.querySelector('.nw').textContent = p.bankrupt ? '—' : fmt(nw);
      r.querySelector('.bar i').style.width = `${Math.max(0, (nw / top) * 100)}%`;
      r.querySelector('.cs').textContent = p.bankrupt ? '—' : fmt(p.cash);
      const db = r.querySelector('.db'); db.textContent = p.bankrupt ? '—' : fmt(p.bankDebt); db.classList.toggle('hot', p.bankDebt > 0);
      const lv = r.querySelector('.lv'); lv.textContent = p.bankrupt || p.leverage == null ? '—' : `${p.leverage.toFixed(2)}×`; lv.classList.toggle('hot', p.leverage > 2.5);
      const badge = p.bankrupt ? '<span class="dBadge dB-bk">☠ bankrupt</span>' : p.marginCall ? '<span class="dBadge dB-mc">margin call</span>' : p.inJail ? '<span class="dBadge dB-jail">lockup</span>' : '';
      const bd = r.querySelector('.bd'); if (bd.innerHTML !== badge) bd.innerHTML = badge;
      r.classList.toggle('dMC', !!p.marginCall && !p.bankrupt);
      r.classList.toggle('dDead', p.bankrupt);
      const prev = prevNw[p.id];
      if (prev !== undefined && !p.bankrupt && Math.abs(nw - prev) >= 450 && Math.abs(nw - prev) / Math.max(prev, 1) > 0.12 && !window.__fast) {
        const up = nw > prev;
        r.classList.remove('flashUp', 'flashDown'); void r.offsetWidth; r.classList.add(up ? 'flashUp' : 'flashDown');
        const fl = el('div', `dFly ${up ? 'up' : 'down'}`, `${up ? '+' : '−'}$${Math.abs(Math.round(nw - prev)).toLocaleString('en-US')}`);
        r.appendChild(fl); setTimeout(() => fl.remove(), 1700);
      }
      prevNw[p.id] = nw;
    }
    // charts
    maxSoFar = Math.max(maxSoFar, ...Object.values(f.nw));
    $('#dNwC svg').innerHTML = nwPaths(i, 120, maxSoFar * 1.08, 2.2);
    const leader = s.players.filter((p) => !p.bankrupt).sort((a, b) => b.netWorth - a.netWorth)[0];
    $('#dNwC h5 b').textContent = leader ? `${leader.token} ${leader.name} leads` : '';
    let d = '';
    for (let k = 0; k <= i; k += 2) d += `${k ? 'L' : 'M'}${X(k).toFixed(1)},${(57 - (F[k].rate / 6) * 52).toFixed(1)}`;
    d += `L${X(i).toFixed(1)},${(57 - (F[i].rate / 6) * 52).toFixed(1)}`;
    $('#dRateC svg').innerHTML = `<path d="${d}L${X(i).toFixed(1)},60L0,60Z" fill="#ec6b6222"/><path d="${d}" fill="none" stroke="#ec6b62" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
    $('#dRate').textContent = `${s.econ.policyRate.toFixed(2)}%`;
  }

  // ---------------------------------------------------------------- captions, stamps, zoom
  const capBox = el('div'); capBox.id = 'dCap'; document.body.appendChild(capBox);
  const chap = el('div'); chap.id = 'dChapter'; chap.style.opacity = 0; $('#dSub').appendChild(chap);
  const spd = el('div'); spd.id = 'dSpeed'; spd.style.opacity = 0; $('#dSub').appendChild(spd);
  const stampBox = el('div'); stampBox.id = 'dStamp'; document.body.appendChild(stampBox);
  const vig = el('div'); vig.id = 'dVignette'; document.body.appendChild(vig);
  const cap = (html) => { capBox.innerHTML = html ? `<div class="c">${html}</div>` : ''; };
  const chapter = (t) => { chap.textContent = t || ''; chap.style.opacity = t ? 1 : 0; };
  const stamp = (icon, kicker, title, sub = '', color = 'red') => { stampBox.innerHTML = `<div class="a ${color}"><div class="ic">${icon}</div><div class="tx"><div class="k">${kicker}</div><div class="t">${title}</div>${sub ? `<div class="sb">${sub}</div>` : ''}</div></div>`; };
  const vignette = (on) => vig.classList.toggle('on', on);
  const hlRate = (on) => $('#dRateC').classList.toggle('hl', on);
  function zoom(space, scale = 1.6) {
    const stage = $('.stage');
    if (space == null) { stage.style.transform = ''; return; }
    stage.style.transition = 'none'; const t = stage.style.transform; stage.style.transform = '';
    const sr = stage.getBoundingClientRect(); const cr = $(`#board [data-space="${space}"]`).getBoundingClientRect();
    stage.style.transform = t; void stage.offsetWidth; stage.style.transition = '';
    stage.style.transformOrigin = `${cr.left + cr.width / 2 - sr.left}px ${cr.top + cr.height / 2 - sr.top}px`;
    stage.style.transform = `scale(${scale})`;
  }
  let msPer = 100;
  const setSpeed = (ms) => {
    msPer = ms; window.__fast = ms < 90;
    const x = 1500 / ms;
    if (x >= 6) { spd.textContent = `▶▶ ${x >= 12 ? Math.round(x / 5) * 5 : Math.round(x)}×`; spd.style.opacity = 1; } else spd.style.opacity = 0;
  };

  const debt = (i, n) => F[i].state.players.find((p) => p.name === n).bankDebt;
  const loanNo = {}; let hayekLoans = 0;
  F.forEach((f, i) => { if (f.events.some((e) => /^🏦 Hayek borrows/.test(e.msg))) loanNo[i] = ++hayekLoans; });

  // ---------------------------------------------------------------- the script (frame index → cues)
  const CUES = {
    0: () => { setSpeed(40); chapter('Rounds 1–9 · land grab'); cap('Round 1. Each agent starts with <em>$1,500</em>. The bank lends up to <em>3× leverage</em>.'); },
    95: () => cap(null),
    132: () => chapter('Rounds 10–16 · building sets'),
    205: () => setSpeed(120),
    221: () => { chapter('Round 16'); cap(`${tok('Hayek')} Hayek pays ${tok('Volcker')} Volcker <em>$980 cash</em> for the last navy lot…`); return 2000; },
    222: () => setSpeed(90),
    230: () => { cap('…then borrows from the central bank to build on it. 🏦'); return 1000; },
    231: () => setSpeed(50),
    ...Object.fromEntries(Object.entries(loanNo).filter(([i]) => i > 240 && i < 330).map(([i, n]) => [i, () => { cap(`${tok('Hayek')} Hayek: loan <em>#${n}</em> · bank debt <span class="r">${fmt(debt(+i, 'Hayek'))}</span>`); return 250; }])),
    330: () => { cap(`${tok('Keynes')} Keynes trades into the green set…`); return 900; },
    335: () => { cap(`…borrows <em>$770</em> and builds.`); setSpeed(110); return 500; },
    343: () => { chapter('Round 24 · rate shock'); stamp('📈', 'Rate shock · round 24', 'Policy rate <span class="num">+1.00%</span>', '“Hawkish surprise” card: the central bank hikes', 'amber'); hlRate(true); cap('Then the central bank <span class="r">hikes rates</span>.'); return 2600; },
    344: () => { setSpeed(60); cap('Policy rate: <span class="r">2% → 5.25%</span> in five rounds.'); },
    377: () => { cap(`${tok('Hayek')} Hayek can’t repay. Loans roll over at a <span class="r">6–7.5% penalty rate</span>.`); return 1100; },
    388: () => { stamp(tok('Hayek'), 'Margin call · round 26', 'Hayek is over the limit', 'Leverage 3.18× against a 3× cap', 'red'); vignette(true); return 1800; },
    389: () => { vignette(false); hlRate(false); cap(null); },
    418: () => { setSpeed(150); chapter('Round 28'); },
    426: () => { cap(`${tok('Minsky')} Minsky rolls a 7…`); return 1000; },
    427: () => { stamp(tok('Minsky'), 'Rent due · round 28', 'Minsky pays <span class="num">$1,609</span>', `to ${tok('Keynes')} Keynes for Emerald Drive (4 houses)`, 'red'); cap('Back to that roll. Keynes borrowed to build those houses.'); return 2600; },
    428: () => { setSpeed(200); cap(`${tok('Minsky')} Minsky mortgages everything…`); },
    434: () => { cap('…borrows at <span class="r">7.65%</span>. A textbook <em>Minsky moment</em>.'); return 2000; },
    435: () => { setSpeed(100); cap(null); },
    442: () => { cap(`${tok('Friedman')} Friedman lands on the greens too: <span class="r">−$1,207</span>.`); return 1300; },
    443: () => { setSpeed(45); chapter('Rounds 29–33 · fire sales'); cap(null); },
    453: () => { stamp(tok('Minsky'), 'Margin call · round 29', 'Minsky at 5.72× leverage', 'Sell, repay, or the bank liquidates', 'red'); vignette(true); return 1200; },
    454: () => vignette(false),
    456: () => { cap('Underwater agents <em>fire-sell</em> property to rivals by sealed bid.'); return 600; },
    486: () => { stamp('🔨', 'Forced liquidation · round 29', 'The bank seizes Hayek’s assets', 'Margin call not met: cash seized, property mortgaged', 'red'); return 1500; },
    487: () => cap(null),
    579: () => { cap('Harbour Walk sells for <span class="r">$14</span>.'); return 1100; },
    580: () => setSpeed(100),
    591: () => { stamp(tok('Hayek'), 'Bankruptcy · round 33', 'Hayek is out', 'First agent eliminated', 'grey'); vignette(true); cap('Hayek goes bust first. The bank writes off <span class="r">$956</span>.'); return 2300; },
    592: () => { vignette(false); setSpeed(150); },
    601: () => { cap(`${tok('Minsky')} Minsky pays Friedman <span class="r">$933</span> in rent…`); return 800; },
    602: () => { stamp(tok('Minsky'), 'Bankruptcy · round 34', 'Minsky is out', '3 agents left', 'grey'); vignette(true); cap('Two down.'); return 2000; },
    603: () => { vignette(false); setSpeed(45); chapter('Rounds 35–46'); cap(`${tok('Keynes')} Keynes & ${tok('Friedman')} Friedman keep refinancing at <span class="r">6–7.5%</span>…`); },
    660: () => { cap(`${tok('Volcker')} Volcker hasn’t taken <em>a single loan</em>.`); return 700; },
    706: () => { setSpeed(100); cap(null); },
    717: () => { stamp(tok('Friedman'), 'Margin call · round 46', 'Friedman at 3.26× leverage', `${fmt(debt(717, 'Friedman'))} of bank debt`, 'red'); vignette(true); chapter('Rounds 47–48 · endgame'); return 1500; },
    718: () => { vignette(false); setSpeed(35); },
    800: () => setSpeed(120),
    810: () => { stamp(tok('Friedman'), 'Bankruptcy · round 48', 'Friedman is out', 'Bank writes off $1,026', 'grey'); vignette(true); return 1900; },
    811: () => { vignette(false); setSpeed(100); },
    815: () => { stamp(tok('Keynes'), 'Margin call · round 48', 'Keynes at 3.63× leverage', `${fmt(debt(815, 'Keynes'))} of bank debt`, 'red'); vignette(true); return 1500; },
    816: () => { vignette(false); setSpeed(30); },
    866: () => setSpeed(150),
    877: () => { cap(`${tok('Keynes')} Keynes goes bust. <em>${tok('Volcker')} Volcker is the last agent standing.</em>`); return 2800; },
  };

  // ---------------------------------------------------------------- intro / outro
  const card = (html) => { const c = el('div', 'dCard', html); document.body.appendChild(c); return c; };
  // Cold open: drop in at round 28 mid-crisis, show the worst roll, then rewind to round 1.
  const COLD = 420;
  async function intro() {
    chapter('Round 28'); spd.style.opacity = 0;
    cap('<em>5 AI agents</em> are playing a property game where they can borrow from a central bank.');
    for (let i = COLD; i <= 427; i++) { push(i); updatePanel(i); await sleep(i === 427 ? 1300 : i === 426 ? 900 : 260); if (i === 425) cap(`${tok('Minsky')} Minsky rolls…`); }
    stamp(tok('Minsky'), 'Rent due · round 28', 'Minsky pays <span class="num">$1,609</span>', `to ${tok('Keynes')} Keynes for Emerald Drive (4 houses)`, 'red');
    cap('…and loses <span class="r">$1,609</span> on one roll. How did it get this bad?');
    await sleep(2600);
    spd.textContent = '◀◀ REWIND'; spd.style.background = '#3a6ea5'; spd.style.opacity = 1; chapter('Rewinding');
    cap(null); window.__fast = true; vignette(false);
    for (let i = 427; i >= 0; i -= 3) { push(i); updatePanel(i); await sleep(8); }
    for (const k of Object.keys(prevNw)) delete prevNw[k];
    maxSoFar = 2500; push(0); updatePanel(0);
    spd.style.background = ''; spd.style.opacity = 0;
    await sleep(350);
  }
  async function outro() {
    cap(null); chapter(null); spd.style.opacity = 0;
    const maxY = Math.max(...F.map((f) => Math.max(...Object.values(f.nw)))) * 1.05;
    const H = 300; let paths = '';
    for (const p of P) {
      let d = '';
      for (let i = 0; i < N; i += 2) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(H - 4 - (Math.max(0, F[i].nw[p.id]) / maxY) * (H - 10)).toFixed(1)}`;
      d += `L${X(N - 1)},${(H - 4 - (Math.max(0, F[N - 1].nw[p.id]) / maxY) * (H - 10)).toFixed(1)}`;
      paths += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${p.name === 'Volcker' ? 4.5 : 2.6}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }
    const c = card(`<div>
      <div class="kick fade">48 rounds · 878 moves · 4 bankruptcies</div>
      <h1 class="fade" style="animation-delay:.1s">${tok('Volcker')} Volcker wins with <em>$12,033</em>.</h1>
      <p class="fade" style="animation-delay:.4s">The only agent that <b style="color:#fff">never took a loan</b> from the central bank.</p>
      <div class="outroChart fade" style="animation-delay:.6s"><svg viewBox="0 0 400 ${H}" preserveAspectRatio="none" style="width:900px;height:300px"><defs><clipPath id="rev"><rect x="0" y="0" width="0" height="${H}"><animate attributeName="width" from="0" to="400" begin="0.7s" dur="2.4s" fill="freeze" calcMode="spline" keySplines=".3 .1 .2 1" keyTimes="0;1"/></rect></clipPath></defs><g clip-path="url(#rev)">${paths}</g></svg>
        <div class="legend">${P.map((p) => `<span><i style="background:${p.color}"></i>${p.token} ${p.name}</span>`).join('')}</div></div>
      <div class="kick fade" style="animation-delay:1.2s;margin:14px 0 0;color:#cfd8c6;letter-spacing:.22em">MARGIN<span style="color:var(--gold)"> CALL</span> · net worth by round</div></div>`);
    await sleep(6500);
  }

  // ---------------------------------------------------------------- run
  push(COLD); updatePanel(COLD); chapter('Round 28');
  cap('<em>5 AI agents</em> are playing a property game where they can borrow from a central bank.');
  window.__dbg = { push, updatePanel, CUES, intro, outro, cap, stamp };
  window.__ready = true;
  window.__start = async () => {
    await intro();
    for (let i = 0; i < N; i++) {
      push(i); updatePanel(i);
      let hold = 0;
      if (CUES[i]) hold = (await CUES[i]()) || 0;
      await sleep(msPer + hold);
    }
    await sleep(600);
    await outro();
    window.__done = true;
  };
  if (location.hash === '#auto') window.__start();
})();
