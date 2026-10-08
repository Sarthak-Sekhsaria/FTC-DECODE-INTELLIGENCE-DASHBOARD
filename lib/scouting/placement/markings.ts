/* eslint-disable @typescript-eslint/no-explicit-any */
// Field-plane anchor, model-alignment variant (part of placement method B).
//
// Aligns the whole field model to the image by analysis-by-synthesis, so it works from any
// camera angle and at low resolution:
//
//   observations  : the TILE floor region (colour-adaptive), the ALLIANCE-coloured regions
//                   (GOAL panels + lower-RAMP blockers) and the floor-tape pixels
//   model (CAD)   : FIELD outline, GOAL / blocker panel outlines, tape centre-lines
//   score         : how well the model projected with a candidate camera explains the
//                   observations — region agreement for the floor (asymmetric: parts of
//                   the field may be hidden) and the coloured panels (IoU, with the nearer
//                   GOAL hiding the farther), chamfer distance both ways for the tape
//
// The region terms are large, smooth and resolution-independent (they fix position, height
// and FOV — the tall GOALS break the floor-only FOV/height ambiguity); the tape terms add
// precision when the tape is resolved. Search = coarse grid of camera poses (cheap
// pre-score) + close-range views of each GOAL + views anchored on each GOAL's colour blob ->
// quick local fits of the most different candidates -> Nelder–Mead (pose + FOV) -> tape ICP
// polish; the result must pass one method-independent acceptance test (evaluatePose).
//
// Output = 2D<->3D correspondences + pose, like every other method.

import type { CV } from "./cv.ts";
import { release } from "./cv.ts";
import { cameraCentre, clipConvex, clipToRect, convexHull, intrinsicsFromFov, lookAt, pointInPolygon, polygonArea, projectCam, projectPoint, projectSegment, rodrigues, rotationToRodrigues, type Intrinsics, type Pose, type Vec2, type Vec3 } from "./geometry.ts";
import { goalReferencePoint, type Alliance, type FieldModel, type MarkingColour } from "./fieldModel.ts";
import { errorAtReference, poseIsPlausible, projectAllRamps, solvePose, solvePoseFixed, DEFAULT_POSE_CONFIG, DEFAULT_SANITY, type Correspondence, type PoseConfig, type PoseSolution, type RampRoi, type SanityConfig } from "./pose.ts";

export interface MarkingConfig {
  sampleStepIn: number; // model sample spacing along each tape (inches)
  scoreStepIn: number; // coarser spacing used during the global search
  refineStepIn: number; // spacing used while refining candidates
  tophatKernelFrac: number; // white-tape top-hat kernel, fraction of image width
  whiteMinContrast: number; // top-hat response needed for "white tape"
  whiteMaxSat: number;
  azimuthStepDeg: number;
  elevationsDeg: number[];
  distancesIn: number[];
  fovsDeg: number[];
  targets: Vec3[]; // points the camera may be aimed at
  goalDistancesIn: number[]; // extra close-range views aimed at each GOAL (a scout beside a GOAL / RAMP)
  anchorElevationsDeg: number[]; // views anchored on the GOAL colour blob (see alignMarkings)
  anchorMinAreaFrac: number;
  preKeepFrac: number; // share of the coarse grid that survives the cheap pre-score
  coarseCapFrac: number; // tolerant chamfer cap for the coarse search
  refineCapsFrac: number[]; // Nelder–Mead stages, tightening the cap
  refineIters: number;
  refineStepScale: number; // initial Nelder–Mead step multiplier
  refineRestarts: number;
  quickTop: number; // diverse coarse candidates given a quick local optimisation
  quickIters: number;
  diversityFrac: number; // candidates closer than this (fraction of width) count as the same
  refineTop: number; // candidates refined by Nelder–Mead at full detail
  icpTop: number; // refined candidates also polished by tape ICP
  icpRadiiFrac: number[]; // ICP search radii, fraction of image width
  inlierFrac: number; // tape inlier distance, fraction of image width
  floorMinVal: number;
  floorMaxVal: number;
  floorMaxStd: number; // local grey-level std-dev ceiling for "smooth" floor
  floorColourTol: number; // Lab distance from the estimated floor colour
  floorMaxChroma: number; // TILE is grey / lighting-tinted: Lab chroma ceiling for floor candidates
  minFloorFrac: number; // smallest field-floor region, fraction of the frame
  tapeColourDelta: number; // Lab a*/b* shift from the floor colour that counts as red/blue tape
  goalMinAreaFrac: number; // ALLIANCE-colour blobs smaller than this are ignored
  reverseSamples: number; // white-tape pixels used by the image->model term
  reverseCapFrac: number;
  // score weights (tape model->image chamfer has weight 1)
  iouWeight: number; // FIELD outline vs floor region
  reverseWeight: number; // white-tape pixels explained by the model
  goalWeight: number; // GOAL / blocker silhouettes vs ALLIANCE-colour regions (IoU)
  goalDistWeight: number; // coloured-panel points vs ALLIANCE-colour regions (distance)
  goalDistCapFrac: number; // its distance cap (fraction of width): wide, so a GOAL far off its region is still pulled in
  // acceptance (evaluatePose)
  minVisibleSamples: number; // tape samples on the floor needed before the tape check applies
  minTapeRatio: number; // share of those that must land on tape
  minGoalIoU: number; // every GOAL silhouette in view must overlap its colour this much
  minFloorExplained: number; // share of the detected floor that must lie inside the projected FIELD
  minFloorFilled: number; // share of the projected FIELD (in view) that must be seen as floor
}

export const DEFAULT_MARKING_CONFIG: MarkingConfig = {
  sampleStepIn: 1.5,
  scoreStepIn: 8,
  refineStepIn: 3,
  tophatKernelFrac: 0.018,
  whiteMinContrast: 18,
  whiteMaxSat: 90,
  azimuthStepDeg: 15,
  elevationsDeg: [8, 15, 24, 35, 48, 62, 78],
  distancesIn: [70, 110, 170, 260, 380, 540], // 70 in: a phone held at the FIELD wall
  fovsDeg: [35, 50, 65, 80],
  // Aim points on a 40 in grid over the field, so an off-centre framing is covered.
  targets: [-40, 0, 40].flatMap((x) => [-40, 0, 40].map((y) => [x, y, 0] as Vec3)),
  goalDistancesIn: [45, 70, 110],
  anchorElevationsDeg: [4, 10, 17, 25, 35, 47, 60, 75],
  anchorMinAreaFrac: 0.002,
  preKeepFrac: 0.25,
  coarseCapFrac: 0.06,
  refineCapsFrac: [0.04, 0.02, 0.01],
  refineIters: 140,
  refineStepScale: 3,
  refineRestarts: 1,
  quickTop: 60,
  quickIters: 90,
  diversityFrac: 0.04,
  refineTop: 5,
  icpTop: 2,
  icpRadiiFrac: [0.03, 0.018, 0.01, 0.006],
  inlierFrac: 0.0055,
  floorMinVal: 70,
  floorMaxVal: 235,
  floorMaxStd: 14,
  floorColourTol: 22,
  floorMaxChroma: 60,
  minFloorFrac: 0.012,
  tapeColourDelta: 8,
  goalMinAreaFrac: 0.0006,
  reverseSamples: 300,
  reverseCapFrac: 0.012,
  iouWeight: 0.6,
  reverseWeight: 0.8,
  goalWeight: 1.2,
  goalDistWeight: 0.6,
  goalDistCapFrac: 0.15,
  minVisibleSamples: 40,
  minTapeRatio: 0.2,
  minGoalIoU: 0.3,
  minFloorExplained: 0.7,
  minFloorFilled: 0.08,
};

// Score of a view that cannot be right (no FIELD in front of the camera, parameters out of range).
export const IMPOSSIBLE = 99;

export interface Sample {
  world: Vec3;
  colour: MarkingColour;
}

// Points along every floor-tape centre-line.
export function sampleMarkings(model: FieldModel, stepIn: number): Sample[] {
  const out: Sample[] = [];
  for (const m of model.markings) {
    const pts = m.closed ? [...m.points, m.points[0]] : m.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / stepIn));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({ world: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0], colour: m.colour });
      }
    }
    if (!m.closed) out.push({ world: pts[pts.length - 1], colour: m.colour });
  }
  return out;
}

export interface MarkingMaps {
  W: number;
  H: number;
  floorHull: Vec2[]; // work px; markings are only searched for on the field floor
  floorColour: [number, number, number] | null; // Lab (0..255) of the chosen floor region
  floorAlternatives: number; // distinct floor candidates ranked after the chosen one
  floor: Uint8Array; // 1 = on the (dilated) field floor
  // ALLIANCE-colour regions (GOAL panels, blockers), small blobs and broadcast banners
  // removed: per-row prefix sums (W + 1 per row) and total pixel count.
  goalRows: Record<Alliance, Int32Array>;
  goalInt: Record<Alliance, Int32Array>; // 2D integral image, (W + 1) x (H + 1)
  goalTotal: Record<Alliance, number>;
  goalDist: Record<Alliance, Float32Array>; // distance to the nearest kept ALLIANCE-colour pixel
  banners: Rect[]; // broadcast overlay areas: nothing is known about the field there
  goalBlob: Record<Alliance, Blob | null>; // largest ALLIANCE-colour region (usually the GOAL)
  whitePts: Float32Array; // subsample of white-tape pixel coordinates (x, y pairs)
  masks: Record<MarkingColour, Uint8Array>; // 1 = tape pixel
  dist: Record<MarkingColour, Float32Array>; // distance to nearest tape pixel (px)
  counts: Record<MarkingColour, number>;
}

