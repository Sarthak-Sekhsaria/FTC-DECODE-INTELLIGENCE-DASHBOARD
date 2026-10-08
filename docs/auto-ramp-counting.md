# Auto Scouting — counting CLASSIFIED ARTIFACTS from the RAMP queue

> **This is the v1 counter, now the fallback.** The page counts from the broadcast's score bar
> when the video has one (`auto-scoreboard.md`). Otherwise it uses the v2 counter
> (`auto-ramp-counting-v2.md`), which counts ARTIFACTS coming onto the RAMP and also sees
> those that roll straight out through an open GATE. For a placed RAMP, v1 runs only when the v2
> networks cannot load. Placement, camera following and the RAMP lanes described here are
> shared by both.

Replaces the scoring-line counter (`GateMultiTracker`, per-gate sensitivity and clump
sliders) whenever automatic ROI placement found a camera pose. The legacy counter is still
used for boxes drawn by hand (no pose) and can be selected in Debug.

Code:
- `lib/scouting/rampQueue.ts` — the counter: appearance model, per-frame slot evidence, queue
  decoding, entry detection, counting, confidence. DOM-free; `rampQueue.test.ts`.
- `lib/scouting/rampScorer.ts` — streaming wrapper: camera following, self-calibration,
  per-frame sampling, results on demand. `rampScorer.test.ts` runs a synthetic match end to end.
- `lib/scouting/viewTracker.ts` — follows a moving / handheld camera.
- `lib/scouting/calibration.ts` — staged-ARTIFACT colour sampling.
- `lib/scouting/rampState.ts` — the 9 RAMP slots and their visible sample points.
- `app/video-scouting/auto/components/RampDebug.tsx` — the Debug view.

## Why the RAMP, not a scoring line

The lower RAMP holds exactly 9 ARTIFACTS queued against the GATE (CM §9.8.2). An ARTIFACT
that enters through the SQUARE rolls down and stops on top of the queue, so between GATE
releases the queue level rises by one per CLASSIFIED ARTIFACT and never falls. Counting the
rises is far more robust than counting blobs crossing a line:

- A queued ball sits still for seconds, so there is plenty of evidence for it.
- Nothing needs to be split into single balls, because each slot holds one ARTIFACT.
- People, robots and floor ARTIFACTS near the RAMP are not on the lane.

Two things the queue alone cannot see are handled separately:
- **ARTIFACTS rolling straight through an open GATE.** These are counted from their track
  down the RAMP.
- **OVERFLOW.** Entries while the RAMP holds 9 are not CLASSIFIED.

## Pipeline

0. **Working scale.** The counter sees every video at one scale. Frames are shrunk (area
   filter) until the smaller RAMP's ARTIFACTS are at most 12 px in radius
   (`WORK_BALL_RADIUS_PX`, `counterScale`). They are never enlarged, and the camera pose is
   rescaled with them (`resizedCamera`). A 720p and a 1080p recording of the same view
   therefore give the counter the same input at the same cost. Bigger balls only add texture
   (the ARTIFACTS' holes, robot detail), not colour, and the counter was validated on balls of
   3–15 px. Bedford, recorded at both 720p and 1080p, counts 48/11 and 50/8 in Node, and
   44/12 and 48/9 live in the app (official 44/7). `rampScorer.test.ts` renders the synthetic
   match at 1080p, checks the scale, and counts it exactly.
1. **Lane.** The 9 slot centres run along the lower RAMP from the GATE end (field model, CAD).
   Each slot has up to 17 sample points on the ball's disc as the camera sees it. Points
   hidden by the GOAL panels or the lower-RAMP blocker are dropped. The points are built
   once, in the frame the placement pose was solved on.
   - **Height.** A ball rests on the two rails' inner top edges, which are 80.5 mm apart in the
     CAD, so its centre is 1.93 in above the rail tops (`rampState.CENTRE_ABOVE_RAIL`). The
     lane samples 0.83 in lower (`laneDrops`), on the lower half of each ball, which the
     camera sees against the RAMP itself. The upper half is seen against whatever is behind the
     RAMP (people, legs, the audience). Sampling there was worse on the benchmark: 10.8 against
     7.8 mean error.
   - **Position.** The pose is only good to about 1% of the frame, a few pixels on a 6 px ball
     at 360p, so the lane is also sampled moved half a ball across and along the RAMP.
   - **Choice.** The count is the median of the three positions whose decoded queue explains
     the evidence best (`consensusOf`). A single winner flips with small pose errors; the
     consensus does not. Debug shows the chosen position as "Lane fit".
   - **Alignment from the ARTIFACTS** (`laneAlignRadii`, 2026-10-04). A GOAL and its RAMP can
     stand inches from where the field model puts them relative to the floor tape (field
     assembly). On DC1 the camera pose fits about 340 floor points and the red GOAL's AprilTag to
     1.7 px, with no gain from lens distortion, pixel aspect or principal point, yet the red
     queue lies 2.8 ball radii off the placed lane.
     - The lane is also sampled out to 3 radii either side.
     - Once a second, the ARTIFACTS around the placed lane are measured
       (`artifactCheck.measureArtifact`). A measurement is kept only where the counter's own
       evidence, at that lane position, says "not the empty RAMP". A panel or rail of
       ARTIFACT-like colour is part of the empty RAMP there; a queued ARTIFACT is not.
       (Without this check Bedford's blue RAMP showed a static distractor 2.5–3 radii to one
       side.)
     - When at least 60, from at least 10 different seconds, agree (inter-quartile range ≤ 2
       radii, one ball width) on an offset beyond the normal search, and they measure like single
       ARTIFACTS (median width 0.75–1.35× the automatic size), counting uses the lanes within
       0.75 radii of it. The page says so ("Lane aligned").
     - DC1 red: 247 measurements, median +2.2 radii; it counts 26 against 29 (8 on the placed
       lane).
     - The guards were set after a looser first version moved Marshall's red lane on 21
       measurements onto blobs 2.5× an ARTIFACT's width (143 against 40). With them, the only
       other benchmark RAMP that moves is Marshall's red (1.2 radii: 95 against 40, 89 without
       the move); its wide-lens view is wrong either way.
