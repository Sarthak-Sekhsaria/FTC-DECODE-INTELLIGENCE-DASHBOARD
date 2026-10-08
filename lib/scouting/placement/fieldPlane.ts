/* eslint-disable @typescript-eslint/no-explicit-any */
// Placement method B — field-plane anchor (best for overhead / high views where the
// GOAL tags are edge-on or tiny). Finds the TILE grid on the floor and matches its
// line intersections to the field model's grid, then solves a FULL pose (not a
// floor homography — the RAMP is raised, so a homography would misplace it).
//
//   1. segment the grey TILE floor, take its convex hull
//   2. Canny + HoughLinesP inside/along it
//   3. group segments into families by vanishing point (RANSAC); each family is one
//      grid direction under perspective (launch-line diagonals form their own family)
//   4. merge each family's segments into distinct lines, intersect family pairs
//   5. hypothesise which detected lines are which model grid lines (offsets, axis
//      swap, flips) with a 4-point floor homography, score by how many detected
//      intersections land on predicted grid points
//   6. for the best hypotheses solve the full pose from >= 6 non-collinear points,
//      and break the field's rotational symmetry with the GOAL colours

import type { CV } from "./cv.ts";
import { release } from "./cv.ts";
import {
  applyH,
  cameraCentre,
  clipToRect,
  convexHull,
  convexIoU,
  isConvex,
  homography4,
  intersect,
  intrinsicsFromFov,
  lineThrough,
  nonCollinear,
  pointInPolygon,
  projectPoint,
  type HLine,
  type Vec2,
  type Vec3,
} from "./geometry.ts";
import type { Alliance, FieldModel } from "./fieldModel.ts";
import { solvePose, solvePoseFixed, poseIsPlausible, projectAllRamps, errorAtReference, DEFAULT_POSE_CONFIG, DEFAULT_SANITY, type Correspondence, type PoseConfig, type PoseSolution, type RampRoi, type SanityConfig } from "./pose.ts";
import type { FrameImage } from "./apriltag.ts";
import { alignMarkings, allianceColourMasks, buildMarkingMaps, evaluatePose, DEFAULT_MARKING_CONFIG, type FloorPick, type MarkingConfig, type MarkingMaps, type PoseEvaluation } from "./markings.ts";

export interface FieldPlaneConfig {
  workWidth: number; // frames are downscaled to this width for line work (TILE-seam grid)
  alignWidth: number; // ... and to this width for the whole-model alignment (region + tape cues)
  floorMaxSat: number; // HSV (0..255) saturation ceiling for grey TILE
  floorMinVal: number;
  floorMaxVal: number;
  minFloorAreaFrac: number;
  cannyLow: number;
  cannyHigh: number;
  houghThreshold: number;
  minSegFrac: number; // min segment length as a fraction of the image diagonal
  maxGapFrac: number;
  vpAngleTolDeg: number;
  maxFamilies: number;
  mergeTolFrac: number; // lines closer than this (fraction of diagonal) merge
  minLineSupportFrac: number; // total segment length a line needs
  matchTolFrac: number; // intersection <-> predicted grid point tolerance
  minMatches: number; // "at least 6 non-collinear matched points"
  maxHypothesesToSolve: number;
  maxHypothesesForShifts: number; // top hypotheses expanded with ±1-tile relabellings
  minFloorIoU: number; // projected FIELD outline vs segmented floor
  goalMinAreaFrac: number;
  minGoalColourAgreement: number; // share of a projected GOAL silhouette that must be its colour
}

export const DEFAULT_FIELD_PLANE_CONFIG: FieldPlaneConfig = {
  workWidth: 960,
  alignWidth: 640,
  floorMaxSat: 70,
  floorMinVal: 35,
  floorMaxVal: 215,
  minFloorAreaFrac: 0.04,
  cannyLow: 30,
  cannyHigh: 90,
  houghThreshold: 30,
  minSegFrac: 0.035,
  maxGapFrac: 0.01,
  vpAngleTolDeg: 1.5,
  maxFamilies: 4,
  mergeTolFrac: 0.012,
  minLineSupportFrac: 0.05,
  matchTolFrac: 0.014,
  minMatches: 6,
  maxHypothesesToSolve: 12,
  maxHypothesesForShifts: 3,
  minFloorIoU: 0.3,
  goalMinAreaFrac: 0.0015,
  minGoalColourAgreement: 0.35,
};

interface Seg {
  p: Vec2;
  q: Vec2;
  len: number;
  mid: Vec2;
  dir: Vec2; // unit
}

export interface DetectedLine {
  family: number;
  line: HLine; // work-image px
  support: number;
  endpoints: [Vec2, Vec2]; // clipped to the frame, work px
}

export interface FieldPlaneDebug {
  scale: number; // work px = native px * scale
  floorHull: Vec2[]; // native px
  segments: { p: Vec2; q: Vec2; family: number }[]; // native px, family -1 = none
  lines: { a: Vec2; b: Vec2; family: number }[]; // native px
  intersections: Vec2[]; // native px
  matched: Correspondence[];
  variant?: "grid" | "markings";
  goalBlobs: Partial<Record<Alliance, Vec2>>;
}

export interface MethodBResult {
  tracked?: boolean; // solved by tracking the previous frame's pose
  variant?: "grid" | "markings"; // TILE-seam grid or whole-model alignment
  evaluation?: PoseEvaluation; // acceptance-test measurements of the returned / last rejected pose
  solution: PoseSolution | null;
  rois: RampRoi[];
  correspondences: Correspondence[];
  reason?: string;
  debug: FieldPlaneDebug;
  floorColour?: [number, number, number] | null; // Lab of the field floor the alignment used
}

// ---- image stages -------------------------------------------------------------

function scalarMat(cv: CV, like: any, v: number[]) {
  return new cv.Mat(like.rows, like.cols, like.type(), new cv.Scalar(...v));
}

