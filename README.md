# Margin Call — a levered property-trading game

A browser-based multiplayer board game for 2–8 players on the same network.
It plays by the **traditional property-trading rules** (40-space board, colour groups,
houses and hotels, mortgages, jail, cards, auctions, trading, bankruptcy) and adds a
**central bank**, a **macro-economy** and **player-to-player financial contracts**.

Board names and branding are original.

## Run it

```bash
npm install
npm start            # serves on 0.0.0.0:3000 (PORT=xxxx to change)
```

The server prints its network address, for example `http://192.168.1.20:3000`. Everyone on
the same Wi-Fi or LAN opens that URL. One player clicks **Create a new room** and the others
join with the 4-letter room code. Refreshing or reconnecting resumes your seat.

```bash
npm test             # rules engine tests + randomised full-game fuzzing
```

## Traditional rules (implemented)

| Rule | Implementation |
|---|---|
| Start | Every player gets the starting cash (default $1,500, configurable) |
| Movement | Roll 2d6. Doubles roll again; three doubles in a row → Lockup (jail) |
| PAYDAY (GO) | Collect salary when passing or landing |
| Buying | Buy an unowned property at list price, or decline and it is **auctioned** (optional) |
| Rent | Streets: base rent, doubled for a full unimproved group, 1–4 houses / hotel table. Transit: 25/50/100/200. Utilities: 4× or 10× dice |
| Building | Full group, nothing in the group mortgaged, build evenly. Bank has 32 houses and 12 hotels. Sell back at half |
| Mortgages | Mortgage for half value; lift for +10%. No rent while mortgaged; group must have no buildings |
| Lockup | Pay bail, use a get-out card, or roll doubles. After the 3rd failed roll, pay and move |
| Cards | *Market Event* (≈ Chance) and *Town Treasury* (≈ Community Chest), plus macro-shock cards |
| Trading | Property, cash and get-out cards, any time. No buildings in the traded group |
| Bankruptcy | Can't get back to $0 cash → bankrupt. Assets return to the bank. Last player standing wins, or the host ends the game and the highest net worth wins |

## The central bank (leverage)

- **Fixed or floating loans.** Borrow any time for 5, 10 or 20 rounds. Interest is charged every round and principal is due at maturity. If you can't repay, the loan rolls over for 5 rounds at +2%.
  - **Floating:** policy rate + 0.25% + credit spread, reset every round.
  - **Fixed:** max(yield curve, floating base) + a lock-in premium (0.25% / 0.35% / 0.5% for 5 / 10 / 20 rounds) + credit spread. Locked for the term, and always more expensive than floating at signing.
- **Yield curve.** `rate(term) = w·policy + (1−w)·(neutral + target inflation) + term premium`, where `w = 5/term`. Short money tracks the policy rate and long money is anchored, so the curve inverts when the bank is hiking.
- **Credit spread.** +0.5% per unit of leverage (assets ÷ equity) after the new loan.
- **Leverage cap.** Bank debt ≤ (cap − 1) × book equity. The host picks the cap in the lobby: 1× disables borrowing, 3× is the default.
- **Margin call.** If losses push you over the cap you are flagged. Fix it before you end your turn, or the bank seizes cash, sells buildings and mortgages property until you are back under the cap.

## The economy

At the end of every round:

```
velocity      = spending this round ÷ money supply        (50 ≈ 6% per round)
credit growth = Δ bank credit ÷ money supply              (50 = no change)
credit level  = bank credit ÷ money supply
development   = share of houses/hotels in use
heat  = ½·heat_prev + ½·(0.45·velocity + 0.25·creditGrowth + 0.15·creditLevel + 0.15·development + shocks)
inflation (%/round) = 0.5 + 0.04·(heat − 50) + noise
price level ×= (1 + inflation)
policy rate → Taylor rule: neutral 1.5 + π + 0.5·(π − 0.5) + 0.02·(heat − 50), smoothed and rounded to 25bp
fiscal rule: heat < 30 → stimulus (salary +25%); heat > 75 → surtax (taxes +50%)
```