2. **Camera following.** Each RAMP has its own tracker on the area around the RAMP and its
   GOAL (corners, pyramidal Lucas–Kanade, RANSAC homography). A camera that also moves
   (handheld) shifts near and far things differently, so the tracker uses only features near
   the RAMP. Keyframes are chained, and every 8 frames the reference is re-registered
   directly, so drift cannot build up. When a RAMP's own tracker has too little texture, a
   whole-view tracker takes over. While the view is lost (a graphic, a cut to another
   camera), retries happen only every 8 frames, because a failing search is the expensive
   case.
   - **Structure-checked re-anchor.** Late in a match, people and robots stand around the GOAL.
     A direct match to the reference frame can then latch onto things that have moved, and
     jump the RAMP by several pixels. When the re-anchor and the frame-to-frame chain disagree
     by more than 2 px (at the tracker's 480 px), the static field structure decides: the
     RAMP's own GOAL panels, blocker and RAMP surface, projected from the pose (`verifyPolys`).
     Whichever of the two homographies lines that area up better with the reference frame
     (normalised cross-correlation) is kept.
     - **Measurement.** Tracking error is measured against where template matching finds the
       GOAL's AprilTag (NCC ≥ 0.85), every 5 s over the whole match.
     - **Results.** It is better or equal on every 720p and 1080p RAMP:
       - Lake Orion Q10 red: worst error 54 → 0.9 px.
       - DC1 blue: 22 → 1.7 px.
       - Hawaii 720p blue: 26 → 4.7 px.
       - Maxwell blue: 7.8 → 3.5 px.
     - **One small loss:** Brisbane red's worst error 2.6 → 4.0 px, with the same 90th
       percentile.
     - **Counts.** Maxwell red 73 → 33 (official 26), DC1 red 68 → 59 and blue 43 → 34
       (official 29 / 28).
     - `rampScorer.test.ts` checks the rule both ways: a wrong re-anchor is refused, and a
       chain that missed a camera move is replaced.
3. **Self-calibration.** Around the match start the scorer looks for frames where the 18
   pre-staged ARTIFACTS are visible with their manual colours (CM §10.3: near GPP, middle PGP,
   far PPG) — "seen" means at least 30% of the ARTIFACT's disc has its colour.
   - **Window.** From 10 s before the start to 2 s after it. The staged ARTIFACTS stay in place
     for at least 2.5 s of AUTO on all 17 videos. On 5 of them the field only comes into full
     view at or just before the start: Loveland fades in at the start, and with the old 1 s
     limit it calibrated on a half-faded frame (green read as teal) and counted red 88 against 4.
   - **Start not seen.** When the match clock cannot see AUTO begin, the start lies between
     TELEOP − 45 s and TELEOP − 38 s (15 s or 8 s transition). The calibration frame is chosen
     closest to the earlier one, before the match either way. Using the later one put da
     Vinci's (World Championship, 15 s transition) calibration 2.5 s into AUTO, with
     ARTIFACTS already on the RAMP, and it counted 96/80 against 150/162; now 129/142.
   - **Colours.** Each staged ARTIFACT's colour is its median over every frame of the window,
     weighted by how many frames it was seen in. Something that covers a staged position only
     for a moment counts for little: DC1's broadcast overlay puts bright green motif icons over
     3 of the 6 green positions from the start on, and its "green" had been (64, −29, 51) ±49;
     now (35, −25, 1) ±12. The spread is robust: samples beyond 3σ of a median-based estimate
     are left out (`rampQueue.colourModel`).
   - **Empty RAMP.** The 2 s after the calibration frame give every sample point's empty-RAMP
     colour (median) and noise (RMS). Over 0.8 s, one arm in front of the RAMP changed a whole
     match: Hawaii 720p red counted 81 to 111 depending on the calibration moment, and 86 to 93
     over 2 s (official 85). A median-based noise estimate was tried and dropped: it made the
     counter too sensitive (Hawaii red 96 to 109). No ARTIFACT reached a RAMP sooner than about
     3.5 s into AUTO on the benchmark.
4. **Per-frame evidence.** Every point is compared with its empty-RAMP colour and with the
   ARTIFACT colours, as normalised squared distances. Both are capped at 3σ, so something far
   from both says nothing (a person or robot in front).
   - A colourfulness gate stops greys from ever looking like a ball: hair, dark clothes and
     shadows fall below 30% of the staged ARTIFACT chroma.
   - Each slot's sum is weighted by how many real pixels its ball covers, because sample
     points closer than ~2 px repeat the same compressed pixels. This is the automatic
     sensitivity: small or distant RAMPS get less weight per slot.
5. **Queue decoding.** The whole match is decoded jointly with Viterbi over the level 0..9:
   - Staying costs nothing, and each added ARTIFACT costs 5.
   - A release costs 14, plus 2 per ARTIFACT left behind, since real releases drain the queue.
   - A slot that looks empty under the queue costs at most 20 (it may be hidden, e.g. by a
     referee in front of the GATE end).
   - A ball above the queue is explained as rolling past unless its evidence is very strong
     and lasting.
   - Frame evidence is weighted 0.3, because neighbouring frames are not independent.
   - The RAMPS start empty.
6. **Counting.**
   - **Held levels:** a queued ARTIFACT rests until the GATE opens. So when the balls are
     well resolved (mean radius ≥ 6 px, i.e. about 12 px across), a decoded level only counts
     once it has lasted 0.5 s. Shorter peaks are a robot, an arm or a person passing in front
     of the RAMP. At 720p their coloured parts pass for balls, and a passer-by can light up
     all 9 slots in one frame (Bedford, 0→9→0 in 0.3 s). With smaller balls the decoded level
     flickers, and brief levels still carry real balls rolling through an open GATE, so
     nothing is cut. Any threshold from 5 to 8 px gave the same result on the benchmark.
   - **Fill periods:** a release is a drop of ≥ 2 below the period's peak, and the 1 s drain
     after it belongs to the release. Each period counts max(queue gain, ARTIFACTS seen
     rolling in from the top while the RAMP was not full).
   - **Events:** every counted ARTIFACT becomes a reviewable event at the moment it joined
     the queue (or entered, for pass-throughs), with its colour from the slot it filled.
   - **Confidence** per RAMP:
     - **Ball size:** under 3.5 px radius is low, under 4.5 px is medium.
     - **Agreement:** the share of clear slot observations consistent with the decoded queue
       (under 92% is low, under 95% is medium).
     - **Camera followed:** under 85% of frames is low, under 95% is medium.
     - **Colours:** default ARTIFACT colours cap it at medium.

   The reasons are shown in the page.

7. **Self-check** (`artifactCheck.ts`). Every second of the match, each ARTIFACT the counter
   sees queued is measured in the picture: its width across the lane against the automatic
   size, its distance from the lane, and its colour against the calibrated colour. The medians
   are shown per RAMP under "Automatic calibration" with ✓ fits or ⚠ check, so every video
   shows whether the automatic values fit it.

All constants live in `DEFAULT_RAMP_QUEUE_CONFIG` with a comment each. None is set per video.

## The match window (start and buzzer), found automatically

Only ARTIFACTS scored during the match count. Before this round the page counted from the
start of the video to its end unless the user set the buzzer by hand. Measured to the end of
each video with no buzzer set:
- Brisbane 1080p red: 30 at the buzzer, 64 at the end of the video.
- Lake Orion Q10: 18 and 27 more, from the field reset after the buzzer.

The scoring window is now found from the video itself (`lib/scouting/matchClock.ts`).

- **Timing (game manual).** 30 s AUTO, an 8 s transition (15 s at the FIRST Championship,
  §15.2.2) and 2:00 TELEOP, so 158 s (§10.1, §10.4). ROBOTS may not move during the transition.
- **Motion.** Measured on the FIELD floor one TILE in from the walls, where drive teams,
  referees and spectators cannot be. The camera's own motion is removed by a tracker fitted to
  the field area (the floor is a plane). Every 0.2 s, the share of that floor that changed is
  recorded.
- **TELEOP start.** The strongest step from at least 8 s of stillness to motion that starts at
  once (the first 3 s already move) and lasts.
  - Its two minutes must fit in the recording.
  - The 30 s before the transition must show AUTO motion: at least 5% of TELEOP's. Before a
    match the robots stand still, so the start of AUTO, which looks the same, is never taken
    for TELEOP.
- **Buzzer.** TELEOP start + 120 s.
- **Start.** The robots' first move (a step in 5-second medians, so a title card or camera bump
  cannot fake it), less 1.5 s. When that step cannot be seen, it is TELEOP − 45 s, which is
  early enough for either transition; the RAMPS are empty before a match, so this costs nothing.
