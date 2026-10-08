// End-to-end RAMP scoring on a synthetic match: the field is rendered from a known pose, the
// pre-staged ARTIFACTS and the balls queued on each RAMP are painted where the field model
// puts them, and the camera pans slowly — the scorer must calibrate itself, follow the view
// and count every CLASSIFIED ARTIFACT exactly once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getFieldModel } from "./placement/fieldModel.ts";
import { intrinsicsFromFov, lookAt, projectPoint, type Vec3 } from "./placement/geometry.ts";
import { initNodeOpenCV, renderField } from "./placement/testing/synthetic.ts";
import { projectBall, stagedArtifactLab, stagedArtifacts, type CameraSolution, type Frame } from "./calibration.ts";
import { buildLane, slotCentres } from "./rampState.ts";
import { counterScale, RampScorer, resizedCamera, WORK_BALL_RADIUS_PX, type RampScorerOptions } from "./rampScorer.ts";
import { applyH, DEFAULT_VIEW_TRACKER_CONFIG, ViewTracker, type Homography } from "./viewTracker.ts";
import type { CV } from "./placement/cv.ts";

const model = getFieldModel();
const W = 640;
const H = 360;
const FOV = 60;
const pose = lookAt([0, 150, 90], [0, -20, 0]);
const cam: CameraSolution = { pose, intrinsics: intrinsicsFromFov(W, H, FOV) };
const RGBA = { purple: [125, 60, 175, 255], green: [40, 175, 80, 255] };