"Spending" counts purchases, building, rent, taxes, fines and card payments.

The **price level** scales property prices, building costs, rents, salary, taxes and card
amounts. Loans and contracts stay **nominal**: inflation erodes debt, which rewards borrowers
and hurts lenders, and deflation does the reverse. Some cards are macro shocks: rate hikes and
cuts, an oil shock, a tech boom, austerity, or fiscal stimulus.

## The bank desk

Players can trade instruments with the central bank as counterparty (Bank Desk tab). You can't trade instruments on yourself.

| Product | How it works |
|---|---|
| Shares | Each player is split into 100 shares priced at book equity ÷ 100, re-marked at the start of every round. Buy at the mark + 3%, sell at the mark − 3%. Max 50 shares of one player. Worthless if they go bankrupt |
| Call / put options | On a rival's shares, any strike, 5/10/20 rounds. Premium = Black-Scholes using that player's measured volatility, + 15%. Cash-settled any time; auto-exercised at expiry. A put pays the full strike if the player goes bankrupt |
| Credit default swap | Pay a premium every round; the bank pays the notional if the named player goes bankrupt. Premium = notional × default risk × 1.3, where default risk comes from leverage, cash and the worst rent on the board |
| Rent insurance | Pay a premium every round; the bank pays 80% of any single rent above your deductible ($100/$250/$500), up to $1,500. Priced from the rents on the board when you buy |
| Rate swap | Pay fixed and receive the policy rate (or the reverse) on a notional, settled every round. Close early at mark-to-market − 1% |

Desk positions count toward net worth but not toward your borrowing limit. Share prices are re-marked only once a round, so a single trade can't pump a price.

## AI players

The host can add up to 7 AI players in the lobby. They act through the same rule engine as humans:
- value property by its role in colour groups and how often each space is landed on
- keep a cash reserve sized to the rents ahead of them
- build where the return is best and borrow to build when that return beats the loan rate
- hold at four houses when the bank runs short
- bid to their valuation in auctions and haggle for set-completing trades
- price contracts by discounted cash flows and counterparty risk
- buy rent insurance when the board turns dangerous

In tests, two AI players beat two casual players in 23 of 24 four-player games.

## Player-to-player financial contracts

Each contract is a set of clauses between two players. Periodic legs are **netted and settled
at the start of each round**.

| Clause | Effect |
|---|---|
| Upfront payment | Cash at signing |
| Fixed payment | $X every round |
| Interest leg | Notional × fixed rate, or × (policy rate + spread), every round |
| Rent share | X% of rent the payer collects on chosen properties (or all), paid instantly |
| Equity stake | Holder receives X% of the issuer's rent income and X% of the issuer's book equity in net worth |
| Maturity payment | Paid when the term ends |
| Credit-event payment | Paid if a reference player goes bankrupt |
| Call / put option | Holder may buy (call) or sell (put) a property at the strike, any time during the term |
| Collateral | Pledged property can't be traded. If the pledger is short on any payment in this contract, they **default** and the collateral transfers |

Built-in templates: **bond**, **secured loan**, **interest-rate swap**, **rent swap**
(total-return style), **equity investment**, **call option**, **put option**,
**credit default swap**, and **custom**.

When a player goes bankrupt:
- CDS contracts referencing them pay out.
- Their pledged collateral goes to the counterparty.
- Their other contracts are void.

## Layout

```
server.js          HTTP + WebSocket server, rooms, reconnection
src/board.js       board data
src/cards.js       card decks
src/engine.js      authoritative rules engine (traditional rules, central bank, economy, contracts)
src/desk.js        bank desk (shares, options, CDS, insurance, swaps)
src/pricing.js     shared pricing (Black-Scholes etc.), used by server and browser
src/bot.js         AI players
public/            browser client (vanilla JS, no build step)
test/              node:test suite incl. randomised full-game fuzzing
```