export interface Blob {
  cx: number;
  cy: number; // centroid, work px
  area: number;
}

export interface Rect {
  x0: number;
  x1: number; // inclusive
  y0: number;
  y1: number; // inclusive
}

// Broadcast score banners: a band of ALLIANCE colour at the bottom / top frame edge whose
// sides are straight and vertical (a rectangle). A GOAL touching the frame edge has sloped
// sides under perspective, so it is not mistaken for one.
function findBanners(md: Uint8Array, W: number, H: number): Rect[] {
  const out: Rect[] = [];
  for (const fromBottom of [true, false]) {
    const ys: number[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let skipped = 0;
    for (let k = 0; k < 0.3 * H; k++) {
      const y = fromBottom ? H - 1 - k : k;
      let first = -1;
      let last = -1;
      let n = 0;
      for (let x = 0; x < W; x++)
        if (md[y * W + x]) {
          if (first < 0) first = x;
          last = x;
          n++;
        }
      if (n < 0.2 * W) {
        if (!ys.length && ++skipped <= 3) continue; // a thin border line at the very edge
        break;
      }
      ys.push(y);
      starts.push(first);
      ends.push(last);
    }
    if (ys.length < 3) continue;
    const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];
    const ms = med(starts);
    const me = med(ends);
    const straight = starts.filter((v, i) => Math.abs(v - ms) <= 2 && Math.abs(ends[i] - me) <= 2).length >= 0.8 * ys.length;
    if (!straight) continue;
    const yA = Math.min(...ys);
    const yB = Math.max(...ys);
    out.push({ x0: Math.max(0, ms - 2), x1: Math.min(W - 1, me + 2), y0: fromBottom ? Math.max(0, yA - 2) : 0, y1: fromBottom ? H - 1 : Math.min(H - 1, yB + 2) });
  }
  return out;
}

// Keep the ALLIANCE-colour blobs that can be field structure: clear the broadcast banners
// (`banners`, found on both colours) and drop specks.
function goalRegions(cv: CV, mask0: any, minArea: number, banners: Rect[]): { rows: Int32Array; integral: Int32Array; total: number; dist: Float32Array; blob: Blob | null } {
  const W = mask0.cols;
  const H = mask0.rows;
  const mask = mask0.clone();
  {
    const md = mask.data as Uint8Array;
    for (const b of banners) for (let y = b.y0; y <= b.y1; y++) md.fill(0, y * W + b.x0, y * W + b.x1 + 1);
  }
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const cents = new cv.Mat();
  const rows = new Int32Array((W + 1) * H);
  let total = 0;
  try {
    const n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
    const keep = new Uint8Array(n);
    const st = stats.data32S as Int32Array;
    const cd = cents.data64F as Float64Array;
    let blob: Blob | null = null;
    for (let i = 1; i < n; i++) {
      const area = st[i * 5 + 4];
      if (area >= minArea) keep[i] = 1;
      if (area >= minArea && (!blob || area > blob.area)) blob = { cx: cd[2 * i], cy: cd[2 * i + 1], area };
    }
    const lb = labels.data32S as Int32Array;
    const inv = new cv.Mat(H, W, cv.CV_8UC1);
    const iv = inv.data as Uint8Array;
    for (let y = 0; y < H; y++) {
      let acc = 0;
      const o = y * (W + 1);
      for (let x = 0; x < W; x++) {
        const k = keep[lb[y * W + x]];
        iv[y * W + x] = k ? 0 : 255;
        if (k) acc++;
        rows[o + x + 1] = acc;
      }
      total += acc;
    }
    const dt = new cv.Mat();
    cv.distanceTransform(inv, dt, cv.DIST_L2, 3);
    const dist = total ? new Float32Array(dt.data32F) : new Float32Array(W * H).fill(1e6);
    release(inv, dt);
    // 2D integral image: integral[(y) * (W + 1) + x] = kept pixels in rows < y, columns < x.
    const integral = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      const o = y * (W + 1);
      const o2 = (y + 1) * (W + 1);
      for (let x = 0; x <= W; x++) integral[o2 + x] = integral[o + x] + rows[o + x];
    }
    return { rows, integral, total, dist, blob };
  } finally {
    release(labels, stats, cents, mask);
  }
}

// Build tape masks + distance transforms and the ALLIANCE-colour regions from a
// work-resolution RGBA / HSV image.
// Where the GOALs stand: the lowest pixel of each column of every sizeable, upright
// ALLIANCE-colour blob (GOAL panels with their RAMPS; bbox at least half as tall as wide), as
// flat x, y pairs. Flat blobs are left out: a saturated patch of a red / blue venue floor lies
// on that floor rather than standing on the field.
function goalBases(cv: CV, masks: Record<Alliance, any>, minArea: number): Int32Array {
  const out: number[] = [];
  for (const a of ["red", "blue"] as Alliance[]) {
    const m = masks[a];
    const W = m.cols;
    const H = m.rows;
    const labels = new cv.Mat();
    const stats = new cv.Mat();
    const cents = new cv.Mat();
    try {
      const n = cv.connectedComponentsWithStats(m, labels, stats, cents, 8, cv.CV_32S);
      const st = stats.data32S as Int32Array;
      const low = new Map<number, Int32Array>();
      for (let i = 1; i < n; i++) if (st[i * 5 + 4] >= minArea && st[i * 5 + 3] >= 0.5 * st[i * 5 + 2]) low.set(i, new Int32Array(W).fill(-1));
      if (!low.size) continue;
      const lb = labels.data32S as Int32Array;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const col = low.get(lb[y * W + x]);
          if (col) col[x] = y;
        }
      for (const col of low.values()) for (let x = 0; x < W; x++) if (col[x] >= 0) out.push(x, col[x]);
    } finally {
      release(labels, stats, cents);
    }
  }
  return Int32Array.from(out);
}

// Which field-floor candidate buildMarkingMaps uses: the best-ranked one (after moving the one
// closest to `prefer` to the front), or the `skip`-th distinct one after it.
export interface FloorPick {
  prefer?: [number, number, number]; // Lab (0..255) of a floor that worked on an earlier frame
  skip?: number;
}