function largestContour(cv: CV, mask: any): { pts: Vec2[]; area: number; centroid: Vec2 } | null {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  try {
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) {
        bestArea = a;
        best = i;
      }
      c.delete();
    }
    if (best < 0) return null;
    const c = contours.get(best);
    const hull = new cv.Mat();
    cv.convexHull(c, hull, false, true);
    const d = hull.data32S as Int32Array;
    const pts: Vec2[] = [];
    for (let i = 0; i < d.length; i += 2) pts.push([d[i], d[i + 1]]);
    const m = cv.moments(c, false);
    const centroid: Vec2 = m.m00 > 0 ? [m.m10 / m.m00, m.m01 / m.m00] : pts[0];
    release(c, hull);
    return { pts, area: bestArea, centroid };
  } finally {
    release(contours, hier);
  }
}

function toHsv(cv: CV, rgba: any) {
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  rgb.delete();
  return hsv;
}

function maskRange(cv: CV, hsv: any, lo: number[], hi: number[]) {
  const l = scalarMat(cv, hsv, lo);
  const h = scalarMat(cv, hsv, hi);
  const m = new cv.Mat();
  cv.inRange(hsv, l, h, m);
  release(l, h);
  return m;
}

function morph(cv: CV, m: any, op: number, k: number) {
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
  cv.morphologyEx(m, m, op, kernel);
  kernel.delete();
}

// Saturated red / blue masks — the GOAL structures (and their RAMP covers) are the
// big alliance-coloured objects on the field (CM §9.7). Caller releases the Mats.
export function goalColourMasks(cv: CV, hsv: any): Record<Alliance, any> {
  return allianceColourMasks(cv, hsv);
}

// Largest blob centroid per colour (for the debug overlay).
export function findGoalBlobs(cv: CV, masks: Record<Alliance, any>, cfg: FieldPlaneConfig): Partial<Record<Alliance, Vec2>> {
  const out: Partial<Record<Alliance, Vec2>> = {};
  for (const alliance of ["red", "blue"] as Alliance[]) {
    const m = masks[alliance].clone();
    const area = m.rows * m.cols;
    const c = largestContour(cv, m);
    m.delete();
    if (c && c.area >= cfg.goalMinAreaFrac * area) out[alliance] = c.centroid;
  }
  return out;
}

// For a candidate pose, how much of each GOAL's projected silhouette is actually
// that GOAL's colour. A grid shifted by a tile, or the field rotated/flipped, puts
// the silhouettes on the wrong pixels (or the other alliance's colour).
export function goalColourAgreement(
  cv: CV,
  masks: Record<Alliance, any>,
  sol: PoseSolution,
  model: FieldModel,
  scale: number,
): { score: number; worst: number; perGoal: Partial<Record<Alliance, number>>; evaluated: number } {
  const W = masks.red.cols;
  const H = masks.red.rows;
  const perGoal: Partial<Record<Alliance, number>> = {};
  let sum = 0;
  let n = 0;
  let worst = 1;
  for (const g of model.goals) {
    const pts: Vec2[] = [];
    let behind = false;
    for (const p of [...g.footprint, ...g.topLip]) {
      const r = projectPoint(p, sol.pose, sol.intrinsics);
      if (r.depth <= 0) behind = true;
      pts.push([r.uv[0] * scale, r.uv[1] * scale]);
    }
    if (behind) continue;
    const hull = clipToRect(convexHull(pts), W, H);
    if (hull.length < 3) continue;
    const poly = cv.matFromArray(hull.length, 1, cv.CV_32SC2, hull.flatMap((p) => [Math.round(p[0]), Math.round(p[1])]));
    const pv = new cv.MatVector();
    pv.push_back(poly);
    const sil = cv.Mat.zeros(H, W, cv.CV_8UC1);
    const both = new cv.Mat();
    try {
      cv.fillPoly(sil, pv, new cv.Scalar(255));
      const total = cv.countNonZero(sil);
      if (total < 30) continue;
      cv.bitwise_and(sil, masks[g.alliance], both);
      const f = cv.countNonZero(both) / total;
      perGoal[g.alliance] = f;
      worst = Math.min(worst, f);
      sum += f;
      n++;
    } finally {
      release(poly, pv, sil, both);
    }
  }
  return { score: n ? sum / n : 0, worst: n ? worst : 0, perGoal, evaluated: n };
}

function detectSegments(cv: CV, rgba: any, hsv: any, cfg: FieldPlaneConfig): { segs: Seg[]; hull: Vec2[] } | { reason: string } {
  const W = rgba.cols;
  const H = rgba.rows;
  const diag = Math.hypot(W, H);
  const floor = maskRange(cv, hsv, [0, 0, cfg.floorMinVal, 0], [180, cfg.floorMaxSat, cfg.floorMaxVal, 255]);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const hullMask = cv.Mat.zeros(H, W, cv.CV_8UC1);
  const lines = new cv.Mat();
  try {
    morph(cv, floor, cv.MORPH_OPEN, 5);
    morph(cv, floor, cv.MORPH_CLOSE, 15);
    const f = largestContour(cv, floor);
    if (!f || f.area < cfg.minFloorAreaFrac * W * H) return { reason: "TILE floor not found" };
    const hull = f.pts;
    // Hull mask, grown so the floor/wall boundary lines are kept.
    const pv = cv.matFromArray(hull.length, 1, cv.CV_32SC2, hull.flat());
    const mv = new cv.MatVector();
    mv.push_back(pv);
    cv.fillPoly(hullMask, mv, new cv.Scalar(255));
    release(mv, pv);
    morph(cv, hullMask, cv.MORPH_DILATE, Math.max(3, Math.round(diag * 0.025)));

    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, edges, cfg.cannyLow, cfg.cannyHigh, 3, true);
    cv.bitwise_and(edges, hullMask, edges);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, cfg.houghThreshold, Math.max(15, cfg.minSegFrac * diag), Math.max(3, cfg.maxGapFrac * diag));
    const d = lines.data32S as Int32Array;
    let segs: Seg[] = [];
    for (let i = 0; i < d.length; i += 4) {
      const p: Vec2 = [d[i], d[i + 1]];
      const q: Vec2 = [d[i + 2], d[i + 3]];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1) continue;
      segs.push({ p, q, len, mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], dir: [(q[0] - p[0]) / len, (q[1] - p[1]) / len] });
    }
    segs.sort((a, b) => b.len - a.len);
    segs = segs.slice(0, 400);
    return { segs, hull };
  } finally {
    release(floor, gray, edges, hullMask, lines);
  }
}

