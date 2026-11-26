'use strict';
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (x, y) => {
  const mx = mean(x); const my = mean(y); let n = 0; let dx = 0; let dy = 0;
  for (let k = 0; k < x.length; k++) { n += (x[k] - mx) * (y[k] - my); dx += (x[k] - mx) ** 2; dy += (y[k] - my) ** 2; }
  return dx && dy ? n / Math.sqrt(dx * dy) : 0;
};

// Ordinary least squares R^2 of y on columns X (adds intercept).
function r2(X, y) {
  const n = y.length; const k = X[0].length + 1;
  const A = Array.from({ length: k }, () => Array(k).fill(0)); const b = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    for (let p = 0; p < k; p++) { b[p] += row[p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q]; }
  }
  for (let p = 0; p < k; p++) A[p][p] += 1e-9;
  // Gaussian elimination
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue; const f = A[r][c] / A[c][c];
      for (let q = c; q < k; q++) A[r][q] -= f * A[c][q]; b[r] -= f * b[c];
    }
  }
  const beta = b.map((v, i) => v / A[i][i]);
  const my = mean(y); let ss = 0; let st = 0;
  for (let i = 0; i < n; i++) { const yh = beta[0] + X[i].reduce((a, v, j) => a + v * beta[j + 1], 0); ss += (y[i] - yh) ** 2; st += (y[i] - my) ** 2; }
  return 1 - ss / st;
}

// Skill-detection metrics for a lineup split into side X (skilled) and side Y.
// Per game D = mean NW share of X seats - mean NW share of Y seats. Cohen's d = mean(D)/sd(D).
// n80 = games needed to detect the gap with 80% power at 5% two-sided significance.
function gap(results, xName, yName) {
  const D = []; let xWins = 0; let n = 0;
  for (const r of results) {
    const xs = r.players.filter((p) => p.agent === xName); const ys = r.players.filter((p) => p.agent === yName);
    if (!xs.length || !ys.length) continue;
    D.push(mean(xs.map((p) => p.share)) - mean(ys.map((p) => p.share)));
    const w = r.players.find((p) => p.win);
    if (w && w.agent === xName) xWins++;
    n++;
  }
  const m = mean(D); const s = sd(D); const d = s > 0 ? m / s : 0;
  const nx = results[0] ? results[0].players.filter((p) => p.agent === xName).length : 0;
  return {
    n, meanGap: m, d, n80: d > 0 ? Math.ceil(7.85 / (d * d)) : Infinity,
    xWinRate: xWins / n, xWinBase: nx / (results[0] ? results[0].players.length : 1),
    rounds: mean(results.map((r) => r.rounds)),
  };
}

module.exports = { mean, sd, corr, r2, gap };