export function buildMarkingMaps(cv: CV, rgba: any, hsv: any, goalMasks: Record<Alliance, any>, cfg: MarkingConfig, pick: FloorPick = {}): MarkingMaps {
  const W = rgba.cols;
  const H = rgba.rows;
  const gray = new cv.Mat();
  const tophat = new cv.Mat();
  const white = new cv.Mat();
  const lowSat = new cv.Mat();
  const k = Math.max(3, Math.round(cfg.tophatKernelFrac * W) | 1);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
  const lo = new cv.Mat(H, W, hsv.type(), new cv.Scalar(0, 0, 0, 0));
  const hi = new cv.Mat(H, W, hsv.type(), new cv.Scalar(180, cfg.whiteMaxSat, 255, 255));
  const out: Partial<MarkingMaps> = { W, H, masks: {} as any, dist: {} as any, counts: {} as any, floorHull: [], floorColour: null, floorAlternatives: 0 };
  const floor = cv.Mat.zeros(H, W, cv.CV_8UC1);
  let redTapeRaw: any = null;
  let blueTapeRaw: any = null;
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    // White tape = thin bright lines: morphological top-hat, low saturation. Found first,
    // because the tape is what identifies the field floor.
    cv.morphologyEx(gray, tophat, cv.MORPH_TOPHAT, kernel);
    cv.threshold(tophat, white, cfg.whiteMinContrast, 255, cv.THRESH_BINARY);
    cv.inRange(hsv, lo, hi, lowSat);
    cv.bitwise_and(white, lowSat, white);
    // Field floor = the large SMOOTH, low-chroma region that carries the white tape. The
    // TILE is grey, but venue lighting / white balance can tint it (e.g. warm beige), and
    // the frame centre is not always floor (a low camera next to a GOAL), so candidate
    // floor colours are the commonest smooth low-chroma colours in the whole frame, and the
    // one whose region holds the most white tape wins (largest region when no tape is
    // resolved). Crowds are textured; carpets / drapes rarely carry tape lines.
    let fA = 0, fB = 0;
    let haveColour = false;
    {
      const f32 = new cv.Mat();
      const mu = new cv.Mat();
      const mu2 = new cv.Mat();
      const sq = new cv.Mat();
      gray.convertTo(f32, cv.CV_32F);
      const kb = new cv.Size(Math.max(3, Math.round(W * 0.015) | 1), Math.max(3, Math.round(W * 0.015) | 1));
      cv.blur(f32, mu, kb);
      cv.multiply(f32, f32, sq);
      cv.blur(sq, mu2, kb);
      const g = gray.data as Uint8Array;
      const m1 = mu.data32F as Float32Array;
      const m2 = mu2.data32F as Float32Array;
      const rgb = new cv.Mat();
      const lab = new cv.Mat();
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const lb = lab.data as Uint8Array;
      const smoothOk = new Uint8Array(W * H);
      // Coarse Lab histogram of smooth, mid-bright, low-chroma pixels.
      const nb = 16 * 16 * 16;
      const cnt = new Float64Array(nb), sL = new Float64Array(nb), sA = new Float64Array(nb), sB = new Float64Array(nb);
      const bin = (L: number, a: number, b: number) => ((L >> 4) * 16 + Math.max(0, Math.min(15, ((a - 128) >> 3) + 8))) * 16 + Math.max(0, Math.min(15, ((b - 128) >> 3) + 8));
      for (let i = 0; i < W * H; i++) {
        const sd = Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i]));
        if (!(g[i] >= cfg.floorMinVal && g[i] <= cfg.floorMaxVal && sd < cfg.floorMaxStd)) continue;
        smoothOk[i] = 1;
        const L = lb[3 * i], a = lb[3 * i + 1], b = lb[3 * i + 2];
        if (Math.hypot(a - 128, b - 128) > cfg.floorMaxChroma) continue; // candidate colours only
        const k2 = bin(L, a, b);
        cnt[k2]++;
        sL[k2] += L;
        sA[k2] += a;
        sB[k2] += b;
      }
      // Up to 5 histogram peaks (each suppresses its neighbouring bins).
      const peaks: [number, number, number][] = [];
      const c2 = Float64Array.from(cnt);
      for (let p = 0; p < 5; p++) {
        let bi = -1;
        for (let k2 = 0; k2 < nb; k2++) if (c2[k2] > 0 && (bi < 0 || c2[k2] > c2[bi])) bi = k2;
        if (bi < 0 || c2[bi] < 0.002 * W * H) break;
        peaks.push([sL[bi] / cnt[bi], sA[bi] / cnt[bi], sB[bi] / cnt[bi]]);
        const Li = Math.floor(bi / 256), ai = Math.floor(bi / 16) % 16, bb = bi % 16;
        for (let dl = -1; dl <= 1; dl++) for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
          const L2 = Li + dl, a2 = ai + da, b2 = bb + db;
          if (L2 >= 0 && L2 < 16 && a2 >= 0 && a2 < 16 && b2 >= 0 && b2 < 16) c2[(L2 * 16 + a2) * 16 + b2] = 0;
        }
      }
      const wd = white.data as Uint8Array;
      const ko = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      const kc = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(W * 0.03)), Math.max(5, Math.round(W * 0.03))));
      // The GOALs stand on the field TILES, so the field floor is a region found just below
      // their bases. A venue floor around the field (stone, wood, carpet) or a wall behind it
      // can hold more tape-like lines than the field does (Maxwell's atrium, the Bedford gym
      // wall), but the GOALs do not stand on it. Candidates are each colour's three largest
      // regions. When some candidate supports a GOAL base, the ones supporting at least half as
      // much rank first; otherwise each colour's largest region does (the rule before GOAL
      // support). The rest follow by tape. Callers can retry with the next distinct candidate
      // when the field model does not fit (FloorPick.skip).
      const bases = goalBases(cv, goalMasks, Math.max(4, cfg.goalMinAreaFrac * W * H));
      const reach = Math.max(2, Math.round(W * 0.02));
      const cands: { hull: Vec2[]; box: Rect; score: number; colour: [number, number, number]; support: number; largest: boolean }[] = [];
      const region = new cv.Mat(H, W, cv.CV_8UC1);
      const rd = region.data as Uint8Array;
      for (const [cL, cA, cB] of peaks) {
        for (let i = 0; i < W * H; i++) {
          if (!smoothOk[i]) {
            rd[i] = 0;
            continue;
          }
          const dL = (lb[3 * i] - cL) * 0.5; // lighting varies across a field: weigh lightness less
          const dA = lb[3 * i + 1] - cA;
          const dB = lb[3 * i + 2] - cB;
          rd[i] = dL * dL + dA * dA + dB * dB < cfg.floorColourTol * cfg.floorColourTol ? 255 : 0;
        }
        cv.morphologyEx(region, region, cv.MORPH_OPEN, ko);
        cv.morphologyEx(region, region, cv.MORPH_CLOSE, kc);
        const contours = new cv.MatVector();
        const hier = new cv.Mat();
        cv.findContours(region, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const big: { i: number; area: number }[] = [];
        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const a = cv.contourArea(c);
          if (a >= cfg.minFloorFrac * W * H) big.push({ i, area: a });
          c.delete();
        }
        big.sort((a, b) => b.area - a.area);
        big.slice(0, 3).forEach(({ i: ci, area }, rank) => {
          const c = contours.get(ci);
          const hm = new cv.Mat();
          cv.convexHull(c, hm, false, true);
          const hd = hm.data32S as Int32Array;
          const hull: Vec2[] = [];
          for (let i = 0; i < hd.length; i += 2) hull.push([hd[i], hd[i + 1]]);
          // white-tape pixels inside the hull
          const fill = cv.Mat.zeros(H, W, cv.CV_8UC1);
          const mv = new cv.MatVector();
          mv.push_back(hm);
          cv.fillPoly(fill, mv, new cv.Scalar(255));
          const fdat = fill.data as Uint8Array;
          let tape = 0;
          for (let i = 0; i < W * H; i++) if (fdat[i] && wd[i]) tape++;
          // GOAL-base columns with this region at most `reach` px below them
          const cm = cv.Mat.zeros(H, W, cv.CV_8UC1);
          cv.drawContours(cm, contours, ci, new cv.Scalar(255), cv.FILLED);
          const cmd = cm.data as Uint8Array;
          let support = 0;
          for (let k = 0; k < bases.length; k += 2) {
            const x = bases[k];
            for (let y = bases[k + 1] + 1; y <= Math.min(H - 1, bases[k + 1] + reach); y++)
              if (cmd[y * W + x]) {
                support++;
                break;
              }
          }
          const r = cv.boundingRect(c);
          const score = tape + 0.002 * area;
          if (typeof process !== "undefined" && process.env?.PLACEMENT_DEBUG) console.error("[floor] candidate Lab", [cL, cA, cB].map((v) => v.toFixed(0)).join(","), "area", area, "tape", tape, "support", support, "of", bases.length / 2, "score", score.toFixed(1));
          cands.push({ hull, box: { x0: r.x, y0: r.y, x1: r.x + r.width - 1, y1: r.y + r.height - 1 }, score, colour: [cL, cA, cB], support, largest: rank === 0 });
          release(c, hm, fill, mv, cm);
        });
        release(contours, hier);
      }
      const maxSupport = Math.max(0, ...cands.map((c) => c.support));
      const supported = maxSupport >= Math.max(3, Math.round(W * 0.01));
      const first = cands.filter((c) => (supported ? c.support >= 0.5 * maxSupport : c.largest)).sort((a, b) => b.score - a.score);
      const ranked = [...first, ...cands.filter((c) => !first.includes(c)).sort((a, b) => b.score - a.score)];
      if (pick.prefer) {
        const d = (c: (typeof ranked)[number]) => Math.hypot(c.colour[0] - pick.prefer![0], c.colour[1] - pick.prefer![1], c.colour[2] - pick.prefer![2]);
        const near = ranked.filter((c) => d(c) < cfg.floorColourTol).sort((a, b) => d(a) - d(b) || b.score - a.score)[0];
        if (near) ranked.splice(0, 0, ...ranked.splice(ranked.indexOf(near), 1));
      }
      // Distinct regions: two candidates whose boxes mostly overlap are the same floor seen
      // with a slightly different colour estimate.
      const overlap = (a: Rect, b: Rect) => {
        const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
        const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
        if (iw <= 0 || ih <= 0) return 0;
        const area = (q: Rect) => (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1);
        return (iw * ih) / Math.min(area(a), area(b));
      };
      const distinct: typeof ranked = [];
      for (const c of ranked) if (!distinct.some((d) => overlap(d.box, c.box) > 0.5)) distinct.push(c);
      out.floorAlternatives = Math.max(0, distinct.length - 1 - (pick.skip ?? 0));
      const best = distinct[pick.skip ?? 0] ?? null;
      if (best) {
        [, fA, fB] = best.colour;
        out.floorColour = best.colour;
        haveColour = true;
        out.floorHull = best.hull;
        const hm = cv.matFromArray(best.hull.length, 1, cv.CV_32SC2, best.hull.flat());
        const mv = new cv.MatVector();
        mv.push_back(hm);
        cv.fillPoly(floor, mv, new cv.Scalar(255));
        const kd = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(3, Math.round(W * 0.02)), Math.max(3, Math.round(W * 0.02))));
        cv.dilate(floor, floor, kd);
        release(mv, hm, kd);
      }
      // No clear field floor -> empty hull; callers treat that as "field not in view".
      // Coloured tape relative to the floor colour: red tape is redder (higher a*),
      // blue tape bluer (lower b*) than the TILE. Absolute "saturated red / blue"
      // thresholds miss washed-out tape under warm venue lighting.
      if (haveColour) {
        // Colour shift images (clamped 0..255), then a top-hat so only THIN structures
        // (tape) survive — large redder/bluer regions such as walls, shadows or robot
        // bodies are removed.
        const shiftA = new cv.Mat(H, W, cv.CV_8UC1);
        const shiftB = new cv.Mat(H, W, cv.CV_8UC1);
        const sa = shiftA.data as Uint8Array;
        const sb = shiftB.data as Uint8Array;
        for (let i = 0; i < W * H; i++) {
          const da = lb[3 * i + 1] - fA;
          const db = fB - lb[3 * i + 2];
          sa[i] = da > 0 && da > db ? Math.min(255, da * 4) : 0;
          sb[i] = db > 0 && db > da ? Math.min(255, db * 4) : 0;
        }
        const kt = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
        cv.morphologyEx(shiftA, shiftA, cv.MORPH_TOPHAT, kt);
        cv.morphologyEx(shiftB, shiftB, cv.MORPH_TOPHAT, kt);
        redTapeRaw = new cv.Mat();
        blueTapeRaw = new cv.Mat();
        cv.threshold(shiftA, redTapeRaw, cfg.tapeColourDelta * 4, 255, cv.THRESH_BINARY);
        cv.threshold(shiftB, blueTapeRaw, cfg.tapeColourDelta * 6, 255, cv.THRESH_BINARY);
        release(shiftA, shiftB, kt);
      }
      release(rgb, lab, f32, mu, mu2, sq, ko, kc, region);
    }
    {
      const fd = floor.data as Uint8Array;
      const fb = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) fb[i] = fd[i] ? 1 : 0;
      out.floor = fb;
    }
    const sources: [MarkingColour, any][] = [
      ["white", white],
      ["red", redTapeRaw ?? goalMasks.red],
      ["blue", blueTapeRaw ?? goalMasks.blue],
    ];
    for (const [c, m0] of sources) {
      const m = new cv.Mat();
      cv.bitwise_and(m0, floor, m); // tape only counts on the field floor
      const bin = new Uint8Array(W * H);
      const d = m.data as Uint8Array;
      let n = 0;
      for (let i = 0; i < W * H; i++) if (d[i]) {
        bin[i] = 1;
        n++;
      }
      const inv = new cv.Mat();
      const dt = new cv.Mat();
      cv.threshold(m, inv, 0, 255, cv.THRESH_BINARY_INV);
      m.delete();
      cv.distanceTransform(inv, dt, cv.DIST_L2, 3);
      out.masks![c] = bin;
      out.dist![c] = new Float32Array(dt.data32F);
      out.counts![c] = n;
      release(inv, dt);
    }
    out.goalRows = {} as Record<Alliance, Int32Array>;
    out.goalInt = {} as Record<Alliance, Int32Array>;
    out.goalTotal = {} as Record<Alliance, number>;
    out.goalDist = {} as Record<Alliance, Float32Array>;
    out.banners = [...findBanners(goalMasks.red.data, W, H), ...findBanners(goalMasks.blue.data, W, H)];
    out.goalBlob = { red: null, blue: null };
    for (const a of ["red", "blue"] as Alliance[]) {
      const r = goalRegions(cv, goalMasks[a], Math.max(4, cfg.goalMinAreaFrac * W * H), out.banners);
      out.goalRows[a] = r.rows;
      out.goalInt[a] = r.integral;
      out.goalTotal[a] = r.total;
      out.goalDist[a] = r.dist;
      out.goalBlob[a] = r.blob;
    }
    const wm = out.masks!.white;
    const idx: number[] = [];
    for (let i = 0; i < W * H; i++) if (wm[i]) idx.push(i);
    const step = Math.max(1, Math.floor(idx.length / cfg.reverseSamples));
    const pts: number[] = [];
    for (let k = 0; k < idx.length; k += step) pts.push(idx[k] % W, (idx[k] / W) | 0);
    out.whitePts = new Float32Array(pts);
    return out as MarkingMaps;
  } finally {
    release(gray, tophat, white, lowSat, kernel, lo, hi, floor, redTapeRaw, blueTapeRaw);
  }
}

