# Margin Call — a levered property-trading game

A browser-based multiplayer board game for 2–8 players, on the same network or
[online](#play-online-with-friends).
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

## Play online with friends

It's already a web game: one Node server holds the game and everyone plays in a browser. To play from
different places, the server just needs a public address. Two ways:

**1. Quickest: run it on your computer and open a tunnel** (no account, no deploy, works while your
computer is on):

```bash
npm start
# in a second terminal (install cloudflared from Cloudflare first):
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a `https://….trycloudflare.com` address. Send that to your friends. `ngrok http 3000`
or Tailscale Funnel work the same way.

**2. Always on: deploy it to a host that runs Node and supports WebSockets.** For example Render, Railway or
Fly.io, or any small VPS. Connect the GitHub repository and the host redeploys on every push:

* Build command `npm install` (or `npm ci`), start command `npm start`. The server reads `PORT` from the host.
* Or use the included `Dockerfile` (`docker build -t margin-call . && docker run -p 3000:3000 margin-call`).

Things to know:

* **GitHub Pages won't work.** It only serves static files, and the game needs its Node server.
* **Games live in memory.** A restart or redeploy ends games in progress. Free tiers that sleep when idle
  restart the server too, and take a few seconds to wake up.
* **Anyone with the address and a room code can join.** There are no accounts, so share the room code only
  with your group.
* **The server pings every connection every 25 s.** That keeps hosting proxies from dropping quiet games;
  dropped players reconnect and keep their seat.

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
| Bankruptcy | Can't get back to $0 cash → bankrupt. The estate is auctioned to the other players (or returned to the bank with distressed sales off). Last player standing wins, or the host ends the game and the highest net worth wins |
| Distressed sales | Below $0 or in a margin call, you can **auction** property to the other players instead of only selling to the bank: a sealed, second-price sale whose reserve is the bank's price (half the building cost + mortgage value). A lot in a built colour group sells as the whole group, buildings included. Lobby option, on by default |

## The central bank (leverage)

- **Fixed or floating loans.** Borrow any time for 5, 10 or 20 rounds. Interest is charged every round and principal is due at maturity. If you can't repay, the loan rolls over for 5 rounds at +2%.
  - **Floating:** policy rate + 0.25% + credit spread, reset every round.
  - **Fixed:** max(yield curve, floating base) + a lock-in premium (0.25% / 0.35% / 0.5% for 5 / 10 / 20 rounds) + credit spread. Locked for the term, and always more expensive than floating at signing.
- **Yield curve.** `rate(term) = w·policy + (1−w)·(neutral + target inflation) + term premium`, where `w = 5/term`. Short money tracks the policy rate and long money is anchored, so the curve inverts when the bank is hiking.
- **Credit spread.** +0.5% per unit of leverage (assets ÷ equity) after the new loan. With **risk-priced credit**
  (lobby option) it is +1.5% per unit and re-prices on all your bank debt every round (fixed loans lock only the base rate).
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
| Shares | Each player is split into 100 shares priced at book equity ÷ 100, re-marked at the start of every round. The desk deals at the **worse of the mark and the live price** for you: buy at the higher + 3%, sell at the lower − 3%. Max 50 shares of one player. Worthless if they go bankrupt |
| Call / put options | On a rival's shares, any strike, 5/10/20 rounds. Premium = Black-Scholes using that player's measured volatility, + 15%. Cash-settled any time (at the worse of mark and live price); auto-exercised at expiry. A put pays the full strike if the player goes bankrupt. No new puts on a player already below $0 |
| Credit default swap | Pay a premium every round; the bank pays the notional if the named player goes bankrupt. Premium = notional × default risk × 1.3, where default risk comes from leverage, cash and the worst rent on the board. Not sold on a player already below $0 |
| Rent insurance | Pay a premium every round; the bank pays 80% of any single rent above your deductible ($100/$250/$500), up to $1,500. Priced from the rents on the board when you buy |
| Rate swap | Pay fixed and receive the policy rate (or the reverse) on a notional, settled every round. The fixed rate is the expected policy path (the curve without its term premium) ± 0.1%. Total swap notional is capped at your desk limit. Close early at mark-to-market − 1% |

Desk positions count toward net worth (at what closing them would pay now) but not toward your borrowing limit.
Dealing at the worse of the once-a-round mark and the live price means neither stale prices (news the mark
hasn't caught up with) nor an intra-round pump pays. Simulation showed both the stale mark and the old swap
and CDS rules were free money (see `sim/REPORT.md`).

## Skill-test mode

The lobby has a **Rules preset** switch. **Classic** is the traditional game. **Skill test** changes the rules
so that trading decisions, not dice, decide the game. Every option can also be set on its own:

| Option | Skill test | What it does |
|---|---|---|
| Getting property | Opening draft | Every lot is auctioned before round 1, instead of buying what you land on |
| Auction format | Sealed bid, second price | Everyone bids once in secret. The highest bid wins and pays the second-highest bid, so bid your true value; reaction speed doesn't matter |
| Dice | Seeded per seat | Seat order is join order, and each seat has its own dice and card stream from the seed. Replay the seed with players rotated through the seats for a **duplicate match**: everyone faces the same luck |
| Money cards, Lockup, doubles | Off | Pure noise: they add variance but no decisions. Macro-shock cards stay |
| Credit pricing | Risk-priced | Steeper credit spread, re-priced every round, so leverage has a running cost |
| Neutral real rate | 8%/round | Borrowing costs about what property earns, so there is a best amount to borrow |
| Game length | 40 rounds | Then the highest net worth wins |
| Distressed property | Auction to players | Underwater players can auction property to the other players; bankrupt estates are auctioned |

In simulation (`sim/REPORT.md`) the Skill test preset plays in about 39 rounds and ~480 actions (classic: ~80
rounds and ~900). Two AI players beat two casual players in 91% of games (classic: about 70%), and
the gap shows in about 14 games instead of about 115.

## Real-money payouts

An optional lobby toggle for playing for money. When **Real-money payouts** is on, every human declares
their own stake in dollars in the lobby. $0 means you play for fun: you can neither win nor lose money. AI
players always stake $0. Stakes lock when the game starts. The host picks one of four payout modes:

| Mode | Weight |
|---|---|
| Winner take all | 1 for the last player standing, or the highest net worth if the round cap (or the host) ends the game; ties split |
| Order of bankruptcy | n−1, n−2, …, 0 by finishing place: survivors ranked by net worth, then players who went out, last out placing highest. Tied places share the average weight |
| Share payout, capped rounds | share = max(0, net worth) ÷ the sum over all players (bankrupt = 0) |
| Share³ payout, capped rounds | share³ ÷ Σshare³ |

The two share modes are settled at the round cap, so choosing one sets the game length to 40 rounds if no
cap is set. If everyone else goes bankrupt first, the survivor's weight is 1.

**Unequal stakes are settled with side pots, as in poker.** The pot is cut into layers at each distinct stake.
Each layer is funded by every player whose stake reaches it and is split only among those players by their
weights, renormalised among them. If none of them has any weight, the best-placed of them takes the layer.
Nobody wins more from an opponent than they risked themselves.

When the game ends (last player standing, round cap, or the host ending it), the game-over screen and the
log show one row per player: stake, finishing place, net worth, share, payout and net ±$, plus the pot.
Payouts are rounded down to the cent and each layer's leftover cents go to its top finisher, so they sum to
the pot exactly. During the game the Players tab shows what the payout would be if the host ended the game
now. All the arithmetic is one pure function in `src/payout.js`, shared by the server and the browser.

## AI players

The host can add up to 7 AI players in the lobby. They act through the same rule engine as humans:
- value property by its role in colour groups and how often each space is landed on
- keep a cash reserve sized to the rents ahead of them
- build where the return is best and borrow to build when that return beats the loan rate
- hold at four houses when the bank runs short
- bid to their valuation in auctions and haggle for set-completing trades
- in sealed-bid auctions bid their valuation once; in an opening draft spend to a budget
  (≤ 0.8× list, ≤ 1.6× for a set-completing or blocking lot, 15% of starting cash kept back)
- price contracts by discounted cash flows and counterparty risk
- buy rent insurance when the board turns dangerous

**AI speed.** The host sets how long AI players wait between moves (0.5s to 10s, default 1.5s) from the lobby
or at any time during the game (Players tab). **Pause AI** stops AI players from taking turns; they still answer
auctions and offers, so nothing stalls. `BOT_DELAY=ms npm start` changes the default for new rooms.

The AI's tunable parameters are in `bot.params` and were tuned with the simulator (`sim/tune.js`,
`sim/tuneDraft.js`). Over 300 classic four-player games, two AI players beat two casual players about 3 times
in 4. In the Skill test preset they win 91% of games.

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
src/payout.js      shared real-money payout settlement (modes, side pots), used by server and browser
src/bot.js         AI players
sim/               headless AI-vs-AI simulation harness + rules/skill study (see sim/REPORT.md)
public/            browser client (vanilla JS, no build step)
test/              node:test suite incl. randomised full-game fuzzing
```
