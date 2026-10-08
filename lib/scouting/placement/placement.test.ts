// End-to-end placement tests on synthetic renders of the field model from known
// camera poses (overhead, high stands, low side, phone at the field wall). Each
// method must recover the ramp ROIs that the TRUE pose projects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getFieldModel, type Alliance } from "./fieldModel.ts";
import { intrinsicsFromFov, lookAt, projectPoint, type Pose, type Vec2, type Vec3 } from "./geometry.ts";
import { projectAllRamps, solvePose, solvePoseFixed, type Correspondence, type PoseSolution } from "./pose.ts";
import { detectAprilTags, tagCorrespondences } from "./apriltag.ts";
import { runFieldPlane } from "./fieldPlane.ts";
import { aggregatePlacements, placeFromTaps, placeWithMethodA, runPlacement, shotThumbnail, thumbnailDiff, DEFAULT_PLACEMENT_CONFIG, type FramePlacement } from "./placer.ts";
import { allianceColourMasks, buildMarkingMaps, evaluatePose, DEFAULT_MARKING_CONFIG } from "./markings.ts";
import { CameraMotionMonitor } from "./cameraMotion.ts";
import { initNodeOpenCV, renderField } from "./testing/synthetic.ts";

const model = getFieldModel();
const W = 1280;
const H = 720;

const VIEWS: Record<string, { eye: Vec3; target: Vec3; fov: number }> = {
  stands: { eye: [0, 150, 90], target: [0, -20, 0], fov: 60 },
  overhead: { eye: [0, 100, 260], target: [0, -5, 0], fov: 55 },
  side: { eye: [-110, 20, 30], target: [30, -30, 15], fov: 75 },
  wallphone: { eye: [30, 72, 20], target: [-40, -50, 12], fov: 70 },
};

function truth(pose: Pose, fov: number): PoseSolution {
  return { pose, intrinsics: intrinsicsFromFov(W, H, fov), reprojError: 0, inliers: 0, total: 0, perPoint: [], fovRefined: true };
}

function quadError(a: Vec2[], b: Vec2[]): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

function expectRois(got: { alliance: Alliance; quad: Vec2[] }[], pose: Pose, fov: number, tol: number, label: string) {
  const want = projectAllRamps(model, truth(pose, fov)).rois;
  assert.deepEqual(got.map((r) => r.alliance).sort(), want.map((r) => r.alliance).sort(), `${label}: visible ramps`);
  for (const w of want) {
    const g = got.find((r) => r.alliance === w.alliance)!;
    const e = quadError(g.quad, w.quad);
    assert.ok(e < tol, `${label}: ${w.alliance} ramp quad off by ${(e * 100).toFixed(2)}% of the frame`);
  }
}

test("solvePose recovers a known pose and refines the FOV from 8 tag corners", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const K = intrinsicsFromFov(W, H, v.fov);
  const corrs: Correspondence[] = model.tags.flatMap((t) => t.corners.map((c) => ({ image: projectPoint(c, pose, K).uv, world: c })));
  const sol = solvePose(cv, corrs, W, H)!;
  assert.ok(sol, "pose solved");
  assert.ok(sol.fovRefined);
  assert.ok(Math.abs(sol.intrinsics.fovDeg - v.fov) <= 1, `FOV ${sol.intrinsics.fovDeg} vs ${v.fov}`);
  assert.ok(sol.reprojError < 0.5, `reproj ${sol.reprojError}`);
  expectRois(projectAllRamps(model, sol).rois, pose, v.fov, 0.01, "solvePose");
});

