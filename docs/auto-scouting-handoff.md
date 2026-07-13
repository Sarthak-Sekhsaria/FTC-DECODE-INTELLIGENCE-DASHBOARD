# Auto Scouting — Full Technical Handoff

Written as a complete-context dump so work can resume on Auto Scouting with zero
prior conversation history. Everything below reflects the **actual current code**
(read fresh from disk, not memory) as of this writing. Covers only Auto Scouting —
Prediction AI, Manual Scouting, and the landing pages are untouched and out of scope.

Test video used throughout: `da_Vinci_Finals_1_0.5x.mp4` (a real FTC Championship
match — "da Vinci Finals 1", RED alliance "Goodall" vs BLUE alliance "Lovelace"),
640×360, 409s duration, wide overhead broadcast angle showing the whole field.
Known real final score from the broadcast: **RED 454, BLUE 489** (this includes
auto + teleop + pattern + endgame; user confirmed pattern was 8 pts for red, so
artifact+other-auto-scoring alone should land close to these totals). This file is
not in the repo (too large / user-supplied) — get it fresh from the user to
re-test.

---

## 1. What Auto Scouting is

A browser-only computer-vision tool: user uploads/drops an FTC DECODE match video,
draws two small calibration boxes over each alliance's goal (a collection tube
artifacts drop into), and the app watches those two crops for purple/green
artifacts crossing a scoring line, awarding +3 per artifact live or via an offline
frame-by-frame pass. Everything runs client-side in the browser (canvas
`drawImage`/`getImageData` + JS), nothing is uploaded anywhere, and results are
in-memory only (never written to disk) per the original feature spec.

It is **explicitly phase-free**: there used to be an AUTO/TELEOP/ENDGAME phase
system (with separate counters per phase) — it was entirely removed per user
request. The detector now runs continuously through the whole video; every
artifact crossing a gate scores the same flat +3 regardless of timestamp. Pattern,
LEAVE, and endgame BASE are still separate **manual** inputs (not detected), and a
free-form manual point adjustment exists per alliance.

---

## 2. File map

```
app/video-scouting/auto/
  page.tsx                          — orchestrator: all state, the two detection
                                       loops (live + offline), all handlers, layout
  components/
    AutoVideoPlayer.tsx              — video element + upload dropzone + zone-box
                                       overlays (drawn as absolutely-positioned
                                       divs, not canvas) + color-sample click layer
    DebugPanel.tsx                   — "Detection Debug" panel: per-gate crop/mask
                                       canvases, live stats, clump-size sliders,
                                       test/analyze/clear/export buttons, log
    Scoreboard.tsx                   — RED/BLUE score cards (phase-free fields)
    EventList.tsx                   — event timeline list, filters, per-event
                                       confirm/reject/swap-alliance/mark-overflow,
                                       click-timestamp-to-seek
    ManualPanel.tsx                  — pattern / LEAVE / BASE / manual-adjustment
                                       inputs per alliance (steppers)
    AutoReport.tsx                   — final "view report" summary card

lib/scouting/
  cvDetector.ts                      — ALL pure CV/tracking logic (DOM-free, unit
                                       testable): color classification, blob
                                       detection, multi-artifact tracker
  cvDetector.test.ts                 — 19 unit tests for cvDetector.ts
  autoTypes.ts                       — ScoreEvent / AllianceManualEntry /
                                       AllianceScore types + computeAllianceScore
  autoScoring.test.ts                — 10 unit tests for autoTypes.ts scoring
  decodeRules.ts                     — shared point-value constants (no timing/
                                       phase config anymore — that was removed)

docs/
  decode-scouting-rules.md           — game-rules reference (Manual/Prediction/
                                       both scouting modes), not auto-scouting-CV-
                                       specific
  auto-scouting-handoff.md           — THIS FILE
```

Total current test count for the whole `lib/scouting` suite: **29 passing**
(`node --experimental-transform-types --test lib/scouting/*.test.ts`).

---

## 3. Detection pipeline (exactly how a frame is processed)

### 3.1 Zone sampling (`sampleZone` in page.tsx)
For each gate (red/blue), a `Zone` is `{ x, y, w, h, line }`, all **normalized
0..1** against the *real* video resolution (`video.videoWidth`/`videoHeight`),
never CSS/display size. `sampleZone` draws that rectangle of the current video
frame into a hidden `<canvas>` via `ctx.drawImage(video, ...)`, then reads back
`ImageData` (`Uint8ClampedArray` RGBA). This crop is the *only* region ever
analyzed — the rest of the field is never touched.

