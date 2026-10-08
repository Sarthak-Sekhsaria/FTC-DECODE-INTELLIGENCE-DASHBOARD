// RAMP queue counter: decoding and counting on synthetic slot evidence, and the per-point
// evidence model on synthetic colours.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOTS, type Lab } from "./rampState.ts";
import { assessQuality, countRamp, DEFAULT_RAMP_QUEUE_CONFIG as CFG, decodeQueue, fillPeriods, frameEvidence, heldLevels, learnAppearance, type RampAppearance } from "./rampQueue.ts";

const PTS = 10; // sample points per slot
const EMPTY: Lab = [60, 5, 5];
const PURPLE: Lab = [45, 30, -25];
const GREEN: Lab = [58, -38, 12];

function appearance(radius = 6, staged = true): RampAppearance {
  const slotOfPoint = Array.from({ length: SLOTS * PTS }, (_, i) => Math.floor(i / PTS));
  const empty = Array.from({ length: 6 }, () => Float32Array.from(slotOfPoint.flatMap(() => EMPTY)));
  const colours = staged ? { purple: [PURPLE, PURPLE, [46, 31, -24] as Lab], green: [GREEN, [57, -37, 12] as Lab] } : { purple: [], green: [] };
  return learnAppearance(slotOfPoint, new Array(SLOTS).fill(radius), new Array(SLOTS).fill(1), empty, colours);
}

// Evidence for a scripted queue: slots below `level` hold balls, `extra` marks single slots
// that look like a ball (rolling past) and `hidden` queued slots that look empty for a frame.
function evidence(levels: number[], extra: [number, number][] = [], hidden: [number, number][] = []) {
  const T = levels.length;
  const llr = new Float64Array(T * SLOTS);
  const colour = new Int16Array(T * SLOTS);
  for (let t = 0; t < T; t++)
    for (let k = 0; k < SLOTS; k++) {
      llr[t * SLOTS + k] = k < levels[t] ? 40 : -40;
      colour[t * SLOTS + k] = k < levels[t] ? (k % 3 === 2 ? -PTS : PTS) : 0;
    }
  for (const [t, k] of extra) llr[t * SLOTS + k] = 40;
  for (const [t, k] of hidden) llr[t * SLOTS + k] = -40;
  return { llr, colour };
}

// Level script: `steps` of [level, frames].
function script(steps: [number, number][]): number[] {
  return steps.flatMap(([l, n]) => new Array(n).fill(l));
}

test("queue fills one ARTIFACT at a time, releases, refills: every rise counts once", () => {
  const levels = script([[0, 20], [1, 15], [2, 15], [3, 15], [4, 15], [5, 30], [3, 2], [1, 2], [0, 20], [1, 15], [2, 15], [3, 30]]);
  const app = appearance();
  const r = countRamp(evidence(levels), app, new Array(SLOTS).fill(6));
  assert.equal(r.total, 8);
  assert.deepEqual(r.periods.map((p) => p.queueGain), [5, 3]);
  assert.equal(r.quality.confidence, "high");
  // colours follow the slots (every third slot green in the script)
  assert.equal(r.artifacts.filter((a) => a.colour === "green").length, 2);
});

test("flicker, a ball rolling past and a slot hidden for a moment do not change the count", () => {
  const levels = script([[0, 20], [1, 15], [2, 15], [3, 60]]);
  const extra: [number, number][] = [[30, 7], [31, 6], [32, 5], [70, 8]];
  const hidden: [number, number][] = [[80, 0], [81, 0], [90, 1]];
  const r = countRamp(evidence(levels, extra, hidden), appearance(), new Array(SLOTS).fill(6));
  assert.equal(r.total, 3);
});

test("a person standing in front of the GATE end does not hide a queue seen above it", () => {
  // slots 0-1 look empty for the whole fill (blocked), slots 2-5 clearly fill
  const levels = script([[0, 20], [3, 15], [4, 15], [5, 15], [6, 40]]);
  const hidden: [number, number][] = [];
  for (let t = 0; t < levels.length; t++) hidden.push([t, 0], [t, 1]);
  const r = countRamp(evidence(levels, [], hidden), appearance(), new Array(SLOTS).fill(6));
  assert.ok(r.total >= 5 && r.total <= 6, `counted ${r.total}`);
});

test("GATE held open: ARTIFACTS rolling straight through are counted as entries", () => {
  const T = 200;
  const levels = new Array(T).fill(0);
  const extra: [number, number][] = [];
  for (const start of [20, 60, 100, 140]) for (let k = 8; k >= 0; k--) extra.push([start + (8 - k) * 2, k], [start + (8 - k) * 2 + 1, k]);
  const r = countRamp(evidence(levels, extra), appearance(), new Array(SLOTS).fill(6));
  assert.equal(r.total, 4);
  assert.ok(r.artifacts.every((a) => a.source === "entry"));
});

test("heldLevels cuts peaks shorter than the hold and keeps levels that last, and drops", () => {
  const path = Int8Array.from(script([[2, 10], [9, 3], [2, 10], [5, 12], [0, 10]]));
  const held = heldLevels(path, 8);
  assert.equal(Math.max(...held.slice(0, 23)), 2); // the 3-frame peak to 9 is gone
  assert.equal(held[30], 5); // a level held for 12 frames stays
  assert.equal(held[40], 0); // the drop stays
  assert.equal(heldLevels(path, 0), path);
});