test("lens distortion: projectPoint matches cv.projectPoints with k1", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const K = { ...intrinsicsFromFov(W, H, v.fov), k1: -0.22 };
  const pts: Vec3[] = [];
  for (const x of model.gridLinesX) for (const y of model.gridLinesY) pts.push([x, y, 0]);
  const obj = cv.matFromArray(pts.length, 1, cv.CV_64FC3, pts.flat());
  const r = cv.matFromArray(3, 1, cv.CV_64F, pose.rvec);
  const t = cv.matFromArray(3, 1, cv.CV_64F, pose.tvec);
  const Km = cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
  const dist = cv.matFromArray(4, 1, cv.CV_64F, [K.k1, 0, 0, 0]);
  const out = new cv.Mat();
  cv.projectPoints(obj, r, t, Km, dist, out);
  let worst = 0;
  pts.forEach((p, i) => {
    const uv = projectPoint(p, pose, K).uv;
    if (uv[0] >= 0 && uv[0] < W && uv[1] >= 0 && uv[1] < H) worst = Math.max(worst, Math.hypot(uv[0] - out.data64F[2 * i], uv[1] - out.data64F[2 * i + 1]));
  });
  [obj, r, t, Km, dist, out].forEach((m) => m.delete());
  assert.ok(worst < 1e-6, `largest difference ${worst} px`);
});

test("lens distortion: a wide lens is fitted (and the RAMPS land right); a pinhole camera gets none", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const floor = (K: ReturnType<typeof intrinsicsFromFov>): Correspondence[] => {
    const out: Correspondence[] = [];
    for (const x of model.gridLinesX) for (const y of model.gridLinesY) {
      const uv = projectPoint([x, y, 0], pose, K).uv;
      // the TILE corners in view, read to a quarter pixel
      if (uv[0] >= 0 && uv[0] < W && uv[1] >= 0 && uv[1] < H) out.push({ image: [Math.round(4 * uv[0]) / 4, Math.round(4 * uv[1]) / 4], world: [x, y, 0] });
    }
    return out;
  };
  const cfg = { ...DEFAULT_PLACEMENT_CONFIG.pose, fitDistortion: true };
  const wide = { ...intrinsicsFromFov(W, H, v.fov), k1: -0.2 };
  const sol = solvePose(cv, floor(wide), W, H, cfg)!;
  assert.ok(sol, "pose solved");
  assert.ok(Math.abs((sol.intrinsics.k1 ?? 0) - wide.k1) <= 0.03, `k1 ${sol.intrinsics.k1} vs ${wide.k1}`);
  const want = projectAllRamps(model, { ...truth(pose, v.fov), intrinsics: wide }).rois;
  const got = projectAllRamps(model, sol).rois;
  for (const w of want) assert.ok(quadError(got.find((r) => r.alliance === w.alliance)!.quad, w.quad) < 0.005, `${w.alliance} RAMP`);
  const pin = solvePose(cv, floor(intrinsicsFromFov(W, H, v.fov)), W, H, cfg)!;
  assert.ok(pin && !pin.intrinsics.k1, `pinhole camera got k1 ${pin?.intrinsics.k1}`);
  assert.ok(Math.abs(pin.intrinsics.fovDeg - v.fov) <= 1);
});

test("RANSAC tolerates a bad correspondence", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const pose = lookAt(v.eye, v.target);
  const K = intrinsicsFromFov(W, H, v.fov);
  const corrs: Correspondence[] = [];
  for (const x of model.gridLinesX) for (const y of model.gridLinesY.slice(1, 5)) corrs.push({ image: projectPoint([x, y, 0], pose, K).uv, world: [x, y, 0] });
  corrs[3] = { ...corrs[3], image: [corrs[3].image[0] + 80, corrs[3].image[1] - 60] };
  const sol = solvePoseFixed(cv, corrs, K)!;
  assert.ok(sol && sol.inliers === corrs.length - 1, `inliers ${sol?.inliers}`);
  assert.ok(sol.reprojError < 0.5);
});

test("sanity checks reject ramps outside the frame or behind the camera", () => {
  // Camera looking away from the goals: both ramps behind it.
  const away = lookAt([0, 0, 60], [0, 200, 0]);
  assert.equal(projectAllRamps(model, truth(away, 70)).rois.length, 0);
  // Close-up of only the red goal from the side: blue ramp is out of frame.
  const v = VIEWS.wallphone;
  const r = projectAllRamps(model, truth(lookAt(v.eye, v.target), v.fov));
  assert.deepEqual(r.rois.map((x) => x.alliance), ["red"]);
  assert.ok(r.rejected.some((x) => x.alliance === "blue"));
});

