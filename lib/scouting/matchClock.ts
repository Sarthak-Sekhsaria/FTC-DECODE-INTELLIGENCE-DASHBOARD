// When the match starts and when the buzzer sounds, found from the video itself.
//
// The game manual fixes the timing (CM §10.1, §10.4): a 30 s AUTO period, an 8 s transition
// (15 s at the FIRST Championship, §15.2.2) and a 2:00 TELEOP period. ROBOTS may not move
// during the transition (§10.4, "There is an 8-second delay between AUTO and TELEOP"; operating
// a ROBOT then is penalised, §10.5). So inside the FIELD a match looks the same in every video:
// robots move in AUTO, the field goes still for at least the transition, then two minutes of
// driving start all at once. That still-then-moving step is the start of TELEOP; the match
// started AUTO + transition before it and the buzzer is TELEOP later.
//
// Motion is measured on the FIELD floor one TILE in from the walls, where drive teams, referees
// and spectators cannot be, after removing the camera's own movement with a tracker fitted to
// the field area (the floor is a plane, so a homography maps it exactly). A camera cut, or a
// frame the tracker cannot follow, gives no sample.
//
// ARTIFACTS are assessed until they come to rest after the match ends (§10.5 A): a ball still
// in the air or the GOAL at the buzzer is scored when it reaches the RAMP. Counting therefore
// runs SETTLE_SEC past the buzzer, and nothing after that counts.

import type { CV } from "./placement/cv.ts";
import type { FieldModel } from "./placement/fieldModel.ts";
import { projectPoint, type Vec2 } from "./placement/geometry.ts";
import type { CameraSolution, Frame } from "./calibration.ts";
import { applyH, DEFAULT_VIEW_TRACKER_CONFIG, ViewTracker, workGrey, type Homography } from "./viewTracker.ts";

export const AUTO_SEC = 30;
export const TELEOP_SEC = 120;
export const TRANSITIONS_SEC = [8, 15] as const; // regular events, FIRST Championship
export const MATCH_SEC = AUTO_SEC + TRANSITIONS_SEC[0] + TELEOP_SEC; // 158 s
// After the buzzer: ARTIFACTS still in the air or in the GOAL reach the RAMP and come to rest
// within a couple of seconds (flight, the drop through the GOAL and the SQUARE, the roll down
// the RAMP). Measured on 10 videos counted to their end: no ARTIFACT joined a queue later than
// this after the buzzer, the found buzzer is within 1.6 s on all 17, and a broadcast can fade
// to its graphics 2-3 s after the buzzer (Washington DC1).
export const SETTLE_SEC = 3;

export interface MotionSample {
  t: number;
  motion: number; // share of the inner-FIELD floor that changed since the previous sample
}

export interface MatchWindow {
  start: number; // video seconds: the start of AUTO (or, when that cannot be seen, the earliest it can have been)
  likelyStart: number; // the start of AUTO, or when that cannot be seen, the latest it can have been (8 s transition)
  teleopStart: number;
  buzzer: number;
  transitionSec: number; // 8, or 15 at the FIRST Championship (known when the start of AUTO is seen)
  score: number; // driving after the step / stillness before it
  final: boolean; // late enough in the video that no later TELEOP start can replace it
}

export interface MatchClockConfig {
  sampleSec: number; // motion is measured between frames this far apart
  workWidth: number; // frames are reduced to this width for it
  innerShare: number; // the inner FIELD: this share of the perimeter, i.e. one TILE in from each wall
  changeLevel: number; // grey-level change (of 255, after a light blur) that counts as motion
  minScore: number; // a TELEOP start needs at least this much more motion after the step than before...
  onsetSec: number; // ...from the first few seconds on
  minAutoShare: number; // ...and motion in AUTO of at least this share of TELEOP's (robots do not move before a match)
  minAutoSeen: number; // the AUTO check is made when at least this much of AUTO is in the video
  lateStartSec: number; // a recording may start this far into AUTO...
  earlyStopSec: number; // ...or stop this far before the buzzer
  commitAfterSec: number; // live: a TELEOP start is final this long after it (a later one would have been seen)
  minAutoStep: number; // the start of AUTO is taken from the robots' first move when it is this clear
}

export const DEFAULT_MATCH_CLOCK_CONFIG: MatchClockConfig = {
  sampleSec: 0.2,
  workWidth: 320,
  innerShare: 0.66,
  changeLevel: 15,
  minScore: 2,
  onsetSec: 3,
  minAutoShare: 0.05,
  minAutoSeen: 10,
  lateStartSec: 15,
  earlyStopSec: 10,
  commitAfterSec: 55,
  minAutoStep: 4,
};

