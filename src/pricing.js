// Shared pricing for the bank trading desk. Loaded by the server (require) and the browser (window.Pricing)
// so client-side quote previews match server-side prices exactly.
//
// The bank is a market maker: it quotes a fair value from the board, then adds a spread it keeps.
// Every price below is "fair value +/- the bank's edge"; where fair value can't be estimated
// (a player in distress, a $0 share price) the bank widens the spread or refuses to trade.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DESK = {
    insiderShares: 100,     // shares each player owns at the start
    floatShares: 25,        // extra shares per player held by the bank at the start, buyable by others
    shareSpread: 0.03,      // base spread each way on shares
    scarcityPremium: 0.15,  // ask rises by up to +15% as the bank's inventory of a name runs out
    inventoryDiscount: 0.04,// bid falls by up to -4% the more of a name the bank already holds
    distressDiscount: 2,    // bid falls by 2 x the player's per-round default risk
    issueDiscount: 0.06,    // new shares are bought by the bank at -6% ...
    issueImpact: 0.25,      // ... and a further -25% x (shares issued / shares outstanding)
    maxIssuePerRound: 25,
    maxIssuedTotal: 100,
    maxSharesPerName: 50,   // one player may hold at most this many shares of another
    optionSpread: 0.10,     // options sold at fair x 1.10, bought back at fair x 0.90
    maxOptionSharesPerName: 100, // bank's total open option exposure per reference player
    minPremium: 5,
    cdsLoad: 1.3,           // premium = notional x hazard x load, per round, fixed at inception
    cdsMaxHazard: 0.2,      // no new protection on a player this close to default
    issueMaxHazard: 0.12,   // no new equity from a player this close to default
    optionMaxHazard: 0.25,
    insuranceLoad: 1.25,    // premium = expected covered rent this round x load
    insuranceMin: 3,
    insuranceCoverage: 0.8,
    insuranceCap: 1500,
    swapSpread: 0.1,        // % per round either side of the forward curve
    terms: [5, 10, 20],
    deductibles: [100, 250, 500],
    maxPositions: 12,
    loanPrepayFee: 0.005,   // early repayment of a fixed loan: market value + 0.5% of the principal repaid
    maxShortPerName: 25,    // one player may be short at most this many shares of another
    shortFeeBase: 0.005,    // stock-borrow fee per round: 0.5% of the position's value ...
    shortFeeHazard: 0.5,    // ... plus 0.5 x the name's per-round default risk
    axeShareDiscount: 0.02, // bank sells excess inventory below its mark
    axeRiskDiscount: 0.03,  // ... a bit more when the name is getting riskier
    axeCdsRate: 1.15,       // bank buys protection back at notional x hazard x 1.15 (it sells at 1.3)
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

  // Options here can be exercised any time (American), so fair value is never below exercise value.
  // (A deep in-the-money European put is worth less than intrinsic; using that would let a player buy
  // at the ask and immediately sell back above it.)
  const fairOption = (kind, S, K, T, ratePct, vol, shares) =>
    Math.max(blackScholes(kind, S, K, T, ratePct / 100, vol), Math.max(0, kind === 'call' ? S - K : K - S)) * shares;
  // What the bank charges to sell you an option.
  const optionAsk = (kind, S, K, T, ratePct, vol, shares) =>
    Math.max(DESK.minPremium, Math.round(fairOption(kind, S, K, T, ratePct, vol, shares) * (1 + DESK.optionSpread)));
  // What the bank pays to buy an option back: fair value less the spread, never below what exercising pays.
  const optionBid = (kind, S, K, T, ratePct, vol, shares) => {
    const intrinsic = Math.max(0, kind === 'call' ? S - K : K - S) * shares;
    return Math.floor(Math.max(intrinsic, fairOption(kind, S, K, T, ratePct, vol, shares) * (1 - DESK.optionSpread)));
  };

  // Shares. outside = float + issued shares (everything not held by the player themselves);
  // inv = how many of those the bank still holds.
  function shareAskCost(price, n, inv, outside) {
    let c = 0;
    for (let k = 0; k < n; k++) c += price * (1 + DESK.shareSpread + DESK.scarcityPremium * (1 - (inv - k) / Math.max(1, outside)));
    return Math.ceil(c);
  }
  function shareBidProceeds(price, n, inv, outside, hazard) {
    let c = 0;
    for (let k = 0; k < n; k++) {
      const cut = DESK.shareSpread + DESK.inventoryDiscount * ((inv + k) / Math.max(1, outside)) + DESK.distressDiscount * (hazard || 0);
      c += price * Math.max(0.2, 1 - cut);
    }
    return Math.floor(c);
  }
  function issueProceeds(price, n, outstanding, hazard) {
    const unit = price * (1 - DESK.issueDiscount - DESK.issueImpact * (n / Math.max(1, outstanding)) - 3 * (hazard || 0));
    return Math.max(0, Math.floor(unit * n));
  }

  const cdsPremium = (notional, hazard) => Math.max(1, Math.round(notional * hazard * DESK.cdsLoad));

  // Probability of landing on each space during one turn from `pos`: the first roll, plus the second
  // move after doubles (third roll ignored; cards and Lockup ignored).
  function turnLanding(pos) {
    const p = new Array(40).fill(0);
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
      const s1 = (pos + a + b) % 40;
      p[s1] += 1 / 36;
      if (a === b) for (let c = 1; c <= 6; c++) for (let d = 1; d <= 6; d++) p[(s1 + c + d) % 40] += 1 / 36 / 36;
    }
    return p;
  }

  // The desk deals at the WORSE of the round's mark and the live price for the customer.
  // Neither stale news (live moved, mark hasn't) nor an intra-round pump (live pushed, then reversed) pays.
  //   'ask': the higher price, used when the customer pays for upside (buying shares or a call, covering a short, closing a put)
  //   'bid': the lower price, used when the customer is paid for upside (selling or shorting shares, closing a call, buying a put)
  const dealPrice = (mark, live, side) => (side === 'ask' ? Math.max(mark, live) : Math.min(mark, live));
  const TERM_PREMIUM = { 5: 0.25, 10: 0.5, 20: 1.0 };

  // Older names, kept so existing callers (e.g. sim/) still work.
  const optionPremium = optionAsk;
  const shareAsk = (price, shares) => Math.ceil(price * shares * (1 + DESK.shareSpread));
  const shareBid = (price, shares) => Math.floor(price * shares * (1 - DESK.shareSpread));

  return {
    DESK, normCdf, blackScholes, fairOption, optionAsk, optionBid, shareAskCost, shareBidProceeds, issueProceeds,
    cdsPremium, turnLanding, dealPrice, TERM_PREMIUM, optionPremium, shareAsk, shareBid,
  };
}));