// ---- vanishing-point families ---------------------------------------------------

// Direction from a segment midpoint toward a homogeneous point v (finite or not).
function dirToward(mid: Vec2, v: Vec3): Vec2 | null {
  if (Math.abs(v[2]) < 1e-9) {
    const l = Math.hypot(v[0], v[1]);
    return l > 0 ? [v[0] / l, v[1] / l] : null;
  }
  const dx = v[0] / v[2] - mid[0];
  const dy = v[1] / v[2] - mid[1];
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? [dx / l, dy / l] : null;
}

function consistent(s: Seg, v: Vec3, cosTol: number): boolean {
  const d = dirToward(s.mid, v);
  if (!d) return false;
  return Math.abs(s.dir[0] * d[0] + s.dir[1] * d[1]) >= cosTol;
}

// Homogeneous line through a segment in a normalized frame (for numerical sanity).
function segLine(s: Seg, W: number, H: number, D: number): Vec3 {
  const n = (p: Vec2): Vec2 => [(p[0] - W / 2) / D, (p[1] - H / 2) / D];
  return lineThrough(n(s.p), n(s.q));
}

function vpToPixels(v: Vec3, W: number, H: number, D: number): Vec3 {
  // normalized homogeneous -> pixel homogeneous
  return [v[0] * D + (W / 2) * v[2], v[1] * D + (H / 2) * v[2], v[2]];
}

function findFamilies(segs: Seg[], W: number, H: number, cfg: FieldPlaneConfig, rand: () => number): { vp: Vec3; members: Seg[] }[] {
  const D = Math.hypot(W, H);
  const cosTol = Math.cos((cfg.vpAngleTolDeg * Math.PI) / 180);
  let pool = [...segs];
  const fams: { vp: Vec3; members: Seg[] }[] = [];
  for (let f = 0; f < cfg.maxFamilies && pool.length >= 2; f++) {
    const total = pool.reduce((s, x) => s + x.len, 0);
    const pickWeighted = () => {
      let r = rand() * total;
      for (const s of pool) {
        r -= s.len;
        if (r <= 0) return s;
      }
      return pool[pool.length - 1];
    };
    let best: { vp: Vec3; score: number } | null = null;
    for (let it = 0; it < 500; it++) {
      const a = pickWeighted();
      const b = pickWeighted();
      if (a === b) continue;
      const vn = [0, 0, 0] as Vec3;
      const la = segLine(a, W, H, D);
      const lb = segLine(b, W, H, D);
      vn[0] = la[1] * lb[2] - la[2] * lb[1];
      vn[1] = la[2] * lb[0] - la[0] * lb[2];
      vn[2] = la[0] * lb[1] - la[1] * lb[0];
      const nrm = Math.hypot(vn[0], vn[1], vn[2]);
      if (nrm < 1e-12) continue;
      const v = vpToPixels([vn[0] / nrm, vn[1] / nrm, vn[2] / nrm], W, H, D);
      let score = 0;
      for (const s of pool) if (consistent(s, v, cosTol)) score += s.len;
      if (!best || score > best.score) best = { vp: v, score };
    }
    if (!best) break;
    const members = pool.filter((s) => consistent(s, best!.vp, cosTol));
    if (members.length < 2) break;
    fams.push({ vp: best.vp, members });
    const set = new Set(members);
    pool = pool.filter((s) => !set.has(s));
  }
  return fams;
}

// Merge a family's segments into distinct lines. Segments are clustered by where
// their VP-directed line crosses a reference line through the image centre; each
// cluster is then fitted by weighted total least squares on its segment endpoints
// (more accurate than forcing it through the estimated vanishing point).
function familyLines(fam: { vp: Vec3; members: Seg[] }, fi: number, W: number, H: number, cfg: FieldPlaneConfig): DetectedLine[] {
  const D = Math.hypot(W, H);
  const c: Vec2 = [W / 2, H / 2];
  const d = dirToward(c, fam.vp) ?? fam.members[0].dir;
  const ref: HLine = lineThrough(c, [c[0] - d[1], c[1] + d[0]]); // through centre, perpendicular to d
  const perp: Vec2 = [-d[1], d[0]];
  const items: { t: number; w: number; seg: Seg }[] = [];
  for (const s of fam.members) {
    const dir = dirToward(s.mid, fam.vp) ?? s.dir;
    const l = lineThrough(s.mid, [s.mid[0] + dir[0], s.mid[1] + dir[1]]);
    const x = intersect(l, ref);
    if (!x) continue;
    items.push({ t: (x[0] - c[0]) * perp[0] + (x[1] - c[1]) * perp[1], w: s.len, seg: s });
  }
  items.sort((a, b) => a.t - b.t);
  const clusters: { t: number; w: number; segs: Seg[] }[] = [];
  for (const it of items) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(it.t - last.t) < cfg.mergeTolFrac * D) {
      const w = last.w + it.w;
      last.t = (last.t * last.w + it.t * it.w) / w;
      last.w = w;
      last.segs.push(it.seg);
    } else clusters.push({ t: it.t, w: it.w, segs: [it.seg] });
  }
  const out: DetectedLine[] = [];
  for (const cl of clusters) {
    if (cl.w < cfg.minLineSupportFrac * D) continue;
    const p: Vec2 = [c[0] + perp[0] * cl.t, c[1] + perp[1] * cl.t];
    const dir = dirToward(p, fam.vp) ?? d;
    const line = fitLine(cl.segs) ?? lineThrough(p, [p[0] + dir[0], p[1] + dir[1]]);
    out.push({ family: fi, line, support: cl.w, endpoints: clipLine(line, W, H) ?? [p, p] });
  }
  return out;
}