// Cheap "is the FIELD in view at all?" test on a small copy of the frame (intro cards,
// replays and crowd shots fail it), so placement can skip such frames quickly: a TILE
// floor region plus either floor tape or an ALLIANCE-coloured structure.
export function fieldInView(cv: CV, frame: { data: Uint8ClampedArray; width: number; height: number }, cfg: MarkingConfig = DEFAULT_MARKING_CONFIG): boolean {
  const full = cv.matFromImageData(frame);
  const small = new cv.Mat();
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  let goals: Record<Alliance, any> | null = null;
  try {
    const w = 240;
    const h = Math.max(2, Math.round((frame.height / frame.width) * w));
    cv.resize(full, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    goals = allianceColourMasks(cv, hsv);
    const maps = buildMarkingMaps(cv, small, hsv, goals, cfg);
    return maps.floorHull.length >= 3 && (maps.counts.white >= 0.0008 * w * h || maps.goalTotal.red + maps.goalTotal.blue >= 0.004 * w * h);
  } finally {
    release(full, small, rgb, hsv, goals?.red, goals?.blue);
  }
}

// Saturated red / blue masks — the GOAL panels and lower-RAMP blockers are the big
// ALLIANCE-coloured objects on the field (CM §9.7). Caller releases the Mats.
export function allianceColourMasks(cv: CV, hsv: any): Record<Alliance, any> {
  const range = (l: number[], h: number[]) => {
    const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(...l));
    const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(...h));
    const m = new cv.Mat();
    cv.inRange(hsv, lo, hi, m);
    release(lo, hi);
    return m;
  };
  // Saturation floor measured on real footage: GOAL panel pixels have HSV S >= 150 (10th
  // percentile, da Vinci broadcast and Hawaii 240p); carpets and drapes are duller.
  const red = range([0, 140, 60, 0], [8, 255, 255, 255]);
  const red2 = range([170, 140, 60, 0], [180, 255, 255, 255]);
  cv.bitwise_or(red, red2, red);
  red2.delete();
  const blue = range([95, 140, 50, 0], [130, 255, 255, 255]);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.morphologyEx(red, red, cv.MORPH_OPEN, kernel);
  cv.morphologyEx(blue, blue, cv.MORPH_OPEN, kernel);
  kernel.delete();
  return { red, blue };
}

function nearestOnMask(mask: Uint8Array, W: number, H: number, x: number, y: number, r: number): Vec2 | null {
  const cx = Math.round(x);
  const cy = Math.round(y);
  let best: Vec2 | null = null;
  let bd = r * r + 1;
  const x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r);
  const y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * W;
    for (let xx = x0; xx <= x1; xx++) {
      if (!mask[row + xx]) continue;
      const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (d < bd) {
        bd = d;
        best = [xx, yy];
      }
    }
  }
  return best;
}

// Pair every tape sample that projects onto the detected floor with the nearest
// same-coloured tape pixel within `r` work px. Image points are NATIVE px.
function tapePairs(samples: Sample[], pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, r: number): { corrs: Correspondence[]; visible: number } {
  const corrs: Correspondence[] = [];
  let visible = 0;
  for (const s of samples) {
    const pr = projectPoint(s.world, pose, K);
    if (pr.depth <= 1) continue;
    const u = pr.uv[0] * scale;
    const v = pr.uv[1] * scale;
    if (u < 0 || v < 0 || u >= maps.W - 1 || v >= maps.H - 1) continue;
    if (!maps.floor[(v | 0) * maps.W + (u | 0)]) continue;
    visible++;
    const q = nearestOnMask(maps.masks[s.colour], maps.W, maps.H, u, v, r);
    if (q) corrs.push({ image: [q[0] / scale, q[1] / scale], world: s.world, label: `tape ${s.colour}` });
  }
  return { corrs, visible };
}

export interface IcpResult {
  sol: PoseSolution;
  corrs: Correspondence[];
  visible: number;
  inliers: number;
}

// ICP on the tape: pair each visible model sample with the nearest same-coloured tape
// pixel and re-solve the pose (fixed lens), shrinking the radius each round.
// `extra` = fixed correspondences from another cue (e.g. AprilTag corners, which sit on a
// vertical face and so pin down the camera height / FOV); weighted like all the tape together.
function icp(cv: CV, samples: Sample[], pose0: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, cfg: MarkingConfig, poseCfg: PoseConfig, extra: Correspondence[] = []): IcpResult | null {
  const weighExtra = (nTape: number) => (extra.length ? Array.from({ length: Math.max(1, Math.round(nTape / extra.length)) }, () => extra).flat() : []);
  let pose = pose0;
  let last: IcpResult | null = null;
  const icpCfg: PoseConfig = { ...poseCfg, minInlierRatio: 0.3, ransacIterations: 60 };
  for (const rf of cfg.icpRadiiFrac) {
    const r = Math.max(2, Math.round(rf * maps.W));
    const { corrs, visible } = tapePairs(samples, pose, K, maps, scale, r);
    if (corrs.length < 12) return last;
    const sol = solvePoseFixed(cv, [...corrs, ...weighExtra(corrs.length)], K, { ...icpCfg, ransacReprojPx: Math.max(1.5, (r / scale) * 0.8) });
    if (!sol || !poseIsPlausible(sol)) return last;
    pose = sol.pose;
    last = { sol, corrs, visible, inliers: sol.inliers };
  }
  return last;
}

// Everything the score needs that does not depend on the pose.
export interface ScoreCtx {
  outline: Vec3[];
  whiteSegs: [Vec3, Vec3][]; // white tape segments (image->model term)
  panels: { alliance: Alliance; body: Vec3[][]; blocker: Vec3[] }[];
  panelPts: { alliance: Alliance; pts: Vec3[] }[]; // points spread over the coloured panels
}

// Points spread over a planar polygon: a fan of triangles from vertex 0, each sampled on
// a small barycentric grid.
function panelPoints(poly: Vec3[], n = 4): Vec3[] {
  const out: Vec3[] = [];
  const a = poly[0];
  for (let i = 1; i + 1 < poly.length; i++) {
    const b = poly[i];
    const c = poly[i + 1];
    for (let u = 0; u <= n; u++)
      for (let v = 0; u + v <= n; v++) {
        const w = n - u - v;
        if ((u === 0 && v === 0) || (u === 0 && w === 0) || (v === 0 && w === 0)) continue; // skip vertices
        out.push([(a[0] * w + b[0] * u + c[0] * v) / n, (a[1] * w + b[1] * u + c[1] * v) / n, (a[2] * w + b[2] * u + c[2] * v) / n]);
      }
  }
  return out;
}