// `f` moved by (dx, dy) px, edges repeated.
function shiftFrame(cv: CV, f: Frame, dx: number, dy: number): Frame {
  const m = cv.matFromImageData(f);
  const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, dx, 0, 1, dy]);
  const out = new cv.Mat();
  cv.warpAffine(m, out, M, new cv.Size(f.width, f.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const r = { data: new Uint8ClampedArray(out.data), width: f.width, height: f.height };
  m.delete();
  M.delete();
  out.delete();
  return r;
}

// The synthetic match recorded at w x h (same view): staged ARTIFACTS until 4 s; red fills to
// 5, is released at 9 s and refills to 3; blue gets 2; from 5 s the camera pans (the same share
// of the frame at every size). 8 red and 2 blue CLASSIFIED ARTIFACTS.
// `redOffsetRadii`: the red queue painted that many ball radii across from where the field model
// puts it (a RAMP standing off its nominal place); `decoyRadii`: a static purple strip along
// the red RAMP that far across, in every frame.
function syntheticMatch(cv: CV, w: number, h: number, opts: { redOffsetRadii?: number; decoyRadii?: number } = {}): { cam: CameraSolution; frameAt: (t: number) => Frame } {
  const camera: CameraSolution = { pose, intrinsics: intrinsicsFromFov(w, h, FOV) };
  const base = renderField(cv, model, { width: w, height: h, fovDeg: FOV, pose, realism: { seed: 7, people: 6, noise: 4 } }).frame;
  const staged = stagedArtifacts(model);
  const slots = { red: slotCentres(model.ramps.find((r) => r.alliance === "red")!), blue: slotCentres(model.ramps.find((r) => r.alliance === "blue")!) };
  const redLevel = (t: number) => (t < 3 ? 0 : t < 9 ? Math.min(5, Math.floor(t - 2)) : t < 10 ? 0 : Math.min(3, Math.floor(t - 9)));
  const blueLevel = (t: number) => (t < 5 ? 0 : t < 6 ? 1 : 2);
  const k = w / W;
  const shift = (t: number): [number, number] => (t < 5 ? [0, 0] : [0.6 * k * (t - 5), 0.3 * k * (t - 5)]);
  // across the red lane in the image (the scorer's convention: the left normal of slot 1 -> 9)
  const r0 = projectBall(slots.red[0], camera)!, r8 = projectBall(slots.red[8], camera)!;
  const ul = Math.hypot(r8.c[0] - r0.c[0], r8.c[1] - r0.c[1]);
  const across = [-(r8.c[1] - r0.c[1]) / ul, (r8.c[0] - r0.c[0]) / ul];
  const frameAt = (t: number): Frame => {
    const m = cv.matFromImageData(base);
    const paint = (world: Vec3, colour: "purple" | "green", offsetRadii = 0) => {
      const b = projectBall(world, camera);
      if (b) cv.circle(m, new cv.Point(Math.round(b.c[0] + offsetRadii * b.r * across[0]), Math.round(b.c[1] + offsetRadii * b.r * across[1])), Math.max(1, Math.round(b.r)), new cv.Scalar(...RGBA[colour]), -1);
    };
    if (opts.decoyRadii) for (const sl of slots.red) paint(sl, "purple", opts.decoyRadii);
    if (t < 4) for (const a of staged) paint(a.world, a.colour);
    for (let i = 0; i < redLevel(t); i++) paint(slots.red[i], i % 3 === 1 ? "green" : "purple", opts.redOffsetRadii ?? 0);
    for (let i = 0; i < blueLevel(t); i++) paint(slots.blue[i], "purple");
    const painted = { data: new Uint8ClampedArray(m.data), width: w, height: h };
    m.delete();
    return shiftFrame(cv, painted, ...shift(t));
  };
  return { cam: camera, frameAt };
}

test("RAMP scorer: self-calibrates, follows a panning camera and counts queue fills + a release", async () => {
  const cv = await initNodeOpenCV();
  const { frameAt } = syntheticMatch(cv, W, H);
  const scorer = new RampScorer(cv, model, cam, frameAt(0), ["red", "blue"]);
  for (let i = 0; i <= 14 * 15; i++) scorer.push(frameAt(i / 15), i / 15);
  const res = scorer.results();
  const auto = scorer.autoParams();
  scorer.dispose();

  const red = res.find((r) => r.alliance === "red")!;
  const blue = res.find((r) => r.alliance === "blue")!;
  assert.equal(red.count.total, 8, `red counted ${red.count.total}`);
  assert.equal(blue.count.total, 2, `blue counted ${blue.count.total}`);
  assert.deepEqual(red.count.periods.map((p) => p.queueGain), [5, 3]);
  const a = auto.find((x) => x.alliance === "red")!;
  assert.equal(a.colourSource, "staged-artifacts");
  assert.ok(a.calibrationTime != null && a.calibrationTime < 2.5, `calibrated at ${a.calibrationTime}`);
  assert.ok(a.artifactAreaPx > 5 && a.trackedShare > 0.95);
  // counted ARTIFACTS carry the time they joined the queue
  const times = red.count.artifacts.map((x) => red.t0 + x.frame / red.fps);
  assert.ok(Math.abs(times[0] - 3) < 0.5 && Math.abs(times[5] - 10) < 0.5, `times ${times.map((x) => x.toFixed(1))}`);
});

test("ViewTracker follows a pan with features limited to a region", async () => {
  const cv = await initNodeOpenCV();
  const base = renderField(cv, model, { width: W, height: H, fovDeg: FOV, pose, realism: { seed: 3, people: 4, noise: 3 } }).frame;
  const shifted = (dx: number, dy: number) => shiftFrame(cv, base, dx, dy);
  const tr = new ViewTracker(cv, base, { ...DEFAULT_VIEW_TRACKER_CONFIG, reanchorEvery: 4, region: [120, 60, 520, 300] });
  let last = { ok: false, H: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  for (let i = 1; i <= 30; i++) last = tr.update(shifted(i * 0.4, -i * 0.2));
  tr.dispose();
  assert.ok(last.ok);
  const p = applyH(last.H, [320, 180]);
  assert.ok(Math.hypot(p[0] - 332, p[1] - 174) < 0.6, `mapped to ${p.map((x) => x.toFixed(2))}`);
});

test(`working scale: a 1080p recording is shrunk to ${WORK_BALL_RADIUS_PX} px ARTIFACTS and counts the same match the same`, async () => {
  const cv = await initNodeOpenCV();
  const big = syntheticMatch(cv, 1920, 1080);
  const s = counterScale(model, big.cam, { width: 1920, height: 1080 }, ["red", "blue"]);
  const w = Math.round(1920 * s), h = Math.round(1080 * s);
  const work = resizedCamera(big.cam, w, h);
  const meanRadius = (alliance: "red" | "blue") => {
    const r = buildLane(model, model.ramps.find((x) => x.alliance === alliance)!, work, { width: w, height: h }).slots.map((x) => x.radiusPx).filter((x) => x > 0);
    return r.reduce((a, b) => a + b, 0) / r.length;
  };
  // the RAMP with the smaller ARTIFACTS is at the working size; small recordings are never enlarged
  assert.ok(s < 1 && Math.abs(Math.min(meanRadius("red"), meanRadius("blue")) - WORK_BALL_RADIUS_PX) < 0.1, `scale ${s}`);
  assert.equal(counterScale(model, cam, { width: W, height: H }, ["red", "blue"]), 1);
  // the resized camera is the same camera on the resized frame
  for (const r of model.ramps) {
    const a = projectPoint(r.gateEnd, big.cam.pose, big.cam.intrinsics).uv, b = projectPoint(r.gateEnd, work.pose, work.intrinsics).uv;
    assert.ok(Math.hypot(b[0] - (a[0] * w) / 1920, b[1] - (a[1] * h) / 1080) < 1e-6);
  }
  // frames shrunk the way the page grabs them (area filter), counted at the working size
  const shrink = (f: Frame): Frame => {
    const m = cv.matFromImageData(f);
    const out = new cv.Mat();
    cv.resize(m, out, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const r = { data: new Uint8ClampedArray(out.data), width: w, height: h };
    m.delete();
    out.delete();
    return r;
  };
  const scorer = new RampScorer(cv, model, work, shrink(big.frameAt(0)), ["red", "blue"]);
  for (let i = 0; i <= 14 * 15; i++) scorer.push(shrink(big.frameAt(i / 15)), i / 15);
  const res = scorer.results();
  scorer.dispose();
  assert.equal(res.find((r) => r.alliance === "red")!.count.total, 8);
  assert.equal(res.find((r) => r.alliance === "blue")!.count.total, 2);
});

test("ViewTracker: when a re-anchor and the frame-to-frame chain disagree, the GOAL and RAMP decide", async () => {
  const cv = await initNodeOpenCV();
  const base = renderField(cv, model, { width: W, height: H, fovDeg: FOV, pose, realism: { seed: 3, people: 4, noise: 3 } }).frame;
  // the red GOAL's panels and blocker and the red RAMP, as the scorer passes them
  const goal = model.goals.find((g) => g.alliance === "red")!;
  const ramp = model.ramps.find((r) => r.alliance === "red")!;
  const verifyPolys = [...goal.panels.body, goal.panels.blocker, ramp.surfaceCorners].map((poly) => poly.map((q) => projectPoint(q, cam.pose, cam.intrinsics).uv as [number, number]));
  const cfg = { ...DEFAULT_VIEW_TRACKER_CONFIG, reanchorEvery: 4, verifyPolys };
  const work = (dx: number, dy: number): Homography => [1, 0, dx, 0, 1, dy, 0, 0, 1]; // trackers work at 480 px: 0.75 x native
  const centre = (Hm: Homography) => applyH(Hm, [320, 180]);
  // stand-ins for the tracker's two estimates (its private direct match and chain step)
  type Internals = { direct: () => Homography; track: () => { H: Homography; inliers: number; total: number } };
  const internals = (tr: ViewTracker) => tr as unknown as Internals;
  const run = (tr: ViewTracker, frame: Frame, n: number) => {
    let H: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < n; i++) H = tr.update(frame).H;
    return H;
  };

  // The camera does not move; the re-anchor latches onto something that moved since the
  // reference (stand-in: it reports a 6 px shift). The chain lines up the GOAL and RAMP
  // better, so the re-anchor is refused and the RAMP stays put.
  const still = new ViewTracker(cv, base, cfg);
  internals(still).direct = () => work(6, 3);
  let p = centre(run(still, base, 12));
  assert.ok(Math.hypot(p[0] - 320, p[1] - 180) < 0.3, `still: mapped to ${p.map((x) => x.toFixed(2))}`);
  assert.equal(still.reanchors, 0);
  assert.equal(still.reanchorRejects, 3);
  still.dispose();
  // without the GOAL and RAMP to check against, the same re-anchor is taken
  const unchecked = new ViewTracker(cv, base, { ...cfg, verifyPolys: undefined });
  internals(unchecked).direct = () => work(6, 3);
  p = centre(run(unchecked, base, 12));
  assert.ok(Math.hypot(p[0] - 328, p[1] - 184) < 0.3, `unchecked: mapped to ${p.map((x) => x.toFixed(2))}`);
  unchecked.dispose();

  // The camera moved 5 px and the chain missed it (stand-in: it reports no motion); the real
  // re-anchor lines up the GOAL and RAMP, so it replaces the chain.
  const moved = new ViewTracker(cv, base, cfg);
  internals(moved).track = () => ({ H: work(0, 0), inliers: 200, total: 250 });
  p = centre(run(moved, shiftFrame(cv, base, 5, -3), 4));
  assert.ok(Math.hypot(p[0] - 325, p[1] - 177) < 0.6, `moved: mapped to ${p.map((x) => x.toFixed(2))}`);
  assert.equal(moved.reanchors, 1);
  moved.dispose();
});

test("calibrateAt: a counter not told the match start, calibrated at it later, counts exactly like one told up front", async () => {
  const cv = await initNodeOpenCV();
  const { frameAt } = syntheticMatch(cv, W, H);
  const told = new RampScorer(cv, model, cam, frameAt(0), ["red", "blue"], { matchStart: 2 });
  const later = new RampScorer(cv, model, cam, frameAt(0), ["red", "blue"]);
  for (let i = 0; i <= 14 * 15; i++) {
    const f = frameAt(i / 15);
    told.push(f, i / 15);
    later.push(f, i / 15);
  }
  assert.equal(later.calibrateAt(2), true);
  assert.equal(later.calibrateAt(2), false); // the same start again changes nothing
  const a = told.results(), b = later.results();
  assert.equal(later.calibrationTime, told.calibrationTime);
  for (const al of ["red", "blue"] as const) {
    const x = a.find((r) => r.alliance === al)!, y = b.find((r) => r.alliance === al)!;
    assert.equal(y.t0, x.t0, `${al} counting start`);
    assert.equal(y.count.total, x.count.total, `${al} count`);
  }
  assert.equal(b.find((r) => r.alliance === "red")!.count.total, 8);
  told.dispose();
  later.dispose();
});

test("calibration: a video that fades in on the field just as the match starts calibrates on the clear frames", async () => {
  const cv = await initNodeOpenCV();
  const { frameAt } = syntheticMatch(cv, W, H);
  // black until 2.0 s, then a 0.3 s wipe (left half washed out toward grey, right half black),
  // then the field; the start was found 0.8 s early, at 1.2 s (Loveland: found 4.2, fade-in at 5.0)
  const shown = (t: number): Frame => {
    const f = frameAt(t);
    if (t >= 2.3) return f;
    const d = new Uint8ClampedArray(f.data);
    for (let i = 0; i < d.length; i += 4) {
      const x = (i >> 2) % W;
      for (let c = 0; c < 3; c++) d[i + c] = t < 2 || x >= W / 2 ? 0 : Math.round(0.4 * d[i + c] + 0.6 * 128);
    }
    return { data: d, width: W, height: H };
  };
  const sc = new RampScorer(cv, model, cam, frameAt(0), ["red", "blue"]);
  for (let i = 0; i <= 14 * 15; i++) sc.push(shown(i / 15), i / 15);
  sc.calibrateAt(1.2);
  assert.ok(sc.calibrationTime! >= 2.3, `calibrated at ${sc.calibrationTime}`);
  const clear = stagedArtifactLab([frameAt(2.5)], cam, model);
  const med = (ls: number[][]) => [0, 1, 2].map((c) => ls.map((l) => l[c]).sort((p, q) => p - q)[ls.length >> 1]);
  const p = sc.autoParams().find((a) => a.alliance === "red")!;
  const want = med(clear.purple);
  assert.ok(Math.hypot(p.purple[0] - want[0], p.purple[1] - want[1], p.purple[2] - want[2]) < 3, `purple ${p.purple} vs ${want}`);
  assert.equal(sc.results().find((r) => r.alliance === "red")!.count.total, 8);
  sc.dispose();
});

test("lane alignment: a queue standing off the placed lane is found from its ARTIFACTS and counted; a static strip of ARTIFACT colour is not followed", async () => {
  const cv = await initNodeOpenCV();
  const { frameAt } = syntheticMatch(cv, W, H, { redOffsetRadii: 2.5, decoyRadii: -2.5 });
  const run = (opts: Partial<RampScorerOptions> = {}) => {
    // a 14 s match holds fewer ARTIFACT measurements than a real one: smaller minimums
    const sc = new RampScorer(cv, model, cam, frameAt(0), ["red", "blue"], { alignMinObs: 20, alignMinSeconds: 4, ...opts });
    for (let i = 0; i <= 14 * 15; i++) sc.push(frameAt(i / 15), i / 15);
    const red = sc.results().find((r) => r.alliance === "red")!;
    const a = sc.autoParams().find((x) => x.alliance === "red")!;
    sc.dispose();
    return { total: red.count.total, align: a.laneAlignment, check: a.check };
  };
  const on = run();
  assert.ok(on.align && Math.abs(on.align.offset - 2.5) <= 0.5, `alignment ${JSON.stringify(on.align)}`);
  assert.equal(on.total, 8, `red counted ${on.total}`);
  assert.ok(on.check && Math.abs(on.check.offset) < 0.6, `self-check on the counted lane ${JSON.stringify(on.check)}`);
  const off = run({ laneAlignRadii: 0 });
  assert.notEqual(off.total, 8, "without the alignment the placed lane misses the queue");
});
