/* Combined demo: "You" vs 4 AI agents. Same broadcast look as the AI-vs-AI cut, plus the hedge: at round 12 You
   borrows floating and hedges it with a swap with Hayek (shown as a term-sheet card) and a desk swap. */
(async () => {
  'use strict';
  const D = await (await fetch('/__frames81.json')).json();
  const F = D.frames; const N = F.length;
  const P = D.players; const byName = Object.fromEntries(P.map((p) => [p.name, p]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const tok = (n) => byName[n].token;

  // ---------------------------------------------------------------- boot the real client
  __ws.onmessage({ data: JSON.stringify({ type: 'joined', playerId: D.me, code: 'DEMO', token: 'x', board: D.board }) });
  const push = (i) => __ws.onmessage({ data: JSON.stringify({ type: 'state', state: F[i].state }) });

  // ---------------------------------------------------------------- right panel
  const panel = el('div', '', ''); panel.id = 'dPanel';
  panel.innerHTML = `<div class="hd"><span class="logo tiny">MARGIN<span>CALL</span></span><span class="rd">You vs 4 AI · Round <b id="dRound">1</b></span></div>
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
      const badge = p.bankrupt ? '<span class="dBadge dB-bk">☠ bankrupt</span>' : p.marginCall ? '<span class="dBadge dB-mc">margin call</span>' : p.id === D.me && i >= D.tags.accept ? '<span class="dBadge dB-hedge">🛡 hedged</span>' : p.inJail ? '<span class="dBadge dB-jail">lockup</span>' : '';
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
    $('#dNwC h5 b').textContent = leader ? `${leader.token} ${leader.name} ${leader.id === D.me ? "lead" : "leads"}` : '';
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

  // ---------------------------------------------------------------- the script (frame index → cues)
  // ---------------------------------------------------------------- the deal card (high-level term sheet)
  const dealBox = el('div'); dealBox.id = 'dDeal'; document.body.appendChild(dealBox);
  const Y = tok('You'); const H = tok('Hayek');
  function deal(signed) {
    dealBox.innerHTML = `<div class="dDealCard ${signed ? 'signed' : ''}">
      <div class="k">Custom contract · interest-rate swap</div>
      <div class="pt"><span>${Y} You</span><i>⇄</i><span>${H} Hayek</span></div>
      <div class="rw"><span>You pay</span><b>fixed 2.80% on $1,200</b></div>
      <div class="rw"><span>Hayek pays</span><b>the policy rate (floating)</b></div>
      <div class="rw"><span>Collateral</span><b>Hayek pledges Harbour Walk</b></div>
      <div class="rw"><span>Term</span><b>20 rounds, settled every round</b></div>
      <div class="sg">${signed ? '✓ Signed by Hayek’s AI' : 'Sent to Hayek…'}</div></div>`;
  }
  const dealOff = () => { const d = dealBox.firstElementChild; if (d) { d.classList.add('out'); setTimeout(() => { dealBox.innerHTML = ''; }, 450); } };

  // ---------------------------------------------------------------- the script (frame index → cues)
  const CUES = {
    0: () => { setSpeed(45); chapter('Rounds 1–11 · land grab'); cap('Round 1. Everyone starts with <em>$1,500</em>. The bank lends up to <em>3× leverage</em>.'); },
    95: () => cap(null),
    146: () => { setSpeed(200); chapter('Round 12 · the hedge'); },
    [D.tags.borrow]: () => { cap(`${Y} You borrow <em>$2,000</em> at a <em>floating</em> rate to build.`); return 2300; },
    [D.tags.propose]: () => { deal(false); cap('Then hedge it with a custom <em>interest-rate swap</em> with Hayek.'); return 3600; },
    [D.tags.accept]: () => { deal(true); cap('Hayek’s AI prices the deal and <em>signs</em>.'); return 2400; },
    [D.tags.desk]: () => { dealOff(); stamp('🏛', 'Bank desk · round 12', 'Pay fixed 2.04% on $800', 'and receive the policy rate', 'gold'); cap('Plus a swap with the central bank’s desk. Your whole loan is <em>hedged</em>.'); return 2600; },
    [D.tags.desk + 1]: () => { setSpeed(55); chapter('Rounds 13–21'); cap('While rates stay low, the hedge costs you a little each round…'); },
    240: () => cap(null),
    296: () => { setSpeed(110); chapter('Rounds 22–25 · rates climb'); hlRate(true); },
    311: () => { cap('Then the economy overheats. The policy rate climbs <span class="r">2% → 5%</span>.'); return 600; },
    337: () => { cap(`The AIs keep borrowing: ${tok('Keynes')} Keynes at <span class="r">4.35%</span>…`); return 700; },
    349: () => { cap(`…${tok('Volcker')} Volcker at <span class="r">4.90%</span>.`); return 700; },
    357: () => { cap(`Now your swaps pay <span class="g">you</span>: up to <span class="g">$40</span> a round.`); return 1500; },
    358: () => setSpeed(90),
    398: () => { stamp(tok('Volcker'), 'Bankruptcy · round 25', 'Volcker is out', 'First AI eliminated', 'grey'); vignette(true); cap(null); return 2000; },
    399: () => vignette(false),
    402: () => { cap(`${H} Hayek lands on your Crown Point: <span class="r">−$2,438</span>.`); return 1300; },
    412: () => { stamp(H, 'Bankruptcy · round 26', 'Hayek is out, mid-contract', 'The swap’s collateral, Harbour Walk, passes to you', 'grey'); vignette(true); cap('The <em>collateral clause</em> kicks in: Harbour Walk is yours.'); return 3200; },
    413: () => { vignette(false); hlRate(false); setSpeed(110); chapter('Rounds 26–32 · margin calls'); cap(null); },
    436: () => { cap(`${tok('Minsky')} Minsky borrows at <span class="r">6.45%</span>…`); return 600; },
    441: () => { stamp(tok('Minsky'), 'Margin call · round 27', 'Minsky is over the limit', `${fmt(debt(441, 'Minsky'))} of bank debt at up to 6.45%`, 'red'); vignette(true); return 1800; },
    442: () => { vignette(false); cap(null); },
    448: () => { cap(`${tok('Keynes')} Keynes lands on Crown Point too (<span class="r">−$2,530</span>)…`); return 900; },
    449: () => { cap('…and borrows <span class="r">$2,639 at 6.25%</span> to cover it.'); return 1500; },
    450: () => { setSpeed(70); cap(null); },
    484: () => { stamp('🔨', 'Forced liquidation · round 30', 'The bank seizes Minsky’s assets', 'Margin call not met', 'red'); return 1600; },
    516: () => { stamp(tok('Minsky'), 'Bankruptcy · round 32', 'Minsky is out', 'One AI left: Keynes', 'grey'); vignette(true); return 2000; },
    517: () => { vignette(false); setSpeed(110); chapter('Rounds 33–35 · endgame'); },
    538: () => { cap(`${tok('Keynes')} Keynes hits Crown Point again and borrows another <span class="r">$2,495</span>.`); return 1400; },
    539: () => { cap(null); setSpeed(90); },
    560: () => { stamp(tok('Keynes'), 'Margin call · round 34', 'Keynes is over the limit', `${fmt(debt(560, 'Keynes'))} of bank debt`, 'red'); vignette(true); return 1800; },
    561: () => { vignette(false); setSpeed(45); },
    598: () => setSpeed(160),
    602: () => { stamp('🔨', 'Forced liquidation · round 35', 'The bank seizes Keynes’s assets', 'Margin call not met', 'red'); return 1600; },
    603: () => setSpeed(160),
    [N - 1]: () => { cap(`${tok('Keynes')} Keynes goes bust. <em>${Y} You win.</em>`); return 3000; },
  };

  // ---------------------------------------------------------------- intro / outro
  const card = (html) => { const c = el('div', 'dCard', html); document.body.appendChild(c); return c; };
  // Cold open: round 27, rates at 4.75%, an AI gets margin-called; then rewind to round 1.
  const COLD = 434;
  async function intro() {
    chapter('Round 27'); spd.style.opacity = 0;
    for (let i = COLD; i <= 441; i++) { push(i); updatePanel(i); await sleep(i === 441 ? 200 : 320); }
    stamp(tok('Minsky'), 'Margin call · round 27', 'Minsky is over the limit', 'Rates are at 4.75% and climbing', 'red'); vignette(true);
    cap('Rates hit <span class="r">4.75%</span>. The AIs are getting <span class="r">margin-called</span>. You’re <em>hedged</em>. How?');
    await sleep(3200); vignette(false);
    spd.textContent = '◀◀ REWIND'; spd.style.background = '#3a6ea5'; spd.style.opacity = 1; chapter('Rewinding');
    cap(null); window.__fast = true;
    for (let i = 441; i >= 0; i -= 3) { push(i); updatePanel(i); await sleep(8); }
    for (const k of Object.keys(prevNw)) delete prevNw[k];
    maxSoFar = 2500; push(0); updatePanel(0);
    spd.style.background = ''; spd.style.opacity = 0;
    await sleep(350);
  }
  async function outro() {
    cap(null); chapter(null); spd.style.opacity = 0;
    const maxY = Math.max(...F.map((f) => Math.max(...Object.values(f.nw)))) * 1.05;
    const HH = 300; let paths = '';
    for (const p of P) {
      let d = '';
      for (let i = 0; i < N; i += 2) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(HH - 4 - (Math.max(0, F[i].nw[p.id]) / maxY) * (HH - 10)).toFixed(1)}`;
      d += `L${X(N - 1)},${(HH - 4 - (Math.max(0, F[N - 1].nw[p.id]) / maxY) * (HH - 10)).toFixed(1)}`;
      paths += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${p.id === D.me ? 4.5 : 2.6}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }
    const you = F[N - 1].state.players.find((p) => p.id === D.me);
    const c = card(`<div>
      <div class="kick fade">${F[N - 1].round} rounds · rates ${Math.min(...F.map((f) => f.rate)).toFixed(2)}% → ${Math.max(...F.map((f) => f.rate)).toFixed(2)}% · 4 AI agents bankrupt</div>
      <h1 class="fade" style="animation-delay:.1s">${Y} You win with <em>${fmt(you.netWorth)}</em>.</h1>
      <p class="fade" style="animation-delay:.4s">The only player who <b style="color:#fff">hedged their rate</b>, with a swap the AI priced and signed.</p>
      <div class="outroChart fade" style="animation-delay:.6s"><svg viewBox="0 0 400 ${HH}" preserveAspectRatio="none" style="width:900px;height:300px"><defs><clipPath id="rev"><rect x="0" y="0" width="0" height="${HH}"><animate attributeName="width" from="0" to="400" begin="0.7s" dur="2.4s" fill="freeze" calcMode="spline" keySplines=".3 .1 .2 1" keyTimes="0;1"/></rect></clipPath></defs><g clip-path="url(#rev)">${paths}</g></svg>
        <div class="legend">${P.map((p) => `<span><i style="background:${p.color}"></i>${p.token} ${p.name}</span>`).join('')}</div></div>
      <div class="kick fade" style="animation-delay:1.2s;margin:14px 0 0;color:#cfd8c6;letter-spacing:.22em">MARGIN<span style="color:var(--gold)"> CALL</span> · loans · swaps · options · CDS · margin calls</div></div>`);
    await sleep(6500);
  }

  // ---------------------------------------------------------------- run
  push(COLD); updatePanel(COLD); chapter('Round 27');
  cap('<em>You vs 4 AI agents</em> in a property game where everyone can borrow from a central bank.');
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