test("a passer-by lighting up the whole RAMP for a moment is not a fill when balls are well resolved", () => {
  // empty RAMP, 0.3 s of all 9 slots looking like balls, empty again, then 2 real ARTIFACTS
  const levels = script([[0, 30], [9, 5], [0, 30], [1, 15], [2, 30]]);
  const big = countRamp(evidence(levels), appearance(12), new Array(SLOTS).fill(12));
  assert.equal(big.total, 2);
  // with small balls the decoded level flickers and brief levels can be real: nothing is cut
  const small = countRamp(evidence(levels), appearance(4), new Array(SLOTS).fill(4));
  assert.equal(small.total, 11);
});

test("a full RAMP stays at 9: later ARTIFACTS are OVERFLOW", () => {
  const steps: [number, number][] = [[0, 10]];
  for (let l = 1; l <= 9; l++) steps.push([l, 12]);
  steps.push([9, 60]);
  const r = countRamp(evidence(script(steps)), appearance(), new Array(SLOTS).fill(6));
  assert.equal(r.total, 9);
});

test("decodeQueue ignores a one-frame dip; fillPeriods merges the drain after a release", () => {
  const levels = script([[0, 10], [4, 30], [3, 1], [4, 30], [2, 3], [1, 3], [2, 2], [0, 20]]);
  const path = decodeQueue(evidence(levels).llr, CFG);
  assert.equal(Math.max(...path.slice(10, 70)), 4);
  const periods = fillPeriods(path, CFG);
  assert.equal(periods.reduce((a, p) => a + p.queueGain, 0), 4);
});

test("per-point evidence: ball colours vote ball, the empty RAMP votes empty, greys and occluders say little", () => {
  const app = appearance();
  const frame = (c: Lab) => Float32Array.from(Array.from({ length: SLOTS * PTS }, () => c).flat());
  assert.ok(frameEvidence(frame(PURPLE), app).llr[0] > 20);
  assert.ok(frameEvidence(frame(GREEN), app).llr[4] > 20);
  assert.ok(frameEvidence(frame(EMPTY), app).llr[0] < -20);
  // dark grey (hair, clothes): far from the RAMP, but not coloured like an ARTIFACT
  assert.ok(frameEvidence(frame([25, 2, -3]), app).llr[0] <= 0);
  // purple ARTIFACT colours vote purple
  assert.ok(frameEvidence(frame(PURPLE), app).colour[0] > 0);
  assert.ok(frameEvidence(frame(GREEN), app).colour[0] < 0);
  // off-frame points say nothing
  assert.equal(frameEvidence(frame([NaN, NaN, NaN]), app).llr[0], 0);
});

test("automatic sensitivity: a slot whose ball covers few pixels gets less weight", () => {
  assert.equal(appearance(6).slotWeight[0], 1);
  const small = appearance(2).slotWeight[0];
  assert.ok(small < 1 && small > 0.2, `weight ${small}`);
});

test("ARTIFACT colours: something else seen at staged positions for a moment neither moves the colour nor widens the tolerance", () => {
  const slotOfPoint = Array.from({ length: SLOTS * PTS }, (_, i) => Math.floor(i / PTS));
  const empty = Array.from({ length: 6 }, () => Float32Array.from(slotOfPoint.flatMap(() => EMPTY)));
  const learn = (staged: Parameters<typeof learnAppearance>[4]) => learnAppearance(slotOfPoint, new Array(SLOTS).fill(6), new Array(SLOTS).fill(1), empty, staged);
  // a broadcast overlay's bright green motif icons over 3 of the 6 green positions, from the
  // start on (seen in 14 frames), the real ARTIFACTS seen for the whole window (160 frames)
  const ICON: Lab = [75, -76, 73];
  const a = learn({ purple: [PURPLE, PURPLE, PURPLE], green: [GREEN, GREEN, [57, -37, 12], ICON, ICON, ICON], greenWeight: [160, 160, 160, 14, 14, 14] });
  assert.ok(Math.hypot(a.green[0] - GREEN[0], a.green[1] - GREEN[1], a.green[2] - GREEN[2]) < 2, `green ${a.green}`);
  assert.equal(a.greenSigma, CFG.minBallSigma);
  // one stray sample among equals: the median keeps the colour, the tolerance stays tight
  const b = learn({ purple: [PURPLE, PURPLE, [46, 31, -24], PURPLE, [80, 5, 60]], green: [GREEN, GREEN] });
  assert.deepEqual(b.purple, PURPLE);
  assert.equal(b.purpleSigma, CFG.minBallSigma);
});

test("confidence: tiny RAMP or default colours lower it and say why", () => {
  const levels = script([[0, 20], [1, 15], [2, 30]]);
  const ev = evidence(levels);
  const path = decodeQueue(ev.llr, CFG);
  const tiny = assessQuality(ev.llr, path, appearance(2.5), new Array(SLOTS).fill(2.5), 1);
  assert.equal(tiny.confidence, "low");
  assert.ok(tiny.notes.some((n) => /small/.test(n)));
  const noStaged = assessQuality(ev.llr, path, appearance(6, false), new Array(SLOTS).fill(6), 1);
  assert.equal(noStaged.confidence, "medium");
  assert.ok(noStaged.notes.some((n) => /default ARTIFACT colours/.test(n)));
});