- **After the buzzer.** ARTIFACTS already in the air count when they come to rest (§10.5 A), so
  scoring runs 3 s past the buzzer (`SETTLE_SEC`) and nothing later counts. Measured on 10
  videos counted to their end: no real ARTIFACT joined a queue later than that, and a broadcast
  can fade to its graphics 2–3 s after the buzzer.
- **Accuracy.** On all 17 videos the buzzer is within 1.6 s of the true one (median 0.8 s), and
  the start is never more than 0.6 s after the true start.
- **Live mode.** The window becomes final 55 s into TELEOP, when no later TELEOP start could
  replace it. Live mode then stops by itself at the buzzer + 3 s. It pauses once to show the
  result; played on after that, nothing more is counted.
- **Calibration.** The counter calibrates at the found start, exactly as if it had been given
  the start up front (`RampScorer.calibrateAt`): on the frame just before the start that shows
  nearly as many staged ARTIFACTS as the best, with the colours pooled from the good frames
  around it. (Without this, DC1 and Maxwell counted 0: their videos open on a title card or a
  results graphic, and the counter had calibrated on that.)
- **Manual override.** What the user sets by hand wins. A start set alone puts the buzzer
  2:38 later.
- **Tests.** `matchClock.test.ts` checks a regular match, the Championship transition, live
  replay (the start of AUTO is never taken for TELEOP), recordings that start late or stop
  early, videos with no match, and the motion measurement itself (a robot moving is motion; a
  panning camera over a still field is not).

