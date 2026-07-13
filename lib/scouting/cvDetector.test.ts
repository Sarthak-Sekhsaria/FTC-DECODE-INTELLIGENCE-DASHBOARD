// Unit tests for the Auto Scouting CV logic: connected-components candidate
// detection (finds EVERY artifact, not just the largest) and the multi-artifact
// gate tracker (per-candidate crossing, several artifacts at once, no double
// count, no global gate lock). Pure logic, no DOM.
//
// Run with:  node --experimental-transform-types --test lib/scouting/cvDetector.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GateMultiTracker,
  detectCandidates,
  analyzeZonePixels,
  computeMaskImage,
  targetFromSample,
  sideOfLine,
  DEFAULT_CANDIDATE_CONFIG,
  type Candidate,
  type TrackerConfig,
} from "./cvDetector.ts";

const cfg: TrackerConfig = { line: 0.5, direction: "downward", maxMatchDist: 0.45, maxMissing: 6 };

// A candidate at a given normalized centre (small blob).
function cand(x: number, y: number, extra: Partial<Candidate> = {}): Candidate {
  return { centerX: x, centerY: y, width: 0.2, height: 0.2, area: 0.05, color: "purple", matchedPixels: 20, ...extra };
}

// Build an 8-bit RGBA crop and paint a filled rectangle of one colour into it.
function makeCrop(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) px[i + 3] = 255; // opaque black
  return px;
}
function paintRect(px: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
    }
  }
}
const PURPLE: [number, number, number] = [150, 20, 200];
const GREEN: [number, number, number] = [40, 190, 60];

// --- candidate detection ---

test("detectCandidates finds a single blob", () => {
  const w = 40, h = 40;
  const px = makeCrop(w, h);
  paintRect(px, w, 8, 8, 20, 20, PURPLE);
  const cands = detectCandidates(px, w, h, { ...DEFAULT_CANDIDATE_CONFIG, sampleStride: 1 });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].color, "purple");
});

test("detectCandidates returns EVERY separate blob, not just the largest", () => {
  const w = 60, h = 40;
  const px = makeCrop(w, h);
  paintRect(px, w, 4, 4, 14, 14, PURPLE); // blob A
  paintRect(px, w, 30, 4, 40, 14, PURPLE); // blob B (gap between)
  paintRect(px, w, 4, 24, 14, 34, GREEN); // blob C, different colour
  const cands = detectCandidates(px, w, h, { ...DEFAULT_CANDIDATE_CONFIG, sampleStride: 1 });
  assert.equal(cands.length, 3);
});

test("two touching blobs of different colours are separate candidates", () => {
  const w = 40, h = 40;
  const px = makeCrop(w, h);
  paintRect(px, w, 5, 5, 20, 20, PURPLE);
  paintRect(px, w, 20, 5, 35, 20, GREEN); // touches purple at x=20
  const cands = detectCandidates(px, w, h, { ...DEFAULT_CANDIDATE_CONFIG, sampleStride: 1 });
  assert.equal(cands.length, 2);
  assert.ok(cands.some((c) => c.color === "purple"));
  assert.ok(cands.some((c) => c.color === "green"));
});

test("tiny specks below minAreaFrac are ignored", () => {
  const w = 40, h = 40;
  const px = makeCrop(w, h);
  paintRect(px, w, 1, 1, 2, 2, PURPLE); // 1px speck
  const cands = detectCandidates(px, w, h, { ...DEFAULT_CANDIDATE_CONFIG, sampleStride: 1, minAreaFrac: 0.02 });
  assert.equal(cands.length, 0);
});

// --- side helper ---

test("sideOfLine respects direction", () => {
  assert.equal(sideOfLine(0.2, 0.5, "downward"), "field");
  assert.equal(sideOfLine(0.8, 0.5, "downward"), "goal");
  assert.equal(sideOfLine(0.2, 0.5, "upward"), "goal");
  assert.equal(sideOfLine(0.8, 0.5, "upward"), "field");
});

// --- multi-artifact tracker ---

function run(frames: Candidate[][], config: TrackerConfig = cfg): number {
  const t = new GateMultiTracker(config);
  let n = 0;
  for (const f of frames) n += t.update(f).crossings.length;
  return n;
}

test("one artifact crossing field -> goal creates exactly one crossing", () => {
  // gradual descent across the line at 0.5 (realistic per-frame motion).
  const frames = [[cand(0.5, 0.25)], [cand(0.5, 0.4)], [cand(0.5, 0.62)], [cand(0.5, 0.8)]];
  assert.equal(run(frames), 1);
});

