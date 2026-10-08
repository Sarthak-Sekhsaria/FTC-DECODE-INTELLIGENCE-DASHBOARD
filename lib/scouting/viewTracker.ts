/* eslint-disable @typescript-eslint/no-explicit-any */
// Follows a moving camera (handheld phone) through a video so the RAMP slot points stay on
// the RAMP. Keyframe feature tracking: corners found on a keyframe are tracked into each new
// frame with pyramidal Lucas–Kanade and a RANSAC homography keyframe -> current frame is fitted;
// chaining gives reference -> current. When too few features survive (large pan, occlusion)
// the current frame becomes the new keyframe. For a camera that mostly rotates (a phone in the
// stands) a homography maps the whole view exactly; RANSAC ignores robots and people moving.
// Chained keyframes drift a little at every re-key, so every `reanchorEvery` frames the
// reference corners are tracked straight into the current frame (seeded with the chained
// estimate) and, when that fits, it replaces the chain: drift cannot build up over a match.
// When the two disagree by more than a couple of pixels, the static field structure
// (`verifyPolys`: the GOAL and the RAMP) decides which one is right.
// A handheld camera also translates, so near and far things (the RAMP vs the stands behind)
// move differently; with `region` set, only features around the RAMP and its GOAL are used.
// A failing search is the expensive case (every corner runs to the iteration limit), so while
// the view is lost (a graphic, a cut to another camera) it is retried only every
// `reanchorEvery` frames.

import type { CV } from "./placement/cv.ts";
import { release } from "./placement/cv.ts";

export interface ViewFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface ViewTrackerConfig {
  workWidth: number;
  maxCorners: number;
  minInliers: number; // below this the view is "lost" for the frame
  rekeyInlierFraction: number; // re-key when fewer of the keyframe's corners still fit
  ransacPx: number;
  reanchorEvery: number; // frames between direct reference -> current registrations (0 = off)
  reanchorInlierFraction: number; // share of the reference corners that must fit to re-anchor
  maxReanchorShiftPx: number; // a periodic re-anchor that moves the tracked area further than this (work px) from the chain...
  verifyPolys?: [number, number][][]; // ...is checked on these static areas (reference native px), e.g. the GOAL and RAMP
  region?: [number, number, number, number]; // x0,y0,x1,y1 in reference native px (features only here)
  lkIterations: number; // Lucas–Kanade stopping rule per pyramid level
  lkEpsilon: number;
}

export const DEFAULT_VIEW_TRACKER_CONFIG: ViewTrackerConfig = {
  workWidth: 480,
  maxCorners: 250,
  minInliers: 20,
  rekeyInlierFraction: 0.55,
  ransacPx: 2,
  reanchorEvery: 8,
  reanchorInlierFraction: 0.3,
  maxReanchorShiftPx: 2,
  lkIterations: 20,
  lkEpsilon: 0.03,
};

export type Homography = number[]; // row-major 3x3

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulH(a: Homography, b: Homography): Homography {
  const o: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return o;
}

export function applyH(H: Homography, p: [number, number]): [number, number] {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

// A frame as grey at a tracker's working width (at most `workWidth` px wide). Trackers built
// with the same workWidth on frames of one size can share it (ViewTracker.update's `grey`).
export function workGrey(cv: CV, f: ViewFrame, workWidth: number): any {
  const m = cv.matFromImageData({ data: f.data instanceof Uint8ClampedArray ? f.data : new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.length), width: f.width, height: f.height });
  const g = new cv.Mat();
  cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
  const scale = Math.min(1, workWidth / f.width);
  if (scale < 1) cv.resize(g, g, new cv.Size(Math.round(f.width * scale), Math.round(f.height * scale)), 0, 0, cv.INTER_AREA);
  m.delete();
  return g;
}

export interface ViewUpdate {
  ok: boolean;
  H: Homography; // reference -> current, native pixels (last good one when !ok)
  inliers: number;
}