## In the app

- **Offline analysis** (recommended): reads every frame of the match at 15 fps by seeking,
  from 3 s before the match start to the buzzer (or the video end). A full 2:40 match at
  360p takes about 4 minutes in Chrome, about 100 ms per frame: seek 50, grab 10, counter 40.
- **Live**: the same counter is fed from playback, driven by `requestVideoFrameCallback` plus
  a 33 ms timer.
  - **Re-decoding.** It re-decodes about once a second (provisional) and once more at the
    buzzer or when live stops. If a provisional decode is slow on the device, it runs less
    often, so it never takes more than about 10% of the time.
  - **Status line.** Shows the frames counted per second, and warns when the device falls
    behind.
  - **Placement does not re-run during counting.** The camera-moved monitor of the legacy
    counter used to re-run placement here. It made live mode freeze about 10 s into a match and
    start counting again from zero.
  - **Page in the background.** A browser stops giving a background page frames, and throttles
    its timers, while the video keeps playing. A hidden page therefore pauses live (also when
    playback is started while hidden), and it resumes by itself when the page is visible again.
  - **Frames held back without the page being hidden** (an occluded or minimised window, a
    throttled embedded view). If more than 0.75 s of playback passes between two counted frames
    (`LIVE_STALL_SEC`), that stretch is not counted across. The video goes back to the last
    counted frame and plays on, and the status line says why. This is checked before the
    buzzer, so the last seconds are not lost either. A throttled page gets its timers about
    once a second, so it always trips this; a device that counts at least ~1.5 frames a second
    never does.
  - **Tested in Chrome**, through the page as a user drives it:
    - Hide, play while hidden, show: 4/4 checks.
    - With the window minimised, the page was starved (timers about once a second, once
      none for ~50 s). Every gap the guard saw was played again, including gaps of 0.76–1.14 s
      with the final 0.75 s threshold.
