/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared correspondence -> pose -> projection path used by EVERY placement method
// (AprilTag, field-plane, 4-tap, and the future keypoint model "B2").
//
//   correspondences (2D image <-> 3D field) --solvePose--> PoseSolution
//   PoseSolution + FieldModel --projectRamps--> RampRoi[] (normalized, sanity-checked)

import type { CV } from "./cv.ts";
import { release } from "./cv.ts";
import {
  bbox,
  cameraCentre,
  clipToRect,
  convexHull,
  intrinsicsFromFov,
  isConvex,
  polygonArea,
  projectPoint,
  type Intrinsics,
  type Pose,
  type Vec2,
  type Vec3,
} from "./geometry.ts";
import { rampLinePoint, rampVolume, type Alliance, type FieldModel, type RampModel } from "./fieldModel.ts";

export interface Correspondence {
  image: Vec2; // native video pixels
  world: Vec3; // field inches
  label?: string;
}

export interface PoseSolution {
  pose: Pose;
  intrinsics: Intrinsics;
  reprojError: number; // mean pixel distance over the inlier correspondences
  inliers: number;
  total: number;
  perPoint: number[]; // reprojection error of every correspondence (px)
  fovRefined: boolean;
}

export interface PoseConfig {
  fovDeg: number; // assumed horizontal FOV when it can't be refined (camera assumption)
  refineFovMinPoints: number; // refine FOV when at least this many correspondences
  fovSearchMin: number;
  fovSearchMax: number;
  fovCoarseStep: number;
  fovFineStep: number;
  ransacReprojPx: number; // RANSAC inlier threshold (px, native resolution)
  ransacIterations: number;
  minInlierRatio: number;
  // Lens distortion (solvePose): fit k1 with the FOV when the inliers number at least
  // distortionMinPoints and reach out to distortionMinReach of the half-diagonal from the centre;
  // keep it only when it lowers the mean reprojection error by at least distortionMinGain.
  fitDistortion: boolean;
  distortionK1: number[];
  distortionMinPoints: number;
  distortionMinReach: number;
  distortionMinGain: number;
}

export const DEFAULT_POSE_CONFIG: PoseConfig = {
  fovDeg: 70,
  refineFovMinPoints: 6,
  fovSearchMin: 30,
  fovSearchMax: 120,
  fovCoarseStep: 4,
  fovFineStep: 0.5,
  ransacReprojPx: 4,
  ransacIterations: 200,
  minInlierRatio: 0.6,
  fitDistortion: false,
  distortionK1: [-0.35, -0.28, -0.22, -0.16, -0.11, -0.06, 0.06, 0.12],
  distortionMinPoints: 12,
  distortionMinReach: 0.4,
  distortionMinGain: 0.2,
};

// Pose-error limits (reprojection error, tag disagreement) are in pixels of a frame 640 px
// wide, the width the whole-model alignment works at. On a larger frame the same misfit (field
// build tolerance, lens distortion, 1 in tape) covers proportionally more pixels, so a
// 1280x720 frame's error is halved before it is compared. Frames up to 640 px wide are
// compared as they are.
export const ERROR_REFERENCE_WIDTH = 640;
export function errorAtReference(errPx: number, frameWidth: number): number {
  return errPx * Math.min(1, ERROR_REFERENCE_WIDTH / frameWidth);
}

// Set PLACEMENT_DEBUG=1 (tests / Node) to see OpenCV exceptions that are otherwise
// treated as "this solve failed".
function debugLog(where: string, cv: CV, e: unknown) {
  if (typeof process !== "undefined" && process.env?.PLACEMENT_DEBUG) {
    console.error(where, typeof e === "number" && cv.exceptionFromPtr ? cv.exceptionFromPtr(e).msg : e);
  }
}

function kMat(cv: CV, K: Intrinsics) {
  return cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
}

// OpenCV distortion coefficients (k1, k2, p1, p2) of the intrinsics: only k1 is modelled.
function distMat(cv: CV, K: Intrinsics) {
  return cv.matFromArray(4, 1, cv.CV_64F, [K.k1 ?? 0, 0, 0, 0]);
}