// Weighted total-least-squares line through the endpoints of a cluster's segments.
function fitLine(segs: Seg[]): HLine | null {
  let sw = 0, mx = 0, my = 0;
  for (const s of segs) for (const p of [s.p, s.q]) {
    sw += s.len;
    mx += p[0] * s.len;
    my += p[1] * s.len;
  }
  if (sw <= 0) return null;
  mx /= sw;
  my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (const s of segs) for (const p of [s.p, s.q]) {
    sxx += s.len * (p[0] - mx) ** 2;
    sxy += s.len * (p[0] - mx) * (p[1] - my);
    syy += s.len * (p[1] - my) ** 2;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal direction
  const dir: Vec2 = [Math.cos(th), Math.sin(th)];
  return lineThrough([mx, my], [mx + dir[0], my + dir[1]]);
}

function clipLine(l: HLine, W: number, H: number): [Vec2, Vec2] | null {
  const borders: HLine[] = [lineThrough([0, 0], [W, 0]), lineThrough([W, 0], [W, H]), lineThrough([W, H], [0, H]), lineThrough([0, H], [0, 0])];
  const pts: Vec2[] = [];
  for (const b of borders) {
    const x = intersect(l, b);
    if (x && x[0] >= -1 && x[0] <= W + 1 && x[1] >= -1 && x[1] <= H + 1) pts.push(x);
  }
  if (pts.length < 2) return null;
  let best: [Vec2, Vec2] = [pts[0], pts[1]];
  let bd = -1;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dd = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (dd > bd) {
        bd = dd;
        best = [pts[i], pts[j]];
      }
    }
  return best;
}

// ---- grid matching ---------------------------------------------------------------

interface Hypothesis {
  H: number[]; // world floor (x,y) -> work image
  matches: { img: Vec2; world: Vec3; key: string }[];
  residual: number;
  iou: number; // projected FIELD outline vs detected floor
  score: number;
}

function adjacentPairs(lines: DetectedLine[], maxPairs: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < lines.length; i++) pairs.push([i, i + 1]);
  return pairs.sort((a, b) => lines[b[0]].support + lines[b[1]].support - (lines[a[0]].support + lines[a[1]].support)).slice(0, maxPairs);
}

function modelPairs(n: number, steps: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (const s of steps) if (i + s >= 0 && i + s < n) out.push([i, i + s]);
  return out;
}

// Homogeneous w of H applied to a world floor point (its sign tells front/back).
const wOf = (H: number[], p: Vec2) => H[6] * p[0] + H[7] * p[1] + H[8];

interface ScoreCtx {
  inters: Vec2[];
  gridX: number[];
  gridY: number[];
  tol: number;
  hull: Vec2[]; // detected floor hull (work px)
  W: number;
  H: number;
}

function scoreHypothesis(H: number[], seed: Vec2, ctx: ScoreCtx): Hypothesis | null {
  const { gridX, gridY } = ctx;
  const front = Math.sign(wOf(H, seed));
  // The model floor outline must project to a sane convex quad in front of the camera.
  const outlineW: Vec2[] = [
    [gridX[0], gridY[0]],
    [gridX[gridX.length - 1], gridY[0]],
    [gridX[gridX.length - 1], gridY[gridY.length - 1]],
    [gridX[0], gridY[gridY.length - 1]],
  ];
  if (outlineW.some((p) => Math.sign(wOf(H, p)) !== front)) return null;
  const outline = outlineW.map((p) => applyH(H, p));
  if (outline.some((p) => !p) || !isConvex(outline as Vec2[])) return null;
  // How well the projected FIELD outline matches the segmented floor — a grid
  // shifted by a tile fits the seams nearly as well but not the floor's extent.
  const inFrame = clipToRect(outline as Vec2[], ctx.W, ctx.H);
  const iou = inFrame.length >= 3 ? convexIoU(inFrame, ctx.hull) : 0;

  const proj: { p: Vec2; world: Vec3; key: string }[] = [];
  for (let i = 0; i < gridX.length; i++)
    for (let j = 0; j < gridY.length; j++) {
      if (Math.sign(wOf(H, [gridX[i], gridY[j]])) !== front) continue;
      const p = applyH(H, [gridX[i], gridY[j]]);
      if (p) proj.push({ p, world: [gridX[i], gridY[j], 0], key: `${i},${j}` });
    }
  const { inters, tol } = ctx;
  const used = new Set<string>();
  const matches: Hypothesis["matches"] = [];
  let res = 0;
  for (const q of inters) {
    let best: (typeof proj)[number] | null = null;
    let bd = tol;
    for (const m of proj) {
      if (used.has(m.key)) continue;
      const d = Math.hypot(m.p[0] - q[0], m.p[1] - q[1]);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) {
      used.add(best.key);
      matches.push({ img: q, world: best.world, key: best.key });
      res += bd;
    }
  }
  return matches.length ? { H, matches, residual: res / matches.length, iou, score: matches.length * iou * iou } : null;
}

function searchGrid(famA: DetectedLine[], famB: DetectedLine[], inters: Vec2[][], ctx: ScoreCtx, steps: number[]): Hypothesis[] {
  const hyps: Hypothesis[] = [];
  const pa = adjacentPairs(famA, 5);
  const pb = adjacentPairs(famB, 5);
  const gx = ctx.gridX;
  const gy = ctx.gridY;
  for (const swap of [false, true]) {
    const axA = swap ? gy : gx; // model lines family A maps to
    const axB = swap ? gx : gy;
    const mA = modelPairs(axA.length, steps);
    const mB = modelPairs(axB.length, steps);
    for (const [a1, a2] of pa)
      for (const [b1, b2] of pb) {
        const img = [inters[a1][b1], inters[a2][b1], inters[a1][b2], inters[a2][b2]];
        if (img.some((p) => !p)) continue;
        for (const [i1, i2] of mA)
          for (const [j1, j2] of mB) {
            const w = (ia: number, jb: number): Vec2 => (swap ? [axB[jb], axA[ia]] : [axA[ia], axB[jb]]);
            const H = homography4([w(i1, j1), w(i2, j1), w(i1, j2), w(i2, j2)], img as Vec2[]);
            if (!H) continue;
            const h = scoreHypothesis(H, w(i1, j1), ctx);
            if (h && h.matches.length >= 4) hyps.push(h);
          }
      }
  }
  return hyps;
}

