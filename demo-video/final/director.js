/* Final cut: "You" vs 4 AI agents (seed 133) in the AI-vs-AI broadcast look. Shows four finance moves as term-sheet
   cards: an equity raise (Keynes), a floating loan hedged with a swap (Volcker) + desk swap, and a CDS + put on Minsky. */
(async () => {
  'use strict';
  const D = await (await fetch('/__frames133.json')).json();
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
  // ---------------------------------------------------------------- deal cards (high-level term sheets)
  const dealBox = el('div'); dealBox.id = 'dDeal'; document.body.appendChild(dealBox);
  const Y = tok('You');
  function deal({ kicker, a, b, rows, foot, signed = false, sep = '⇄' }) {
    dealBox.innerHTML = `<div class="dDealCard ${signed ? 'signed' : ''}">
      <div class="k">${kicker}</div>
      <div class="pt"><span>${a}</span><i>${sep}</i><span>${b}</span></div>
      ${rows.map(([l, r]) => `<div class="rw"><span>${l}</span><b>${r}</b></div>`).join('')}
      <div class="sg">${foot}</div></div>`;
  }
  const dealOff = () => { const d = dealBox.firstElementChild; if (d) { d.classList.add('out'); setTimeout(() => { dealBox.innerHTML = ''; }, 450); } };
  const I = D.info; const TG = D.tags;
  const EQ = { kicker: 'Raising equity · equity-stake contract', a: `${Y} You`, b: `${tok('Keynes')} Keynes`,
    rows: [['Keynes pays', `$${I.equity.up} now`], ['Keynes gets', '20% of your rent income'], ['…and', '20% of your book equity'], ['Term', 'until one of you goes bust']] };
  const SW = { kicker: 'Custom contract · interest-rate swap', a: `${Y} You`, b: `${tok('Volcker')} Volcker`,
    rows: [['You pay', `fixed ${I.hedge.fixed.toFixed(2)}% on $1,200`], ['Volcker pays', 'the policy rate (floating)'], ['Collateral', 'Volcker pledges East Ferry Terminal'], ['Term', '20 rounds, settled every round']] };
  const CR = { kicker: 'Bank desk · betting on a default', a: `${Y} You`, b: `${tok('Minsky')} Minsky`, sep: 'vs',
    rows: [['Minsky’s default risk', `${(I.credit.hazard * 100).toFixed(1)}% a round`], ['Credit default swap', `$${I.credit.cdsPremium}/round → $1,000 if Minsky goes bust`], ['Put option', `30 Minsky shares @ $${I.credit.strike.toFixed(2)} ($${I.credit.putPremium})`], ['On default', 'the put pays the full strike']] };
  // P&L from the recorded log
  const tot = (re) => F.reduce((a, f) => a + f.events.filter((e) => re.test(e.msg)).reduce((x, e) => x + +/\$(\d+)/.exec(e.msg)[1], 0), 0);
  const swapNet = tot(/^(Volcker|Bank) → You: .*(Rate hedge|swap settlement)/) - tot(/^You → (Volcker|Bank): .*(Rate hedge|swap settlement)/);
  const creditNet = tot(/^Bank → You: .*(CDS payout|put pays out)/) - tot(/^You → Bank: .*(CDS premium|put on)/);
  const divs = tot(/^You → Keynes: .*equity dividend/);

  // ---------------------------------------------------------------- the script (frame index → cues)
  const CUES = {
    0: () => { setSpeed(45); chapter('Rounds 1–5 · land grab'); cap('Round 1. Everyone starts with <em>$1,500</em>. The bank lends up to <em>3× leverage</em>.'); },
    58: () => { setSpeed(200); chapter('Round 6 · raising equity'); cap(null); },
    [TG.equity]: () => { deal({ ...EQ, foot: 'Sent to Keynes…' }); cap(`Round 6: you want cash to build. You offer <em>20% of yourself</em> to Keynes.`); return 3600; },
    [TG.equityAccept]: () => { deal({ ...EQ, signed: true, foot: '✓ Signed by Keynes’s AI' }); cap(`Keynes’s AI values the stake and pays <em>$${I.equity.up}</em>.`); return 2200; },
    [TG.equityAccept + 1]: () => { dealOff(); setSpeed(50); chapter('Rounds 7–11'); cap(null); },
    146: () => { setSpeed(200); chapter('Round 12 · the hedge'); },
    [TG.borrow]: () => { cap(`${Y} You borrow <em>$2,000</em> at a <em>floating</em> rate…`); return 2000; },
    [TG.propose]: () => { deal({ ...SW, foot: 'Sent to Volcker…' }); cap('…and hedge it with a custom <em>interest-rate swap</em> with Volcker.'); return 3600; },
    [TG.accept]: () => { deal({ ...SW, signed: true, foot: '✓ Signed by Volcker’s AI' }); cap('Volcker’s AI prices the deal and <em>signs</em>.'); return 1900; },
    [TG.desk]: () => { dealOff(); stamp('🏛', 'Bank desk · round 12', `Pay fixed ${I.hedge.deskFixed.toFixed(2)}% on $800`, 'and receive the policy rate', 'gold'); cap('Plus a swap with the bank’s desk. Your loan is fully <em>hedged</em>.'); return 2400; },
    [TG.desk + 1]: () => { setSpeed(110); chapter('Round 13'); cap(null); },
    207: () => { cap(`The catch: Keynes now takes <span class="r">20% of every rent</span> you collect.`); return 2000; },
    208: () => { setSpeed(200); chapter('Round 14 · betting on a default'); },
    [TG.cds]: () => { deal({ ...CR, signed: true, foot: '✓ Bought from the central bank’s desk' }); cap(`${tok('Minsky')} Minsky looks shaky. You buy <em>credit protection</em> and a <em>put</em>.`); return 4200; },
    [TG.put + 1]: () => { dealOff(); setSpeed(65); chapter('Rounds 15–20 · rates climb'); hlRate(true); cap(null); },
    296: () => { stamp('🔨', 'Forced liquidation · round 19', 'The bank seizes Minsky’s assets', 'Margin call not met', 'red'); return 1500; },
    [F.findIndex((f) => f.events.some((e) => /CDS payout/.test(e.msg)))]: () => { stamp(tok('Minsky'), 'Bankruptcy · round 20', 'Minsky is out', 'Your CDS pays $1,000 · your put pays $129', 'gold'); vignette(true); cap('Minsky goes bust. Your CDS and put pay out <span class="g">+$1,129</span>.'); return 3200; },
    333: () => { vignette(false); setSpeed(90); chapter('Rounds 21–25 · margin calls'); cap(null); },
    357: () => { cap('Rates keep climbing. Now your swaps pay <span class="g">you</span> every round.'); return 1300; },
    386: () => cap(null),
    388: () => { cap(`${tok('Hayek')} Hayek borrows at <span class="r">5.95%</span>…`); return 600; },
    397: () => { stamp(tok('Hayek'), 'Margin call · round 23', 'Hayek is over the limit', `${fmt(debt(397, 'Hayek'))} of bank debt`, 'red'); vignette(true); return 1600; },
    398: () => { vignette(false); cap(null); },
    453: () => { cap(`${tok('Keynes')} Keynes lands on your Crown Point: <span class="r">−$2,632</span>…`); return 900; },
    461: () => { cap('…and borrows at <span class="r">7.45%</span> to pay it.'); return 1300; },
    463: () => { stamp(tok('Hayek'), 'Bankruptcy · round 25', 'Hayek is out', 'Volcker is margin-called the same turn', 'grey'); vignette(true); cap(null); return 2400; },
    464: () => { vignette(false); hlRate(false); setSpeed(80); chapter('Rounds 26–29 · endgame'); },
    488: () => { stamp(tok('Keynes'), 'Margin call · round 26', 'Keynes is over the limit', `${fmt(debt(488, 'Keynes'))} of bank debt at up to 7.45%`, 'red'); vignette(true); return 1600; },
    489: () => vignette(false),
    504: () => setSpeed(200),
    505: () => { stamp('📜', 'Default · round 28', 'Volcker defaults on your swap', 'Collateral seized: East Ferry Terminal is yours', 'gold'); cap('Volcker misses a swap payment. The <em>collateral clause</em> kicks in.'); return 3000; },
    506: () => { setSpeed(80); cap(null); },
    536: () => { stamp(tok('Keynes'), 'Bankruptcy · round 28', 'Keynes is out', 'The 20% stake he bought in you ends with him', 'grey'); vignette(true); return 2600; },
    537: () => { vignette(false); setSpeed(140); },
    [N - 1]: () => { cap(`${tok('Volcker')} Volcker goes bust. <em>${Y} You win.</em>`); return 3000; },
  };

  // ---------------------------------------------------------------- intro / outro
  const card = (html) => { const c = el('div', 'dCard', html); document.body.appendChild(c); return c; };
  // Cold open: round 25, rates at 4.5%, the AIs are going under; then rewind to round 1.
  const COLD = 452;
  async function intro() {
    chapter('Round 25'); spd.style.opacity = 0;
    for (let i = COLD; i <= 463; i++) { push(i); updatePanel(i); await sleep(i === 453 ? 900 : 230); }
    stamp(tok('Hayek'), 'Bankruptcy · round 25', 'Hayek is out', 'Volcker is margin-called the same turn', 'grey'); vignette(true);
    cap('Rates hit <span class="r">4.5%</span>. The AIs are going under. You’re <em>up</em>. How?');
    await sleep(3200); vignette(false);
    spd.textContent = '◀◀ REWIND'; spd.style.background = '#3a6ea5'; spd.style.opacity = 1; chapter('Rewinding');
    cap(null); window.__fast = true;
    for (let i = 463; i >= 0; i -= 3) { push(i); updatePanel(i); await sleep(8); }
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
    const chip = (icon, label, val, cls) => `<span class="ch ${cls}"><i>${icon}</i><small>${label}</small><b>${val}</b></span>`;
    const c = card(`<div>
      <div class="kick fade">${F[N - 1].round} rounds · rates ${I.hedge.rate0.toFixed(2)}% → ${Math.max(...F.map((f) => f.rate)).toFixed(2)}% · 4 AI agents bankrupt</div>
      <h1 class="fade" style="animation-delay:.1s;margin-bottom:14px">${Y} You win with <em>${fmt(you.netWorth)}</em>.</h1>
      <div class="chips4 fade" style="animation-delay:.35s">
        ${chip('📈', 'Rate swaps', `+${fmt(swapNet)}`, 'g')}
        ${chip('🛡', 'CDS + put, net', `+${fmt(creditNet)}`, 'g')}
        ${chip('📜', 'Collateral seized', 'East Ferry Terminal', 'g')}
        ${chip('🧾', 'Equity: raised $' + I.equity.up, `−${fmt(divs)} dividends`, 'r')}</div>
      <div class="outroChart fade" style="animation-delay:.6s;margin-top:12px"><svg class="dReveal" viewBox="0 0 400 ${HH}" preserveAspectRatio="none" style="width:900px;height:250px">${paths}</svg>
        <div class="legend">${P.map((p) => `<span><i style="background:${p.color}"></i>${p.token} ${p.name}</span>`).join('')}</div></div>
      <div class="kick fade" style="animation-delay:1.2s;margin:14px 0 0;color:#cfd8c6;letter-spacing:.22em">MARGIN<span style="color:var(--gold)"> CALL</span> · loans · swaps · equity · options · CDS · margin calls</div></div>`);
    await sleep(6500);
  }

  // ---------------------------------------------------------------- run
  push(COLD); updatePanel(COLD); chapter('Round 25');
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
