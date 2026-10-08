# Auto Scouting — the v2 RAMP counter (ARTIFACTS coming onto the RAMP)

The app scores a match from the broadcast's score bar when the video has one (see
`auto-scoreboard.md`). For every other video (a team's own recording from the stands or the
field) it counts CLASSIFIED ARTIFACTS from the picture. This document is about that counter.

## Why v1 was replaced

v1 (`rampQueue.ts`, `auto-ramp-counting.md`) decodes how many ARTIFACTS are queued on each RAMP
and counts each time the queue grows. Strong alliances hold the GATE open while scoring. Their
ARTIFACTS then roll down the RAMP and straight out, so the queue never grows. Looking at the RAMP
over time showed this directly: every official increment from the score bar lines up with
ARTIFACTS rolling down the RAMP.

| Match | Official CLASSIFIED | v1 count |
|---|---|---|
| Run for the Robots Q61, red | 96 | 49 |
| Hawaii final, red | 85 | 76 |

v1 also depends on a per-video calibration of the empty RAMP and the ARTIFACT colours. On several
new videos that calibration failed outright (1 counted against 68; 12 against 69).

The rules agree with counting entries (CM 10.5.1): an ARTIFACT that passes the SQUARE and comes
directly onto the RAMP is CLASSIFIED. One that rolls over ARTIFACTS already on the RAMP is
OVERFLOW.

## How it works

Every frame, at 15 per second:

1. **Strip** (`lib/scouting/rampStrip.ts`). Each RAMP's lane is cut out of the frame and
   straightened into a 144 × 40 px RGB strip:
   - along the lane from slot −0.5 (the GATE end) to 8.5 (the top) at 16 px per slot;
   - across it ±2.5 ball radii, so an ARTIFACT is 16 px across whatever the camera.

   The lane and the camera following come from `RampScorer` (placement + view tracker), and
   `RampScorer.strips()` cuts the lane it is counting on.
2. **Strip detector** (`ml/strip/detector.py`, ONNX `public/models/ramp-detector.onnx`).
   - It has about 90k parameters and is fully convolutional along the lane.
   - Its main output is the probability that an ARTIFACT is centred in each of 36 bins along the
     lane, rolling ones included.
   - A second output says whether the strip shows a RAMP at all. It is not used for counting
     (see "What was tried").
3. **Entry counter** (`ml/strip/entry_model.py`, ONNX `public/models/ramp-entries.onnx`, three
   models averaged).
   - It reads those 36 responses over time, plus whether the RAMP was followed in each frame.
   - For each frame it gives the expected number of ARTIFACTS that came onto the RAMP: one
     appearing at the top of the visible lane and rolling down, or appearing and staying (the
     9th).
   - It reaches ±1.2 s either side of a frame. BatchNorm makes a frame's count depend only on
     the frames within reach, so the live page can count piece by piece and get the same answer
     as counting the whole match.
4. **Count** (`lib/scouting/rampCounterV2.ts`). The sum over the scoring window (start →
   buzzer + 3 s). The page shows one event per ARTIFACT, placed where the running sum passes
   k − ½.

In the browser the networks run in ONNX Runtime Web (WASM, in a worker, `lib/scouting/rampModels.ts`):
- the detector takes ~10 ms per RAMP per frame;
- the entry counter takes ~50 ms per second of video;
- the WebAssembly file is served from `node_modules` by `app/api/ort/[file]`.

If the networks cannot load, the page counts with v1.

**Live counting needs every frame.** A frame the page does not count is a frame the RAMP was
not seen, so the entry counter adds nothing there.
- Camera following (two Lucas–Kanade trackers in OpenCV.js) takes 40–60 ms per frame on a
  laptop. That is more than a 15 fps budget leaves.
- When the share of frames counted drops below 95%, the page plays the video slower, down to
  0.25×. It speeds up again once every frame is being counted. The status line shows the rate.
  - Measured on a 240p match before this change: 9–10 of 15 frames counted, "seen 59%", and
    red counted 37 against 44 official.
- Chromium and Windows slow down or freeze a page whose window is minimized, covered, or on a
  screen that is off. Timers and video decoding then stop for seconds at a time. The page
  rewinds over any gap, so nothing is counted wrong, but the run crawls. Keep the window in
  front while counting live.

## How far the count can be trusted

The page says beside each RAMP's count when it cannot be relied on:

- **Seen share.** This is the share of the match the RAMP was followed. ARTIFACTS that come on
  while it is not followed (camera turned away, RAMP out of the picture) are not counted.