// Mean motion over [a, b) of time-sorted samples, and how much of that span had samples
// (prefix sums: the detector asks for thousands of spans).
function spans(samples: MotionSample[]) {
  const t = Float64Array.from(samples.map((q) => q.t));
  const sum = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) sum[i + 1] = sum[i] + samples[i].motion;
  const lower = (x: number) => {
    let lo = 0, hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (a: number, b: number): { mean: number; seen: number; n: number } => {
    const i = lower(a), j = lower(b);
    const n = j - i;
    return { mean: n > 0 ? (sum[j] - sum[i]) / n : NaN, seen: n > 0 ? t[j - 1] - t[i] : 0, n };
  };
}

// The match window from motion samples (sorted by time). `duration`: the video's length.
// `now`: the latest video time processed (live); defaults to the last sample.
export function detectMatchWindow(samples: MotionSample[], duration: number, now?: number, cfg: MatchClockConfig = DEFAULT_MATCH_CLOCK_CONFIG): MatchWindow | null {
  if (samples.length < 20) return null;
  const last = now ?? samples[samples.length - 1].t;
  const span = spans(samples);
  let best: MatchWindow | null = null;
  for (const tr of TRANSITIONS_SEC) {
    const from = Math.max(samples[0].t + tr, AUTO_SEC + tr - cfg.lateStartSec);
    const to = Math.min(last - tr, duration + cfg.earlyStopSec - TELEOP_SEC);
    for (let tau = from; tau <= to + 1e-9; tau += cfg.sampleSec) {
      const quiet = span(tau - tr, tau - cfg.sampleSec);
      const onset = span(tau + cfg.sampleSec, tau + tr);
      if (quiet.n < tr / cfg.sampleSec / 2 || onset.n < tr / cfg.sampleSec / 2) continue;
      const active = span(tau + cfg.sampleSec, Math.min(last, tau + TELEOP_SEC));
      // drivers start at the bells: the first seconds after the step must already move
      const first = span(tau + cfg.sampleSec, tau + cfg.onsetSec);
      const score = Math.min(first.mean, onset.mean, active.mean) / (quiet.mean + 0.002);
      if (score < cfg.minScore) continue;
      const auto = span(tau - tr - AUTO_SEC, tau - tr);
      if (auto.seen >= cfg.minAutoSeen && auto.mean < cfg.minAutoShare * onset.mean) continue;
      if (!best || score > best.score)
        best = { start: Math.max(0, tau - AUTO_SEC - TRANSITIONS_SEC[TRANSITIONS_SEC.length - 1]), likelyStart: Math.max(0, tau - AUTO_SEC - TRANSITIONS_SEC[0]), teleopStart: tau, buzzer: tau + TELEOP_SEC, transitionSec: tr, score, final: false };
    }
  }
  if (!best) return null;
  // The start of AUTO: robots stand still in their starting positions, then all move at once,
  // AUTO + transition before TELEOP. Where that step is clear it gives the start and the
  // transition length; otherwise the window starts early enough for either transition. Medians:
  // robots keep moving in AUTO, while a one-off change (a broadcast title card going away, a
  // camera bump) is a single spike.
  const medianIn = (a: number, b: number) => {
    const xs = samples.filter((q) => q.t >= a && q.t < b).map((q) => q.motion).sort((x, y) => x - y);
    return { m: xs.length ? xs[xs.length >> 1] : NaN, n: xs.length };
  };
  let step: { s: number; tr: number; score: number } | null = null;
  for (const tr of TRANSITIONS_SEC)
    for (let x = best.teleopStart - AUTO_SEC - tr - 2; x <= best.teleopStart - AUTO_SEC - tr + 2 + 1e-9; x += cfg.sampleSec) {
      const pre = medianIn(x - 5, x - cfg.sampleSec), post = medianIn(x + cfg.sampleSec, x + 5);
      if (pre.n < 10 || post.n < 10) continue;
      const score = post.m / (pre.m + 0.002);
      if (!step || score > step.score) step = { s: x, tr, score };
    }
  if (step && step.score >= cfg.minAutoStep) {
    best.start = best.likelyStart = Math.max(0, step.s - 1.5); // medians place the step up to ~1.5 s late
    best.transitionSec = step.tr;
  }
  best.final = last >= best.teleopStart + cfg.commitAfterSec || last >= duration - 0.5;
  return best;
}