### 3.2 Color classification (`cvDetector.ts` → `classifyPixel` / `rgbToHsv`)
Every sampled pixel is converted RGB→HSV. A pixel is "purple" or "green" if its
saturation and value both clear per-gate floors (`minSat`, `minVal`) AND its hue
is within `tol` degrees of a target hue. Targets default to:
```ts
DEFAULT_TARGETS = [
  { label: "purple", hue: 285, tol: 45 },
  { label: "green",  hue: 130, tol: 50 },
]
```
Users can also **click-to-sample** an artifact's actual color on a paused frame
(`sampleColorAt` in page.tsx → `targetFromSample` in cvDetector.ts), which
overrides the default hue for that color using the real footage's lighting.

### 3.3 Candidate (blob) detection — `detectCandidates()`
This is the core "find every artifact in the crop" function. Runs 8-connectivity
connected-components labeling on a **strided grid** (stride 2, i.e. every other
pixel row/col, for speed) of the classified pixels. Purple and green are kept as
*separate* labels so two touching artifacts of different colors still come back
as two blobs. Each connected region above `minAreaFrac` (fraction of crop area)
becomes a `Candidate`:
```ts
interface Candidate {
  centerX: number;   // 0..1 within crop
  centerY: number;   // 0..1 within crop
  width: number;      // bbox width / crop width
  height: number;     // bbox height / crop height
  area: number;       // matched-pixel-count / total-grid-cells
  color: DetectedColor;
  matchedPixels: number;
}
```
Returns **every** candidate above threshold, sorted largest-first — never just
the biggest blob. This was a deliberate rewrite (see §6.2) replacing an earlier
single-blob-only detector.

### 3.4 Multi-artifact tracking — `GateMultiTracker`
One instance per gate. Given all candidates for a frame:
1. **Greedy nearest-neighbor match**: each candidate (largest first) links to the
   closest *unused* existing track within `maxMatchDist` (0.45 normalized units).
   Distance formula weights X (lane position) 2× more than Y (`X_WEIGHT = 2.0`) —
   artifacts move mostly vertically along the tube, so this tolerates large
   per-frame Y jumps (fast crossings, low frame rate) while still keeping two
   side-by-side artifacts in different "lanes" from merging into one track.
2. Matched tracks update position; unmatched candidates spawn new tracks.
3. Tracks unmatched this frame get `missing++`; tracks older than `maxMissing`
   (6 frames) are dropped — this is what makes a single dropped frame not lose
   the artifact.
4. **Crossing rule**: a track fires exactly once, the frame its centroid moves
   from `field` side to `goal` side of the scoring line (`sideOfLine()`), *and*
   it hasn't already fired (`track.counted`). Side is computed from `line` (0..1
   within crop) and `direction` (`"downward"` or `"upward"` — whichever way is
   "into the goal" for that camera angle/gate).
5. **No global gate lock.** This is the single most important design property:
   there is no "gate occupied / wait for empty" state. Each track is independent,
   so several artifacts crossing simultaneously, or back-to-back with the tube
   still full of other stacked balls, are each counted. (The *original*
   implementation had exactly this global lock and it was the root cause of a
   major undercounting bug — see §6.2.)

### 3.5 Clump / multi-count estimation (`makeCrossing()`)
When a track crosses, if `singleArtifactArea` is configured (>0) and the track's
blob `area` is > 1.6× that value, the crossing is assumed to represent *several*
touching/merged artifacts: `estimatedCount = round(area / singleArtifactArea)`,
clamped to `maxClump`. This produces a `CrossingEvent`:
```ts
interface CrossingEvent {
  trackId: number;
  centerX: number;
  color: DetectedColor;
  estimatedCount: number;   // usually 1
  uncertain: boolean;        // true when estimatedCount > 1
  confidence: "high" | "medium" | "low"; // based on track.seen (frames matched)
}
```
**As of the current shipped code, `singleArtifactArea` defaults to 0 for BOTH
gates — multi-count is OFF by default.** See §6.5–§6.6 for why (it caused
overshoot and amplified false positives). It is still fully wired and available
via the Debug panel's two clump-size sliders for a user who wants to chase the
exact match total and accept some overshoot risk.

---

## 4. Scoring model (`lib/scouting/autoTypes.ts`)

```ts
interface ScoreEvent {
  id: string;
  videoTime: number;              // seconds into video
  alliance: "red" | "blue";
  type: "classified" | "overflow"; // classified=3pts, overflow=1pt (official manual)
  color: "purple" | "green" | "unknown";
  points: number;                  // already includes ×count multiplier
  method: "cv" | "manual";
  status: "auto" | "confirmed" | "rejected";
  confidence: "high" | "medium" | "low";
  source?: "gate_detection" | "manual" | "test";
  zoneX?: number;                  // crossing x, used for dedup
  trackId?: number;
  count?: number;                  // artifacts this ONE event represents (clump)
  note?: string;                   // e.g. "Clump ×3 (area estimate) — review"
}
```
No `phase` field exists — this was deliberately removed (§6.1).