test("an artifact lingering on the goal side after crossing is counted once", () => {
  const frames = [
    [cand(0.5, 0.3)], [cand(0.5, 0.6)], [cand(0.5, 0.72)], [cand(0.5, 0.8)], [cand(0.5, 0.82)],
  ];
  assert.equal(run(frames), 1);
});

test("a single dropped frame does not lose the crossing", () => {
  // field, then empty (dropped), then goal — the track survives and still crosses.
  const frames = [[cand(0.5, 0.35)], [], [cand(0.5, 0.7)]];
  assert.equal(run(frames), 1);
});

test("an artifact appearing already on the goal side is not counted", () => {
  const frames = [[cand(0.5, 0.8)], [cand(0.5, 0.82)], [cand(0.5, 0.85)]];
  assert.equal(run(frames), 0);
});

test("THREE separate artifacts crossing together each count (=> +9)", () => {
  // three blobs at distinct x lanes, all descending field -> goal gradually.
  const t = new GateMultiTracker(cfg);
  t.update([cand(0.2, 0.3), cand(0.5, 0.3), cand(0.8, 0.3)]); // all field
  const res = t.update([cand(0.2, 0.7), cand(0.5, 0.7), cand(0.8, 0.7)]); // all cross
  assert.equal(res.crossings.length, 3);
});

test("the gate does NOT lock after one artifact scores", () => {
  // A crosses; while A lingers on goal side, B enters on field side and crosses.
  const t = new GateMultiTracker(cfg);
  t.update([cand(0.3, 0.3)]); // A field
  const a = t.update([cand(0.3, 0.7)]); // A crosses
  assert.equal(a.crossings.length, 1);
  t.update([cand(0.3, 0.75), cand(0.7, 0.3)]); // A lingers, B appears on field
  const b = t.update([cand(0.3, 0.8), cand(0.7, 0.7)]); // B crosses
  assert.equal(b.crossings.length, 1);
});

test("consecutive artifacts through the same lane each count", () => {
  const t = new GateMultiTracker(cfg);
  let total = 0;
  // A: field -> goal -> leaves (missing frames) -> B: field -> goal
  total += t.update([cand(0.5, 0.3)]).crossings.length;
  total += t.update([cand(0.5, 0.7)]).crossings.length; // A +1
  for (let i = 0; i < 7; i++) total += t.update([]).crossings.length; // A ages out
  total += t.update([cand(0.5, 0.3)]).crossings.length; // B field (new track)
  total += t.update([cand(0.5, 0.7)]).crossings.length; // B +1
  assert.equal(total, 2);
});

test("reversed direction counts goal-side->field-side motion instead", () => {
  const up: TrackerConfig = { ...cfg, direction: "upward" };
  // upward: high y = field, low y = goal. Move 0.7 -> 0.3.
  assert.equal(run([[cand(0.5, 0.7)], [cand(0.5, 0.3)]], up), 1);
  // the downward motion should NOT count under upward.
  assert.equal(run([[cand(0.5, 0.3)], [cand(0.5, 0.7)]], up), 0);
});

test("a large blob flags an uncertain multi-artifact estimate", () => {
  const big: TrackerConfig = { ...cfg, singleArtifactArea: 0.05 };
  const t = new GateMultiTracker(big);
  t.update([cand(0.5, 0.3, { area: 0.16 })]);
  const res = t.update([cand(0.5, 0.7, { area: 0.16 })]);
  assert.equal(res.crossings.length, 1);
  assert.ok(res.crossings[0].uncertain);
  assert.ok(res.crossings[0].estimatedCount >= 3);
});

// --- colour analyzer (retained) ---

test("analyzeZonePixels detects purple / green / empty and reports matched pixels", () => {
  const mk = (r: number, g: number, b: number) => {
    const px = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    return px;
  };
  assert.equal(analyzeZonePixels(mk(150, 20, 200), 8, 8).color, "purple");
  assert.equal(analyzeZonePixels(mk(40, 190, 60), 8, 8).color, "green");
  const empty = analyzeZonePixels(mk(120, 120, 120), 8, 8);
  assert.equal(empty.present, false);
  assert.equal(empty.matchedPixels, 0);
});

test("a sampled colour target matches pixels of that colour", () => {
  const target = targetFromSample(150, 20, 200, "purple");
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 150; px[i + 1] = 20; px[i + 2] = 200; px[i + 3] = 255; }
  const o = analyzeZonePixels(px, 4, 4, { targets: [target], minSat: 0.25, minVal: 0.18, minCoverage: 0.03, sampleStride: 1 });
  assert.equal(o.present, true);
});

test("computeMaskImage highlights matched pixels", () => {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 150; px[i + 1] = 20; px[i + 2] = 200; px[i + 3] = 255; }
  const mask = computeMaskImage(px, 4, 4);
  assert.ok(mask[0] > 50 || mask[2] > 50);
});