- **Too small.** The ARTIFACTS are less than `MIN_RELIABLE_ARTIFACT_PX` (6) px apart on the
  RAMP, measured as its slot pitch in the frames the counter works on.
  - Every RAMP below this was far off, in either direction:

    | Video | App | Official |
    |---|---|---|
    | 02, 240p bleachers | 7 / 33 | 4 / 22 |
    | 05, 240p handheld corner | 58 | 5 |
    | 07, 240p broadcast | 64 / 35 | 85 / 47 |

  - RAMPS of 6–10 px were off by 6–38%.

  Such a RAMP is not scored, the same as one out of the picture. The page shows the reason, the
  counter's estimate marked as unreliable, and what would fix it: recording closer or at a
  higher resolution.

## Training data

Nothing was labelled by hand, and no video in the two Downloads folders or the held-out test
split was trained on.

- **Videos.** The 30 training videos in `Downloads\ArtifactIQ new test videos\train`.
  - 14 of them have RAMP lanes checked by eye: 24 RAMPS.
  - The score bar gives the scorekeepers' CLASSIFIED count over the match on 18 of those RAMPS.
- **Strips.** Every frame of every RAMP, cut on the lane the v1 counter settled on.
  - 360p and 240p renditions of each video (re-encoded as a small upload would be) are cut on the
    same lanes.
  - 8 of the 17 dev videos are 360p or below.
- **Detector labels.**
  - Slots where v1's decoded queue and the slot's own evidence clearly agree (ARTIFACT / empty).
  - ARTIFACTS pasted along the lane at any position, sharp or blurred. These are the rolling
    ones, which v1 never labelled.
  - Augmentation: lane found off, lighting, low resolution, and blocks of robot or person colours
    in front.
- **Entry counter.**
  - First trained on simulated RAMPS (`entry_sim.py`): rolling, queueing, GATE releases, bursts,
    OVERFLOW when full, detector noise, a hidden top, untracked stretches and dropped frames.
  - Then trained on the real matches' detector responses, against the score bar's count. The
    scorekeepers enter an ARTIFACT 1 s before to 4 s after it reaches the RAMP. The running count
    is kept inside that band, with no frame-exact labels.
  - Lanes placement put off the RAMP count as zero.
  - Cross-fitting: each video's responses come from a fold detector trained without it, as a
    user's video would be. The fold detectors are trained on the renditions and on strips off the
    RAMP. The shipped detector is trained at the original resolution only. See "What was tried".
  - `ml/strip/train_final.sh` rebuilds the shipped models.

## Results (2026-10-06)

**Test set.** No video below was trained on:
- the dev videos from both Downloads folders;
- N1 and N2;
- the test split X01, X02, X04, X10 and X12.

That makes 22 videos, 41 RAMPS and 1798 official CLASSIFIED.

**Method.**
- Vision only: the count does not use the score bar. The bar, or the official timing where a
  video has no bar, gives only the window.
- Counted on the strips the app cuts.
- 03 red and 04 blue have no lane, because placement found only one RAMP.

**Totals.**
- v2: |error| 320 (17.8%).
- v1 on the same RAMPS: 533 (29.6%).

The detector and counter pair was picked from four pairs measured on this set, so 17.8% is
slightly optimistic. On broadcasts, the page scores from the score bar instead. That is exact
on 20 of 23 videos (`auto-scoreboard.md`).

| Video | px apart | Red official → v2 | Blue official → v2 |
|---|---|---|---|
| 01 | 7.6 / 8.2 | 33 → 31.1 | 33 → 21.8 |
| 02 (240p) | 4.5 / 4.4 | 4 → 9.0 | 22 → 34.8 |
| 03 | – / 12.7 | – | 6 → 8.7 |
| 04 (240p) | 11.4 / – | 44 → 37.4 | – |
| 05 (240p) | 5.3 / – | 5 → 53.3 | – (RAMP mostly out of the picture) |
| 06 | 8.9 / 10.0 | 30 → 41.3 | 22 → 29.0 |
| 07h | 14.6 / 14.8 | 85 → 76.7 | 47 → 61.8 |
| 08 | 8.9 / 8.8 | 150 → 137.1 | 162 → 145.0 |
| 09 | 14.7 / 16.5 | 29 → 22.5 | 28 → 35.4 |
| 10 | 13.6 / 16.3 | 26 → 28.5 | 0 → 1.0 |
| 11 | 12.8 / 11.5 | 44 → 47.1 | 7 → 11.4 |
| 12 | 13.5 / 13.4 | 22 → 22.6 | 12 → 14.8 |
| 13 | | 29 → 31.0 | 23 → 27.7 |
| 14 (wide-angle) | 11.3 / 11.7 | 40 → 54.9 | 13 → 1.1 |
| 15 | 14.3 / 14.7 | 28 → 31.5 | 25 → 24.8 |
| N1 | 15.0 / 15.2 | 32 → 29.3 | 44 → 44.6 |
| N2 (handheld) | | 55 → 75.8 | 58 → 64.9 |
| X01 | 15.8 / 15.7 | 3 → 3.7 | 6 → 8.2 |
| X02 | 21.1 / 18.9 | 9 → 0.8 | 38 → 39.0 |
| X04 | 16.7 / 16.0 | 106 → 110.7 | 67 → 49.4 |
| X10 | 14.7 / 14.7 | 35 → 35.5 | 24 → 25.7 |
| X12 (Worlds record) | 20.0 / 20.2 | 206 → 183.2 | 146 → 141.7 |