`computeAllianceScore(color, events, manualEntry)`:
- Filters to `alliance === color && status !== "rejected"`.
- `artifacts = sum of (e.count ?? 1)` over accepted events — **not**
  `accepted.length** — because one event can represent a multi-ball clump.
- `artifactPoints = sum of e.points` (already pre-multiplied by count at event
  creation time).
- `patternPoints = patternArtifacts × 2`, `leavePoints = robotsLeft × 3`,
  `endgamePoints` from BASE status (partial=5, full=10, both-full bonus=+10).
- `total` = sum of all of the above + free `manualAdjustment`.

Point values come from `decodeRules.ts` (official 2025-2026 manual Table 10-2):
classified=3, overflow=1, depot=1 (unused), pattern=2/artifact, leave=3/robot,
base partial=5, base full=10, both-full bonus=10.

---

## 5. Live detection loop (page.tsx, the big `useEffect` gated on `liveOn`)

**Dual driver**, a deliberate fix for a real bug (§6.3): both
`video.requestVideoFrameCallback` (rVFC) AND a `setInterval(..., 33)` watchdog
call the same `processAtTime(mediaTime)`, deduped by a 3ms epsilon so they never
double-process the same instant. Reason: rVFC is the "correct" API (fires once
per actually-presented frame, so it's speed-independent), but in at least one
tested environment (headless/offscreen renderer) it silently never fires at all —
so the interval is a safety net that keeps working even where rVFC is dead, while
being harmless (deduped) where rVFC works fine. Both read **media time**
(`video.currentTime` / the rVFC callback's `mediaTime`), not wall-clock time, so
detection is correct at 0.25×–2× playback and doesn't skip or double-count frames
when speed changes.

Each `processFrame(mediaTime)` call:
1. Checks the **buzzer** (`matchEndRef.current`): if `mediaTime >= matchEnd`,
   pause the video, set `matchComplete = true` once (one-shot via
   `matchEndedRef`), log it, and return — no more scoring happens past this
   point. (§7)
2. Checks `inWindow = mediaTime >= matchStart` — footage before match start never
   scores even if the buzzer isn't past yet.
3. Checks `newTerritory` via `scoredUpToRef` (a high-water mark) — only footage
   *ahead* of anything already scored creates new events. This is what makes
   seeking backward and replaying not create duplicate events (on seek, the
   trackers are also `.reset()` via the `seeking` event listener, and
   `scoredUpToRef` isn't rewound, so replayed old footage is inert).
4. Samples both zones, runs `detectCandidates` with each gate's own
   sensitivity-derived config, updates each gate's `GateMultiTracker`.
5. For each crossing (only if `newTerritory && inWindow`): updates diag counters,
   pushes a log line, and calls `addLiveEvents` which builds the actual
   `ScoreEvent` (deduped again by `alliance+trackId+time±0.4s` as a final
   same-frame-double guard) and does a functional `setEvents` update.
6. If Debug mode is on, repaints the crop-overlay canvases and color-mask
   canvases (throttled implicitly since this only runs when a frame is actually
   processed).

`onSeeking` handler: resets both trackers, resets `lastMediaTimeRef` (forces
reprocessing of the new position), and — if the new position is before the
buzzer — clears `matchComplete` and re-arms `matchEndedRef` so the results
banner disappears and scoring can resume (this lets a user scrub back and
re-watch/re-verify without the app staying "stuck" in the completed state).

## 6. Sensitivity → config translation (`candidateCfgFrom`)

```ts
function candidateCfgFrom(targets, sensitivity) {
  const s = Math.max(0.5, sensitivity);
  return {
    ...DEFAULT_CANDIDATE_CONFIG,
    targets,
    minSat: Math.max(0.1, 0.25 / s),
    minVal: Math.max(0.08, 0.18 / s),
    minCoverage: 0.03 / s,
    minAreaFrac: 0.012 / s,
  };
}
```
Higher sensitivity → lower saturation/brightness/coverage/area floors → catches
fainter, dimmer, smaller artifacts. Applied **per gate independently** (separate
red/blue sensitivity sliders and refs) because the two goal tubes in the test
footage are lit very differently (see §6.4). The `Math.max(0.1, ...)` /
`Math.max(0.08, ...)` floors exist specifically to stop sensitivity from going so
low that non-artifact dim/washed-out pixels (shadows, reflections, a green
intro-screen — see §6.6) start reading as artifacts; these floors were **raised**
in the most recent fix (were `0.05`/`0.04` before, which was too permissive).

---

## 7. Match window / buzzer feature (most recently added)

State: `matchStart` (number, default 0), `matchEnd` (number | null, default null
= no buzzer set), `matchComplete` (boolean). Refs mirror all three for the loop.

UI (in the "Live Detection" card): three buttons — **"Set start = m:ss"** (sets
`matchStart` to current playhead), **"Set buzzer = m:ss"** (sets `matchEnd`,
clears any prior completed state), **"Clear"** (resets both to defaults) — plus a
text readout: `Scoring 0:00 → 2:52 · auto-stops at buzzer`.

Behavior:
- Both the **live loop** and the **offline analysis pass** (`runAnalysis`) only
  score/analyze footage in `[matchStart, matchEnd ?? video.duration]`.
- When live playback's mediaTime reaches `matchEnd`, the video **auto-pauses**
  and a **"Match Complete — Final Results"** banner appears above the scoreboard
  showing RED total – BLUE total and the winner.
- Playing past the buzzer re-triggers the pause immediately (verified: pressing
  play again when already at/past the buzzer just re-pauses at the same
  timestamp, no further scoring).
- Seeking to before the buzzer clears `matchComplete` and re-arms the one-shot
  guard, so the banner disappears and you can replay through it again.
- New video upload resets `matchStart`→0, `matchEnd`→null, `matchComplete`→false.

**This was built specifically to solve the "score keeps climbing after the match
already ended" problem** — post-match ball handling in the tubes (teams/refs
touching the goals after the buzzer) was inflating totals if you let playback run
past match end. Always set a buzzer before trusting a "final" number.

---

## 8. Offline analysis pass (`runAnalysis` in page.tsx)

Alternative to live: seeks the video frame-by-frame (`step` = 0.12s "fast" / 0.07s
"balanced" / 0.04s "thorough", `detail` selector in UI) across
`[matchStart, matchEnd ?? duration]`, running the same `detectCandidates` +
`GateMultiTracker` logic at each step (fresh, non-live trackers — `.update()` per
seeked frame instead of per rendered frame). Replaces all `method:"cv"` events
with the new pass's results while preserving any `method:"manual"` events. Useful
because it's deterministic/repeatable and doesn't depend on the renderer actually
presenting frames — but it's **slower to run** (can take minutes for a full match
at "thorough") and, being coarser than live's frame-by-frame sampling in
practice, sometimes gives visibly different (sometimes lower) totals than a live
run over the same footage — this discrepancy was observed directly and is not
fully resolved (see §9 Known Issues).

---

## 9. Debug tooling (`DebugPanel.tsx` + supporting page.tsx handlers)

Toggled by the "Debug: ON/OFF" button. Shows:
- **Per-gate card** (red/blue): a live "raw crop + candidate boxes" canvas
  (`drawCropWithOverlay` in page.tsx — draws the actual crop upscaled ~280px,
  with the scoring line, a direction arrow, "field"/"goal" text labels, every
  candidate's bounding box + center dot + `A1`/`A2`/... id label in the
  candidate's own color, and a green flash overlay "COUNTED +3" for ~700ms after
  a crossing) and a separate "color mask" canvas (`computeMaskImage` — every
  pixel recolored to bright purple/green/dark-grey per its classification, a
  quick visual sanity check independent of blob detection).
- Live stats: frames processed, detector running yes/no, objects found this
  frame, crossings this frame, total crossings, artifact count, artifact score
  (points), last event, and a direction-reverse button per gate.
- **Clump-size sliders** (0 to 0.08, step 0.0005) per gate — this is
  `redSingleArea`/`blueSingleArea`, i.e. `singleArtifactArea` in the tracker
  config. Shown as "off" when 0.
- Buttons: **Test RED artifact** / **Test BLUE artifact** (adds a manual +3 test
  event immediately — verifies the render/scoring pipeline independent of CV),
  **Analyze current frame** (runs detection once on the paused frame, logs
  per-candidate details: color, position, which side of the line, matched-pixel
  count — does NOT create a scoring event, purely diagnostic), **Reset test
  scores** (removes only `source:"test"` events), **Clear automatic events**
  (removes only `method:"cv"` events and resets crossing counters + the
  `scoredUpToRef` high-water mark), **Export debug log** (downloads a JSON blob
  of the full diag state + events + all calibration values).
- A scrolling log pane (last 50 of up to 300 lines), fed by `pushLog()` calls
  throughout the loop — every crossing, test, analyze, clear, and match-complete
  event is logged with a timestamp.

---

## 10. Current calibration defaults (exact, as shipped)

```ts
// page.tsx top-level constants
DEFAULT_RED_ZONE   = { x: 0.63, y: 0.03, w: 0.09, h: 0.4,  line: 0.5 }
DEFAULT_BLUE_ZONE  = { x: 0.28, y: 0.03, w: 0.08, h: 0.42, line: 0.5 }
DEFAULT_RED_SENSITIVITY  = 3      // slider range 0.5–5
DEFAULT_BLUE_SENSITIVITY = 2.1    // slider range 0.5–5
MAX_SENSITIVITY = 5
DEFAULT_RED_SINGLE_AREA  = 0      // multi-count OFF by default
DEFAULT_BLUE_SINGLE_AREA = 0      // multi-count OFF by default
DEFAULT_RED_MAX_CLUMP  = 3        // cap even if user raises the slider above 0
DEFAULT_BLUE_MAX_CLUMP = 3

