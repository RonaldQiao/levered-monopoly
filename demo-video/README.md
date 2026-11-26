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
