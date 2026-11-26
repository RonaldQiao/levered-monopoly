# Demo video: AI vs AI

Scripts that turn a recorded all-AI game into a 1080p demo video. The video replays
the real browser client (`public/`) with broadcast graphics layered on top: a standings
panel, net-worth and policy-rate charts, captions, alert cards and zooms.

The game itself is real. Five copies of the shipped AI (`src/bot.js`) play through the rules
engine (`src/engine.js`) with the default classic settings. A seeded random-number generator makes it
reproducible: seed 30 is the game in the video. Hayek and Minsky lever up, a rate-hike
card hits, they get margin-called and go bankrupt, and Volcker, the one agent that never
took a bank loan, wins.

```bash
node demo-video/scan.js '{}' 40 5     # score seeds 1..40 for drama (margin calls, bankruptcies, ...)
node demo-video/story.js 30           # print the key events of one game, by frame index
node demo-video/rec.js 30             # record every state of seed 30 -> demo-video/frames30.json
node demo-video/capture.js take       # replay in headless Chromium, capture frames in real time (~105 s)
demo-video/encode.sh take out.mp4     # H.264 1920x1080 30fps + silent AAC, faststart (Twitter-ready)
```

Run the record and capture steps from inside `demo-video/`, because the paths are relative to it.
`capture.js` needs Playwright with Chromium, and `encode.sh` needs ffmpeg.

* `director.js` is the script: `CUES` maps a frame index to a caption, alert, zoom or speed
  change, and the number a cue returns is how long to hold on that frame (ms). `setSpeed(ms)` sets the
  time per AI move. The ▶▶ badge shows the speed relative to the game's default AI pace (1.5 s per move).
* `overlay.css` styles the graphics; `fake.js` replaces the WebSocket so the client renders recorded states.
* Frame indices in `CUES` belong to seed 30. A different seed needs new cues (use `story.js`).

## Second video: contracts and rate swaps (`swaps/`)

A feature tour: a human player ("You") against four AI agents. A scripted cursor drives the real
dashboard. It borrows $2,000 floating in the Central Bank tab and builds an interest-rate swap with Keynes in the
contract builder (pay fixed 2.75%, receive floating, Keynes pledges Canal Street as collateral).
Keynes's AI prices the contract and signs it. Then the cursor hedges the rest with a pay-fixed swap on the Bank Desk.
The game then plays on while a rate-hike card and an overheating economy push the policy rate from 1.75% to 4.5%.
Unhedged, the loan's interest would climb from $47 at signing to $102 a round; with both swaps it stays flat at about $61.

```bash
cd demo-video
node swaps/scan.js 200                # seeds where rates rise after the hedge and Keynes signs
node swaps/rec.js                     # record seed 59 -> swaps/frames59.json
node swaps/test.js 4000               # dry run with screenshots (swaps/t_*.png)
node capture.js take1 swaps           # real-time capture (~100 s)
./encode.sh swaps/take1 swaps/margin-call-swaps-demo.mp4
```

"You" plays routine moves with the shipped AI. Only the hedge is scripted (`swaps/game.js`).
The director checks that the contract and orders the UI sends match the recorded ones, and logs `[director] proposeContract matches the recorded action`.

## The Twitter cut (`combined/`)

This is video 1's look with video 2's idea: **You vs 4 AI agents** (seed 81). It opens on an AI margin call at round 27, then rewinds.
At round 12 You borrows $2,000 floating and hedges it. The player swap with Hayek is shown as a term-sheet card, not the
contract form, followed by a desk swap. Rates climb from about 2% to 5%. The AIs borrow at 4–6.5%, get margin-called and go bankrupt.
Hayek goes bust mid-contract and the pledged Harbour Walk passes to You. You win in round 35.

```bash
cd demo-video
node combined/scan.js 120             # games where You hedges, rates rise and You wins
node combined/rec.js                  # record seed 81 -> combined/frames81.json
node capture.js take1 combined && ./encode.sh combined/take1 combined/margin-call-twitter.mp4
```