// cvDetector.ts / trackerCfgFrom
maxMatchDist = 0.45   (X_WEIGHT = 2.0 in the distance formula)
maxMissing   = 6      (frames before a track is dropped)

// candidateCfgFrom
minSat      = max(0.1,  0.25/sensitivity)
minVal      = max(0.08, 0.18/sensitivity)
minCoverage = 0.03/sensitivity
minAreaFrac = 0.012/sensitivity
sampleStride (from DEFAULT_CANDIDATE_CONFIG) = 2
```

**These zone/sensitivity defaults are specifically tuned to this one video's
camera framing** (a wide overhead championship broadcast shot, goals at roughly
x≈0.28 blue / x≈0.63-0.69 red, ~y0.03-0.45 vertically). On any other footage
these are just a starting point — re-drag the boxes onto the actual goal tubes
and re-tune sensitivity per gate.

Rationale for why red's default sensitivity (3) is higher than blue's (2.1): the
red goal tube sits in visibly darker shadow in this footage than the blue one, so
it needs lower color floors to see the same balls blue sees easily. This was
empirically confirmed multiple times (§6.4, §6.5).

Rationale for clump defaults being 0 (off): see §6.6 — the multiplier caused
serious overshoot and dangerously amplified a false-positive source. Suggested
*manual* tuned values if you want to re-enable it and chase the exact match
total, from earlier testing: red ≈0.013, blue ≈0.015, understanding it will
overshoot somewhat and is less stable run-to-run.

---

## 11. Chronological history — every bug found and fix applied

This is the part most worth reading before touching anything again; the same
mistakes are easy to repeat.

### 6.1 — Phase system removed
Original app had PRE_MATCH/AUTONOMOUS/TELEOP/ENDGAME phases with separate
counters/points per phase (`decodeRules.ts` had timing config, `ScoreEvent` had
a `phase` field, there was a `PhaseTimeline.tsx` component, phase filters in
`EventList`, separate `autoPatternArtifacts`/`teleopPatternArtifacts` fields).
User explicitly requested full removal: "Remove the phase system from Auto
Scouting... detector should run continuously... every valid artifact scores the
same +3 regardless of video timestamp." Removed everywhere; `PhaseTimeline.tsx`
deleted; `ManualPanel` merged the two pattern fields into one `patternArtifacts`.

### 6.2 — Root cause of severe undercounting: the ORIGINAL detector was a single
global state machine
Before the current `GateMultiTracker`, detection used a `GateLineTracker` with
states `CLEAR → PRESENT_FIELD → CROSSING_CONFIRMED → WAITING_FOR_CLEAR`. It
tracked **one artifact at a time** and **locked the entire gate** until it went
back to empty. This is fundamentally incompatible with a goal that's a
collection tube that **stays full of stacked balls** — the gate essentially never
returns to "empty," so it gets stuck in `WAITING_FOR_CLEAR` and stops scoring
almost immediately. This was diagnosed by extracting real video frames
(`ffmpeg`) of the goal tubes and visually confirming they're narrow single-file
channels with several balls resting in them at once — a single global lock
cannot possibly work here.

**Fix**: rewrote `cvDetector.ts` from scratch — `detectCandidates()` (all blobs,
not just one) + `GateMultiTracker` (per-candidate independent tracks, no global
gate lock, only ONE per-track `counted` flag). This is the current
implementation described in §3.

### 6.3 — `requestVideoFrameCallback` silently never firing
(This was actually found even earlier, in initial live-detection work.) In the
tested headless/offscreen renderer, `typeof video.requestVideoFrameCallback ===
"function"` is true but the callback **never actually gets invoked** — a direct
probe confirmed 0 calls during playback. The code had a fallback that only
activated if rVFC was *absent* (`typeof !== "function"`), so nothing ever
substituted for the dead callback and detection simply never ran.

**Fix**: the dual-driver approach in §5 — rVFC AND a `setInterval(33ms)` both
call the same deduped `processAtTime`, so detection works whether or not the
environment's rVFC actually fires.

### 6.4 — Real footage is a wide overhead shot with goal TUBES, not close-up boxes
First real-video test with the rewritten multi-tracker gave **RED=5, BLUE=38**
artifacts for the full match — way off (target ~130-150 each). Investigation
(pixel-density heatmap across the frame, aggregated over many timestamps) showed
the camera is a **wide shot of the entire field from above**, and the goals are
**vertical collection tubes** at roughly x≈0.31 (blue) and x≈0.67-0.69 (red), not
simple boxes near the camera. The **red tube specifically sits in shadow** —
much dimmer than blue — so the shared/global color thresholds that worked for
blue were far too strict for red.

**Fix**: made sensitivity **per-gate** (separate red/blue state, refs, sliders)
instead of one global sensitivity value. Iteratively tuned red up (2.2 → 3 → 5 at
different points — see 6.5) while blue stayed lower (found accurate around 2.1).
Also recentered the zone boxes precisely on the measured tube x-positions via
targeted pixel-density profiling (not just eyeballing the video).

### 6.5 — Chasing the exact 454/489 target: sensitivity + area-based multi-count
Full-match live runs at increasing red sensitivity kept improving red's count
(2.2→9 crossings in a test window, 3→10, 5→much higher over the full match) —
user explicitly reported "the higher I put sensitivity for red, the more
accurate, nearer to the actual score it became" after checking against a
known-correct intermediate score (RED ≈126 after auto minus 8 pattern points,
app was giving only 90). This confirmed red was still genuinely undercounting at
that point and pushing sensitivity higher was net-positive *at that time*
(before the clump multiplier existed).

To close the remaining gap to 454/489, investigated **why** artifacts were still
missed even at high sensitivity: extracted a time-lapse frame montage of each
goal tube and found artifacts travel **single-file down a narrow chute**, often
with several already resting in the column — a moving-blob tracker can
legitimately fail to register a "field→goal crossing" for an artifact that drops
in too fast/small to be seen on the field side first (it's only ever visible
already merged into the stack). Measured blob-area distribution and found most
blobs were single-ball sized (not big merged clumps), meaning burst-merging
wasn't the dominant loss — but user insisted on trying every lever anyway.

Implemented the **area-based multi-count** (§3.5): a big blob is assumed to be N
touching balls, `points`/`count` scaled by N. This was NOT previously wired into
actual scoring (the `estimatedCount`/`uncertain` fields existed in
`CrossingEvent` but weren't multiplied into points before this point) —
`computeAllianceScore`'s `artifacts` field was changed from `accepted.length` to
`sum of (count ?? 1)`.

Result: RED went from ~102/306pts (multiplier off, full match) to **156
artifacts / 468 points** at match-end (verified by auto-stopping playback right
at the buzzer, before post-match noise), BLUE similarly to **170/510**, both
within ~3-4% of the 454/489 targets. This was initially reported as a success.

**But this introduced a new problem** — see 6.6.

### 6.6 — THE BIG REGRESSION: overshoot + pre-match false-positive scoring
User reported two things after further live testing on their own machine:
1. "Blue overshot by quite a lot" (worse than my verification runs showed) while
   red only slightly undershot — i.e. **run-to-run variance**, not a fixed bias.
2. "Before the match actually starts it somehow starts detecting artifacts...
   score went up to 51 when the match didn't even start."

**Root cause of (1) — blue variance/spikes**: the bright, fully-lit, tightly
packed blue tube occasionally has its whole stacked column read as **one giant
connected blob** (because it's bright and uniform, the color classifier connects
a huge contiguous region). The area-based multiplier then turns that single
giant blob into "many balls scoring at once" — a huge spike. This doesn't happen
every run (depends on exact frame timing/exposure), hence the variance the user
saw but I didn't reproduce identically.

Fix attempt 1: added a `maxClump` cap (max balls one blob can represent) to
`TrackerConfig`, applied **globally** at first (cap=4). This reduced blue's
spikes but ALSO reduced red — which was already undercounting and explicitly
should NOT be trimmed. Wrong direction for red.

Fix attempt 2: made the cap **per-gate**: tried `DEFAULT_RED_MAX_CLUMP=8` (later
even `20`, i.e. effectively uncapped) for red (never trim its bursts, since it
undercounts) and `DEFAULT_BLUE_MAX_CLUMP=3` (tight, prevents the whole-column
spike) for blue. This did stabilize blue in verification runs.

**Root cause of (2) — pre-match green intro screen**: extracted a frame at t=5s
and found the video shows a **full-screen green "FIRST TECH CHALLENGE / FIRST
AGE" intro graphic** before the match actually starts (confirmed via the
broadcast's own on-screen clock: frozen at "2:30" — not yet counting down —
until roughly t≈11s). Green is one of the two artifact target hues, so **both
gate boxes see the entire screen as a giant animating green blob** during the
intro, and the (at-the-time uncapped-for-red, high-sensitivity) detector counted
this as dozens of artifacts. This bug **always existed as a latent risk** (the
intro was always green) but was only bad enough to notice once sensitivity was
cranked high (red=5) and the clump multiplier could turn one false green blob
into 10-20x amplified fake points.

**Combined fix (current shipped state)**:
1. `DEFAULT_RED_SENSITIVITY`: **5 → 3** (dialed back from max; still higher than
   blue's 2.1, but not aggressive enough to treat washed-out non-artifact pixels
   as real).
2. `candidateCfgFrom` floors raised: `minSat` floor `0.05→0.1`, `minVal` floor
   `0.04→0.08` — makes even a cranked-up sensitivity slider less likely to treat
   dim/grey/reflective non-artifact pixels as artifacts.
3. `DEFAULT_RED_MAX_CLUMP`: **20 → 3** (both gates now capped tight at 3 — a
   real touching-ball burst is small; nothing legitimate needs a cap above 3).
4. **`DEFAULT_RED_SINGLE_AREA` and `DEFAULT_BLUE_SINGLE_AREA` both set to `0`
   (multi-count OFF by default) — this is the big one.** Verified directly: with
   the multiplier off entirely, red's clean crossing count in the early match
   (t15-36s, using the match-start gate to skip the intro) was **10 vs a real
   value of 9** read off the broadcast overlay at that timestamp — i.e.
   accurate and stable. With the multiplier on, the SAME window could read
   3× higher on a bad run. The multiplier "roughly averages out" to near the
   true total over a full match in aggregate on this one video, but is volatile
   locally and dangerously amplifies any false-positive source. Traded "hits
   454/489 almost exactly" for "accurate and stable, but the raw total will read
   noticeably below the true final score" — considered the right tradeoff, but
   this is a deliberate accuracy-vs-exactness choice the user should know about
   (see §12).
5. Users can still manually push `redSingleArea`/`blueSingleArea` up via the
   Debug sliders (0 to 0.08 range) if they want to chase the higher, closer-to-
   454/489 number and accept the overshoot/instability risk — it's opt-in now,
   not forced.
6. **The match-start gate is now the correct way to exclude the intro/pre-match
   entirely**: verified that setting `matchStart` to just after the intro (e.g.
   t=15s in this video) makes the entire pre-match period (t0-14, including the
   full green screen) score **exactly 0** for both alliances. This should always
   be set before trusting any live run's numbers.

**Net current behavior**: accurate, stable, low-noise, but the raw full-match
total will land noticeably below 454/489 if multi-count stays off (see §12 for
what an honest current re-test would likely show — this has not been re-verified
end-to-end since this last fix, only the sub-pieces were verified in isolation:
pre-match=0 confirmed, red clean-count-vs-real confirmed for one 21s window).

---

## 12. What is verified vs. what still needs a fresh full-match re-test

**Verified after the most recent (§6.6) fix:**
- Pre-match window (t0-14s, includes the full green intro) → RED=0, BLUE=0
  points, with `matchStart` set to 15s. ✅
- Red clean crossing count (multiplier off) in window t15-36s → 10 detected vs
  9 real (read off broadcast overlay). ✅ Accurate in this small sample.
- Build compiles clean, all 29 unit tests pass, after every change in this
  history. ✅

**NOT yet re-verified after the §6.6 fix (do this first when resuming):**
- A **full match, live, buzzer-bounded** run with the current shipped defaults
  (red sens 3, blue sens 2.1, both clumps off, both max-clump 3) has not been
  played start-to-finish and compared against 454/489. Given multi-count is now
  off, expect the raw total to be **meaningfully below** 454/489 (previous
  multiplier-off full-match numbers, from an earlier point in this history with
  slightly different zone/sensitivity values, were RED≈102/306pts,
  BLUE≈123/369pts — treat as a rough floor estimate, not exact, since zones and
  floors have since changed).
- Whether the raised `minSat`/`minVal` floors (0.1/0.08) cost any *real*
  detections in the red tube (they were raised specifically to reject the green
  intro, but could also reject some genuinely dim balls — this tradeoff hasn't
  been quantified).
- Whether the offline analysis pass, run with current defaults, agrees with a
  live run over the same match window (earlier testing showed these two methods
  can diverge — never root-caused why).

**Honest, permanent limitation of this approach** (independent of tuning): this
is a wide, ~30fps overhead broadcast shot, and artifacts drop into a filling,
translucent, single-file tube. A blob/crossing-line detector on this kind of
footage has an inherent ceiling — some artifacts genuinely never present a
clean "field-side then goal-side" transition before merging into the stack. The
multi-count/clump multiplier was an attempt to compensate for this by inference
(area math) rather than by actually seeing the crossing, which is inherently a
noisier, less trustworthy signal than a real detected crossing — hence why it
was turned off by default in favor of stability. **The single biggest lever for
actually closing the gap to 454/489 would be better source footage** — a
closer, steadier per-goal camera where each entry is large/slow enough to
register a clean crossing — not further CV tuning on this camera angle.

---

## 13. Testing methodology used throughout (useful to repeat)

- **Video injection**: the harness's file-picker dialog is blocked in the
  automated browser, so testing used a synthetic `DragEvent('drop')` with a
  `DataTransfer` holding a `File` built from `fetch()`-ed bytes of the video
  (copied temporarily into `public/__test_clip.mp4`, always deleted after
  testing — **never commit a test video to the repo**).
  ```js
  const res = await fetch('/__test_clip.mp4'); const buf = await res.arrayBuffer();
  const file = new File([buf], 'name.mp4', { type: 'video/mp4' });
  const dt = new DataTransfer(); dt.items.add(file);
  dropzoneEl.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt }));
  ```
- **Reading live state**: `javascript_tool` snippets read `document.body.innerText`
  and regex out scoreboard numbers (`RED ALLIANCE...Artifact points\n(\d+)` etc.)
  or the diag status line, rather than screenshotting (screenshots of a
  `<video>`-containing page frequently timed out in this environment — text
  extraction was far more reliable).
- **Driving playback for a bounded test**: `v.playbackRate=1; v.currentTime=T;
  v.play();` then poll every ~25-29s (must stay under the tool's ~30s timeout)
  reading back the scoreboard. For an exact stop point, poll a `setInterval`
  that calls `v.pause()` once `v.currentTime >= target`.
- **Ground-truth extraction**: `ffmpeg` (available on this machine at a WinGet
  path) was used extensively to pull single frames or crops at specific
  timestamps for visual inspection — both to see the actual goal geometry (crop
  a strip and view it with the `Read` tool) and to read the broadcast's own
  on-screen score/clock/artifact-counter overlay as ground truth to compare
  against. Example:
  ```
  ffmpeg -y -ss <t> -i <video> -frames:v 1 -vf "crop=W:H:X:Y,scale=<w>:-1" out.jpg -loglevel error
  ```
- **Locating the actual goal tube position precisely** (rather than eyeballing):
  ran a JS snippet in-browser that seeks to several timestamps, classifies every
  pixel in a broad region, and aggregates a per-column (or per-band) histogram
  of matched-pixel density, then finds the peak — this is how the exact tube
  x-centers (blue≈0.28-0.31, red≈0.63-0.69) were determined.
- **Diagnosing the multiplier overshoot**: compared "multiplier off" vs
  "multiplier on" crossing counts over the *same* short window against a
  broadcast-read ground truth, rather than only ever looking at multiplier-on
  full-match totals — this is what revealed the 10-vs-9 accurate baseline and
  proved the multiplier itself (not the base detector) was the source of
  overshoot.
- Free the dev server's port before each fresh verification run (an orphaned
  `node.exe` on port 3000 from a previous session is common in this environment
  — check with `Get-NetTCPConnection -LocalPort 3000 -State Listen` in
  PowerShell and kill it before `preview_start`).

---

## 14. Ideas not yet tried / possible next steps

- Re-verify a full buzzer-bounded live match run against 454/489 with the
  **current** shipped defaults (this is the immediate next step — see §12).
- Quantify whether the raised color floors (§6.6 fix) cost real red detections,
  not just reject the green intro — e.g. compare candidate counts on a genuinely
  dim real ball before/after the floor change.
- Investigate why live vs. offline analysis can diverge on the same footage/
  window — never root-caused.
- Consider a per-gate **tripwire/pulse** approach instead of (or blended with)
  blob-crossing tracking for the single-file chutes specifically — was discussed
  as a hypothesis (measuring color coverage in a thin fixed band and counting
  rising-edge pulses, like a physical beam-break sensor) but not implemented;
  early manual probing suggested band width/placement is finicky and it wasn't
  pursued to completion.
- If chasing the exact 454/489 total is a priority again, re-enabling
  multi-count with the suggested tuned values (red≈0.013, blue≈0.015) plus the
  now-tighter maxClump=3 cap (which didn't exist during the original multiplier
  testing) might land closer with less overshoot than before — this specific
  combination (multiplier ON + cap=3 + tighter floors) has NOT been tested yet
  and is a reasonable first experiment.
- A visible on-screen "match clock" overlay/marker synced to the user's
  Set-start/Set-buzzer clicks (currently only shown as a text readout) could
  make the match-window feature easier to use.
- OCR-reading the broadcast's own on-screen artifact-count overlay was floated
  as a way to get exact ground truth automatically instead of manually reading
  frames — never implemented, flagged as fragile/out of scope at the time.

---

## 15. Quick-start for resuming work

1. `cd` to the project, `npx next build` to confirm the current state still
   compiles, `node --experimental-transform-types --test lib/scouting/*.test.ts`
   to confirm 29 tests still pass.
2. Get the test video from the user again (not in the repo). Copy it to
   `public/__test_clip.mp4` for browser-based testing, delete it when done.
3. Read §12 first — that's the actual open TODO.
4. When testing live, ALWAYS set a `matchStart` (after any intro) and a
   `matchEnd`/buzzer before trusting a number — see §7 and §6.6.
5. Any tuning of sensitivity/clump values should be tested against a short,
   ground-truth-checkable window (via ffmpeg frame extraction of the broadcast's
   own overlay) BEFORE trusting a full-match run — this is the methodology that
   actually caught the overshoot bug; full-match-only testing missed it.