test("ramp ROI direction/line follow the ramp: ARTIFACTS move goal -> gate", () => {
  const v = VIEWS.overhead;
  const { rois } = projectAllRamps(model, truth(lookAt(v.eye, v.target), v.fov));
  for (const r of rois) {
    assert.equal(r.direction, "downward"); // goals at the top of this view, gates lower
    assert.ok(r.zone.line > 0.2 && r.zone.line < 0.8, `line ${r.zone.line} sits below the ARTIFACT landing point`);
  }
});

for (const name of ["stands", "wallphone"]) {
  test(`method A (AprilTag) places the ROI — ${name} view`, async () => {
    const cv = await initNodeOpenCV();
    const v = VIEWS[name];
    const pose = lookAt(v.eye, v.target);
    const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose });
    const r = placeWithMethodA(cv, frame, model, DEFAULT_PLACEMENT_CONFIG, 0);
    assert.ok(r.placement, `A failed: ${r.attempt.reason}`);
    const p = r.placement!;
    console.log(`  [${name}] method A${p.assistedBy ? "+B" : ""} reproj ${p.solution.reprojError.toFixed(3)} px, FOV ${p.solution.intrinsics.fovDeg}° (true ${v.fov}°, refined=${p.solution.fovRefined}), tags ${p.tags?.filter((t) => t.id === 20 || t.id === 24).map((t) => t.id).join("+")}`);
    expectRois(r.placement!.rois, pose, v.fov, 0.02, `A/${name}`);
  });
}

// Low side view: only one GOAL tag (29 px) and almost no floor tape in view. One tag fixes the
// camera only once the field of view is known, and nothing else in this frame pins that down
// (method B alone gets 29-48 deg; a joint tag + floor fit that settles on a wrong field of view
// is refused because it misses the GOAL colours). So method A must place the RAMP beside its
// tag and say the result is uncertain, never return a confident wrong pose. (Before the GOAL tag
// corner order was corrected, this view passed only because the joint fit happened to land near
// the right field of view.)
test("method A, one tag in a low side view: the tag and the floor fitted together give the FOV and both RAMPS", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.side;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose });
  const r = placeWithMethodA(cv, frame, model, DEFAULT_PLACEMENT_CONFIG, 0);
  assert.ok(r.placement, r.attempt.reason);
  // one tag alone cannot give the FOV (4 coplanar points): the floor fitted with it does
  assert.equal(r.placement!.assistedBy, "B");
  assert.ok(Math.abs(r.placement!.solution.intrinsics.fovDeg - v.fov) <= 2, `FOV ${r.placement!.solution.intrinsics.fovDeg} vs ${v.fov}`);
  const locked = aggregatePlacements([r.placement!], { ...DEFAULT_PLACEMENT_CONFIG, targetFrames: 1 })!;
  const want = projectAllRamps(model, truth(pose, v.fov)).rois;
  for (const [alliance, tol] of [["blue", 0.01], ["red", 0.02]] as const) {
    const got = locked.rois.find((x) => x.alliance === alliance);
    assert.ok(got, `${alliance} RAMP placed`);
    const e = quadError(got!.quad, want.find((x) => x.alliance === alliance)!.quad);
    assert.ok(e < tol, `${alliance} ramp quad off by ${(e * 100).toFixed(2)}% of the frame`);
  }
  // the red RAMP runs out of the picture: said, and the confidence is low
  assert.equal(locked.confidence, "low");
  assert.ok(locked.confidenceNotes.some((n) => /red ramp is outside the frame/.test(n)));
});

