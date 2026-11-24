# Margin Call as a trading-skill test: simulation report

About 300,000 full games, played headless by AI agents through the real rules engine (`game.apply`), at roughly
20 ms per 4-player game. To reproduce, see [Reproduce](#reproduce).

> **Status: implemented.** Sections 1–6 measure the game *before* the changes (commit `71c143d`), with rule
> variants applied as patches. Section 7 measures the changes as they now exist in `src/`: the desk exploit
> fixes (always on), the lobby options with the **Skill test** preset, and the re-tuned AI.
> Re-running the section 1–6 scripts today measures the fixed engine and the new AI, so their numbers will differ.

## How skill was measured

* **Agents.** `pro` is the shipped AI (`src/bot.js`). Each variant is pro with exactly one ability changed
  (`sim/agents.js`, `sim/skills.js`):

  | agent | change vs pro |
  |---|---|
  | `casual`, `random` | baseline humans: buy what's affordable / noise trader |
  | `pro_noTrade`, `pro_sucker` | never trades / accepts every offer |
  | `pro_noLev`, `pro_reckless` | never borrows / borrows to the cap every turn |
  | `pro_overbid` | bids 1.6× list on anything at auction |
  | `pro_noDesk`, `pro_noShares`, `pro_noInsure` | bank-desk habits switched off |
  | `pro_stale` | buys desk shares when live equity is >10% above the once-a-round mark, sells after the re-mark |
  | `pro_distress` | buys max CDS + ATM puts on a rival who is below $0 and can't raise enough to survive |
  | `pro_carry` | receive-fixed 20-round swaps when the curve is steep, closed when the economy overheats |
  | `pro_draft` | budget-aware bidding in an opening draft |
  | `pro_quant` | stale + distress + carry + draft combined |

* **Skill test.** Two copies of agent X play two copies of agent Y. Per game,
  D = mean net-worth share of X − mean net-worth share of Y. The effect size is **d = mean(D) / sd(D)**.
  **Games needed** = 7.85 / d², the number of games for 80% power at p < 0.05. Lower means the rules reveal
  the skill faster; "—" means the supposed skill *loses*.
* **Luck.** In mirror games (4 × pro) every difference in outcome is luck by construction.
* Players are polled in a random order each step. A fixed order hands tied English-auction bids to whoever
  is asked last: in a draft that seat won 52% of games. `server.js` polls bots in fixed seat order, so the
  live game has the same tie problem.
* Standard error on d at 400 games per cell is about 0.05, so treat |d| < 0.1 as zero.

## 1. Where the current game's outcomes come from (luck audit, 2,000 mirror games)

| | |
|---|---|
| Average length | 77 rounds, ~900 actions. 31% of games are still running at round 100 |
| Variance in final net-worth share explained by named dice/card events | **R² = 0.48** |
| Landing on unowned property (acquisition chances) | corr with share **0.43** |
| Avoiding the single biggest rent hit | corr **0.46** |
| Laps / salary collected (dice speed) | corr 0.34 |
| Cards (net cash) | corr −0.11 (minor, and confounded by repair cards) |
| First player to complete a colour set wins | 64.5% |
| Net-worth leader at round 10 / 20 / 30 goes on to win | 38% / 46% / 63% |
| Seat 1 vs seat 4 win rate | 27.3% vs 22.2% (first-mover edge) |

Luck enters mainly through **who lands on unowned property** and **who pays the big rents**. Cards, jail and
doubles barely register.

## 2. Skill × rules matrix (400 games/cell, 100-round cap)

Each cell: skilled side's win rate (50% = no edge) / games needed to detect the gap.

|skill|base|noCards|noJail|noDoubles|noAuction|lev1 (no borrowing)|baseFix (desk fixed)|draft|smoothRent|
|---|---|---|---|---|---|---|---|---|---|
|Overall play (pro vs casual)|69% / 115|67% / 169|71% / 124|68% / 138|69% / 135|62% / 12209|71% / 87|61% / 101|67% / 247|
|Valuation (pro vs over-bidder)|50% / —|47% / —|54% / 1928|49% / —|51% / 14267|56% / 601|50% / 14872|56% / 817|55% / 1004|
|Negotiation (pro vs no-trade)|58% / 171|59% / 310|57% / 201|54% / 1580|62% / 94|59% / 156|56% / 207|56% / 380|56% / 204|
|Adverse selection (pro vs accepts-all)|53% / 1314|57% / 485|56% / 636|57% / 335|62% / 138|53% / 2462|55% / 899|53% / 3232|55% / 994|
|Position sizing (pro vs reckless)|**38% / —**|40% / —|41% / —|44% / —|46% / —|49% / —|38% / —|**21% / —**|36% / —|
|Using leverage (pro vs never-borrow)|**75% / 17**|75% / 17|72% / 24|75% / 16|65% / 42|49% / —|72% / 23|82% / 11|71% / 32|
|Credit-event trading (distress vs pro)|52% / 1957|49% / —|52% / 8288|51% / 3053|52% / 1811|53% / 2938|48% / —|51% / 29150|53% / 3131|
|Rates carry (carry vs pro)|61% / 307|59% / 317|66% / 105|61% / 317|73% / 38|59% / 523|**47% / —**|47% / —|54% / 4671|
|Stale-quote arbitrage (stale vs pro)|**68% / 37**|66% / 49|68% / 42|68% / 41|70% / 34|71% / 30|**49% / —**|63% / 106|69% / 49|
|Rounds (4×pro)|78|75|77|81|87|81|80|57|77|

The full table, including `noMacroCards`, `lowVarDice`, `lev5`, `cash3000`, `proposed` and `proposedFix`, is in
`results/matrix.json`.

## 3. Rules that are bad for testing trading skill (ranked by damage)

1. **Bank credit is far too cheap relative to property yields, so "borrow the maximum" dominates.**
   Using leverage is the single largest edge in the game (75% wins, detectable in 17 games). Reckless
   max-borrowing *beats* the tuned AI (pro wins only 38%). In a 1-vs-3 game, `pro_reckless` takes a 36.5%
   share against 25% par.
   * A built set yields ~10–15% per round, against a loan rate of ~2.5% per round, and inflation (~0.7%/round)
     erodes nominal debt.
   * A real test of position sizing needs an interior optimum, where over- and under-levering both lose. The
     current rules have none: more leverage is always better.
   * The 2× cap and a 3× steeper credit spread (`riskPricedCredit`) did not fix this on their own. An interior
     optimum only appears when the policy anchor is raised to about 7–9%/round (section 5).
2. **Desk shares trade at a stale once-a-round mark, a free option for whoever looks.** `pro_stale` wins 68%
   against pro (37 games to detect). That is a bigger edge than all of pro's strategy over a casual player
   (69%, 115 games). The once-a-round mark stops pumping, but the desk still quotes a price it knows is stale.
3. **Rate swaps print money in cold economies.**
   * The 20-round fixed leg is anchored to neutral + target (≈2.4–2.9%) whatever the policy rate does, and at
     the zero floor that carry is riskless.
   * The notional limit (2 × equity) applies *per position*, so 12 swaps stack into exponential growth.
   * Carry agents average +$925k from the desk; one test game ended at $9.8M net worth. The edge shows up as rare
     blow-outs rather than steady skill (61% wins, 307 games).
4. **CDS and puts are sold on players who are already certain to go bankrupt.** The hazard is capped at 0.3, so
   one premium is ≤39% of notional against a 100% payout. It is a riskless trade, but it happens rarely
   (52% wins, ~2,000 games to detect). It also rewards *who gets polled first*, not analysis.
5. **Property is acquired by landing on it.** This is the largest luck source (corr 0.43). Valuation skill is
   invisible: pro vs a 1.6× over-bidder is 50/50, because auctions only happen on declined lots
   (~11 per game, mostly cheap).
6. **English auctions decided by reaction order.** With equal valuations, the last player to act takes ties.
   In a draft that seat won 52% of games under fixed polling. Real-time human play has the same problem: it
   rewards latency, not valuation.
7. **Games are long and lock in late.** 77 rounds and ~900 actions per game; the round-20 leader wins only
   46%. Capping the game and scoring on net worth *raises* per-game skill signal (pro vs casual d = 0.28 at
   100 rounds, 0.40 at 25, 0.38 at 40), so ~25–40 rounds detects overall skill about 6× faster in total
   rounds played. The one cost: negotiation needs time (d 0.24 at 100 rounds, 0.11 at 25).
8. **Desk products have negative expected value at the prices offered.** 3% share spread each way, 15% option
   load, 1.3× CDS and insurance loads, and shares priced at book equity (which ignores rent engines). The
   shipped AI's habit of parking cash in the leader's shares is its biggest weakness: `pro_noShares` beats pro
   76% of the time. Insurance is neutral (49%).
9. **Low-impact noise: cards, jail, doubles, utility dice.** Removing them barely moves any skill row (all
   within ±0.1 d) or the game length. They add drama but neither help nor hurt a skill test, so they are
   cheap to cut for pace.

Removing *risk* is the wrong fix. `smoothRent` (rent charged in expectation each round) removes "who hit the
hotel" luck, but it makes leverage free. Reckless borrowing then wins 64% (2v2), or 91% combined with the draft,
and pro is no better than `random` in a 30-round game. The fix that works is to keep risk inside the game and take
luck out of the *comparison* (duplicate dice, next section).

## 4. Fixes that work

| fix | effect (measured) |
|---|---|
| **Desk fix**: trade shares/options at the live price; no CDS or puts on a player below $0; receive-fixed pays curve − term premium; total swap notional ≤ 1× equity | Stale, distress and carry edges all go to zero (d −0.04 / −0.02 / −0.02). The whole desk P&L for exploit agents goes from +$925k to ≈$600 |
| **Duplicate dice**: each seat has its own dice and card stream; the same seed is replayed with the lineup rotated | Games to detect negotiation 157 → **50**; leverage 19 → 12; overall 140 → 110 |
| **Opening draft** of all 28 lots (`tight` formats) | Valuation goes from undetectable to d 0.27; games 78 → 57 rounds, 91% end in bankruptcy before the cap. Needs sealed bids or random priority (see rule 6) |
| **Cost of capital near asset yields** (neutral 7–9%/round + `riskPricedCredit`) | Creates the missing sizing optimum: pro beats reckless 63–75% *and* beats never-borrow 61–65% |
| **25–40 round cap, net-worth scoring** | Same or better per-game signal at ½–¼ the length |

## 5. Trading skills and how the agents score

The skill set a trading test should cover, the drill (format) that isolates each one best, and results.
"Speed" is total rounds of play needed to detect the skill = games needed × rounds per game.

| skill | best drill found | detectable in | the shipped AI (`pro`) |
|---|---|---|---|
| **Using leverage / funding** | `tightDup`, 40 rounds | 10 games (~380 rounds) | Strong: never-borrow scores 9.6% share vs 25% par |
| **Position sizing / risk of ruin** | `tightRiskDupN9`, 25 rounds | 24 games (~550 rounds) | Miscalibrated both ways: too timid under base rules (reckless beats it), too aggressive once credit costs ~9% (it busts 28–33%) |
| **Valuation / auction bidding** | `tightRiskDupN9`, 25 rounds | 170 games (~4,250 rounds) | Decent: its English-auction bidding beats my budget-drafter (`pro_draft` wins only 42–45%) |
| **Negotiation (making deals)** | `baseDup`, 100 rounds | 50 games (~4,400 rounds) | Strong: removing trading drops it to 15.6% share |
| **Adverse selection (refusing bad deals)** | `noAuction` 2v2 | ~140 games (700+ under base rules) | Its proposals extract value: an accept-everything copy scores 18.9% |
| **Hedging / instrument selection** | `base` 1-vs-3 (desk on/off) | ~20 games | **Weakest skill**: its desk habits halve its results (no-desk copy 48.5% vs 25%) |
| **Information speed / stale prices** | `base` (exploit) | 37 games | Doesn't exploit it. A legitimate version needs a counterparty that updates, not a frozen mark |
| **Rates / macro forecasting** | none after the desk fix | — | Not tested by any fair rule yet: the fixed desk leaves no edge for a naive carry rule. Needs a forecaster agent (Taylor rule + heat) and a swap curve that doesn't price in that forecast |
| **Credit analysis** | none after the desk fix | — | Same: only the certain-default arbitrage existed |

1-vs-3 scoreboard (each agent replaces one of four pros, all 4 seats rotated, 150 seeds; par = 25% share):

| agent | base rules (100 rds) | `tightRiskDupN9` (40 rds) |
|---|---|---|
| pro_quant (all exploits) | **43.6%** | 23.2% |
| pro_noDesk | **48.5%** | 23.7% |
| pro_reckless | 36.5% | 20.6% (busts 71%) |
| pro_carry / pro_stale | 35.5% / 34.9% | 25.0% / 25.3% |
| pro_overbid | 24.3% | 26.0% |
| pro_sucker | 18.9% | 25.5% |
| pro_noTrade | 15.6% | 21.8% |
| casual | 15.1% | 26.4% |
| pro_noLev | 9.6% | 17.8% |
| random | 2.4% | 23.2% |

Under base rules the leaderboard is led by exploit and leverage agents. Under the fixed format the exploits
are gone, but the field compresses: `random` and `casual` score near par, because pro (tuned for cheap credit)
over-borrows at 9%. The format is now *fair*. To confirm it is also *discriminating*, you need an agent that
is re-tuned for it; the current scores reflect a mis-tuned pro, not a lack of headroom in the format.

## 6. Recommended test format (fast, low luck)

1. Opening **draft** of all lots with **sealed bids** (or randomized tie priority), instead of buy-on-landing.
2. **Duplicate dice**: per-seat dice and card streams, every lineup replayed with seats rotated.
3. Drop money cards, jail and doubles (pure noise, no skill cost); keep macro shocks.
4. **Desk fix** as in section 4.
5. **Cost of capital ≈ property yields**: neutral rate 6–8%/round, credit spread that reprices each round
   with leverage. Tune so neither `pro_reckless` nor `pro_noLev` beats a sizing-aware agent.
6. **30–40 round cap**, scored on net-worth share, played in rotated sets of 4 games.

Measured on (1–6) at 40 rounds: games are 39 rounds (half the base length),
seat bias is removed by rotation, the three exploits are gone, and leverage and sizing are each detectable in
22–92 games. Negotiation and valuation still take a few hundred games, so for those use the longer `baseDup`
drill or the 25-round draft drill.

## 7. After implementation (measured on the shipped engine)

What shipped:

* **Desk fixes, always on.**
  * Shares and options deal at the *worse* of the round mark and the live price. This kills stale-quote
    arbitrage and keeps the old protection against intra-round pumping.
  * No new CDS or puts on a player already below $0.
  * The swap fixed leg is the expected policy path (curve minus term premium) ± 0.1%.
  * Total swap notional is capped at the desk limit.
* **Lobby options plus a Skill test preset:** opening draft, sealed second-price bids, seeded per-seat dice
  (duplicate matches), money cards / jail / doubles off, risk-priced credit (1.5%/unit, re-priced each round),
  neutral rate 8%, 40-round cap.
* **Fairer bot polling.** The server polls bots in random order, so tied bids no longer go to a fixed seat.
* **AI changes:**
  * It no longer buys the leader's desk shares.
  * It bids its valuation once in sealed auctions.
  * In a draft it spends to a budget: ≤ 0.8× list, ≤ 1.6× for a set-completing or blocking lot, 15% of
    starting cash kept back.
  * These values came from `sim/tuneDraft.js`, tuned against a mixed field (casual, random, loose and tight
    drafters).
  * The scoreboard caught the AI's first draft logic overspending: a budget-keeping copy took a 37.8% share
    against three standard copies.

Skill detection, 300 games per cell (skill preset: seeds replayed with seats rotated):

| skill test | classic (100 rds) | **skill preset (40 rds)** | before, base rules |
|---|---|---|---|
| Overall play (pro vs casual) | 70% / 22 games | **91% / 14 games** | 69% / 115 |
| vs noise trader (pro vs random) | 96% / 2 | 91% / 6 | — |
| Valuation (pro vs over-bidder) | 48% / — | **89% / 4** | 50% / — |
| Draft budgeting (pro vs loose drafter) | n/a | **79% / 12** | n/a |
| Negotiation (pro vs no-trade) | 61% / 98 | **61% / 54** | 58% / 171 |
| Position sizing (pro vs reckless) | 48% / — | **58% / 190** | 38% / — (reckless wins) |
| Using leverage (pro vs never-borrow) | 80% / 13 | 70% / 16 | 75% / 17 |
| Stale-quote arbitrage | 37% / — (loses) | 11% / — (loses) | 68% / 37 |
| Rates carry / credit-event | ~50% / — | ~50% / — | 61% / 307, 52% / 1957 |
| Rounds per game | 83 | **39** | 78 |

1-vs-3 scoreboard on the shipped engine (par 25% share):

| agent | classic | skill preset |
|---|---|---|
| pro_reckless | 30.4% | 24.8% (busts 54%) |
| pro_noDesk | 25.4% | 25.3% |
| pro_overbid | 26.9% | 26.1% |
| pro_sucker | 15.4% | 23.1% |
| pro_noTrade | 13.0% | 16.1% |
| pro_noLev | 7.8% | 15.5% |
| pro_stale | 17.3% | 7.8% |
| casual | 8.4% | 16.3% |
| random | 2.1% | 11.8% |

Reading the results:

* **Exploits are gone.** Under both presets every exploit agent scores at par or loses.
* **Desk use is now neutral.** Turning the desk off no longer helps the AI.
* **The Skill test preset is fast and discriminating.** It plays in half the rounds, and overall skill, valuation,
  budgeting, leverage and negotiation all show within 4–54 games.
* **Reckless leverage is no longer dominant** (par, with a 54% bust rate). But sizing is still the slowest
  skill to detect (190 games): the AI's own sizing is not much better than "borrow to the cap".
* **Classic rules still reward max leverage** (`pro_reckless` 30%). This is by design: classic keeps cheap
  credit. Use the preset to test sizing.
* **Not yet testable: rates and credit forecasting.** The fixed desk leaves no free edge, and no forecasting
  agent was built to look for a fair one.

## 8. Distressed-sale auctions

Before this change, an underwater player could only sell buildings back to the bank at half their cost, or
trade lots one at a time. A bankrupt player's land simply went back to the bank. Now, a player below $0 or in a
margin call can auction property to the other players:

* It is a sealed, second-price sale.
* The reserve is what the bank would pay.
* A built colour group sells as one package with its buildings.

Bankrupt estates are auctioned the same way, with the proceeds going to the bank. The lobby option is on by
default.

300 games per cell (`node sim/liquidation.js 300`):

| | classic, bank only | classic, auctions | skill, bank only | skill, auctions |
|---|---|---|---|---|
| Rounds per game | 64 | **57** | 38 | 37 |
| Completed distressed sales per game | 0 | 21 | 0 | 12 |
| Overall play (pro vs casual): win / games to detect | 70% / 22 | 70% / 20 | 91% / 14 | 91% / 14 |
| Negotiation | 61% / 98 | 60% / 120 | 61% / 54 | 61% / 52 |
| Using leverage | 80% / 13 | **84% / 9** | 70% / 16 | 73% / 16 |
| Position sizing (pro vs reckless) | 48% / — | 44% / — | 58% / 190 | **69% / 36** |
| Starting your own sale (pro vs never-auctions) | — | 45% / — | — | 50% / — |

What it does:

* **Sizing is much easier to see in the Skill test preset** (190 → 36 games). Over-levered players now have to
  sell into a market of careful players, who pick up their assets below value.
* **Games end sooner** under classic rules.
* **Starting a sale yourself doesn't help the seller measurably.** The value goes to the buyers, which is
  realistic for a fire sale.
* **The cost is more auctions to sit through** (12–21 per game). Each one closes as soon as every bidder has
  bid, so with bots it is instant; with people, each sale is one sealed bid.

## Caveats

* The agents are rule-based heuristics, not LLM agents. "Skill detectable in N games" is measured *between
  these agents*. A stronger agent can open gaps the current ones don't, especially in rates and credit, where
  no fair-rule specialist was built.
* d is noisy (SE ≈ 0.05–0.07 per cell). Games-needed scales as 1/d², so treat values above ~1,000 as "not
  detectable".
* The duplicate rotation keeps dice per seat, but decks and the economy still drift once decisions differ, so
  luck cancels mostly, not perfectly.

## Reproduce

```bash
node sim/experiments.js luck 2000      # luck audit            (~8 s)
node sim/experiments.js matrix 400     # skill x rules matrix  (~5 min, 4 cores)
node sim/experiments.js caps 300       # game-length caps
node sim/formats.js all                # exploits, duplicate, draft, scoreboard
node sim/round2.js 250                 # tournament formats
node sim/round2.js 300 tightRiskDupN7:40,tightRiskDupN9:40,tightRiskDupN9:25 final
# after implementation (engine-native presets)
node sim/round2.js 300 classic:100,skill:40 final_after
node sim/tune.js 150 skill             # AI leverage parameters
node sim/tuneDraft.js 120              # AI draft bidding
node sim/liquidation.js 300            # distressed-sale auctions vs bank-only
```

JSON results are written to `sim/results/`.