function allCoplanar(pts: Vec3[]): boolean {
  if (pts.length < 4) return true;
  const [a, b] = pts;
  let c: Vec3 | null = null;
  for (const p of pts.slice(2)) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const n = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (n > 1e-6) {
      c = p;
      break;
    }
  }
  if (!c) return true;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  return pts.every((p) => Math.abs(((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) / nl) < 1e-3);
}

// Reprojection error of every correspondence, using cv.projectPoints.
function reprojErrors(cv: CV, corrs: Correspondence[], pose: Pose, K: Intrinsics): number[] {
  const obj = cv.matFromArray(corrs.length, 1, cv.CV_64FC3, corrs.flatMap((c) => c.world));
  const rvec = cv.matFromArray(3, 1, cv.CV_64F, pose.rvec);
  const tvec = cv.matFromArray(3, 1, cv.CV_64F, pose.tvec);
  const Km = kMat(cv, K);
  const dist = distMat(cv, K);
  const out = new cv.Mat();
  try {
    cv.projectPoints(obj, rvec, tvec, Km, dist, out);
    const d = out.data64F;
    return corrs.map((c, i) => Math.hypot(d[2 * i] - c.image[0], d[2 * i + 1] - c.image[1]));
  } finally {
    release(obj, rvec, tvec, Km, dist, out);
  }
}