- **Debug** (per RAMP):
  - confidence and its reasons;
  - the automatic clump size (one ARTIFACT's area on this RAMP, and the slot pitch);
  - the automatic sensitivity (per-slot evidence weight, colour tolerance, RAMP noise);
  - the learned ARTIFACT colours as swatches;
  - where it calibrated, and how much of the match the camera was followed;
  - a slot-by-time picture of the evidence with the decoded queue;
  - the tracked slots drawn on the video.
- Set the match start and the buzzer when the video has pre- or post-match footage. After the
  buzzer, referees reset the field.

## Benchmark

### Current results (2026-10-03): 17 videos, 31 RAMPS, 240p to 1080p

Official results are from FTCScout (classified = classified points ÷ 3). The app's score is
CLASSIFIED ARTIFACTS × 3; pattern, leave and base are entered by hand, and overflow is not
counted. Windows are the match (start to buzzer). The 1080p set is new this round:
- Lake Orion Q10 and Lake Orion Playoff M6;
- Brisbane North Playoff M4;
- Marshall Meet 3 Q8;
- Bedford again at 1080p.

**In the app** (Chrome, the dev server, live mode exactly as a user drives it). The video is
loaded, placed automatically, the ROI confirmed, the match start and buzzer set, and the match
played through to the buzzer. Final counts are as shown on the page:

| Video | RAMP | Official | Live in the app | Points (app / official) | Placement in the app |
|---|---|---|---|---|---|
| Hawaii Finals 1 M6 (720p) | red | 85 | 90 | 270 / 255 | B, 2.54 px, 29/31 |
| | blue | 47 | 38 | 114 / 141 | |
| Washington DC1 Playoff M3 (720p) | red | 29 | 35 | 105 / 87 | B, 3.74 px, 25/36 |
| | blue | 28 | 63 | 189 / 84 | |
| Maxwell Meet 2 Q11 (720p) | red | 26 | 25 | 75 / 78 | B, 2.42 px, 7/37 (low: few frames) |
| | blue | 0 | 2 | 6 / 0 | |
| Bedford Playoff M1 (720p) | red | 44 | 44 | 132 / 132 | B, 1.95 px, 30/31 |
| | blue | 7 | 12 | 36 / 21 | |
| Bedford Playoff M1 (1080p) | red | 44 | 48 | 144 / 132 | B, 3.14 px, 27/28 |
| | blue | 7 | 9 | 27 / 21 | |
| Lake Orion Q10 (1080p) | red | 22 | 21 | 63 / 66 | B, 4.75 px, 30/31 |
| | blue | 12 | 13 | 39 / 36 | |
| Brisbane North Playoff M4 (1080p) | red | 29 | 29 | 87 / 87 | B, 3.42 px, 26/36 (from t = 0, 183 s) |
| | blue | 23 | 26 | 78 / 69 | |
| Lake Orion Playoff M6 (1080p) | red | 28 | 28 | 84 / 84 | B, 2.66 px, 30/31 |
| | blue | 25 | 25 | 75 / 75 | |
| Marshall Meet 3 Q8 (1080p) | both | 40 / 13 | — | — | **failed**: 4 of the 5 frames needed, twice; the app asks for 4 corner taps |

- **Mean error over the 16 counted RAMPS: 4.6 ARTIFACTS** (2.6 without DC1 blue).
- **Run-to-run variation.** Live counting depends on which frames are processed. Maxwell, run
  twice in the app with the same placement, gave 25 / 2 and 23 / 0.
- Seven of the 16 are within 1, and the four Lake Orion RAMPS are within 1.
- Live ran at 10–16 frames a second.
- The Hawaii, DC1 and Bedford 720p runs came before the last two changes (the 0.75 s stall
  threshold and the weak-evidence cutoff). Neither applied there: no stall was detected in
  those runs, and those placements are unchanged by the cutoff, or their frames are all above
  it.

**Why DC1 blue and Marshall are off.** DC1 blue is the side-on RAMP view described under
"What is still hard". Marshall is the wide-angle lens: its frames rarely fit a pinhole model,
and the browser's slower solves gather too few of them.

**In Node, all 17 videos**: the placement pose (current placer), frames decoded by ffmpeg
(the same BT.709 colours as the browser) at 15 fps and resized to the working scale, and the
library exactly as the app runs it (`RampScorer`, default settings, nothing per video).
"Start of round" is the same harness on 2026-10-02, before the tracker check, with the same
placements.

| Video | Camera | RAMP | Official | Counted | Error | Confidence | Start of round |
|---|---|---|---|---|---|---|---|
| **720p** | | | | | | | |
| Hawaii Finals 1 M6 | stream, low, audience end | red | 85 | 81 | −4 | high | 87 |
| | | blue | 47 | 40 | −7 | low | 41 |
| Washington DC1 Playoff M3 | stream, low, audience end | red | 29 | 59 | +30 | high | 68 |
| | | blue | 28 | 34 | +6 | high | 43 |
| Maxwell Meet 2 Q11 | phone, high balcony | red | 26 | 24 | −2 | high | 73 |
| | | blue | 0 | 0 | 0 | high | 0 |
| Bedford Playoff M1 | phone at the field wall | red | 44 | 48 | +4 | high | 49 |
| | | blue | 7 | 11 | +4 | high | 15 |
| **1080p** | | | | | | | |
| Bedford Playoff M1 | phone at the field wall | red | 44 | 50 | +6 | high | 50 |
| | | blue | 7 | 8 | +1 | high | 8 |
| Lake Orion Q10 | stream with overlay | red | 22 | 22 | 0 | high | 22 |
| | | blue | 12 | 13 | +1 | high | 13 |
| Brisbane North Playoff M4 | low, at the field wall | red | 29 | 29 | 0 | high | 30 |
| | | blue | 23 | 31 | +8 | high | 31 |
| Marshall Meet 3 Q8 | handheld, wide-angle | red | 40 | 47 | +7 | medium | 47 |
| | | blue | 13 | 73 | +60 | **low** | 73 |
| Lake Orion Playoff M6 | stream with overlay | red | 28 | 28 | 0 | high | 28 |
| | | blue | 25 | 25 | 0 | high | 25 |
| **240/360p** | | | | | | | |
| Hartland Playoff M6 (360p) | stream, fixed | red | 33 | 34 | +1 | high | 35 |
| | | blue | 33 | 25 | −8 | high | 25 |
| Loveland Scrimmage M4 (240p) | high bleachers, handheld | red | 4 | 1 | −3 | low | 7 |
| | | blue | 22 | 31 | +9 | medium | 30 |
| North East League M3 Q21 (360p) | diagonal | blue | 6 | 6 | 0 | high | 6 |
| Atlanta League final (240p) | phone beside the GOAL | red | 44 | 25 | −19 | high | 27 |
| South East Qualifier ASL Q6 (240p) | handheld, low corner | red | 5 | 39 | +34 | low | 42 |
| Brisbane North finals M2 (360p) | at the field wall, handheld | red | 30 | 23 | −7 | high | 33 |
| | | blue | 22 | 21 | −1 | high | 21 |
| Hawaii Finals 1 M6 (240p) | low, audience end | red | 85 | 83 | −2 | medium | 83 |
| | | blue | 47 | 34 | −13 | medium | 34 |
| da Vinci Finals 2 (360p) | high, overhead | red | 150 | 170 | +20 | medium | 170 |
| | | blue | 162 | 134 | −28 | medium | 148 |

Mean error:
- **720p and 1080p (18 RAMPS): 7.8 ARTIFACTS**, 4.7 without Marshall blue. At the start of the
  round it was 11.4.
- **240/360p (13 RAMPS): 11.2.** At the start of the round it was 9.8. The changes:
  - Brisbane 360p red (33 → 23): its handheld camera swings far away at 108 s and both the old
    and new tracker settle 25–45 px off for the rest of the match. The old count came out
    right by accident, with 11 counts while the lane swept over other things.
  - da Vinci blue (148 → 134): that video has no readable AprilTags, so there is no tracking
    ground truth. Against its broadcast overlay, the old count ran over between 80 and 95 s and
    the new one under between 65 and 80 s.
- **All 31: 9.2** (start of round 10.8).

Maxwell's Node count uses the placement the current placer finds (field at 26.5 s, FOV 57°);
the earlier placement (FOV 66°) gives 33.

The same broadcast at 240p and at 720p (Hawaii) and the same match at 720p and at 1080p
(Bedford) agree within a few ARTIFACTS. The working scale makes the resolution itself not
matter above ~12 px balls.

### Earlier rounds

Twelve real videos, with official results from FTCScout (classified = classified points ÷ 3).
- **240/360p:** eight videos, the first benchmark.
- **720p:** four videos (2026-09-30). Hawaii again at 720p, plus three matches never used while
  building the counter: Washington DC1 Qualifier Playoff M3, Maxwell League Meet 2 Q11 and
  Bedford NH Qualifier Playoff M1.

Windows are the match (start to buzzer). Hartland, Hawaii, da Vinci and DC1 also have the
broadcast overlay's running count.

End to end: the placement pose found automatically, frames decoded by ffmpeg at 15 fps, and the
library exactly as the app runs it (`RampScorer`, default settings, nothing per video). Run
on 2026-10-01 with the current placement of every video. "Before" is the table of 2026-09-30:
the counter and placement at the start of the 720p work.

| Video | Camera | RAMP | Official | Counted | Error | Confidence | Before |
|---|---|---|---|---|---|---|---|
| **720p** | | | | | | | |
| Hawaii Championship Finals 1 M6 | stream, low, audience end | red | 85 | 90 | +5 | medium | 95 |
| | | blue | 47 | 43 | −4 | low | 45 |
| Washington DC1 Qualifier Playoff M3 | stream, low, audience end | red | 29 | 34 | +5 | medium | 46 |
| | | blue | 28 | 49 | +21 | high | 50 |
| Maxwell League Meet 2 Q11 | phone, high balcony | red | 26 | 35 | +9 | high | 35 |
| | | blue | 0 | 0 | 0 | high | 0 |
| Bedford NH Qualifier Playoff M1 | phone at the field wall | red | 44 | 49 | +5 | high | 54 |
| | | blue | 7 | 13 | +6 | high | 14 |
| **240/360p** | | | | | | | |
| Hartland Qualifier Playoff M6 (360p) | stream, fixed | red | 33 | 35 | +2 | high | 35 |
| | | blue | 33 | 25 | −8 | high | 25 |
| Loveland Scrimmage M4 (240p) | high bleachers, handheld | red | 4 | 7 | +3 | **low** (ball ~7 px) | 1 |
| | | blue | 22 | 30 | +8 | medium | 37 |
| North East League M3 Q21 (360p) | diagonal, small camera moves | blue | 6 | 6 | 0 | high | 6 |
| Atlanta League Tournament final (240p) | phone beside the GOAL | red | 44 | 27 | −17 | high | 43 |
| South East Qualifier ASL Q6 (240p) | handheld, low corner | red | 5 | 42 | +37 | **low** (ball ~5 px) | 38 |
| Brisbane North Qualifier finals M2 (360p) | at the field wall | red | 30 | 33 | +3 | high | 27 |
| | | blue | 22 | 21 | −1 | high | 24 |
| Hawaii Championship Finals 1 M6 (240p) | low, audience end | red | 85 | 83 | −2 | medium | 83 |
| | | blue | 47 | 34 | −13 | medium | 34 |
| FIRST Championship da Vinci Finals 2 (360p) | high, overhead | red | 150 | 138 | −12 | medium | 138 |
| | | blue | 162 | 156 | −6 | medium | 154 |

Maxwell and Bedford could not be placed automatically at all before this round (see
`auto-roi-placement.md`). Their "before" counts are the old counter on the new placement.

Mean error:
- **720p:** **6.9 ARTIFACTS** (Hawaii and DC1 before: 12.8). Without DC1 blue, 4.9.
- **240/360p:** 8.6 (before 7.8), or 6.5 on the 11 RAMPS rated high or medium (before 6.0).
- **All 21 RAMPS:** 8.0.

The held-level rule does not apply to balls under 6 px, so the 240/360p changes come from
placement alone. On seven of those eight videos the RAMP moved by at most 0.4% of the frame.
That is enough to move Atlanta red from 43 to 27. The new pose fits the field just as well
(0.88 against 0.87 px), but it hides two or three more sample points per slot behind the
GOAL panel next to this phone. Every lane position now counts 25–27. A 240p view from right
beside a GOAL is that fragile.

In points (3 per ARTIFACT), five of the eight 720p RAMPS are within 15 points of the official
classified score. Bedford blue is off by 18, Maxwell red by 27 and DC1 blue by 63.

**Hawaii at 240p and at 720p** (the same broadcast): red 83 → 90 and blue 34 → 43, against
85 / 47. Blue gains most, because its purple balls read almost grey at 240p. At 720p, before
the held-level rule, the counter over-counted on six of the eight RAMPS (by +7 to +22). The
cause was robots, arms and people in front of the RAMP whose coloured parts are sharp enough
at 720p to pass for balls. That bias is what the held-level rule removes.

**In Chrome:** Bedford 720p was placed automatically (method B, 22/23 frames) and analysed
offline in 290 s for the 158 s match, about 110 ms per frame, the same as at 360p. It counted
red 47 / blue 11, both high confidence (official 44 / 7). The Node pose differs slightly, so
Node gives 49 / 13.

**Comparing with a broadcast's final score.** The app shows CLASSIFIED ARTIFACT points only
(3 each). A match total also holds OVERFLOW, PATTERN, LEAVE and BASE points and the
opponent's fouls. In Hawaii Finals 1 M6 those came to 64 points for red (15 fouls, 22 pattern,
15 base, 6 leave, 6 overflow) and 39 for blue. So even a perfect count there shows red 255 of
319 and blue 141 of 180. Enter pattern, leave and base in the manual panel to compare totals.