// ---- tracking mode ---------------------------------------------------------------------

function trackFromPrior(
  cv: CV,
  prior: PoseSolution,
  famLines: DetectedLine[][],
  W: number,
  H: number,
  scale: number,
  tol: number,
  inHull: (p: Vec2) => boolean,
  model: FieldModel,
  cfg: FieldPlaneConfig,
  masks: Record<Alliance, any>,
  frame: FrameImage,
  poseCfg: PoseConfig,
  sanity: SanityConfig,
  maxReprojErrorPx: number,
): { sol: PoseSolution; rois: RampRoi[]; corrs: Correspondence[]; inters: Vec2[] } | null {
  const gx = model.gridLinesX;
  const gy = model.gridLinesY;
  const nx = gx.length - 1;
  const ny = gy.length - 1;
  const predicted: { p: Vec2; world: Vec3; key: string; interior: boolean }[] = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      const r = projectPoint([gx[i], gy[j], 0], prior.pose, prior.intrinsics);
      if (r.depth > 0) predicted.push({ p: [r.uv[0] * scale, r.uv[1] * scale], world: [gx[i], gy[j], 0], key: `${i},${j}`, interior: i > 0 && i < nx && j > 0 && j < ny });
    }
  const inters: Vec2[] = [];
  for (let a = 0; a < famLines.length; a++)
    for (let b = a + 1; b < famLines.length; b++)
      for (const la of famLines[a])
        for (const lb of famLines[b]) {
          const p = intersect(la.line, lb.line);
          if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H && inHull(p)) inters.push(p);
        }
  const used = new Set<string>();
  const matched: { img: Vec2; world: Vec3; key: string; interior: boolean }[] = [];
  for (const q of inters) {
    let best: (typeof predicted)[number] | null = null;
    let bd = tol;
    for (const m of predicted) {
      if (used.has(m.key)) continue;
      const d = Math.hypot(m.p[0] - q[0], m.p[1] - q[1]);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) {
      used.add(best.key);
      matched.push({ img: q, world: best.world, key: best.key, interior: best.interior });
    }
  }
  const interior = matched.filter((m) => m.interior);
  const use = interior.length >= cfg.minMatches && nonCollinear(interior.map((m) => m.img)) ? interior : matched;
  if (use.length < cfg.minMatches || !nonCollinear(use.map((m) => m.img))) return null;
  const corrs: Correspondence[] = use.map((m) => ({ image: [m.img[0] / scale, m.img[1] / scale] as Vec2, world: m.world, label: `grid ${m.key}` }));
  // The lens does not change between frames of the same shot: keep the prior FOV and distortion.
  const sol = solvePoseFixed(cv, corrs, { ...intrinsicsFromFov(frame.width, frame.height, prior.intrinsics.fovDeg), k1: prior.intrinsics.k1 }, poseCfg);
  if (!sol || !poseIsPlausible(sol) || errorAtReference(sol.reprojError, frame.width) > maxReprojErrorPx) return null;
  const agree = goalColourAgreement(cv, masks, sol, model, scale);
  if (!agree.evaluated || agree.worst < cfg.minGoalColourAgreement) return null;
  const { rois } = projectAllRamps(model, sol, sanity);
  if (!rois.length) return null;
  return { sol: { ...sol, fovRefined: prior.fovRefined }, rois, corrs, inters };
}