// Motion on the inner FIELD floor, sampled every cfg.sampleSec of video, with the camera's own
// movement removed. Built on the frame and camera pose that ROI placement locked on.
export class FieldMotion {
  private cv: CV;
  private cfg: MatchClockConfig;
  private tracker: ViewTracker | null = null;
  private pts: Vec2[] = []; // inner-floor sample points, reference frame px
  private prev: Float32Array | null = null;
  private prevT = -Infinity;
  private scale = 1;
  samples: MotionSample[] = [];

  constructor(cv: CV, model: FieldModel, cam: CameraSolution, reference: Frame, cfg: MatchClockConfig = DEFAULT_MATCH_CLOCK_CONFIG) {
    this.cv = cv;
    this.cfg = cfg;
    const W = reference.width, H = reference.height;
    const outer = model.perimeterCorners.map((c) => projectPoint(c.point, cam.pose, cam.intrinsics));
    const inner = model.perimeterCorners.map((c) => projectPoint([c.point[0] * cfg.innerShare, c.point[1] * cfg.innerShare, 0], cam.pose, cam.intrinsics));
    if (outer.some((p) => p.depth <= 1) || inner.some((p) => p.depth <= 1)) return;
    const poly = inner.map((p) => p.uv as Vec2);
    // a grid of points on the inner floor, about workWidth across the frame
    this.scale = Math.min(1, cfg.workWidth / W);
    const step = 1 / this.scale;
    const inside = (x: number, y: number) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
        if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
      return c;
    };
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) if (inside(x, y)) this.pts.push([x, y]);
    if (this.pts.length < 100) return;
    const ox = outer.map((p) => p.uv[0]), oy = outer.map((p) => p.uv[1]);
    const region: [number, number, number, number] = [Math.max(0, Math.min(...ox)), Math.max(0, Math.min(...oy)), Math.min(W, Math.max(...ox)), Math.min(H, Math.max(...oy))];
    this.tracker = new ViewTracker(cv, reference, { ...DEFAULT_VIEW_TRACKER_CONFIG, workWidth: cfg.workWidth, region });
  }

  get available(): boolean {
    return this.tracker != null;
  }

  push(frame: Frame, t: number) {
    if (!this.tracker) return;
    if (t < this.prevT - 1e-3) {
      // a seek backwards: forget what comes after it
      this.samples = this.samples.filter((s) => s.t < t);
      this.prev = null;
    }
    if (t - this.prevT < this.cfg.sampleSec - 1e-3) return;
    const cv = this.cv;
    const grey = workGrey(cv, frame, this.cfg.workWidth);
    try {
      const u = this.tracker.update(frame, grey);
      this.prevT = t;
      if (!u.ok) {
        this.prev = null;
        return;
      }
      cv.GaussianBlur(grey, grey, new cv.Size(3, 3), 0);
      const Hw = scaled(u.H, this.scale);
      const W = grey.cols, Hh = grey.rows, d = grey.data as Uint8Array;
      // bilinear: the tracker's sub-pixel jitter must not flip whole pixels at sharp edges
      const cur = new Float32Array(this.pts.length);
      for (let i = 0; i < this.pts.length; i++) {
        const q = applyH(Hw, [this.pts[i][0] * this.scale, this.pts[i][1] * this.scale]);
        const x0 = Math.floor(q[0]), y0 = Math.floor(q[1]);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= Hh) {
          cur[i] = -1;
          continue;
        }
        const fx = q[0] - x0, fy = q[1] - y0, k = y0 * W + x0;
        cur[i] = (d[k] * (1 - fx) + d[k + 1] * fx) * (1 - fy) + (d[k + W] * (1 - fx) + d[k + W + 1] * fx) * fy;
      }
      if (this.prev) {
        let moved = 0, n = 0;
        for (let i = 0; i < cur.length; i++)
          if (cur[i] >= 0 && this.prev[i] >= 0) {
            n++;
            if (Math.abs(cur[i] - this.prev[i]) > this.cfg.changeLevel) moved++;
          }
        if (n > 50) this.samples.push({ t, motion: moved / n });
      }
      this.prev = cur;
    } finally {
      grey.delete();
    }
  }

  dispose() {
    this.tracker?.dispose();
    this.tracker = null;
  }
}

// A reference -> current homography in native px, as the same map in px of frames scaled by s.
function scaled(H: Homography, s: number): Homography {
  return [H[0], H[1], H[2] * s, H[3], H[4], H[5] * s, H[6] / s, H[7] / s, H[8]];
}