export function buildScoreCtx(model: FieldModel): ScoreCtx {
  const whiteSegs: [Vec3, Vec3][] = [];
  for (const m of model.markings) {
    if (m.colour !== "white") continue;
    const pts = m.closed ? [...m.points, m.points[0]] : m.points;
    for (let i = 0; i + 1 < pts.length; i++) whiteSegs.push([pts[i], pts[i + 1]]);
  }
  return {
    outline: model.perimeterCorners.map((c) => c.point),
    whiteSegs,
    panels: model.goals.map((g) => ({ alliance: g.alliance, body: g.panels.body, blocker: g.panels.blocker })),
    panelPts: model.goals.map((g) => ({ alliance: g.alliance, pts: [...g.panels.body, g.panels.blocker].flatMap((p) => panelPoints(p)) })),
  };
}

// World polygon -> camera frame -> clipped to z >= near -> image (work px).
function projectPolygon(poly: Vec3[], R: number[], t: Vec3, K: Intrinsics, scale: number, out: Vec2[]): void {
  const near = 1;
  const cam: Vec3[] = poly.map((p) => [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ]);
  const n = cam.length;
  for (let i = 0; i < n; i++) {
    const a = cam[i];
    const b = cam[(i + 1) % n];
    const ain = a[2] >= near;
    const bin = b[2] >= near;
    if (ain) {
      const q = projectCam(a as Vec3, K);
      out.push([q[0] * scale, q[1] * scale]);
    }
    if (ain !== bin) {
      const s = (near - a[2]) / (b[2] - a[2]);
      const q = projectCam([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, near], K);
      out.push([q[0] * scale, q[1] * scale]);
    }
  }
}

// x-extent of a convex polygon on the horizontal line y (null if it misses).
function rowSpan(poly: Vec2[], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
      const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

export interface SilhouetteFit {
  alliance: Alliance;
  iou: number; // overlap with the colour regions in the silhouette's neighbourhood
  area: number; // predicted silhouette pixels in the frame (work px)
  inFrame: number; // share of the whole predicted silhouette that is in the frame
}

const polyArea = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0)) / 2;

// IoU between an alliance's predicted coloured silhouette (GOAL body hull ∪ lower-RAMP
// blocker, clipped to the frame) and that alliance's colour regions, counted inside a window
// around the silhouette (its bounding box grown by half its size): colour further away —
// spectators' shirts, banners, the other end of the venue — says nothing about this pose.
// Each alliance's coloured silhouette in the image (convex hulls of the GOAL body and of the
// lower-RAMP blocker, work px) and how far away its GOAL is (for occlusion).
export interface ProjectedGoal {
  alliance: Alliance;
  polys: Vec2[][];
  depth: number;
  box: [number, number, number, number]; // x0, y0, x1, y1 of the polys
}

export function projectGoals(ctx: ScoreCtx, R: number[], t: Vec3, K: Intrinsics, scale: number): ProjectedGoal[] {
  return ctx.panels.map((p) => {
    const bodyPts: Vec2[] = [];
    for (const f of p.body) projectPolygon(f, R, t, K, scale, bodyPts);
    const blockPts: Vec2[] = [];
    projectPolygon(p.blocker, R, t, K, scale, blockPts);
    let depth = 0;
    let n = 0;
    for (const f of p.body)
      for (const w of f) {
        depth += R[6] * w[0] + R[7] * w[1] + R[8] * w[2] + t[2];
        n++;
      }
    const polys = [bodyPts, blockPts].filter((q) => q.length >= 3).map((q) => convexHull(q));
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of polys)
      for (const v of q) {
        if (v[0] < box[0]) box[0] = v[0];
        if (v[1] < box[1]) box[1] = v[1];
        if (v[0] > box[2]) box[2] = v[0];
        if (v[1] > box[3]) box[3] = v[1];
      }
    return { alliance: p.alliance, polys, depth: depth / Math.max(1, n), box };
  });
}

// Pixel columns covered by a union of convex polygons on image row y (merged, clipped).
function rowIntervals(polys: Vec2[][], yc: number, W: number): [number, number][] {
  const iv: [number, number][] = [];
  for (const q of polys) {
    const sp = rowSpan(q, yc);
    if (!sp) continue;
    const xa = Math.max(0, Math.ceil(sp[0] - 0.5));
    const xb = Math.min(W - 1, Math.floor(sp[1] - 0.5));
    if (xb >= xa) iv.push([xa, xb]);
  }
  iv.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const v of iv) {
    const last = out[out.length - 1];
    if (last && v[0] <= last[1] + 1) last[1] = Math.max(last[1], v[1]);
    else out.push([v[0], v[1]]);
  }
  return out;
}

function subtractIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  let cur = a;
  for (const [b0, b1] of b) {
    const next: [number, number][] = [];
    for (const [a0, a1] of cur) {
      if (b1 < a0 || b0 > a1) next.push([a0, a1]);
      else {
        if (b0 > a0) next.push([a0, b0 - 1]);
        if (b1 < a1) next.push([b1 + 1, a1]);
      }
    }
    cur = next;
  }
  return cur;
}

// IoU between an alliance's predicted coloured silhouette (GOAL body hull ∪ lower-RAMP
// blocker, clipped to the frame, minus what the nearer GOAL / blocker hides) and that
// alliance's colour regions, counted inside a window around the silhouette (its bounding box
// grown by half its size): colour further away — spectators' shirts, banners, the other end of
// the venue — says nothing about this pose.
export function silhouetteFits(ctx: ScoreCtx, pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, goals?: ProjectedGoal[], occlusion = true): SilhouetteFit[] {
  const W = maps.W;
  const H = maps.H;
  const pg = goals ?? projectGoals(ctx, rodrigues(pose.rvec), pose.tvec, K, scale);
  const out: SilhouetteFit[] = [];
  for (const g of pg) {
    const polys = g.polys;
    const occ = occlusion ? pg.filter((o) => o !== g && o.depth < g.depth && o.polys.length) : [];
    const occluders = occ.flatMap((o) => o.polys);
    const oy0 = Math.min(...occ.map((o) => o.box[1]));
    const oy1 = Math.max(...occ.map((o) => o.box[3]));
    const rows = maps.goalRows[g.alliance];
    let area = 0;
    let inter = 0;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    if (polys.length) {
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const q of polys) for (const v of q) {
        if (v[1] < y0) y0 = v[1];
        if (v[1] > y1) y1 = v[1];
      }
      const ya = Math.max(0, Math.ceil(y0 - 0.5));
      const yb = Math.min(H - 1, Math.floor(y1 - 0.5));
      const add = (y: number, xa: number, xb: number) => {
        let hidden = 0;
        for (const b of maps.banners) if (y >= b.y0 && y <= b.y1) hidden += Math.max(0, Math.min(xb, b.x1) - Math.max(xa, b.x0) + 1);
        area += xb - xa + 1 - hidden;
        const o = y * (W + 1);
        inter += rows[o + xb + 1] - rows[o + xa];
      };
      for (let y = ya; y <= yb; y++) {
        const yc = y + 0.5;
        if (occluders.length && yc >= oy0 && yc <= oy1) {
          // a nearer GOAL / blocker may hide part of this row
          const iv = subtractIntervals(rowIntervals(polys, yc, W), rowIntervals(occluders, yc, W));
          for (const [xa, xb] of iv) add(y, xa, xb);
          continue;
        }
        let s0 = polys[0] ? rowSpan(polys[0], yc) : null;
        let s1 = polys[1] ? rowSpan(polys[1], yc) : null;
        if (s0 && s1 && s0[0] <= s1[1] && s1[0] <= s0[1]) {
          s0 = [Math.min(s0[0], s1[0]), Math.max(s0[1], s1[1])];
          s1 = null;
        }
        for (const sp of [s0, s1]) {
          if (!sp) continue;
          const xa = Math.max(0, Math.ceil(sp[0] - 0.5));
          const xb = Math.min(W - 1, Math.floor(sp[1] - 0.5));
          if (xb >= xa) add(y, xa, xb);
        }
      }
    }
    if (!area) {
      out.push({ alliance: g.alliance, iou: 0, area: 0, inFrame: 0 });
      continue;
    }
    const full = polys.reduce((s2, q) => s2 + polyArea(q), 0);
    // The window comes from the WHOLE predicted silhouette (not just its visible part), so a
    // pose cannot hide most of a GOAL off-frame and match only a sliver of its colour region.
    for (const q of polys) for (const v of q) {
      bx0 = Math.min(bx0, v[0]);
      bx1 = Math.max(bx1, v[0]);
      by0 = Math.min(by0, v[1]);
      by1 = Math.max(by1, v[1]);
    }
    const mx = Math.max(3, 0.5 * (bx1 - bx0 + 1));
    const my = Math.max(3, 0.5 * (by1 - by0 + 1));
    const wx0 = Math.max(0, Math.floor(bx0 - mx));
    const wx1 = Math.min(W, Math.ceil(bx1 + 1 + mx));
    const wy0 = Math.max(0, Math.floor(by0 - my));
    const wy1 = Math.min(H, Math.ceil(by1 + 1 + my));
    const I = maps.goalInt[g.alliance];
    const obs = I[wy1 * (W + 1) + wx1] - I[wy0 * (W + 1) + wx1] - I[wy1 * (W + 1) + wx0] + I[wy0 * (W + 1) + wx0];
    const union = area + obs - inter;
    out.push({ alliance: g.alliance, iou: union > 0 ? inter / union : 0, area, inFrame: Math.min(1, area / Math.max(1, full)) });
  }
  return out;
}