test("a lone tag without floor features is placed but flagged low confidence", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.wallphone;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose, drawGrid: false, drawMarkings: false });
  const r = placeWithMethodA(cv, frame, model, DEFAULT_PLACEMENT_CONFIG, 0);
  assert.ok(r.placement, r.attempt.reason);
  assert.equal(r.placement!.assistedBy, undefined);
  const locked = aggregatePlacements([r.placement!], { ...DEFAULT_PLACEMENT_CONFIG, targetFrames: 1 })!;
  assert.equal(locked.confidence, "low");
  assert.ok(locked.confidenceNotes.some((n) => /FOV assumed/.test(n)));
  expectRois(locked.rois, pose, v.fov, 0.06, "A-single/wallphone"); // approximate: 4 points, assumed 70° FOV
});

test("method A ignores tags smaller than the minimum size (after crop retries)", async () => {
  const cv = await initNodeOpenCV();
  const pose = lookAt([0, 330, 140], [0, -40, 0]); // far away: tags ~12 px
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: 50, pose, drawGrid: false });
  const dets = detectAprilTags(cv, frame, model);
  const tc = tagCorrespondences(dets, model);
  assert.equal(tc.correspondences.length, 0);
  assert.match(tc.reason ?? "", /too small|no GOAL AprilTag/);
});

test("method B (field plane) places the ROI from the TILE grid — overhead view, no tags", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose, drawTags: false, launchLines: true });
  const b = runFieldPlane(cv, frame, model);
  assert.ok(b.solution, `B failed: ${b.reason}`);
  console.log(`  [overhead] method B reproj ${b.solution!.reprojError.toFixed(3)} px, FOV ${b.solution!.intrinsics.fovDeg}°, ${b.correspondences.length} grid points`);
  assert.ok(b.correspondences.length >= 6);
  expectRois(b.rois, pose, v.fov, 0.02, "B/overhead");
});

test("method B (field plane) — high stands view, no tags", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose, drawTags: false });
  const b = runFieldPlane(cv, frame, model);
  assert.ok(b.solution, `B failed: ${b.reason}`);
  expectRois(b.rois, pose, v.fov, 0.02, "B/stands");
});

test("method B uses the floor-tape markings when TILE seams are invisible (broadcast-like overhead)", async () => {
  const cv = await initNodeOpenCV();
  const pose = lookAt([-26, 126, 319], [0, -5, 0]);
  const fov = 57;
  const { frame } = renderField(cv, model, { width: 640, height: 360, fovDeg: fov, pose, drawTags: false, drawGrid: false, drawMarkings: true });
  const b = runFieldPlane(cv, frame, model);
  assert.ok(b.solution, `B failed: ${b.reason}`);
  assert.equal(b.variant, "markings");
  console.log(`  [broadcast-like] method B/markings reproj ${b.solution!.reprojError.toFixed(2)} px, FOV ${b.solution!.intrinsics.fovDeg}° (true ${fov}°), ${b.correspondences.length} tape points`);
  const want = projectAllRamps(model, { pose, intrinsics: intrinsicsFromFov(640, 360, fov), reprojError: 0, inliers: 0, total: 0, perPoint: [], fovRefined: true }).rois;
  for (const w of want) {
    const g = b.rois.find((r) => r.alliance === w.alliance)!;
    assert.ok(g, `${w.alliance} ramp found`);
    const e = quadError(g.quad, w.quad);
    assert.ok(e < 0.02, `${w.alliance} ramp off by ${(e * 100).toFixed(2)}%`);
  }
});