// ---- method B ------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runFieldPlane(
  cv: CV,
  frame: FrameImage,
  model: FieldModel,
  cfg: FieldPlaneConfig = DEFAULT_FIELD_PLANE_CONFIG,
  poseCfg: PoseConfig = DEFAULT_POSE_CONFIG,
  sanity: SanityConfig = DEFAULT_SANITY,
  maxReprojErrorPx = 4, // at ERROR_REFERENCE_WIDTH (pose.ts)
  prior?: PoseSolution, // pose from a previous frame of the same shot -> fast tracking mode
  markingCfg: MarkingConfig = DEFAULT_MARKING_CONFIG,
  extraCorrs: Correspondence[] = [], // fixed correspondences from another cue (tag corners)
  floorColour?: [number, number, number] | null, // Lab of the floor an earlier frame of this video aligned on
  retryFloor = true, // align once more on the next floor candidate when the first does not fit
): MethodBResult {
  const scale = Math.min(1, cfg.workWidth / frame.width);
  const debug: FieldPlaneDebug = { scale, floorHull: [], segments: [], lines: [], intersections: [], matched: [], goalBlobs: {} };
  const fail = (reason: string): MethodBResult => ({ solution: null, rois: [], correspondences: [], reason, debug });
  const toNative = (p: Vec2): Vec2 => [p[0] / scale, p[1] / scale];

  const full = cv.matFromImageData(frame);
  const rgba = new cv.Mat();
  let hsv: any = null;
  let masks: Record<Alliance, any> | null = null;
  try {
    if (scale < 1) cv.resize(full, rgba, new cv.Size(Math.round(frame.width * scale), Math.round(frame.height * scale)), 0, 0, cv.INTER_AREA);
    else full.copyTo(rgba);
    const W = rgba.cols;
    const H = rgba.rows;
    const D = Math.hypot(W, H);
    hsv = toHsv(cv, rgba);

    masks = goalColourMasks(cv, hsv);
    const blobs = findGoalBlobs(cv, masks, cfg);
    for (const k of Object.keys(blobs) as Alliance[]) debug.goalBlobs[k] = toNative(blobs[k]!);

    // --- variant 1: TILE-seam grid (needs visible seams) ---------------------------
    const gridAttempt = (trackOnly = false): MethodBResult | string => {
      const segRes = detectSegments(cv, rgba, hsv, cfg);
      if ("reason" in segRes) return String(segRes.reason);
      debug.floorHull = segRes.hull.map(toNative);

      const fams = findFamilies(segRes.segs, W, H, cfg, mulberry32(12345));
      const famOf = new Map<Seg, number>();
      fams.forEach((f, i) => f.members.forEach((s) => famOf.set(s, i)));
      debug.segments = segRes.segs.map((s) => ({ p: toNative(s.p), q: toNative(s.q), family: famOf.get(s) ?? -1 }));
      const famLines = fams.map((f, i) => familyLines(f, i, W, H, cfg));
      for (const fl of famLines) for (const l of fl) debug.lines.push({ a: toNative(l.endpoints[0]), b: toNative(l.endpoints[1]), family: l.family });
      if (famLines.filter((l) => l.length >= 2).length < 2) return String("fewer than two grid-line directions found");

      const tol = cfg.matchTolFrac * D;
      const hullGrown = segRes.hull;
      const inHull = (p: Vec2) => {
        if (pointInPolygon(p, hullGrown)) return true;
        // within the dilation margin of the hull boundary
        let best = Infinity;
        for (let i = 0; i < hullGrown.length; i++) {
          const a = hullGrown[i];
          const b = hullGrown[(i + 1) % hullGrown.length];
          const vx = b[0] - a[0], vy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
          best = Math.min(best, Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t));
        }
        return best < 0.03 * D;
      };

      // Tracking mode: the camera rarely moves between sampled frames, so predict the
      // grid crossings from the previous frame's pose and match detected intersections
      // to them directly, skipping the hypothesis search. Falls through to the full
      // search if the prediction no longer fits.
      if (prior && prior.fovRefined !== undefined) {
        const tracked = trackFromPrior(cv, prior, famLines, W, H, scale, tol, inHull, model, cfg, masks!, frame, poseCfg, sanity, maxReprojErrorPx);
        if (tracked) {
          debug.matched = tracked.corrs;
          debug.intersections = tracked.inters.map(toNative);
          return { solution: tracked.sol, rois: tracked.rois, correspondences: tracked.corrs, debug, tracked: true, variant: "grid" };
        }
      }
      if (trackOnly) return "grid tracking lost the grid";

      const hullInFrame = clipToRect(segRes.hull, W, H);
      let allHyps: { h: Hypothesis; famPair: [number, number] }[] = [];
      for (let fa = 0; fa < famLines.length; fa++)
        for (let fb = fa + 1; fb < famLines.length; fb++) {
          const A = famLines[fa];
          const B = famLines[fb];
          if (A.length < 2 || B.length < 2) continue;
          const inters: Vec2[][] = A.map((la) => B.map((lb) => intersect(la.line, lb.line) as Vec2));
          const valid: Vec2[] = [];
          for (const row of inters) for (const p of row) if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H && inHull(p)) valid.push(p);
          if (valid.length < cfg.minMatches) continue;
          for (const p of valid) debug.intersections.push(toNative(p));
          const ctx: ScoreCtx = { inters: valid, gridX: model.gridLinesX, gridY: model.gridLinesY, tol, hull: hullInFrame, W, H };
          let hyps = searchGrid(A, B, inters, ctx, [1, -1]);
          if (!hyps.some((h) => h.matches.length >= cfg.minMatches)) hyps = hyps.concat(searchGrid(A, B, inters, ctx, [2, -2]));
          allHyps = allHyps.concat(hyps.map((h) => ({ h, famPair: [fa, fb] as [number, number] })));
        }
      if (!allHyps.length) return String("grid intersections did not match the TILE grid");

      // Best first; de-duplicate identical correspondence sets (the field's symmetry
      // produces several equally-scored hypotheses — keep them all for the colour check).
      // Rank by grid matches weighted by how well the projected FIELD outline covers the floor.
      allHyps.sort((a, b) => b.h.score - a.h.score || a.h.residual - b.h.residual);
      const seen = new Set<string>();
      const candidates: Hypothesis[] = [];
      for (const { h } of allHyps) {
        if (h.matches.length < cfg.minMatches || h.iou < cfg.minFloorIoU) continue;
        const key = h.matches.map((m) => `${m.key}@${Math.round(m.img[0])},${Math.round(m.img[1])}`).sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(h);
        if (candidates.length >= cfg.maxHypothesesToSolve) break;
      }
      if (!candidates.length) return String(`fewer than ${cfg.minMatches} grid points matched`);

      // Tile-shift ambiguity: when the floor is cut off by the frame, a grid shifted by
      // one TILE fits the seams (and the visible floor) as well as the true one. So for
      // the best hypotheses also try every ±1-tile relabelling, and let the GOAL colours
      // decide (CM Fig 9-18: each GOAL's projected silhouette must land on pixels of its
      // own alliance colour; this also breaks the field's rotational symmetry).
      const gx = model.gridLinesX;
      const gy = model.gridLinesY;
      const nx = gx.length - 1;
      const ny = gy.length - 1;
      type M = Hypothesis["matches"][number];
      const variants: M[][] = [];
      const vseen = new Set<string>();
      // The TILE grid is square (6x6), so the four 90° rotations of a labelling are
      // equally valid grid fits; only the GOALS can tell them apart.
      const rot = (r: number, i: number, j: number): [number, number] =>
        r === 0 ? [i, j] : r === 1 ? [j, nx - i] : r === 2 ? [nx - i, ny - j] : [ny - j, i];
      for (const h of candidates.slice(0, cfg.maxHypothesesForShifts)) {
        for (let r = 0; r < (nx === ny ? 4 : 1); r++)
        for (const di of [0, -1, 1])
          for (const dj of [0, -1, 1]) {
            const ms: M[] = [];
            for (const m of h.matches) {
              const [i0, j0] = m.key.split(",").map(Number);
              const [i, j] = rot(r, i0, j0);
              const i2 = i + di;
              const j2 = j + dj;
              if (i2 < 0 || i2 > nx || j2 < 0 || j2 > ny) continue;
              ms.push({ img: m.img, world: [gx[i2], gy[j2], 0], key: `${i2},${j2}` });
            }
            if (ms.length < cfg.minMatches) continue;
            const key = ms.map((m) => `${m.key}@${Math.round(m.img[0])},${Math.round(m.img[1])}`).sort().join("|");
            if (vseen.has(key)) continue;
            vseen.add(key);
            variants.push(ms);
          }
      }

      // Floor/wall boundary lines are often hidden behind the near wall's top edge
      // (what looks like the boundary is then ~a wall height higher), so when enough
      // interior TILE-seam crossings are matched, solve from those alone.
      const toCorrs = (ms: M[]): Correspondence[] | null => {
        const ok = (xs: M[]) => xs.length >= cfg.minMatches && new Set(xs.map((m) => m.world[0])).size >= 2 && new Set(xs.map((m) => m.world[1])).size >= 2 && nonCollinear(xs.map((m) => m.img));
        const interior = ms.filter((m) => {
          const [i, j] = m.key.split(",").map(Number);
          return i > 0 && i < nx && j > 0 && j < ny;
        });
        const use = ok(interior) ? interior : ok(ms) ? ms : null;
        return use ? use.map((m) => ({ image: toNative(m.img), world: m.world as Vec3, label: `grid ${m.key}` })) : null;
      };

      // Stage 1: quick fixed-FOV solve per variant, keep those whose GOALS agree.
      let lastReason = "no grid hypothesis gave a valid pose";
      let colourReason: string | null = null; // the most informative failure, if it happened
      // A shifted grid still constrains the lens well, so estimate the FOV once from the
      // top-ranked hypothesis and use it for the quick per-variant solves.
      const topCorrs = variants.length ? toCorrs(variants[0]) : null;
      const fovGuess = (topCorrs && solvePose(cv, topCorrs, frame.width, frame.height, poseCfg, poseIsPlausible)?.intrinsics.fovDeg) || poseCfg.fovDeg;
      const K0 = intrinsicsFromFov(frame.width, frame.height, fovGuess);
      if (typeof process !== "undefined" && process.env?.PLACEMENT_DEBUG) console.error("[B] fovGuess", fovGuess, "variants", variants.length);
      const passing: { corrs: Correspondence[]; worst: number; err: number }[] = [];
      for (const ms of variants) {
        const corrs = toCorrs(ms);
        if (!corrs) {
          lastReason = "matched grid points are collinear";
          continue;
        }
        const s0 = solvePoseFixed(cv, corrs, K0, poseCfg);
        if (!s0 || !poseIsPlausible(s0)) continue;
        const agree = goalColourAgreement(cv, masks!, s0, model, scale);
        if (typeof process !== "undefined" && process.env?.PLACEMENT_DEBUG)
          console.error("[B] variant", corrs.length, "cam", JSON.stringify(cameraCentre(s0.pose).map((v) => Math.round(v))), "K", s0.intrinsics.fovDeg, s0.intrinsics.width, "err@fov0", s0.reprojError.toFixed(2), "colour", JSON.stringify(agree.perGoal), "first", corrs[0].label, corrs[0].image.map((v) => v.toFixed(0)).join(","));
        if (!agree.evaluated) {
          lastReason = "no GOAL visible to confirm the field orientation";
          continue;
        }
        // EVERY visible GOAL must sit on its own colour (one matching goal is not enough —
        // a 90° rotation can put one goal right and the other on bare floor).
        if (agree.worst < cfg.minGoalColourAgreement) {
          lastReason = `grid orientation disagrees with the GOAL colours (${Math.round(agree.worst * 100)}% match)`;
          colourReason = lastReason;
          continue;
        }
        passing.push({ corrs, worst: agree.worst, err: s0.reprojError });
      }
      passing.sort((a, b) => b.worst - a.worst || a.err - b.err);

      // Stage 2: full FOV-refined solve for the best colour-consistent variants.
      let best: { sol: PoseSolution; rois: RampRoi[]; corrs: Correspondence[]; colour: number } | null = null;
      for (const p of passing.slice(0, 3)) {
        const sol = solvePose(cv, p.corrs, frame.width, frame.height, poseCfg, poseIsPlausible);
        if (!sol) {
          lastReason = "pose solve failed";
          continue;
        }
        if (errorAtReference(sol.reprojError, frame.width) > maxReprojErrorPx) {
          lastReason = `reprojection error ${sol.reprojError.toFixed(1)} px too high`;
          continue;
        }
        const agree = goalColourAgreement(cv, masks!, sol, model, scale);
        if (!agree.evaluated || agree.worst < cfg.minGoalColourAgreement) {
          colourReason = lastReason = `grid orientation disagrees with the GOAL colours (${Math.round(agree.worst * 100)}% match)`;
          continue;
        }
        const { rois } = projectAllRamps(model, sol, sanity);
        if (!rois.length) {
          lastReason = "no ramp projection passed the sanity checks";
          continue;
        }
        // Prefer the best colour agreement, then the lowest reprojection error.
        const better = !best || agree.worst > best.colour + 0.1 || (Math.abs(agree.worst - best.colour) <= 0.1 && sol.reprojError < best.sol.reprojError);
        if (better) best = { sol, rois, corrs: p.corrs, colour: agree.worst };
      }
      if (!best) return String(colourReason ?? lastReason);
      debug.matched = best.corrs;
      return { solution: best.sol, rois: best.rois, correspondences: best.corrs, debug, variant: "grid" };
    };

    // --- variant 2: whole-model alignment (floor, GOAL / blocker colours, floor tape) ---
    // The alignment works on its own (smaller) copy: its cues are regions and 1 in tape,
    // resolved at 640 px wide (and at 426 px in the Hawaii footage), and it is ~2x faster.
    const aScale = Math.min(1, cfg.alignWidth / frame.width);
    const buildMaps = (pick: FloorPick): MarkingMaps => {
      if (aScale >= scale) return buildMarkingMaps(cv, rgba, hsv, masks!, markingCfg, pick);
      const small = new cv.Mat();
      cv.resize(full, small, new cv.Size(Math.round(frame.width * aScale), Math.round(frame.height * aScale)), 0, 0, cv.INTER_AREA);
      const sHsv = toHsv(cv, small);
      const sMasks = goalColourMasks(cv, sHsv);
      try {
        return buildMarkingMaps(cv, small, sHsv, sMasks, markingCfg, pick);
      } finally {
        release(small, sHsv, sMasks.red, sMasks.blue);
      }
    };
    const floorPick: FloorPick = floorColour ? { prefer: floorColour } : {};
    let maps = buildMaps(floorPick);
    const mScale = aScale < scale ? aScale : scale;
    let lastEvaluation: PoseEvaluation | undefined;
    const markingsAttempt = (pr?: PoseSolution): MethodBResult | string => {
      const m = alignMarkings(cv, maps, frame, mScale, model, { prior: pr, cfg: markingCfg, poseCfg, sanity, maxReprojErrorPx, extra: extraCorrs });
      if (m.evaluation) lastEvaluation = m.evaluation;
      if (!m.solution) return m.reason ?? "the field model did not line up with the image";
      debug.matched = m.correspondences;
      debug.variant = "markings";
      return { solution: m.solution, rois: m.rois, correspondences: m.correspondences, debug, tracked: !!pr, variant: "markings", evaluation: m.evaluation, floorColour: maps.floorColour };
    };
    // Any accepted pose must be physically sensible and pass the same acceptance test as
    // the alignment (explains the floor, the GOAL colours and the tape).
    const validate = (sol: PoseSolution): string | null => {
      const f = sol.intrinsics.fovDeg;
      if (sol.fovRefined && (f <= poseCfg.fovSearchMin + 1e-6 || f >= poseCfg.fovSearchMax - 1e-6)) return `fitted FOV ${f}° is at the search limit (implausible)`;
      const ev = evaluatePose(model, sol, maps, mScale, markingCfg);
      lastEvaluation = ev;
      return ev.ok ? null : ev.reason!;
    };
    const failB = (reason: string): MethodBResult => ({ ...fail(reason), evaluation: lastEvaluation });

    const reasons: string[] = [];
    if (!maps.floorHull.length) return failB("no field floor in view");
    if (prior) {
      // Tracking from the previous frame's pose, then TILE-grid tracking.
      const m = markingsAttempt(prior);
      if (typeof m !== "string") return m;
      const g = gridAttempt(true);
      if (typeof g !== "string" && g.solution && !validate(g.solution)) return g;
      prior = undefined; // fall through to a full search
    }
    // Whole-model alignment first (works at any resolution / angle), then the TILE-seam grid.
    const m = markingsAttempt();
    if (typeof m !== "string") return m;
    reasons.push(`alignment: ${m}`);
    const g = gridAttempt();
    if (typeof g !== "string" && g.solution) {
      const bad = validate(g.solution);
      if (!bad) return { ...g, evaluation: lastEvaluation, floorColour: maps.floorColour };
      reasons.push(`grid: ${bad}`);
    } else reasons.push(`grid: ${g as string}`);
    // The floor candidate ranked first may be the venue floor or a wall rather than the TILES
    // (their tape-like lines, or GOAL-coloured patches): align once more on the next distinct
    // candidate, and let the field model decide.
    if (retryFloor && maps.floorAlternatives > 0) {
      maps = buildMaps({ ...floorPick, skip: 1 });
      if (maps.floorHull.length) {
        const m2 = markingsAttempt();
        if (typeof m2 !== "string") return m2;
        reasons.push(`alignment on the next floor candidate: ${m2}`);
      }
    }
    return failB(reasons.join("; "));
  } catch (e) {
    return fail(`field-plane error: ${(e as Error).message ?? String(e)}`);
  } finally {
    release(full, rgba, hsv, masks?.red, masks?.blue);
  }
}