export class ViewTracker {
  private cv: CV;
  private cfg: ViewTrackerConfig;
  private scale: number;
  private key: any = null; // keyframe grey (work size)
  private keyPts: any = null; // corners on the keyframe
  private keyH: Homography = IDENTITY; // reference -> keyframe (native px)
  private lastH: Homography = IDENTITY;
  private ref: any = null; // reference grey (work size)
  private refPts: any = null;
  private frames = 0;
  private lost = 0; // consecutive frames without a view
  private noMask: any;
  private term: any;
  reanchors = 0;
  reanchorRejects = 0; // periodic re-anchors that disagreed with the chain and were not used
  private verify: { x: Float32Array; y: Float32Array; v: Float32Array } | null = null; // work px + reference grey

  constructor(cv: CV, reference: ViewFrame, cfg: ViewTrackerConfig = DEFAULT_VIEW_TRACKER_CONFIG) {
    this.cv = cv;
    this.cfg = cfg;
    this.scale = Math.min(1, cfg.workWidth / reference.width);
    this.noMask = new cv.Mat();
    this.term = new cv.TermCriteria(cv.TERM_CRITERIA_COUNT + cv.TERM_CRITERIA_EPS, cfg.lkIterations, cfg.lkEpsilon);
    const g = this.grey(reference);
    this.ref = g.clone();
    this.refPts = new cv.Mat();
    const mask = this.regionMask(IDENTITY);
    cv.goodFeaturesToTrack(this.ref, this.refPts, cfg.maxCorners, 0.01, 6, mask ?? this.noMask);
    mask?.delete();
    this.setKey(g, IDENTITY);
    this.verify = this.verifySamples();
  }

