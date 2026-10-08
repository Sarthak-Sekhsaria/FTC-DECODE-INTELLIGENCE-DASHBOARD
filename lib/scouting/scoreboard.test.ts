// The FTC Live score bar reader: real bars from four broadcasts (testdata/scorebar_*.rgb.gz, the
// score row of one frame each, values read by eye), and the reading-over-time logic on
// synthetic clock / count sequences.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { readScoreBar, ScoreBarTracker, unpackDigits, type PackedDigits, type ScoreBarReading } from "./scoreboard.ts";

const bank = unpackDigits(JSON.parse(fs.readFileSync(new URL("./scoreboardDigits.json", import.meta.url), "utf8")) as PackedDigits);

// The broadcast frame the fixture came from: its score rows pasted into a grey frame of the
// original size.
function fixtureFrame(id: string) {
  const meta = JSON.parse(fs.readFileSync(new URL(`./testdata/scorebar_${id}.json`, import.meta.url), "utf8")) as { width: number; height: number; y0: number; rows: number };
  const rgb = zlib.gunzipSync(fs.readFileSync(new URL(`./testdata/scorebar_${id}.rgb.gz`, import.meta.url)));
  const data = new Uint8ClampedArray(meta.width * meta.height * 4).fill(128);
  for (let y = 0; y < meta.rows; y++)
    for (let x = 0; x < meta.width; x++) {
      const i = ((meta.y0 + y) * meta.width + x) * 4, o = (y * meta.width + x) * 3;
      data[i] = rgb[o];
      data[i + 1] = rgb[o + 1];
      data[i + 2] = rgb[o + 2];
      data[i + 3] = 255;
    }
  return { data, width: meta.width, height: meta.height };
}

test("score bar: real broadcasts — 1080p, 720p with blue on the left and the bar cut off, 360p at the top, the World Championship with three teams", () => {
  const cases: [string, number, [number, number], [number, number]][] = [
    // id, clock (s), red classified/overflow, blue classified/overflow
    ["12", 65, [12, 2], [8, 0]],
    ["09", 71, [18, 5], [17, 5]],
    ["01", 61, [21, 1], [26, 2]],
    ["08", 72, [91, 0], [91, 0]],
  ];
  for (const [id, clock, red, blue] of cases) {
    const r = readScoreBar(fixtureFrame(id), bank);
    assert.ok(r, `${id}: bar found`);
    assert.equal(r!.clock, clock, `${id}: clock`);
    assert.deepEqual([r!.red.classified, r!.red.overflow], red, `${id}: red`);
    assert.deepEqual([r!.blue.classified, r!.blue.overflow], blue, `${id}: blue`);
  }
  assert.equal(readScoreBar(fixtureFrame("09"), bank)!.layout.left, "blue");
});

test("score bar: a frame without the bar reads nothing", () => {
  const W = 640, H = 360;
  const data = new Uint8ClampedArray(W * H * 4);
  // a field-like picture: grey floor with a red and a blue block (GOALS) — not a score bar
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const goal = y > 40 && y < 140 ? (x > 60 && x < 160 ? [200, 30, 40] : x > 480 && x < 580 ? [20, 90, 200] : null) : null;
      data.set(goal ? [...goal, 255] : [120, 120, 125, 255], i);
    }
  assert.equal(readScoreBar({ data, width: W, height: H }, bank), null);
});

// a reading as readScoreBar returns it (the layout is not used by the tracker)
const reading = (clock: number | null, rc: number | null, ro: number | null, bc: number | null, bo: number | null): ScoreBarReading =>
  ({ clock, red: { classified: rc, overflow: ro }, blue: { classified: bc, overflow: bo }, layout: null as never });

// The FTC Live clock for a match starting at video time `start` (2:30 before it, AUTO, the
// transition countdown, TELEOP, then 0:00), read every 0.5 s from `from` to `to`.
function clockAt(t: number, start: number, transition: number): number {
  const e = t - start;
  if (e < 0) return 150;
  if (e < 30) return 150 - Math.floor(e);
  if (e < 30 + transition) return transition - Math.floor(e - 30);
  const te = e - 30 - transition;
  return te >= 120 ? 0 : 120 - Math.floor(te);
}