// The alignment's acceptance test (explains the floor, the GOAL colours and the floor tape)
// for a pose found another way, e.g. from AprilTag corners alone.
export function evaluatePoseOnFrame(cv: CV, frame: FrameImage, model: FieldModel, sol: PoseSolution, cfg: FieldPlaneConfig = DEFAULT_FIELD_PLANE_CONFIG, floorColour?: [number, number, number] | null, markingCfg: MarkingConfig = DEFAULT_MARKING_CONFIG): PoseEvaluation {
  return evaluatePosesOnFrame(cv, frame, model, [sol], cfg, floorColour, markingCfg)[0];
}

// The same test for several poses of one frame (the frame's maps are built once).
export function evaluatePosesOnFrame(cv: CV, frame: FrameImage, model: FieldModel, sols: PoseSolution[], cfg: FieldPlaneConfig = DEFAULT_FIELD_PLANE_CONFIG, floorColour?: [number, number, number] | null, markingCfg: MarkingConfig = DEFAULT_MARKING_CONFIG): PoseEvaluation[] {
  const aScale = Math.min(1, cfg.alignWidth / frame.width);
  const full = cv.matFromImageData(frame);
  const small = new cv.Mat();
  let hsv: any = null;
  let masks: Record<Alliance, any> | null = null;
  try {
    if (aScale < 1) cv.resize(full, small, new cv.Size(Math.round(frame.width * aScale), Math.round(frame.height * aScale)), 0, 0, cv.INTER_AREA);
    else full.copyTo(small);
    hsv = toHsv(cv, small);
    masks = goalColourMasks(cv, hsv);
    const maps = buildMarkingMaps(cv, small, hsv, masks, markingCfg, floorColour ? { prefer: floorColour } : {});
    return sols.map((sol) => evaluatePose(model, sol, maps, aScale, markingCfg));
  } finally {
    release(full, small, hsv, masks?.red, masks?.blue);
  }
}
