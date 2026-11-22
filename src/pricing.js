// Shared pricing for the bank trading desk. Loaded by the server (require) and the browser (window.Pricing)
// so client-side quote previews match server-side prices exactly.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DESK = {
    sharesOutstanding: 100, // each player's balance sheet is split into 100 notional shares
    shareSpread: 0.03,      // bank buys at -3%, sells at +3% of the round's marked price
    maxSharesPerName: 50,
    optionMargin: 0.15,     // bank's load over Black-Scholes fair value
    minPremium: 5,
    cdsLoad: 1.3,           // premium = notional x hazard x load, per round
    insuranceLoad: 1.3,
    insuranceCoverage: 0.8,
    insuranceCap: 1500,
    landingProb: 0.03,      // rough chance a given space is hit by you in one round
    swapSpread: 0.1,        // % per round either side of the curve
    terms: [5, 10, 20],
    deductibles: [100, 250, 500],
    maxPositions: 12,
  };

  // Abramowitz & Stegun 26.2.17, |error| < 7.5e-8
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // Black-Scholes on a per-round clock: T in rounds, r and vol per round.
  function blackScholes(kind, S, K, T, r, vol) {
    const intrinsic = Math.max(0, kind === 'call' ? S - K : K - S);
    if (T <= 0 || vol <= 0 || S <= 0) return intrinsic;
    if (K <= 0) return kind === 'call' ? S : 0;
    const sq = vol * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / sq;
    const d2 = d1 - sq;
    const disc = Math.exp(-r * T);
    return kind === 'call' ? S * normCdf(d1) - K * disc * normCdf(d2) : K * disc * normCdf(-d2) - S * normCdf(-d1);
  }

  function optionPremium(kind, S, K, T, ratePct, vol, shares) {
    const fair = blackScholes(kind, S, K, T, ratePct / 100, vol) * shares;
    return Math.max(DESK.minPremium, Math.round(fair * (1 + DESK.optionMargin)));
  }

  const cdsPremium = (notional, hazard) => Math.max(1, Math.round(notional * hazard * DESK.cdsLoad));
  const shareAsk = (price, shares) => Math.ceil(price * shares * (1 + DESK.shareSpread));
  const shareBid = (price, shares) => Math.floor(price * shares * (1 - DESK.shareSpread));

  // The desk deals at the WORSE of the round's mark and the live book-equity price for the customer.
  // Neither stale news (live moved, mark hasn't) nor an intra-round pump (live pushed, then reversed) pays.
  //   'ask': the higher price, used when the customer pays for upside (buying shares or a call, closing a put)
  //   'bid': the lower price, used when the customer is paid for upside (selling shares, closing a call, buying a put)
  const dealPrice = (mark, live, side) => (side === 'ask' ? Math.max(mark, live) : Math.min(mark, live));
  const TERM_PREMIUM = { 5: 0.25, 10: 0.5, 20: 1.0 };

  return { DESK, normCdf, blackScholes, optionPremium, cdsPremium, shareAsk, shareBid, dealPrice, TERM_PREMIUM };
}));