// Any camera angle, real-footage nuisances (tinted floor, textured crowd with red / blue
// shirts, robots, a referee in front, broadcast score banner, blur, noise), no AprilTags,
// no TILE seams, 640x360: the whole-model alignment must place both ramps.
const ANY_ANGLE: { name: string; eye: Vec3; target: Vec3; fov: number; beige?: boolean; overlay?: boolean }[] = [
  { name: "stands, audience side", eye: [10, 230, 150], target: [0, -10, 0], fov: 55, overlay: true },
  { name: "stands, red side", eye: [-240, 40, 170], target: [0, -10, 0], fov: 50, beige: true },
  { name: "stands, behind the GOALS", eye: [30, -250, 160], target: [0, 10, 0], fov: 55 },
  { name: "overhead", eye: [20, 90, 300], target: [0, -5, 0], fov: 65, beige: true, overlay: true },
  { name: "low side", eye: [120, 30, 50], target: [-10, -30, 5], fov: 75 },
  { name: "phone at the wall", eye: [-50, 84, 55], target: [-30, -40, 8], fov: 75, beige: true },
];
for (const [i, v] of ANY_ANGLE.entries()) {
  test(`method B aligns the field model from any angle — ${v.name}`, async () => {
    const cv = await initNodeOpenCV();
    const pose = lookAt(v.eye, v.target);
    const { frame } = renderField(cv, model, {
      width: 640,
      height: 360,
      fovDeg: v.fov,
      pose,
      drawTags: false,
      drawGrid: false,
      realism: { seed: 101 + i, floorTint: v.beige ? [158, 138, 110] : undefined, people: 20, robots: 3, overlay: v.overlay, blur: 0.8, noise: 6 },
    });
    const b = runFieldPlane(cv, frame, model);
    assert.ok(b.solution, `B failed: ${b.reason}`);
    const want = projectAllRamps(model, { pose, intrinsics: intrinsicsFromFov(640, 360, v.fov), reprojError: 0, inliers: 0, total: 0, perPoint: [], fovRefined: true }).rois;
    assert.ok(want.length > 0);
    for (const w of want) {
      const g = b.rois.find((r) => r.alliance === w.alliance);
      assert.ok(g, `${w.alliance} ramp found`);
      const e = quadError(g!.quad, w.quad);
      assert.ok(e < 0.03, `${w.alliance} ramp off by ${(e * 100).toFixed(2)}%`);
    }
  });
}

test("the acceptance test rejects the field turned around and accepts the true pose", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: 640, height: 360, fovDeg: v.fov, pose, drawTags: false, drawGrid: false });
  const rgba = cv.matFromImageData(frame);
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const masks = allianceColourMasks(cv, hsv);
  const maps = buildMarkingMaps(cv, rgba, hsv, masks, DEFAULT_MARKING_CONFIG);
  const K = intrinsicsFromFov(640, 360, v.fov);
  const sol = (p: typeof pose): PoseSolution => ({ pose: p, intrinsics: K, reprojError: 0, inliers: 0, total: 0, perPoint: [], fovRefined: true });
  assert.equal(evaluatePose(model, sol(pose), maps, 1).ok, true);
  // same camera looking at the field from the opposite side: tape and floor are nearly
  // symmetric, but the GOALS are not where the colours are
  const turned = lookAt([-v.eye[0], -v.eye[1], v.eye[2]], [-v.target[0], -v.target[1], v.target[2]]);
  const ev = evaluatePose(model, sol(turned), maps, 1);
  assert.equal(ev.ok, false);
  assert.match(ev.reason ?? "", /GOAL/);
  for (const m of [rgba, rgb, hsv, masks.red, masks.blue]) m.delete();
});

test("same-shot check: identical frames match, a different shot does not", async () => {
  const cv = await initNodeOpenCV();
  const a = renderField(cv, model, { width: 320, height: 180, fovDeg: 60, pose: lookAt(VIEWS.stands.eye, VIEWS.stands.target) }).frame;
  const b = renderField(cv, model, { width: 320, height: 180, fovDeg: 60, pose: lookAt(VIEWS.overhead.eye, VIEWS.overhead.target) }).frame;
  assert.ok(thumbnailDiff(shotThumbnail(a), shotThumbnail(a)) === 0);
  assert.ok(thumbnailDiff(shotThumbnail(a), shotThumbnail(b)) > DEFAULT_PLACEMENT_CONFIG.sameShotDiff);
});

test("median lock keeps only the largest consistent group of frames (camera cut)", () => {
  const v = VIEWS.stands;
  const shotA = projectAllRamps(model, truth(lookAt(v.eye, v.target), v.fov)).rois;
  const shotB = projectAllRamps(model, truth(lookAt([60, 120, 60], [0, -30, 0]), v.fov)).rois;
  const mk = (rois: typeof shotA, i: number): FramePlacement => ({ time: i, method: "A", solution: { ...truth(lookAt(v.eye, v.target), v.fov), reprojError: 0.4 }, rois, correspondences: [] });
  const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => mk(i < 5 ? shotA : shotB, i));
  const locked = aggregatePlacements(frames, DEFAULT_PLACEMENT_CONFIG)!;
  assert.equal(locked.framesUsed, 5);
  for (const r of locked.rois) assert.ok(quadError(r.quad, shotA.find((x) => x.alliance === r.alliance)!.quad) < 1e-9);
});