Against the broadcast overlay's running count, Hartland red follows the overlay to within 2 at
every 15 s checkpoint. Hartland blue misses one hidden refill at the start of teleop (below).

In Chrome, the Hartland offline pass with the same code took 230 s for 2401 frames and gave
red 37 / blue 28, both high confidence. The pose restored from the saved placement differs
slightly, so it does not match Node exactly. An earlier browser run gave 32 / 23.

The benchmark also drove these choices, each measured on all eight videos:
- **Lane search** (fixed-camera error 8.9 → 7.7 when added).
- **Consensus of the three best lane positions** instead of a single winner (all 13 RAMPS
  8.8 → 7.8).
- **Whole-view tracker at full resolution** (da Vinci red 123 → 138: the staged-ARTIFACT
  colours are placed with it).
- **Tracker fallback** (Brisbane blue 11 → 23).

**720p round (2026-10-01).** Measured on all 21 RAMPS, using lane-by-lane dumps of every
video with 27 lane positions (±2 ball radii across, ±1 along):
- **Lane choice matters less than it seemed.** Counting on the placed lane alone (no lane
  search) scores about the same as the consensus (8.5 against 8.6 before the held-level rule).
  Searching ±2 radii and taking the best path score is much worse (13.0; 720p 18.9). The path
  score rewards lanes that see more ball-like evidence, and at 720p those are lanes on a robot
  parked beside the RAMP. Choosing by "resting ball" evidence (median-filtered over 1 s) fails
  the same way.