test("score bar over time: the match window from the clock (8 s and 15 s transitions, and a video starting mid-match)", () => {
  for (const [transition, from] of [[8, 0], [15, 0], [8, 60]] as const) {
    const start = 12.3;
    const tr = new ScoreBarTracker();
    for (let t = from; t <= start + 30 + transition + 125; t += 0.5) tr.push(t, reading(clockAt(t, start, transition), 0, 0, 0, 0));
    const w = tr.window()!;
    assert.ok(w, `window (${transition} s, from ${from})`);
    const teleop = start + 30 + transition;
    assert.ok(Math.abs(w.teleopStart - teleop) <= 0.5, `TELEOP ${w.teleopStart} vs ${teleop}`);
    assert.ok(Math.abs(w.buzzer - (teleop + 120)) <= 0.5, `buzzer ${w.buzzer}`);
    assert.ok(Math.abs(w.start - start) <= 0.6, `start ${w.start} vs ${start} (${transition} s, from ${from})`);
    assert.equal(w.transitionSec, from > 0 ? 8 : transition);
    assert.equal(w.final, true);
  }
});

test("score bar over time: one misread frame does not change a count; a scorekeeper's correction does", () => {
  const tr = new ScoreBarTracker();
  const seq: [number, number][] = [[0, 0], [0.5, 0], [1, 1], [1.5, 1], [2, 1], [2.5, 7], [3, 1], [3.5, 2], [4, 2], [4.5, 3], [5, 3], [5.5, 2], [6, 2], [6.5, 2]];
  for (const [t, c] of seq) tr.push(t, reading(100, c, 0, 0, 0));
  // the lone 7 (a misread) never counted; 3 was corrected back down to 2
  assert.equal(tr.countsAt(2.9)!.red.classified, 1);
  assert.equal(tr.countsAt(5.2)!.red.classified, 3);
  assert.equal(tr.countsAt(6.5)!.red.classified, 2);
  assert.deepEqual(tr.scoringTimes("red", "classified"), [1.5, 4]);
});

test("score bar after the buzzer: late entries and corrections count until the counts settle", () => {
  // TELEOP ends at 100 s (the clock reads 0:00 from then on). The scorekeepers enter three more
  // ARTIFACTS within a second, correct one away at +2.5 s, and the bar stays up for 20 s.
  const tr = new ScoreBarTracker();
  const counts = (t: number) => (t < 100 ? 20 : t < 100.5 ? 21 : t < 101 ? 22 : t < 102.5 ? 23 : 22);
  for (let t = 0; t <= 120; t += 0.5) tr.push(t, reading(t < 100 ? Math.max(1, 100 - Math.floor(t)) : 0, counts(t), 0, 5, 0));
  const w = tr.window()!;
  assert.ok(Math.abs(w.buzzer - 100) <= 0.6, `buzzer ${w.buzzer}`);
  const settled = tr.settledAt()!;
  // the last change was accepted at 103 s (read twice): final 5 s later
  assert.ok(Math.abs(settled - 108) <= 0.6, `settled ${settled}`);
  assert.equal(tr.countsAt(settled)!.red.classified, 22);
  assert.equal(tr.scoringTimes("red", "classified", settled).length, 22);
});

test("score bar after the buzzer: final when the bar goes away or the next match starts; not before", () => {
  const run = (end: number, next: boolean) => {
    const tr = new ScoreBarTracker();
    for (let t = 0; t <= end + 10; t += 0.5) {
      if (t <= end) tr.push(t, reading(t < 100 ? Math.max(1, 100 - Math.floor(t)) : 0, t < 101 ? 30 : 31, 1, 2, 0));
      else tr.push(t, next ? reading(150, 0, 0, 0, 0) : null);
    }
    return tr;
  };
  // the bar is gone 102.5 s on: final at its last reading, with the late entry
  const gone = run(102.5, false);
  assert.ok(Math.abs(gone.settledAt()! - 102.5) <= 0.01, `gone ${gone.settledAt()}`);
  assert.equal(gone.countsAt(gone.settledAt()!)!.red.classified, 31);
  // the next match's 2:30 shows: its zeros never replace this match's counts
  const next = run(102.5, true);
  assert.ok(Math.abs(next.settledAt()! - 102.5) <= 0.01, `next ${next.settledAt()}`);
  assert.equal(next.countsAt(next.settledAt()!)!.red.classified, 31);
  // read only up to 2 s after the buzzer: not final yet
  const early = new ScoreBarTracker();
  for (let t = 0; t <= 102; t += 0.5) early.push(t, reading(t < 100 ? Math.max(1, 100 - Math.floor(t)) : 0, 30, 1, 2, 0));
  assert.equal(early.settledAt(), null);
});