test("method B refuses an orientation the GOAL colours contradict", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const pose = lookAt(v.eye, v.target);
  // Swapping the goal colours makes every physically possible orientation disagree
  // with them (the only colour-consistent one is a mirror image = camera under the
  // floor), so B must fail rather than guess.
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose, drawTags: false, swapGoalColours: true });
  const b = runFieldPlane(cv, frame, model);
  assert.equal(b.solution, null);
  assert.match(b.reason ?? "", /GOAL colours/);
});

test("method B needs the GOAL colours: no goals visible -> no guess", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose: lookAt(v.eye, v.target), drawTags: false, drawGoals: false });
  const b = runFieldPlane(cv, frame, model);
  assert.equal(b.solution, null);
});

test("method C (4 taps) places the ROI from the field corners", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const pose = lookAt(v.eye, v.target);
  const K = intrinsicsFromFov(W, H, v.fov);
  const taps = model.perimeterCorners.map((c) => {
    const p = projectPoint(c.point, pose, K).uv;
    return [p[0] + 2, p[1] - 1.5] as Vec2; // a little tap noise
  });
  const cfg = { ...DEFAULT_PLACEMENT_CONFIG, pose: { ...DEFAULT_PLACEMENT_CONFIG.pose, fovDeg: v.fov } };
  const r = placeFromTaps(cv, taps, { width: W, height: H }, model, cfg);
  assert.ok(r.placement, r.reason);
  expectRois(r.placement!.rois, pose, v.fov, 0.02, "C/overhead");
});

test("the lock weighs frames by evidence: many weak look-alike frames lose to fewer well-explained ones", () => {
  // e.g. a stream opens on a match-results graphic whose red panel passes for a GOAL
  const v = VIEWS.stands;
  const real = projectAllRamps(model, truth(lookAt(v.eye, v.target), v.fov)).rois;
  const fake = projectAllRamps(model, truth(lookAt([60, 120, 60], [0, -30, 0]), v.fov)).rois;
  const ev = (iou: number, tapeRatio: number, tapeVisible: number, goals: number) => ({
    goals: Array.from({ length: goals }, (_, i) => ({ alliance: (i ? "blue" : "red") as Alliance, iou, area: 5000, inFrame: 1 })),
    goalWorst: iou,
    floor: { explained: 1, filled: 0.8 },
    tapeVisible,
    tapeRatio,
    ok: true,
  });
  const mk = (rois: typeof real, i: number, evaluation: ReturnType<typeof ev>): FramePlacement => ({ time: i, method: "B", solution: { ...truth(lookAt(v.eye, v.target), v.fov), reprojError: 1 }, rois, correspondences: [], evaluation });
  const frames = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => mk(fake, i, ev(0.31, 0.49, 47, 1))), // results graphic
    ...[10, 11, 12].map((i) => mk(real, i, ev(0.57, 0.93, 430, 2))), // the field
  ];
  const locked = aggregatePlacements(frames, DEFAULT_PLACEMENT_CONFIG)!;
  assert.equal(locked.framesUsed, 3);
  for (const r of locked.rois) assert.ok(quadError(r.quad, real.find((x) => x.alliance === r.alliance)!.quad) < 1e-9);
});