// Score for the pose search (lower = better): the capped chamfer distance of tape
// samples that project onto the detected field floor (samples hidden by a broadcast
// overlay or off the floor say nothing), plus how badly the projected FIELD outline
// disagrees with the detected floor region. Returns IMPOSSIBLE when no FIELD is in front
// of the camera.
export function poseScore(samples: Sample[], outline: Vec3[], pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, cap: number, iouWeight: number): number {
  const R = rodrigues(pose.rvec);
  const t = pose.tvec;
  const proj = (x: number, y: number, z: number): Vec2 | null => {
    const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
    if (zc <= 1) return null;
    const q = projectCam([R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1], zc], K);
    return [q[0] * scale, q[1] * scale];
  };
  const ff = floorFit(outline, R, t, K, scale, maps);
  if (!ff) return IMPOSSIBLE;
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    const q = proj(s.world[0], s.world[1], s.world[2]);
    if (!q || q[0] < 0 || q[1] < 0 || q[0] >= maps.W - 1 || q[1] >= maps.H - 1) continue;
    if (!maps.floor[(q[1] | 0) * maps.W + (q[0] | 0)]) continue;
    sum += Math.min(maps.dist[s.colour][(q[1] | 0) * maps.W + (q[0] | 0)], cap);
    n++;
  }
  // Too little of the floor in view to judge the tape: neutral tape term.
  const tape = n >= 8 ? sum / n / cap : 0.8;
  return tape + iouWeight * (0.7 * (1 - ff.explained) + 0.3 * (1 - ff.filled));
}

export interface FloorFit {
  explained: number; // share of the detected floor region inside the projected FIELD outline
  filled: number; // share of the projected outline (in frame) that is seen as floor
}

// How the projected FIELD outline (clipped to the frame) agrees with the detected floor
// region. Asymmetric on purpose: floor seen where the model has none is a real
// disagreement, but parts of the model's floor are normally hidden (GOALS, ROBOTS, the near
// wall seen from a low camera). The outline is clipped at the camera plane first — a camera
// at the FIELD wall has field corners beside / behind it. null when no part of the FIELD is
// in front of the camera.
function floorFit(outline: Vec3[], R: number[], t: Vec3, K: Intrinsics, scale: number, maps: MarkingMaps): FloorFit | null {
  if (maps.floorHull.length < 3) return { explained: 1, filled: 1 };
  const o: Vec2[] = [];
  projectPolygon(outline, R, t, K, scale, o);
  if (o.length < 3) return null;
  const clipped = clipToRect(convexHull(o), maps.W, maps.H);
  if (clipped.length < 3) return { explained: 0, filled: 0 };
  const inter = polygonArea(clipConvex(clipped, maps.floorHull));
  return { explained: inter / Math.max(1, polygonArea(maps.floorHull)), filled: inter / Math.max(1, polygonArea(clipped)) };
}

// Full score (lower = better):
//   tape model->image : chamfer of tape samples on the floor         (poseScore)
//   floor             : detected floor outside / model floor not seen   (poseScore)
//   GOALS / blockers  : mean over alliances of 1 - IoU(silhouette, colour region)
//   tape image->model : white-tape pixels not explained by projected tape (clutter such as
//                       robots or white shirts is explained by no pose, so it cannot reward
//                       a wrong one)
export function fullScore(samples: Sample[], ctx: ScoreCtx, pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, cap: number, cfg: MarkingConfig, withReverse: boolean): number {
  const base = poseScore(samples, ctx.outline, pose, K, maps, scale, cap, cfg.iouWeight);
  if (base >= IMPOSSIBLE) return base;
  const goals = projectGoals(ctx, rodrigues(pose.rvec), pose.tvec, K, scale);
  // Occlusion between the GOALS is modelled in the precise mode (final refinement, final pick,
  // acceptance) only: it costs more and the broad search does not need it.
  const fits = silhouetteFits(ctx, pose, K, maps, scale, goals, withReverse);
  // An alliance whose silhouette is out of view explains nothing: term 1 (for the true pose
  // of such a view this is a constant, so it does not bias the search).
  const goalTerm = cfg.goalWeight * (fits.reduce((s, f) => s + (f.area ? 1 - f.iou : 1), 0) / Math.max(1, fits.length)) + cfg.goalDistWeight * panelDistance(ctx, pose, K, maps, scale, Math.max(cap, cfg.goalDistCapFrac * maps.W), withReverse ? goals : undefined);
  if (!withReverse || maps.whitePts.length < 20) return base + goalTerm;
  const segs: [Vec2, Vec2][] = [];
  for (const [a, b] of ctx.whiteSegs) {
    const s2 = projectSegment(a, b, pose, K, 1);
    if (s2) segs.push([[s2[0][0] * scale, s2[0][1] * scale], [s2[1][0] * scale, s2[1][1] * scale]]);
  }
  const rcap = Math.max(2, cfg.reverseCapFrac * maps.W);
  let sum = 0;
  const wp = maps.whitePts;
  const np = wp.length / 2;
  for (let k = 0; k < wp.length; k += 2) {
    const px = wp[k];
    const py = wp[k + 1];
    let best = rcap;
    for (const [a, b] of segs) {
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const l2 = vx * vx + vy * vy;
      const tt = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) : 0;
      const d = Math.hypot(px - a[0] - vx * tt, py - a[1] - vy * tt);
      if (d < best) best = d;
    }
    sum += best / rcap;
  }
  return base + goalTerm + cfg.reverseWeight * (sum / np);
}

// Mean capped distance of the coloured-panel points (in view) to their alliance's colour
// regions, in [0, 1]. Unlike the IoU it keeps pulling when a silhouette misses its region
// entirely, which widens the basin of the search.
function panelDistance(ctx: ScoreCtx, pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, cap: number, goals?: ProjectedGoal[]): number {
  const R = rodrigues(pose.rvec);
  const t = pose.tvec;
  // (occlusion by the nearer GOAL only when the projected GOALS are supplied — the cheap
  // pre-score skips it)
  const pg = goals ?? [];
  let sum = 0;
  let n = 0;
  for (const p of ctx.panelPts) {
    if (!maps.goalTotal[p.alliance]) continue;
    const dist = maps.goalDist[p.alliance];
    const self = pg.find((g) => g.alliance === p.alliance);
    const occ = self ? pg.filter((g) => g !== self && g.depth < self.depth && g.polys.length) : [];
    for (const w of p.pts) {
      const zc = R[6] * w[0] + R[7] * w[1] + R[8] * w[2] + t[2];
      if (zc <= 1) continue;
      const q = projectCam([R[0] * w[0] + R[1] * w[1] + R[2] * w[2] + t[0], R[3] * w[0] + R[4] * w[1] + R[5] * w[2] + t[1], zc], K);
      const u = q[0] * scale;
      const v = q[1] * scale;
      if (u < 0 || v < 0 || u >= maps.W - 1 || v >= maps.H - 1) continue;
      if (occ.some((o) => u >= o.box[0] && u <= o.box[2] && v >= o.box[1] && v <= o.box[3] && o.polys.some((q) => pointInPolygon([u, v], q)))) continue; // hidden by the nearer GOAL
      sum += Math.min(dist[(v | 0) * maps.W + (u | 0)], cap);
      n++;
    }
  }
  return n >= 10 ? sum / n / cap : 1;
}

// Cheap, smooth pre-score for the coarse grid: floor agreement + coloured-panel distance.
function preScore(ctx: ScoreCtx, pose: Pose, K: Intrinsics, maps: MarkingMaps, scale: number, cfg: MarkingConfig): number {
  const R = rodrigues(pose.rvec);
  const ff = floorFit(ctx.outline, R, pose.tvec, K, scale, maps);
  if (!ff) return IMPOSSIBLE;
  return cfg.iouWeight * (0.7 * (1 - ff.explained) + 0.3 * (1 - ff.filled)) + cfg.goalDistWeight * panelDistance(ctx, pose, K, maps, scale, cfg.goalDistCapFrac * maps.W);
}

export interface PoseEvaluation {
  goals: SilhouetteFit[]; // alliances whose silhouette is in view
  goalWorst: number; // lowest IoU among them (1 when none)
  floor: FloorFit;
  tapeVisible: number; // tape samples on the detected floor
  tapeRatio: number; // share of them within the inlier distance of same-coloured tape
  ok: boolean;
  reason?: string;
}