"px apart" is the RAMP's slot pitch in the frames the counter works on.

### In the app (2026-10-07)

**Method.**
- Videos without a readable score bar.
- Each run: load the video, automatic placement, live from 0:00 to the end of the video. Nothing
  is set by hand.
- Every frame is counted (see "Live counting needs every frame").
- In every run the score stayed the same after the buzzer.

| Video | View | Video's own scoreboard | Official CLASSIFIED red / blue | App red / blue |
|---|---|---|---|---|
| 02 | 240p bleachers | clock only | 4 / 22 | not scored, too small (estimates 6 / 32) |
| 03 | 360p diagonal | clock only | 6 / 6 | red RAMP out of the picture / 8 |
| 04 | 240p beside the red GOAL | none | 44 / 47 | 38 / blue RAMP out of the picture |
| 05 | 240p handheld corner | none | 5 / 23 | 58 / blue RAMP out of the picture |
| 06 | 360p at the field wall | venue 154–107 | 30 / 22 | 34 / 21 |
| 07 | 240p broadcast | bar 85 / 47 | 85 / 47 | 64 / 35 |
| 10 | 720p overhead | clock only | 26 / 0 | 26 / 5 |
| 11 | 720p | none | 44 / 7 | 47 / 12 |
| 11f | the same match, 1080p | none | 44 / 7 | 49 / 12 |
| 13 | 1080p | venue: ARTIFACT points 95 / 74 | 29 / 23 | 31 / 28 |
| 14 | 1080p wide-angle lens | venue: ARTIFACT points 127 / 39 | 40 / 13 | 51 / 28 |
| N2 | 1080p handheld, Worlds | arena: 55 / 58 | 55 / 58 | 74 / 77 |

Notes on the table:
- 05 and 07 ran before too-small RAMPS stopped being scored. Today both are shown as not scored,
  with those numbers as the estimates.
- 07's bar digits are too small to read at 240p (`auto-scoreboard.md`), so the bar gives only
  the window.

**Totals.** On the RAMPS scored, |error| was 107 of 448 official CLASSIFIED (24%; 11 and 11f
both counted). Most of the
error is overcounting, from three sources:
- false entries on a RAMP with little scoring, from people and robots at the RAMP (blue +5 in
  10, 11 and 13);
- the wide-angle lens: placement fitted 2 of 20 frames at 6.31 px;
- the handheld Worlds video.

## What was tried and not kept

All of these were measured on the same held-out set: 22 videos, 41 RAMPS, 1798 official
CLASSIFIED, vision only.

- **Gating by "is this a RAMP".** It rejected the off-RAMP lanes. On views it was not trained
  on, it also turned real RAMPS away (Israel playoff blue: 2% of frames), so the counts
  collapsed. It is kept in the model for diagnostics only (`RampCounterV2(models, useRamp)`).
- **Gating relative to the RAMP's own level** (a frame counts if it looks at least half as much
  like a RAMP as this RAMP usually does): 19.6% against 17.8% without gating.
  - It helped where the camera follower lost the RAMP (N2 red, Marshall red).
  - It cut real counts elsewhere (da Vinci finals red −13 → −27).
- **Training the detector on strips off the RAMP** (to teach the RAMP output): 21.3%.
  - The shared features learned to stay quiet on unfamiliar views: Israel blue 49 → 15
    (official 67).
- **Training the detector on 360p / 240p renditions:** 20.8%, for the same reason. The
  low-resolution labels are ambiguous, and the detector became conservative on small or far
  RAMPS. Low resolution is instead covered by augmentation (blur, downscaling) for the detector
  and by the renditions' responses for the entry counter.
- **Training the entry counter on fold detectors that saw only the original resolution**,
  applied to the renditions: 27.6%. Their responses to the blurry renditions are weak. The
  counter learned to amplify weak responses and overcounted almost every held-out video (05 red
  +64, 14 red +42, N2 +42 / +39). The shipped counter learned from fold detectors trained on the
  renditions and on strips off the RAMP (`train_final.sh`).
- **GroupNorm in the entry counter.** It made a frame's count depend on the whole window, which
  breaks counting piece by piece live.

## Still hard

- **A lane that is not on the RAMP** (placement or camera following wrong) counts whatever moves
  there. Examples: the handheld 240p corner view (05) and the wide-angle lens (14). This is a
  placement problem, see `auto-roi-placement.md`.
- **Very high scoring with a full queue** (the 574-point Worlds record): ARTIFACTS that come on
  while the RAMP is nearly full roll a slot or less, and some are missed.
