# Auto Scouting — the broadcast score bar

When a video is an event broadcast (or a recording of one), the FTC Live score bar is in the
picture: the scorekeepers' live CLASSIFIED and OVERFLOW counts per alliance and the match clock.
Those numbers are the official ones, so the app reads them and scores with them. The RAMP
counter then runs as a check beside them.

Code: `lib/scouting/scoreboard.ts` (DOM-free), tests in `lib/scouting/scoreboard.test.ts` with
real bars cropped from four broadcasts (`lib/scouting/testdata/scorebar_*`). The digit
templates are in `lib/scouting/scoreboardDigits.json`. The page reads the native frame twice per
second of video (`readBarAt` in `app/video-scouting/auto/page.tsx`).

## Reading one frame (`readScoreBar`)

1. **Score row.** Rows whose outer thirds are red on one side and blue on the other. A row
   counts when its third is at least 15% one alliance colour and almost none of the other. A run
   of such rows counts when its two sides average at least 30% colour, it is 7–25% of the picture
   high, and it touches the top or bottom fifth.
   - The 15% row threshold is for the FIRST Championship layout in TELEOP (BASE boxes, three team
     numbers). There some rows are only ~25% panel colour at 720p.
   - Every candidate run is tried in turn. In overhead views the red and blue GOALS on either
     side of the field form a run too (MTI). The first run that has the bar's structure wins.
   - The structure is a white timer box between the panels, plus a stacked value-box pair in a
     panel.
2. **Timer and unit.** The timer is the widest run of middle columns with no panel colour. The
   layout unit is its width / 1.144 (180 px at 1080p).
   - Panel blue needs more green than red, so the motif's purple balls on the timer are not
     taken for blue.
3. **Value boxes.**
   - White rectangles in each panel.
   - The narrow stacked pair is OVERFLOW (upper, arrow) and CLASSIFIED (lower, ball icon).
4. **Digits.**
   - Glyphs are matched by normalised cross-correlation against templates cut from team-number
     boxes of seven broadcasts.
   - Counts are read only when the value box is at least `MIN_VALUE_BOX_PX` (13 px) high. At
     240p the boxes are 10 px and the readings came out wrong (Hawaii red 76 against 85); the
     clock's larger digits are still read there.

## Over the match (`ScoreBarTracker`)

- **Accepting a value.** A count changes only when the same new value is read twice in a row, so
  one misread frame cannot change the score. A scorekeeper's correction (a value going down) is
  accepted the same way.
- **Present.** The bar is present when it was seen in at least 6 readings and in most readings
  during the match. Intros, replays and interviews don't count against it.
- **Counts readable** (`countsReadable`). Both CLASSIFIED counts were read in most readings of the
  match. Otherwise only the clock is used: the window comes from the bar, the counts from the
  RAMP counter.
- **Match window from the clock.** FTC Live shows 2:30 before the match, counts 2:29 → 2:01 in
  AUTO, counts the transition down (0:08 → 0:01, or 0:15 at the Championship), then 2:00 → 0:00
  in TELEOP. TELEOP's start is the median of the TELEOP readings, the buzzer is 120 s later, and
  AUTO's start comes from the AUTO readings.
- **After the buzzer** (`settledAt`). The scorekeepers keep entering ARTIFACTS for a few seconds
  while the bar shows 0:00, sometimes with corrections downwards. In the benchmark this went up
  to 3 s after the buzzer (WA Tesla Q17: red 23 → 26 within a second, overflow 1 → 3 at +3 s).
  - The app keeps reading until the bar's numbers settle: the bar disappears, the clock runs
    again (the next match), nothing changes for `POST_QUIET_SEC` (5 s), or `POST_MAX_SEC` (30 s)
    pass.
  - "Match complete" is shown only then, so the score never rises after it.

## Benchmark (2026-10-06)

Every video with the bar, in Downloads\ArtifactIQ training videos, Downloads\ArtifactIQTrainigVids
and Downloads\ArtifactIQ new test videos. The comparison is the counts the app ends with against
FTCScout, CLASSIFIED and OVERFLOW for both alliances:

- **20 of 23 matches are exact**, from 360p to 1080p: Worlds (da Vinci, Ross), premier events,
  state championships, qualifiers and league meets, at the top or bottom of the picture, with
  either alliance on the left. That includes MTI's world record (206 / 146 CLASSIFIED) and N1
  in the app (32/7, 44/2).
- **The other 3 were corrected after the bar left the video**, so nothing in the video shows
  the official number:
  - T14 red: the bar went away 3 s after the buzzer at 129; the official count is 133.
  - T24 red: 24, official 23.
  - N3 red OVERFLOW: 1, official 0.
- **240p (Hawaii, 07):** the counts are not legible, so the app uses the RAMP counter. The clock
  is still read for the match window.

Videos where the bar is never found:
- team recordings;
- a venue's own score screen (N2, Worlds stands);
- the Thailand Championship stream's compact overlay (X05).