// Method-independent acceptance test for any pose (from tags, the TILE grid or this
// alignment): the projected model must explain the floor region, the ALLIANCE-coloured
// structures and — when enough of it is in view — the floor tape. The thresholds are
// relative (IoU, shares), so they mean the same at every resolution and camera angle.
export function evaluatePose(model: FieldModel, sol: PoseSolution, maps: MarkingMaps, scale: number, cfg: MarkingConfig = DEFAULT_MARKING_CONFIG, ctx: ScoreCtx = buildScoreCtx(model)): PoseEvaluation {
  const K = sol.intrinsics;
  const R = rodrigues(sol.pose.rvec);
  const t = sol.pose.tvec;
  const proj = (x: number, y: number, z: number): Vec2 | null => {
    const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
    if (zc <= 1) return null;
    const q = projectCam([R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1], zc], K);
    return [q[0] * scale, q[1] * scale];
  };
  const minArea = cfg.goalMinAreaFrac * maps.W * maps.H * 4;
  const goals = silhouetteFits(ctx, sol.pose, K, maps, scale).filter((f) => f.area >= minArea && f.inFrame >= 0.3);
  const goalWorst = goals.length ? Math.min(...goals.map((g) => g.iou)) : 1;
  const ff = floorFit(ctx.outline, R, t, K, scale, maps) ?? { explained: 0, filled: 0 };
  const tol = Math.max(1.5, cfg.inlierFrac * K.width) * scale;
  let vis = 0;
  let hit = 0;
  for (const s of sampleMarkings(model, cfg.sampleStepIn)) {
    const q = proj(s.world[0], s.world[1], s.world[2]);
    if (!q || q[0] < 0 || q[1] < 0 || q[0] >= maps.W - 1 || q[1] >= maps.H - 1) continue;
    const i = (q[1] | 0) * maps.W + (q[0] | 0);
    if (!maps.floor[i]) continue;
    vis++;
    if (maps.dist[s.colour][i] <= tol) hit++;
  }
  const tapeRatio = vis ? hit / vis : 0;
  const ev: PoseEvaluation = { goals, goalWorst, floor: ff, tapeVisible: vis, tapeRatio, ok: true };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (!goals.length) return { ...ev, ok: false, reason: "no GOAL in view to confirm the field orientation" };
  if (goalWorst < cfg.minGoalIoU) return { ...ev, ok: false, reason: `pose disagrees with the GOAL colours (${goals.map((g) => `${g.alliance} ${pct(g.iou)}`).join(", ")} overlap)` };
  if (ff.explained < cfg.minFloorExplained || ff.filled < cfg.minFloorFilled) return { ...ev, ok: false, reason: `pose disagrees with the field floor (${pct(ff.explained)} of the floor inside the field, ${pct(ff.filled)} of the field seen as floor)` };
  if (vis >= cfg.minVisibleSamples && tapeRatio < cfg.minTapeRatio) return { ...ev, ok: false, reason: `pose does not explain the floor tape (${pct(tapeRatio)} match)` };
  return ev;
}

// Minimal Nelder–Mead minimiser (no gradients: the objective is piecewise).
function nelderMead(f: (x: number[]) => number, x0: number[], steps: number[], iters: number): { x: number[]; fx: number } {
  const n = x0.length;
  let pts = [x0, ...steps.map((st, i) => x0.map((v, j) => (j === i ? v + st : v)))];
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]);
    vals = order.map((i) => vals[i]);
    const c = Array.from({ length: n }, (_, j) => pts.slice(0, n).reduce((a, p) => a + p[j], 0) / n);
    const worst = pts[n];
    const xr = c.map((v, j) => v + (v - worst[j]));
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = c.map((v, j) => v + 2 * (v - worst[j]));
      const fe = f(xe);
      if (fe < fr) {
        pts[n] = xe;
        vals[n] = fe;
      } else {
        pts[n] = xr;
        vals[n] = fr;
      }
    } else if (fr < vals[n - 1]) {
      pts[n] = xr;
      vals[n] = fr;
    } else {
      const xc = c.map((v, j) => v + 0.5 * (worst[j] - v));
      const fc = f(xc);
      if (fc < vals[n]) {
        pts[n] = xc;
        vals[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]));
          vals[i] = f(pts[i]);
        }
      }
    }
  }
  const bi = vals.indexOf(Math.min(...vals));
  return { x: pts[bi], fx: vals[bi] };
}

// Refine a pose + FOV by minimising the full score with a tightening tape cap.
// Parameters: rotation (Rodrigues), camera CENTRE in field inches, FOV — using the centre
// (not the camera-frame translation) decouples position from rotation for the simplex.
export function refinePose(samples: Sample[], ctx: ScoreCtx, pose: Pose, fov: number, frame: { width: number; height: number }, maps: MarkingMaps, scale: number, cfg: MarkingConfig, capsFrac = cfg.refineCapsFrac, iters = cfg.refineIters, withReverse = true, restarts = cfg.refineRestarts) {
  const toPose = (p: number[]): Pose => {
    const R = rodrigues([p[0], p[1], p[2]]);
    const C = [p[3], p[4], p[5]];
    return { rvec: [p[0], p[1], p[2]], tvec: [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])] };
  };
  let x = [...pose.rvec, ...cameraCentre(pose), fov];
  let fx = Infinity;
  for (const [si, capF] of capsFrac.entries()) {
    const cap = Math.max(2, capF * maps.W);
    // The two-way tape term matters for the final pick, not for getting into the basin, and
    // costs ~3x the rest: only the last (tightest) stage uses it.
    const rev = withReverse && si === capsFrac.length - 1;
    const f = (p: number[]) => {
      if (p[6] < 25 || p[6] > 110) return IMPOSSIBLE;
      const ps = toPose(p);
      // Physically plausible cameras only: above the floor and not absurdly far away.
      if (p[5] < 8 || Math.hypot(p[3], p[4], p[5]) > 1500) return IMPOSSIBLE;
      return fullScore(samples, ctx, ps, intrinsicsFromFov(frame.width, frame.height, p[6]), maps, scale, cap, cfg, rev);
    };
    const dist = Math.hypot(x[3], x[4], x[5]);
    const k = cfg.refineStepScale * (capF / cfg.refineCapsFrac[0]); // steps shrink with the cap
    const steps = [0.03 * k, 0.03 * k, 0.03 * k, dist * 0.03 * k, dist * 0.03 * k, dist * 0.03 * k, 4 * k];
    let r = nelderMead(f, x, steps, iters);
    // A restart from the best point (fresh simplex) escapes shallow local minima.
    for (let i = 0; i < restarts; i++) {
      const r2 = nelderMead(f, r.x, steps.map((st) => st * 0.6), iters);
      if (r2.fx < r.fx - 1e-4) r = r2;
      else break;
    }
    x = r.x;
    fx = r.fx;
  }
  return { pose: toPose(x), fov: x[6], score: fx };
}

export interface MarkingResult {
  solution: PoseSolution | null;
  rois: RampRoi[];
  correspondences: Correspondence[];
  evaluation?: PoseEvaluation;
  reason?: string;
}

// Build a PoseSolution for a pose found by direct alignment: its "reprojection error" is the
// RMS distance of the tape samples to the tape pixels they pair with (native px).
function solutionFromPose(pose: Pose, K: Intrinsics, samples: Sample[], maps: MarkingMaps, scale: number, cfg: MarkingConfig): { sol: PoseSolution; corrs: Correspondence[] } {
  const r = Math.max(2, Math.round(cfg.inlierFrac * K.width * scale * 1.5));
  const { corrs } = tapePairs(samples, pose, K, maps, scale, r);
  const per = corrs.map((c) => {
    const p = projectPoint(c.world, pose, K).uv;
    return Math.hypot(p[0] - c.image[0], p[1] - c.image[1]);
  });
  const rms = per.length ? Math.sqrt(per.reduce((s, e) => s + e * e, 0) / per.length) : 0;
  return { sol: { pose, intrinsics: K, reprojError: rms, inliers: corrs.length, total: corrs.length, perPoint: per, fovRefined: true }, corrs };
}