- **Held levels at every resolution** (no 6 px gate) fixed 720p (9.9 → 6.5) but cost the
  high-scoring 240–360p RAMPS, where brief levels are real balls rolling through (Hawaii and
  da Vinci; 240/360p 7.8 → 9.4). Cutting only peaks entered by a jump of ≥ 2 or ≥ 3 balls in
  one frame did the same. Gating on the ball size keeps the gain and loses nothing.
- **Box-averaged sampling** (each point's colour averaged over 3×3 px at 720p, so the balls'
  holes blur as they do at low resolution) changed nothing useful (DC1 50 / 54).
- **Rail-based lane correction** (prototype only): sliding the CAD rails over bright thin lines
  finds DC1 red's 2–3 radius pose error, but only the across-RAMP shift is defined. It is not
  shipped, because the counts on that RAMP were dominated by robots at the GATE either way.
  Re-checked on 2026-10-03 on all 31 RAMPS (across-only profile, at the lock frame and ±1 s):
  - On DC1 red the profile is a broad plateau from 1.5 to 4.5 radii, not a peak.
  - Offsets over one radius elsewhere change from second to second (Atlanta, South East,
    Marshall blue).
  - North East blue, which counts exactly right, shows a 1.7-radius "offset".
  - No safe rule fires only on bad lanes.