  // Reference pixels inside the verify polygons (a grid every 2 work px, at most ~4000).
  private verifySamples(): { x: Float32Array; y: Float32Array; v: Float32Array } | null {
    const polys = this.cfg.verifyPolys?.filter((q) => q.length >= 3).map((q) => q.map(([x, y]) => [x * this.scale, y * this.scale] as [number, number]));
    if (!polys?.length) return null;
    const W = this.ref.cols, H = this.ref.rows, d = this.ref.data as Uint8Array;
    const inside = (px: number, py: number, q: [number, number][]) => {
      let c = false;
      for (let i = 0, j = q.length - 1; i < q.length; j = i++)
        if (q[i][1] > py !== q[j][1] > py && px < ((q[j][0] - q[i][0]) * (py - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) c = !c;
      return c;
    };
    const xs: number[] = [], ys: number[] = [], vs: number[] = [];
    const all = polys.flat();
    const x0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...all.map((q) => q[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...all.map((q) => q[1]))));
    for (let y = y0; y <= y1; y += 2)
      for (let x = x0; x <= x1; x += 2)
        if (polys.some((q) => inside(x, y, q))) {
          xs.push(x);
          ys.push(y);
          vs.push(d[y * W + x]);
        }
    if (xs.length < 50) return null;
    const step = Math.max(1, Math.floor(xs.length / 4000));
    const pick = (a: number[]) => Float32Array.from(a.filter((_, i) => i % step === 0));
    return { x: pick(xs), y: pick(ys), v: pick(vs) };
  }

  // How well the reference -> current map `H` (native px) lines up the verify areas: normalised
  // cross-correlation of reference and current grey there (-1..1).
  private alignment(cur: any, H: Homography): number {
    const v = this.verify!;
    const Hw = this.toWork(H);
    const W = cur.cols, Ht = cur.rows, d = cur.data as Uint8Array;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < v.x.length; i++) {
      const q = applyH(Hw, [v.x[i], v.y[i]]);
      const qx = Math.round(q[0]), qy = Math.round(q[1]);
      if (qx < 0 || qy < 0 || qx >= W || qy >= Ht) continue;
      const a = v.v[i], b = d[qy * W + qx];
      n++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
    if (n < 50) return -1;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
  }

  // Feature mask: the region mapped into a frame whose reference -> frame homography is H.
  private regionMask(H: Homography): any {
    const r = this.cfg.region;
    if (!r || !this.ref) return null;
    const cv = this.cv;
    const s = this.scale;
    const pts = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map((p) => applyH(H, p as [number, number]));
    const W = this.ref.cols, Ht = this.ref.rows;
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) * s)), x1 = Math.min(W, Math.ceil(Math.max(...pts.map((p) => p[0])) * s));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) * s)), y1 = Math.min(Ht, Math.ceil(Math.max(...pts.map((p) => p[1])) * s));
    const mask = cv.Mat.zeros(Ht, W, cv.CV_8UC1);
    if (x1 - x0 > 4 && y1 - y0 > 4) cv.rectangle(mask, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(255), -1);
    return mask;
  }

  private toNative(h: Homography): Homography {
    const s = this.scale;
    return [h[0], h[1], h[2] / s, h[3], h[4], h[5] / s, h[6] * s, h[7] * s, h[8]];
  }

  private toWork(h: Homography): Homography {
    const s = this.scale;
    return [h[0], h[1], h[2] * s, h[3], h[4], h[5] * s, h[6] / s, h[7] / s, h[8]];
  }

  // Fit a homography to point pairs (flat x,y arrays); null when RANSAC finds nothing.
  private fit(a: number[], b: number[]): { H: Homography; inliers: number } | null {
    const cv = this.cv;
    const A = cv.matFromArray(a.length / 2, 1, cv.CV_32FC2, a);
    const B = cv.matFromArray(b.length / 2, 1, cv.CV_32FC2, b);
    const mask = new cv.Mat();
    const h = cv.findHomography(A, B, cv.RANSAC, this.cfg.ransacPx, mask);
    let inl = 0;
    for (let i = 0; i < mask.rows; i++) inl += mask.data[i] ? 1 : 0;
    const H = h.empty() ? null : (Array.from(h.data64F) as number[]);
    release(A, B, mask, h);
    return H ? { H, inliers: inl } : null;
  }

  // Reference corners tracked straight into `cur`, seeded with the chained estimate `H`
  // (native px). Returns the direct reference -> current homography (work px) or null.
  private direct(cur: any, H: Homography): Homography | null {
    const cv = this.cv;
    const n = this.refPts?.rows ?? 0;
    if (n < this.cfg.minInliers) return null;
    const Hw = this.toWork(H);
    const guess: number[] = [];
    for (let i = 0; i < n; i++) guess.push(...applyH(Hw, [this.refPts.data32F[2 * i], this.refPts.data32F[2 * i + 1]]));
    const next = cv.matFromArray(n, 1, cv.CV_32FC2, guess);
    const st = new cv.Mat(), err = new cv.Mat();
    try {
      cv.calcOpticalFlowPyrLK(this.ref, cur, this.refPts, next, st, err, new cv.Size(21, 21), 3, this.term, cv.OPTFLOW_USE_INITIAL_FLOW);
      const a: number[] = [], b: number[] = [];
      for (let i = 0; i < n; i++)
        if (st.data[i]) {
          a.push(this.refPts.data32F[2 * i], this.refPts.data32F[2 * i + 1]);
          b.push(next.data32F[2 * i], next.data32F[2 * i + 1]);
        }
      if (a.length / 2 < this.cfg.minInliers) return null;
      const r = this.fit(a, b);
      if (!r || r.inliers < Math.max(this.cfg.minInliers, this.cfg.reanchorInlierFraction * n)) return null;
      return r.H;
    } finally {
      release(next, st, err);
    }
  }

  private grey(f: ViewFrame) {
    return workGrey(this.cv, f, this.cfg.workWidth);
  }

  private setKey(g: any, H: Homography) {
    release(this.key, this.keyPts);
    this.key = g;
    this.keyH = H;
    this.keyPts = new this.cv.Mat();
    const mask = this.regionMask(H);
    this.cv.goodFeaturesToTrack(g, this.keyPts, this.cfg.maxCorners, 0.01, 6, mask ?? this.noMask);
    mask?.delete();
  }

  // work-pixel homography keyframe -> current, or null
  private track(cur: any): { H: Homography; inliers: number; total: number } | null {
    const cv = this.cv;
    const n = this.keyPts?.rows ?? 0;
    if (n < this.cfg.minInliers) return null;
    const next = new cv.Mat(), st = new cv.Mat(), err = new cv.Mat();
    try {
      cv.calcOpticalFlowPyrLK(this.key, cur, this.keyPts, next, st, err, new cv.Size(21, 21), 3, this.term);
      const a: number[] = [], b: number[] = [];
      for (let i = 0; i < n; i++)
        if (st.data[i]) {
          a.push(this.keyPts.data32F[2 * i], this.keyPts.data32F[2 * i + 1]);
          b.push(next.data32F[2 * i], next.data32F[2 * i + 1]);
        }
      if (a.length / 2 < this.cfg.minInliers) return null;
      const r = this.fit(a, b);
      return r ? { ...r, total: n } : null;
    } finally {
      release(next, st, err);
    }
  }

  // Largest displacement (work px) between two reference -> current maps over the tracked area
  // (the region's corners, or the frame's).
  private disagreement(a: Homography, b: Homography): number {
    const r = this.cfg.region;
    const W = this.ref.cols / this.scale, Ht = this.ref.rows / this.scale;
    const pts: [number, number][] = r ? [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]] : [[0, 0], [W, 0], [W, Ht], [0, Ht]];
    return Math.max(...pts.map((q) => {
      const pa = applyH(a, q), pb = applyH(b, q);
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * this.scale;
    }));
  }

  // `grey`: this frame from workGrey() with the same workWidth, when the caller already has it
  // (several trackers on one frame); it is not consumed.
  update(frame: ViewFrame, grey?: any): ViewUpdate {
    this.frames++;
    if (this.lost > 0 && this.cfg.reanchorEvery > 0 && this.lost % this.cfg.reanchorEvery !== 0) {
      this.lost++;
      return { ok: false, H: this.lastH, inliers: 0 };
    }
    const cur = grey ? grey.clone() : this.grey(frame);
    const r = this.track(cur);
    const chained = r && r.inliers >= this.cfg.minInliers ? mulH(this.toNative(r.H), this.keyH) : null;
    // re-anchor on the reference: regularly, and whenever the chain is lost
    if (this.cfg.reanchorEvery > 0 && (!chained || this.frames % this.cfg.reanchorEvery === 0)) {
      const d = this.direct(cur, chained ?? this.lastH);
      // A periodic re-anchor removes slow drift (well under a pixel per re-anchor). When the
      // direct match to the reference frame and the frame-to-frame chain disagree by more than
      // maxReanchorShiftPx, one of them is wrong: the direct match can latch onto people and
      // robots that moved since the reference (around the GOAL late in a match), and a chain can
      // drift. The static structure decides: whichever lines up the verify areas (GOAL panels,
      // RAMP) better is kept. Without verify areas the re-anchor is used. With the chain lost
      // there is no choice.
      const H = d ? this.toNative(d) : null;
      if (H && chained && this.verify && this.disagreement(H, chained) > this.cfg.maxReanchorShiftPx && this.alignment(cur, chained) >= this.alignment(cur, H)) this.reanchorRejects++;
      else if (H) {
        this.lastH = H;
        this.reanchors++;
        this.lost = 0;
        this.setKey(cur, H);
        return { ok: true, H, inliers: r?.inliers ?? 0 };
      }
    }
    if (!chained || !r) {
      cur.delete();
      this.lost++;
      return { ok: false, H: this.lastH, inliers: r?.inliers ?? 0 };
    }
    this.lost = 0;
    this.lastH = chained;
    if (r.inliers < this.cfg.rekeyInlierFraction * r.total) this.setKey(cur, chained);
    else cur.delete();
    return { ok: true, H: chained, inliers: r.inliers };
  }

  dispose() {
    release(this.key, this.keyPts, this.ref, this.refPts, this.noMask);
    this.key = this.keyPts = this.ref = this.refPts = this.noMask = null;
  }
}