export function alignMarkings(
  cv: CV,
  maps: MarkingMaps,
  frame: { width: number; height: number },
  scale: number,
  model: FieldModel,
  opts: {
    prior?: PoseSolution;
    cfg?: MarkingConfig;
    poseCfg?: PoseConfig;
    sanity?: SanityConfig;
    maxReprojErrorPx?: number;
    extra?: Correspondence[]; // fixed correspondences from another cue (tag corners)
    onStage?: (stage: string, items: { pose: Pose; K: Intrinsics; score: number }[]) => void; // diagnostics
  } = {},
): MarkingResult {
  const cfg = opts.cfg ?? DEFAULT_MARKING_CONFIG;
  const poseCfg = opts.poseCfg ?? DEFAULT_POSE_CONFIG;
  const sanity = opts.sanity ?? DEFAULT_SANITY;
  const extra = opts.extra ?? [];
  const fail = (reason: string, evaluation?: PoseEvaluation): MarkingResult => ({ solution: null, rois: [], correspondences: [], reason, evaluation });
  if (maps.floorHull.length < 3) return fail("no field floor in view");
  if (maps.goalTotal.red + maps.goalTotal.blue === 0) return fail("no GOAL colours in view");
  const fine = sampleMarkings(model, cfg.sampleStepIn);
  const coarse = sampleMarkings(model, cfg.scoreStepIn);
  const medium = sampleMarkings(model, cfg.refineStepIn);
  const ctx = buildScoreCtx(model);
  const Kof = (fov: number) => intrinsicsFromFov(frame.width, frame.height, fov);

  // 1) candidate poses
  const refined: { pose: Pose; K: Intrinsics; score: number }[] = [];
  if (opts.prior) {
    // Tracking: the camera rarely moves between sampled frames — a short refinement from
    // the previous pose at the tight cap.
    const r = refinePose(medium, ctx, opts.prior.pose, opts.prior.intrinsics.fovDeg, frame, maps, scale, cfg, cfg.refineCapsFrac.slice(-2), Math.round(cfg.refineIters / 2));
    refined.push({ pose: r.pose, K: Kof(r.fov), score: r.score });
  } else {
    type Cand = { pose: Pose; K: Intrinsics; score: number; T: Vec3; a: number; e: number; d: number; fov: number };
    const make = (T: Vec3, a: number, e: number, d: number, fov: number): Cand | null => {
      const ar = (a * Math.PI) / 180;
      const er = (e * Math.PI) / 180;
      const eye: Vec3 = [T[0] + d * Math.cos(er) * Math.cos(ar), T[1] + d * Math.cos(er) * Math.sin(ar), T[2] + d * Math.sin(er)];
      if (eye[2] < 8 || fov < 25 || fov > 110) return null;
      return { pose: lookAt(eye, T), K: Kof(fov), score: 0, T, a, e, d, fov };
    };
    const coarseCap = Math.max(4, cfg.coarseCapFrac * maps.W);
    const all: Cand[] = [];
    const goalTargets = model.goals.map((g) => goalReferencePoint(g));
    const grids: [Vec3[], number[]][] = [
      [cfg.targets, cfg.distancesIn],
      [goalTargets, cfg.goalDistancesIn],
    ];
    // Grid views are first ranked by a cheap, smooth pre-score (floor agreement + distance of
    // the coloured panels to their colour), and only the best share gets the full coarse score.
    const grid: Cand[] = [];
    for (const [targets, dists] of grids)
      for (const fov of cfg.fovsDeg)
        for (const T of targets)
          for (const e of cfg.elevationsDeg)
            for (const d of dists)
              for (let a = 0; a < 360; a += cfg.azimuthStepDeg) {
                const c = make(T, a, e, d, fov);
                if (!c) continue;
                c.score = preScore(ctx, c.pose, c.K, maps, scale, cfg);
                if (c.score < IMPOSSIBLE) grid.push(c);
              }
    grid.sort((a, b) => a.score - b.score);
    opts.onStage?.("grid", []);
    for (const c of grid.slice(0, Math.ceil(grid.length * cfg.preKeepFrac))) {
      c.score = fullScore(coarse, ctx, c.pose, c.K, maps, scale, coarseCap, cfg, false);
      all.push(c);
    }
    // Views ANCHORED on each GOAL's colour blob: for every viewing direction around the GOAL,
    // set the distance so the model silhouette has the blob's area and aim so the GOAL lands on
    // the blob. Data-driven, so it covers close-up / very low views a fixed grid steps over.
    for (const g of model.goals) {
      const blob = maps.goalBlob[g.alliance];
      if (!blob || blob.area < cfg.anchorMinAreaFrac * maps.W * maps.H) continue;
      const G0 = goalReferencePoint(g);
      const silArea = (pose: Pose, K: Intrinsics) => {
        const R = rodrigues(pose.rvec);
        const body: Vec2[] = [];
        for (const p of g.panels.body) projectPolygon(p, R, pose.tvec, K, scale, body);
        const bl: Vec2[] = [];
        projectPolygon(g.panels.blocker, R, pose.tvec, K, scale, bl);
        return (body.length >= 3 ? polygonArea(convexHull(body)) : 0) + (bl.length >= 3 ? polygonArea(convexHull(bl)) : 0);
      };
      for (const fov of cfg.fovsDeg) {
        const K = Kof(fov);
        // camera ray through the blob centroid
        const rx = (blob.cx / scale - K.cx) / K.fx;
        const ry = (blob.cy / scale - K.cy) / K.fy;
        const rl = Math.hypot(rx, ry, 1);
        const ang = Math.acos(1 / rl);
        const al = Math.hypot(rx, ry) || 1;
        const Q = rodrigues([(-ry / al) * ang, (rx / al) * ang, 0]); // takes the optical axis onto that ray
        for (const e of cfg.anchorElevationsDeg)
          for (let a = 0; a < 360; a += cfg.azimuthStepDeg) {
            const ar = (a * Math.PI) / 180;
            const er = (e * Math.PI) / 180;
            const dir: Vec3 = [Math.cos(er) * Math.cos(ar), Math.cos(er) * Math.sin(ar), Math.sin(er)];
            const a0 = silArea(lookAt([G0[0] + 100 * dir[0], G0[1] + 100 * dir[1], G0[2] + 100 * dir[2]], G0), K);
            if (a0 < 1) continue;
            const d = 100 * Math.sqrt(a0 / blob.area);
            const eye: Vec3 = [G0[0] + d * dir[0], G0[1] + d * dir[1], G0[2] + d * dir[2]];
            if (eye[2] < 8 || d > 1500) continue;
            const R1 = rodrigues(lookAt(eye, G0).rvec);
            const R: number[] = [];
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(Q[i * 3] * R1[j] + Q[i * 3 + 1] * R1[3 + j] + Q[i * 3 + 2] * R1[6 + j]);
            const tv: Vec3 = [-(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]), -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]), -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2])];
            const pose: Pose = { rvec: rotationToRodrigues(R), tvec: tv };
            const c: Cand = { pose, K, score: fullScore(coarse, ctx, pose, K, maps, scale, coarseCap, cfg, false), T: G0, a, e, d, fov };
            if (c.score < IMPOSSIBLE) all.push(c);
          }
      }
    }
    all.sort((a, b) => a.score - b.score);
    opts.onStage?.("coarse", all.slice(0, 10));
    // Keep only DIFFERENT views (compared by where the FIELD corners and GOALS project), so
    // the budget is not spent on near-duplicates of one wrong basin.
    const sigPts: Vec3[] = [...ctx.outline, ...model.goals.map((g) => g.panels.body[0][0])];
    const sig = (pose: Pose, K: Intrinsics): Vec2[] =>
      sigPts.map((p) => {
        const r = projectPoint(p, pose, K);
        return r.depth > 1 ? [r.uv[0] * scale, r.uv[1] * scale] : [1e6, 1e6];
      });
    const tol = cfg.diversityFrac * maps.W;
    const diverse = <T extends { pose: Pose; K: Intrinsics }>(list: T[], n: number): T[] => {
      const kept: { c: T; s: Vec2[] }[] = [];
      for (const c of list) {
        const s0 = sig(c.pose, c.K);
        if (kept.some((k) => k.s.every((p, i) => Math.hypot(p[0] - s0[i][0], p[1] - s0[i][1]) < tol))) continue;
        kept.push({ c, s: s0 });
        if (kept.length >= n) break;
      }
      return kept.map((k) => k.c);
    };
    // Quick local optimisation of many different coarse candidates (cheap score), so a
    // true pose that fell between grid points is still found, then full refinement of the
    // best few.
    const quick = diverse(all, cfg.quickTop).map((c) => {
      const r = refinePose(coarse, ctx, c.pose, c.K.fovDeg, frame, maps, scale, cfg, [cfg.coarseCapFrac, cfg.coarseCapFrac / 2], cfg.quickIters, false, 0);
      return { pose: r.pose, K: Kof(r.fov), score: fullScore(coarse, ctx, r.pose, Kof(r.fov), maps, scale, coarseCap / 2, cfg, true) };
    });
    quick.sort((a, b) => a.score - b.score);
    opts.onStage?.("quick", quick.slice(0, 10));
    for (const c of diverse(quick, cfg.refineTop)) {
      const r = refinePose(medium, ctx, c.pose, c.K.fovDeg, frame, maps, scale, cfg);
      refined.push({ pose: r.pose, K: Kof(r.fov), score: r.score });
    }
    refined.sort((a, b) => a.score - b.score);
  }
  opts.onStage?.("refined", refined);

  // 2) polish with tape ICP (and tag corners when given); keep whichever pose scores better
  // on the full score, then run the acceptance test.
  const finalCap = Math.max(2, cfg.refineCapsFrac[cfg.refineCapsFrac.length - 1] * maps.W);
  const score = (pose: Pose, K: Intrinsics) => fullScore(medium, ctx, pose, K, maps, scale, finalCap, cfg, true);
  const weighted = (tape: Correspondence[]) => (extra.length ? [...tape, ...Array.from({ length: Math.max(1, Math.round(tape.length / extra.length)) }, () => extra).flat()] : tape);
  let best: { sol: PoseSolution; corrs: Correspondence[]; score: number; ev: PoseEvaluation } | null = null;
  let lastFail: { reason: string; ev?: PoseEvaluation } = { reason: "the field model did not line up with the image" };
  refined.slice(0, Math.max(1, cfg.icpTop)).forEach((c) => {
    const options: { sol: PoseSolution; corrs: Correspondence[] }[] = [];
    if (!extra.length) options.push(solutionFromPose(c.pose, c.K, fine, maps, scale, cfg));
    const res = icp(cv, fine, c.pose, c.K, maps, scale, cfg, poseCfg, extra);
    if (res) {
      const finalCfg = { ...poseCfg, ransacReprojPx: Math.max(2, cfg.inlierFrac * frame.width), fitDistortion: true };
      const sol = solvePose(cv, weighted(res.corrs), frame.width, frame.height, finalCfg, poseIsPlausible) ?? res.sol;
      options.push({ sol, corrs: res.corrs });
    }
    for (const o of options) {
      const s = score(o.sol.pose, o.sol.intrinsics);
      const ev = evaluatePose(model, o.sol, maps, scale, cfg, ctx);
      if (!ev.ok) {
        lastFail = { reason: ev.reason!, ev };
        continue;
      }
      if (!best || s < best.score) best = { ...o, score: s, ev };
    }
  });
  if (!best) return fail(lastFail.reason, lastFail.ev);
  const b = best as { sol: PoseSolution; corrs: Correspondence[]; score: number; ev: PoseEvaluation };
  const refError = errorAtReference(b.sol.reprojError, frame.width);
  if (opts.maxReprojErrorPx != null && refError > opts.maxReprojErrorPx) return fail(`reprojection error ${refError.toFixed(2)} px${refError !== b.sol.reprojError ? " (at 640 px wide)" : ""} too high`, b.ev);
  const { rois } = projectAllRamps(model, b.sol, sanity);
  if (!rois.length) return fail("no ramp projection passed the sanity checks", b.ev);
  return { solution: b.sol, rois, correspondences: [...b.corrs, ...extra], evaluation: b.ev };
}