test("median lock ignores a few bad frames", () => {
  const v = VIEWS.stands;
  const good = projectAllRamps(model, truth(lookAt(v.eye, v.target), v.fov)).rois;
  const bad = projectAllRamps(model, truth(lookAt([20, 140, 70], [10, -10, 0]), v.fov)).rois;
  const mk = (rois: typeof good, i: number): FramePlacement => ({ time: i * 0.2, method: "A", solution: { ...truth(lookAt(v.eye, v.target), v.fov), fovRefined: true, reprojError: 0.4 }, rois, correspondences: [] });
  const frames = [0, 1, 2, 3, 4, 5, 6].map((i) => mk(i === 2 || i === 5 ? bad : good, i));
  const locked = aggregatePlacements(frames, DEFAULT_PLACEMENT_CONFIG)!;
  for (const r of locked.rois) {
    const g = good.find((x) => x.alliance === r.alliance)!;
    assert.ok(quadError(r.quad, g.quad) < 1e-9, "median equals the good frames");
  }
});

test("runPlacement locks over several frames and reports method + error", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose });
  const run = await runPlacement({ cv, model, grabFrame: async () => frame, startTime: 0, duration: 10, cfg: { ...DEFAULT_PLACEMENT_CONFIG, targetFrames: 6, minUsableFrames: 3 } });
  assert.ok(run.locked, run.failureSummary);
  assert.equal(run.locked!.method, "A");
  assert.equal(run.locked!.framesUsed, 6);
  expectRois(run.locked!.rois, pose, v.fov, 0.02, "run/stands");
});

test("a video that opens on something else does not use up the placement budget", async () => {
  // 40 s of announcers (no field) before the field shows up, with no wall-clock budget at all
  // before the first frame places: the search keeps going, then the view gets its own budget.
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose });
  const studio = { data: new Uint8ClampedArray(W * H * 4).fill(90), width: W, height: H };
  const cfg = { ...DEFAULT_PLACEMENT_CONFIG, targetFrames: 4, minUsableFrames: 3, maxSeconds: 0 };
  const run = await runPlacement({ cv, model, grabFrame: async (t) => (t < 40 ? studio : frame), startTime: 0, duration: 120, cfg });
  assert.ok(run.locked, run.failureSummary);
  assert.equal(run.locked!.framesUsed, 4);
  assert.ok(run.frames[0].time >= 40);
  expectRois(run.locked!.rois, pose, v.fov, 0.02, "late field");
});

test("method B tracking mode: later frames reuse the first pose and are much faster", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.overhead;
  const pose = lookAt(v.eye, v.target);
  const { frame } = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose, drawTags: false });
  const t0 = Date.now();
  const first = runFieldPlane(cv, frame, model);
  const tFull = Date.now() - t0;
  assert.ok(first.solution, first.reason);
  const t1 = Date.now();
  const next = runFieldPlane(cv, frame, model, undefined, undefined, undefined, undefined, first.solution!);
  const tTrack = Date.now() - t1;
  assert.ok(next.solution && next.tracked, next.reason);
  expectRois(next.rois, pose, v.fov, 0.02, "B/tracked");
  console.log(`  [overhead] B full search ${tFull} ms, tracked ${tTrack} ms`);
  assert.ok(tTrack < tFull, "tracking should be cheaper than the full search");
});

test("camera-moved check: consistent shift triggers, a robot covering features does not", async () => {
  const cv = await initNodeOpenCV();
  const v = VIEWS.stands;
  const ref = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose: lookAt(v.eye, v.target) }).frame;
  const mon = new CameraMotionMonitor(cv, ref);
  assert.ok(mon.featureCount >= 12, `features ${mon.featureCount}`);
  assert.equal(mon.check(ref).moved, false);
  // "Robot" occluding a region of the frame.
  const occl = { ...ref, data: new Uint8ClampedArray(ref.data) };
  for (let y = 380; y < 560; y++) for (let x = 500; x < 760; x++) occl.data.set([30, 30, 200, 255], (y * W + x) * 4);
  assert.equal(mon.check(occl).moved, false, "occlusion alone must not trigger");
  // Camera panned.
  const moved = renderField(cv, model, { width: W, height: H, fovDeg: v.fov, pose: lookAt([30, 150, 90], [25, -20, 0]) }).frame;
  const res = mon.check(moved);
  assert.equal(res.moved, true, res.reason);
  mon.dispose();
});