// Solve the camera pose for a FIXED set of intrinsics.
//  - exactly 4 points: plain solvePnP (IPPE when coplanar — a tag or 4 floor corners)
//  - more than 4: solvePnPRansac (so a few bad matches cannot wreck the pose) plus
//    an iterative solve on all points with outlier trimming; SQPnP inside RANSAC can
//    pick the wrong branch of the planar ambiguity on near top-down views, so both
//    candidates are refined on their inliers and the one explaining more points wins.
export function solvePoseFixed(cv: CV, corrs: Correspondence[], K: Intrinsics, cfg: PoseConfig = DEFAULT_POSE_CONFIG): PoseSolution | null {
  if (corrs.length < 4) return null;
  const planar = allCoplanar(corrs.map((c) => c.world));
  const Km = kMat(cv, K);
  const dist = distMat(cv, K);
  const thr = cfg.ransacReprojPx * 1.5;

  const toPose = (r: any, t: any): Pose | null => {
    const pose: Pose = { rvec: Array.from(r.data64F as Float64Array).slice(0, 3) as Vec3, tvec: Array.from(t.data64F as Float64Array).slice(0, 3) as Vec3 };
    return pose.rvec.every(Number.isFinite) && pose.tvec.every(Number.isFinite) ? pose : null;
  };
  // Solve on a subset (optionally from a guess) with a given flag.
  const solveSubset = (idx: number[], flag: number, guess?: Pose): Pose | null => {
    const sub = idx.map((i) => corrs[i]);
    const obj = cv.matFromArray(sub.length, 1, cv.CV_64FC3, sub.flatMap((c) => c.world));
    const img = cv.matFromArray(sub.length, 1, cv.CV_64FC2, sub.flatMap((c) => c.image));
    const r = guess ? cv.matFromArray(3, 1, cv.CV_64F, guess.rvec) : new cv.Mat();
    const t = guess ? cv.matFromArray(3, 1, cv.CV_64F, guess.tvec) : new cv.Mat();
    try {
      return cv.solvePnP(obj, img, Km, dist, r, t, !!guess, flag) ? toPose(r, t) : null;
    } catch (e) {
      debugLog("solvePnP", cv, e);
      return null;
    } finally {
      release(obj, img, r, t);
    }
  };
  const finish = (pose: Pose | null): PoseSolution | null => {
    if (!pose) return null;
    const perPoint = reprojErrors(cv, corrs, pose, K);
    const inl = corrs.length > 4 ? perPoint.map((e, i) => (e <= thr ? i : -1)).filter((i) => i >= 0) : corrs.map((_, i) => i);
    if (inl.length < 4) return null;
    const reprojError = inl.reduce((a, i) => a + perPoint[i], 0) / inl.length;
    return { pose, intrinsics: K, reprojError, inliers: inl.length, total: corrs.length, perPoint, fovRefined: false };
  };
  // Re-solve on the current inliers (LM) a couple of times.
  const polish = (sol: PoseSolution | null): PoseSolution | null => {
    let cur = sol;
    for (let k = 0; k < 2 && cur; k++) {
      const idx = cur.perPoint.map((e, i) => (e <= thr ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 4) break;
      const next = finish(solveSubset(idx, cv.SOLVEPNP_ITERATIVE, cur.pose));
      if (!next || next.inliers < cur.inliers || (next.inliers === cur.inliers && next.reprojError >= cur.reprojError)) break;
      cur = next;
    }
    return cur;
  };

  try {
    const all = corrs.map((_, i) => i);
    let best: PoseSolution | null = null;
    const consider = (s: PoseSolution | null) => {
      if (s && (!best || s.inliers > best.inliers || (s.inliers === best.inliers && s.reprojError < best.reprojError))) best = s;
    };
    if (corrs.length === 4) {
      consider(finish(solveSubset(all, planar ? cv.SOLVEPNP_IPPE : cv.SOLVEPNP_SQPNP) ?? solveSubset(all, cv.SOLVEPNP_SQPNP)));
    } else {
      // (1) direct solve on everything — for a planar set SOLVEPNP_ITERATIVE starts from
      // the plane homography, which lands on the true branch of the planar ambiguity —
      // then trim outliers.
      const direct = solveSubset(all, planar || corrs.length >= 6 ? cv.SOLVEPNP_ITERATIVE : cv.SOLVEPNP_SQPNP);
      consider(polish(finish(direct)));
      const directBest = best as PoseSolution | null;
      // (2) RANSAC — only overrides the direct solve when it explains strictly more
      // points (i.e. the direct solve was dragged off by bad matches).
      const obj = cv.matFromArray(corrs.length, 1, cv.CV_64FC3, corrs.flatMap((c) => c.world));
      const img = cv.matFromArray(corrs.length, 1, cv.CV_64FC2, corrs.flatMap((c) => c.image));
      const r = new cv.Mat();
      const t = new cv.Mat();
      const inl = new cv.Mat();
      try {
        if (cv.solvePnPRansac(obj, img, Km, dist, r, t, false, cfg.ransacIterations, cfg.ransacReprojPx, 0.99, inl, cv.SOLVEPNP_SQPNP)) {
          const rs = polish(finish(toPose(r, t)));
          if (rs && (!directBest || rs.inliers > directBest.inliers)) best = rs;
        }
      } catch (e) {
        debugLog("solvePnPRansac", cv, e);
      } finally {
        release(obj, img, r, t, inl);
      }
    }
    const b = best as PoseSolution | null;
    if (!b || b.inliers / corrs.length < cfg.minInlierRatio) return null;
    return b;
  } catch (e) {
    debugLog("pose", cv, e);
    return null;
  } finally {
    release(Km, dist);
  }
}

// Non-RANSAC Levenberg–Marquardt solve on a fixed inlier set, starting from a guess.
function solveOnInliers(cv: CV, corrs: Correspondence[], inlierIdx: number[], K: Intrinsics, guess: Pose): PoseSolution | null {
  const sub = inlierIdx.map((i) => corrs[i]);
  const obj = cv.matFromArray(sub.length, 1, cv.CV_64FC3, sub.flatMap((c) => c.world));
  const img = cv.matFromArray(sub.length, 1, cv.CV_64FC2, sub.flatMap((c) => c.image));
  const Km = kMat(cv, K);
  const dist = distMat(cv, K);
  const rvec = cv.matFromArray(3, 1, cv.CV_64F, guess.rvec);
  const tvec = cv.matFromArray(3, 1, cv.CV_64F, guess.tvec);
  try {
    if (!cv.solvePnP(obj, img, Km, dist, rvec, tvec, true, cv.SOLVEPNP_ITERATIVE)) return null;
    const pose: Pose = { rvec: Array.from(rvec.data64F).slice(0, 3) as Vec3, tvec: Array.from(tvec.data64F).slice(0, 3) as Vec3 };
    if (!pose.rvec.every(Number.isFinite) || !pose.tvec.every(Number.isFinite)) return null;
    const perPoint = reprojErrors(cv, corrs, pose, K);
    const reprojError = inlierIdx.reduce((s, i) => s + perPoint[i], 0) / inlierIdx.length;
    return { pose, intrinsics: K, reprojError, inliers: inlierIdx.length, total: corrs.length, perPoint, fovRefined: false };
  } catch (e) {
    debugLog("pose", cv, e);
    return null;
  } finally {
    release(obj, img, Km, dist, rvec, tvec);
  }
}

// Solve the pose, refining the focal length when there are enough correspondences:
// a coarse FOV sweep (RANSAC at each candidate) finds the inlier set and the rough
// FOV; a fine sweep then re-solves only the inliers (LM from the coarse pose) and
// keeps the candidate FOV with the lowest reprojection error.
export function solvePose(
  cv: CV,
  corrs: Correspondence[],
  width: number,
  height: number,
  cfg: PoseConfig = DEFAULT_POSE_CONFIG,
  accept?: (s: PoseSolution) => boolean,
): PoseSolution | null {
  const ok = (s: PoseSolution | null): s is PoseSolution => !!s && (!accept || accept(s));
  if (corrs.length < cfg.refineFovMinPoints) {
    const s = solvePoseFixed(cv, corrs, intrinsicsFromFov(width, height, cfg.fovDeg), cfg);
    return ok(s) ? s : null;
  }
  const pick = (sols: PoseSolution[]) => {
    if (!sols.length) return null;
    const maxIn = Math.max(...sols.map((s) => s.inliers));
    return sols.filter((s) => s.inliers >= maxIn * 0.9).sort((a, b) => a.reprojError - b.reprojError)[0];
  };
  const coarseCfg = { ...cfg, ransacIterations: Math.min(cfg.ransacIterations, 80) };
  const coarse: PoseSolution[] = [];
  for (let f = cfg.fovSearchMin; f <= cfg.fovSearchMax + 1e-9; f += cfg.fovCoarseStep) {
    const s = solvePoseFixed(cv, corrs, intrinsicsFromFov(width, height, f), coarseCfg);
    if (ok(s)) coarse.push(s);
  }
  const best = pick(coarse);
  if (!best) return null;
  const inlierIdx = best.perPoint.map((e, i) => (e <= cfg.ransacReprojPx * 1.5 ? i : -1)).filter((i) => i >= 0);
  const fine: PoseSolution[] = [best];
  const f0 = best.intrinsics.fovDeg;
  for (let f = Math.max(cfg.fovSearchMin, f0 - cfg.fovCoarseStep); f <= Math.min(cfg.fovSearchMax, f0 + cfg.fovCoarseStep) + 1e-9; f += cfg.fovFineStep) {
    const s = solveOnInliers(cv, corrs, inlierIdx, intrinsicsFromFov(width, height, f), best.pose);
    if (ok(s)) fine.push(s);
  }
  const refined = { ...(pick(fine) ?? best), fovRefined: true };
  return cfg.fitDistortion ? withLensDistortion(cv, corrs, refined, width, height, cfg, ok) : refined;
}

// A wide lens (a phone's 0.5x camera, an action camera, a broadcast zoom at its wide end)
// bends the field's straight lines outward, most toward the edges of the picture — where the
// GOALS and RAMPS often are. A pinhole fit then compromises, and the far RAMPS land a ball or
// more off (Marshall's wide side camera, DC1's broadcast). The points far from the centre are
// the ones a pinhole fit rejects, so the lens is fitted on every point the pinhole pose
// roughly explains (within 3x the inlier distance): k1 together with the FOV, on a coarse grid
// and then a finer one around the best. It is kept only when it lowers their mean error by
// distortionMinGain and a full robust solve with it explains at least as many points as the
// pinhole camera, more closely.
function withLensDistortion(cv: CV, corrs: Correspondence[], sol: PoseSolution, width: number, height: number, cfg: PoseConfig, ok: (s: PoseSolution | null) => s is PoseSolution): PoseSolution {
  const thr = cfg.ransacReprojPx * 1.5;
  const loose = sol.perPoint.map((e, i) => (e <= 3 * thr ? i : -1)).filter((i) => i >= 0);
  if (loose.length < cfg.distortionMinPoints) return sol;
  const hd = Math.hypot(width / 2, height / 2);
  const reach = loose.map((i) => Math.hypot(corrs[i].image[0] - width / 2, corrs[i].image[1] - height / 2) / hd).sort((a, b) => a - b);
  if (reach[Math.floor(0.9 * (reach.length - 1))] < cfg.distortionMinReach) return sol;
  const base = solveOnInliers(cv, corrs, loose, sol.intrinsics, sol.pose);
  if (!ok(base)) return sol;
  let best: PoseSolution | null = null;
  const tryLens = (fov: number, k1: number) => {
    if (fov < cfg.fovSearchMin || fov > cfg.fovSearchMax) return;
    const s = solveOnInliers(cv, corrs, loose, { ...intrinsicsFromFov(width, height, fov), k1 }, best?.pose ?? sol.pose);
    if (ok(s) && (!best || s.reprojError < best.reprojError)) best = s;
  };
  const f0 = sol.intrinsics.fovDeg;
  for (const k1 of cfg.distortionK1) for (let f = f0 - 8; f <= f0 + 8 + 1e-9; f += 2) tryLens(f, k1);
  if (!best) return sol;
  const c = best as PoseSolution;
  const fc = c.intrinsics.fovDeg, kc = c.intrinsics.k1 ?? 0;
  for (let dk = -0.03; dk <= 0.03 + 1e-9; dk += 0.015) for (let df = -1.5; df <= 1.5 + 1e-9; df += 0.5) if (Math.abs(kc + dk) > 1e-9) tryLens(fc + df, kc + dk);
  const b = best as PoseSolution;
  if (b.reprojError > (1 - cfg.distortionMinGain) * base.reprojError) return sol;
  const fin = solvePoseFixed(cv, corrs, b.intrinsics, cfg);
  if (!ok(fin) || fin.inliers < sol.inliers || (fin.inliers === sol.inliers && fin.reprojError >= sol.reprojError)) return sol;
  return { ...fin, fovRefined: true };
}

// ---- projection of the ramps -------------------------------------------------

export type ScoringDirection = "downward" | "upward";

export interface SanityConfig {
  minInsideFraction: number; // share of the ROI polygon area that must be inside the frame
  minAreaFrac: number; // ROI area / frame area lower bound
  maxAreaFrac: number; // upper bound
  lineOffsetIn: number; // scoring line: this far down the lower RAMP from where ARTIFACTS land
}

export const DEFAULT_SANITY: SanityConfig = {
  minInsideFraction: 0.6,
  minAreaFrac: 0.0003,
  maxAreaFrac: 0.5,
  lineOffsetIn: 6, // a little over one ARTIFACT (5 in, CM §9.9) so each is seen above the line first
};

export interface RampRoi {
  alliance: Alliance;
  quadPx: Vec2[]; // projected ramp surface (4 pts, native px)
  volumePx: Vec2[]; // projected 8-point ROI volume
  quad: Vec2[]; // normalized 0..1 surface quad
  // Axis-aligned counting zone (normalized), the same shape the existing detector
  // uses: x/y/w/h plus the scoring line position within the zone height.
  zone: { x: number; y: number; w: number; h: number; line: number };
  direction: ScoringDirection; // which way ARTIFACTS move across the line in the image
  insideFraction: number;
  areaFrac: number;
  warnings: string[];
}

export interface RoiRejection {
  alliance: Alliance;
  reason: string;
}

export function projectRamp(ramp: RampModel, sol: PoseSolution, cfg: SanityConfig = DEFAULT_SANITY): RampRoi | RoiRejection {
  const K = sol.intrinsics;
  const W = K.width;
  const H = K.height;
  const pts = rampVolume(ramp).map((p) => projectPoint(p, sol.pose, K));
  if (pts.some((p) => p.depth <= 0)) return { alliance: ramp.alliance, reason: "ramp is behind the camera" };
  const volumePx = pts.map((p) => p.uv);
  const quadPx = volumePx.slice(0, 4);
  if (!isConvex(quadPx)) return { alliance: ramp.alliance, reason: "projected ramp is not convex" };
  const hull = convexHull(volumePx);
  const area = polygonArea(hull);
  const inside = polygonArea(clipToRect(hull, W, H));
  const insideFraction = area > 0 ? inside / area : 0;
  const areaFrac = area / (W * H);
  if (insideFraction < cfg.minInsideFraction) return { alliance: ramp.alliance, reason: `only ${Math.round(insideFraction * 100)}% of the ramp is inside the frame` };
  if (areaFrac < cfg.minAreaFrac) return { alliance: ramp.alliance, reason: "projected ramp is implausibly small" };
  if (areaFrac > cfg.maxAreaFrac) return { alliance: ramp.alliance, reason: "projected ramp is implausibly large" };

  // Counting zone = bbox of the in-frame part of the ROI volume.
  const clipped = clipToRect(hull, W, H);
  const b = bbox(clipped);
  const zone = { x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H, line: 0.5 };

  // Scoring line + direction from the ramp's own geometry: ARTIFACTS leave the GOAL,
  // land on the lower RAMP and roll to the GATE, so put the line a little way below
  // the landing point and count in the direction that motion appears in the image.
  const goalEnd = projectPoint(rampLinePoint(ramp, 0), sol.pose, K).uv;
  const gateEnd = projectPoint(rampLinePoint(ramp, 1e6), sol.pose, K).uv;
  const linePt = projectPoint(rampLinePoint(ramp, cfg.lineOffsetIn), sol.pose, K).uv;
  const bh = b.y1 - b.y0;
  zone.line = bh > 0 ? Math.min(0.95, Math.max(0.05, (linePt[1] - b.y0) / bh)) : 0.5;
  const direction: ScoringDirection = gateEnd[1] >= goalEnd[1] ? "downward" : "upward";
  const warnings: string[] = [];
  const du = Math.abs(gateEnd[0] - goalEnd[0]);
  const dv = Math.abs(gateEnd[1] - goalEnd[1]);
  if (dv < 0.3 * du) warnings.push("The ramp runs mostly sideways in this view, so the horizontal scoring line may count poorly.");
  if (insideFraction < 0.95) warnings.push(`Part of the ${ramp.alliance} ramp is outside the frame.`);

  return {
    alliance: ramp.alliance,
    quadPx,
    volumePx,
    quad: quadPx.map(([x, y]) => [x / W, y / H] as Vec2),
    zone,
    direction,
    insideFraction,
    areaFrac,
    warnings,
  };
}

export function isRoi(r: RampRoi | RoiRejection): r is RampRoi {
  return (r as RampRoi).quadPx !== undefined;
}

// General pose sanity independent of the ramps: the camera must be above the
// floor (every real camera angle is) — this rejects mirrored / flipped solutions.
export function poseIsPlausible(sol: PoseSolution): boolean {
  const c = cameraCentre(sol.pose);
  return c[2] > 1;
}

export function projectAllRamps(model: FieldModel, sol: PoseSolution, cfg: SanityConfig = DEFAULT_SANITY) {
  const rois: RampRoi[] = [];
  const rejected: RoiRejection[] = [];
  for (const r of model.ramps) {
    const res = projectRamp(r, sol, cfg);
    if (isRoi(res)) rois.push(res);
    else rejected.push(res);
  }
  return { rois, rejected };
}