**1080p round (2026-10-03)**, also measured on every RAMP:
- **A clearly dominant lane counting alone** (instead of the median of the three best) when
  its path score beats the next by 1.5×, 2× or 3×. At 3× it changes exactly one RAMP, DC1 blue
  with the app's pose (53 → 36). That is the case it was designed on. At 1.5× and 2× it helps
  some RAMPS and hurts others (Hawaii red with the app's pose +2 → +10). Not shipped.
- **Pan recovery from the static structure.** After a large pan (Brisbane North 360p, 108 s) a tracker
  can settle 25–45 px off and never re-anchor, because a crowded reference frame keeps the
  direct match under its inlier share. A re-anchor on corners of the GOAL and RAMP alone, seeded
  by a translation search of those areas, recovers the view when it fits (tag error 0.1–0.5
  px). But the search itself picks wrong offsets on that video: the correct position scored
  0.21, a wrong one 86 px away 0.36. Not shipped.

**Per-video tuning does not generalise.** A random search over 2,400 settings of the evidence
mix, adaptive thresholds and decoder costs found settings that fit the eight videos better.
But chosen on seven videos and tested on the eighth, they averaged **24.1** ARTIFACTS of error
against **8.8** for the untuned design; da Vinci was off by about 100 per RAMP. With this few
videos, knob-tuning overfits, so none of it ships. Every constant above is physical or was
checked on all eight videos.

Tried and rejected, because each helped some videos and hurt others (numbers are mean error
on the 13 RAMPS):
- **ARTIFACT colours re-learned on the RAMP** from a first decode, with or without
  safeguards. Unstable: Hawaii red collapsed to 9, and North East rose to 105 when the blue
  panel was learned as purple.
- **A lighting "cone"** (hue kept, lightness and saturation free), and a **hue-only colour
  model**: large over-counts where dark or shaded panels share the hue.
- **Colour-free slot-shift evidence** (a slot's median colour moving from its empty look), on
  its own, mixed with the colour evidence, or for rolling-ball entries. It separates occupied
  from empty slots well, but people and robots moving behind the RAMP make false entries.
- **Hidden-slot detection** (slots that never change, like those behind the Hawaii referee):
  it helped Hawaii blue's first minute but lost more later.
- **Averaging the lane positions' evidence**; **inner sample points only**; a **hard minimum
  queue drain** for a release; a **stiffer multi-ball jump cost**; a **higher colourfulness
  gate**.
- **Correcting the lane with the GOAL / blocker panels** (sliding their projected outline over
  the alliance colour). It recovers pose errors exactly on synthetic renders and fixed
  da Vinci red (138 → 145), but on real footage it sometimes locked onto other red and blue
  things (Hawaii blue 34 → 26).

## What is still hard

- **Tiny RAMPS** (ball under ~3.5 px radius, e.g. 240p from the far side): per-slot evidence
  is weak and noisy. The confidence says "low" and explains why.
- **A quick release-and-refill the camera cannot resolve.** At Hartland (360p, blue) the
  queue was drained and refilled at the start of teleop without ever looking empty from that
  angle, so 9 CLASSIFIED ARTIFACTS were missed.
- **People standing in front of the RAMP for long periods**, e.g. the Hawaii referee at the
  blue GATE end. Hidden slots are tolerated, but a long occlusion of the GATE end still hides
  releases. On that RAMP the purple balls also read almost grey at 240p (a* 2–17, against 37
  for the staged ones), so they are hard to tell from the empty RAMP.
- **ARTIFACTS passing straight through an open GATE.** Top alliances hold the GATE open
  while scoring: Hawaii red scored 27 in 30 s while its queue never held more than ~5. These
  balls are only seen rolling, and at 240–360p rolling balls are faint and blurred. This is
  the main cause of the da Vinci and Hawaii shortfalls.
- **Robots parked at the GATE end** (any resolution, worst at 720p). In DC1 a robot with green
  panels sat beside the blue GATE for long stretches. Its colour passes for queued balls, and
  because it stays it is not cut as a brief peak: blue +21.
- **Lane alignment.** At 240–360p a lane half a ball off can change a count by 10–20 in either
  direction, and at 720p the RAMP needs a pose good to about half a ball (~6 px). DC1's pose
  (GOAL overlap 0.5–0.7) put the red lane 2–3 radii off. The consensus of the best lane
  positions tames small errors, but the same video placed twice (Node and Chrome) can still
  differ by a few ARTIFACTS per RAMP.
  - On DC1 the two automatic placements differ more: 165 against 190 in from the field, FOV
    74° against 69°. That moves red from 59 to 33 and blue from 34 to 53, counted in Node with
    each pose. The live run in the app gave 35 and 63 (official 29 and 28).
- **Side-on views of the RAMP** (DC1 blue). From low at the audience end, the RAMP's white
  rails pass in front of the queued balls. Lane points land on rail, so a queue of 5–7 reads
  partly empty. The decoded level then swings and each swing is counted again: 53–63 against
  28.
  - The fix is to treat the rails as occluders, as the GOAL panels and blocker already are.
    That needs the rails' cross-sections from the official CAD; the field model has only
    their top edges.
- **Wide-angle phone lenses** (Marshall, 1080p). The pinhole camera model cannot follow the
  lens distortion. The placed blue lane runs up the GOAL panel to the AprilTag instead of along
  the rails, and blue counts 73 against 13. That RAMP is rated low confidence.
- **Recovering after a large pan** (Brisbane North finals M2, 360p, handheld). When the camera swings far away
  and back, the RAMP tracker can settle 25–45 px off for the rest of the match. A crowded
  reference frame (people at the field wall) keeps the direct re-anchor below its inlier
  share, so nothing pulls it back.
- **Resolution helps, but is not free.** 720p fixes the grey-looking balls of 240p (Hawaii blue
  34 → 43), but it also makes robot parts, arms and the balls' holes sharp. The held-level rule
  handles brief occluders; long ones remain.
- **Speed.** Offline analysis is ~100 ms per frame in the browser, on the main thread. A Web
  Worker and seeking fewer frames would help.
