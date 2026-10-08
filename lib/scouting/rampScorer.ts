// Streaming RAMP scorer for Auto Scouting: feed it video frames in time order (live playback
// or an offline pass) and it
//   1. follows the camera (one ViewTracker per RAMP, on the RAMP and its GOAL, so a handheld
//      phone that pans, zooms or shakes keeps the slot samples on the RAMP; a whole-view
//      tracker takes over for frames where the RAMP area alone has too little texture),
//   2. calibrates itself from the video: the first frames at match start where the pre-staged
//      ARTIFACTS are seen give this video's ARTIFACT colours, and the moments after give the
//      empty RAMP's appearance (calibration.ts),
//   3. samples the 9 RAMP slots every frame and counts CLASSIFIED ARTIFACTS with the RAMP
//      queue decoder (rampQueue.ts), on demand — so a live view can show a running count
//      and the final count uses the whole match.
//
// The pose from ROI placement is good to ~1% of the frame, which at 360p can put the sample
// points a few pixels off a 6 px ball. So each RAMP is sampled at several lane positions (moved
// by half a ball across and along the RAMP) and the count is the consensus of the positions whose
// decoded queue explains the evidence best: the balls themselves show where the lane is.

import type { CV } from "./placement/cv.ts";
import type { FieldModel } from "./placement/fieldModel.ts";
import { projectPoint, type Vec2 } from "./placement/geometry.ts";
import { buildLane, CENTRE_ABOVE_RAIL, labAt, SLOTS, type Lab, type RampLane } from "./rampState.ts";
import { stagedArtifactLab, stagedColours, stagedObservation, type CameraSolution, type Frame, type StagedColours, type StagedObservation } from "./calibration.ts";
import { applyH, DEFAULT_VIEW_TRACKER_CONFIG, IDENTITY, ViewTracker, workGrey, type Homography, type ViewTrackerConfig } from "./viewTracker.ts";
import { countRamp, DEFAULT_RAMP_QUEUE_CONFIG, frameEvidence, learnAppearance, type RampAppearance, type RampCount, type RampQueueConfig } from "./rampQueue.ts";
import { detectMatchWindow, FieldMotion, type MatchWindow, type MotionSample } from "./matchClock.ts";
import { DEFAULT_ARTIFACT_CHECK_CONFIG, measureArtifact, measureArtifacts, summarizeChecks, type ArtifactCheck, type ArtifactMeasure } from "./artifactCheck.ts";
import { cutStrip } from "./rampStrip.ts";

export type RampAlliance = "red" | "blue";

export interface RampScorerOptions {
  matchStart: number; // video s marked as match start (0 = not set: calibrate from the video)
  calibrationSearchSec: number; // look this long past matchStart for the staged ARTIFACTS
  calibrationLookbackSec: number; // ...and this long before it (they are seen best just before the start)
  // ...and up to this long after it: the staged ARTIFACTS stay in place for the first seconds of
  // AUTO (robots must first drive to them), and a video can fade in or cut to the field just
  // as the match starts. Measured on the 17 benchmark videos: at >= 90% of their pre-start
  // visibility for at least 2.5 s after the true start (World Championship robots, the
  // fastest); on 5 videos the field only came into full view at or just before the start.
  calibrationGraceSec: number;
  calibrationBestOfSec: number; // after the first good frame, keep the best seen this long
  // The RAMP is still empty this long after the calibration frame: the empty RAMP is learned
  // over it. Over 0.8 s, one arm in front of the RAMP at that moment changed a whole match's
  // count (Hawaii 720p red: 93 against 81 with the window 2 s later); measured on the 17
  // benchmark videos, no ARTIFACT reached a RAMP sooner than ~3.5 s after the start (World
  // Championship robots).
  emptySec: number;
  regionPad: number; // tracking region around the RAMP, in RAMP sizes
  laneSearch: number; // lane offsets tried, in ball radii (0 = only the placed lane)
  // Lane heights tried, in inches below the ball centre on the rails (rampState.CENTRE_ABOVE_RAIL).
  // The default samples 0.83 in below the centre — the lower half of each ball, which the camera
  // sees against the RAMP itself; the upper half is seen against whatever is behind the RAMP
  // (people, the audience), and counting from it was measurably worse on the benchmark videos.
  laneDrops: number[];
  consensusOf: number; // the count is the median of this many best-scoring lane positions
  checkEverySec: number; // how often the queued ARTIFACTS are measured for the self-check (artifactCheck.ts)
  // Lane alignment from the ARTIFACTS: a GOAL and its RAMP can stand inches from where the field
  // model puts them relative to the floor tape (field assembly; DC1's red RAMP: the camera pose
  // fits the floor and the GOAL's AprilTag to 1.7 px, yet the queue is 2.8 ball radii off the
  // placed lane). Lanes are also sampled out to laneAlignRadii ball radii either side; each
  // self-check measures the ARTIFACTS around the placed lane (artifactCheck.measureArtifact) and
  // keeps those that the counter's evidence at their lane position says are not the empty RAMP
  // (a panel or rail of ARTIFACT-like colour is part of the empty RAMP there, a queued ARTIFACT is
  // not). Once at least alignMinObs, from at least alignMinSeconds different seconds, agree
  // (inter-quartile range <= alignMaxSpread radii) on an offset beyond laneSearch + 0.25, and
  // measure like single ARTIFACTS (median width 0.75-1.35x the automatic size), counting uses
  // the lanes within 0.75 radii of it. (With 21 measurements from a few moments, Marshall's
  // red lane moved onto blobs 2.5x an ARTIFACT's width and counted 143 against 40.)
  laneAlignRadii: number;
  alignMinObs: number;
  alignMinSeconds: number;
  alignMaxSpread: number;
  queue: RampQueueConfig;
  tracker: ViewTrackerConfig;
}

export const DEFAULT_RAMP_SCORER_OPTIONS: RampScorerOptions = {
  matchStart: 0,
  calibrationSearchSec: 20,
  calibrationLookbackSec: 10,
  calibrationGraceSec: 2,
  calibrationBestOfSec: 1.5,
  emptySec: 2,
  regionPad: 0.75,
  laneSearch: 0.5,
  laneDrops: [0.83],
  consensusOf: 3,
  checkEverySec: 1,
  laneAlignRadii: 3,
  alignMinObs: 60,
  alignMinSeconds: 10,
  alignMaxSpread: 2,
  queue: DEFAULT_RAMP_QUEUE_CONFIG,
  tracker: DEFAULT_VIEW_TRACKER_CONFIG,
};

export type ScorerPhase = "finding-staged" | "counting";

// Values the scorer derived for one RAMP of this video (shown in debug mode).
export interface RampAutoParams {
  alliance: RampAlliance;
  ballRadiusPx: number; // projected ARTIFACT radius on the RAMP (mean over visible slots)
  artifactAreaPx: number; // one ARTIFACT's area on the RAMP = the automatic clump size
  slotPitchPx: number; // distance between neighbouring slots
  visibleSlots: number;
  slotWeight: number[]; // automatic per-slot sensitivity (independent pixels / sample points)
  purple: Lab;
  green: Lab;
  purpleTolerance: number; // colour tolerance (Lab sigma) learned for this video
  greenTolerance: number;
  emptyNoise: number; // median empty-RAMP spread (Lab sigma)
  colourSource: RampAppearance["colourSource"];
  stagedSamples: { purple: number; green: number };
  laneShift: { across: number; along: number; drop: number }; // chosen lane: ball radii across / along, inches lowered
  laneAlignment: { offset: number; observations: number } | null; // where the ARTIFACTS were found to queue (radii across the placed lane)
  calibrationTime: number | null;
  countStart: number | null;
  trackedShare: number;
  fallbackShare: number; // share of frames the whole-view tracker stood in for the RAMP's own
  reanchors: number;
  // the automatic values checked on the ARTIFACTS queued in this RAMP during the match
  // (artifactCheck.ts): null until some were measured
  check: ArtifactCheck | null;
}

export interface RampResult {
  alliance: RampAlliance;
  t0: number; // video time of evidence frame 0
  fps: number;
  count: RampCount;
  llr: Float64Array; // per frame, per slot evidence (for the debug view)
  pointsPerSlot: number[];
}

// Current view of a RAMP lane for the debug overlay (native px of the current frame).
export interface LaneView {
  alliance: RampAlliance;
  slots: { c: Vec2; r: number; llr: number }[];
  tracked: boolean;
}

// ---- working scale -------------------------------------------------------------------
// The counter sees every video at one working scale: frames are shrunk until no RAMP's
// ARTIFACTS are more than WORK_BALL_RADIUS_PX in radius (they are never enlarged). A 720p and
// a 1080p recording of the same match then give it the same input and cost the same per
// frame. Larger balls add texture (the ARTIFACTS' holes, robot detail) rather than colour, and
// the counter was validated on balls of 3-15 px.
export const WORK_BALL_RADIUS_PX = 12;

// Scale (≤ 1) for frames of `size` so the smallest RAMP's mean ball radius is at most
// WORK_BALL_RADIUS_PX: no RAMP is shrunk below what it needs.
export function counterScale(model: FieldModel, cam: CameraSolution, size: { width: number; height: number }, alliances: RampAlliance[]): number {
  const radii = model.ramps
    .filter((r) => alliances.includes(r.alliance))
    .map((r) => {
      const seen = buildLane(model, r, cam, size).slots.map((s) => s.radiusPx).filter((x) => x > 0);
      return seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : Infinity;
    })
    .filter((r) => Number.isFinite(r));
  if (!radii.length) return 1;
  return Math.min(1, WORK_BALL_RADIUS_PX / Math.min(...radii));
}

// The same camera for frames resized to `width` x `height`.
export function resizedCamera(cam: CameraSolution, width: number, height: number): CameraSolution {
  const K = cam.intrinsics;
  const sx = width / K.width, sy = height / K.height;
  return { pose: cam.pose, intrinsics: { ...K, fx: K.fx * sx, fy: K.fy * sy, cx: K.cx * sx, cy: K.cy * sy, width, height } };
}

// Lane views drawn on frames of a different size (e.g. the counter's working frames shown on
// the native video): every coordinate times `s`.
export function scaleLaneViews(views: LaneView[], s: number): LaneView[] {
  if (s === 1) return views;
  return views.map((v) => ({ ...v, slots: v.slots.map((x) => ({ ...x, c: [x.c[0] * s, x.c[1] * s] as Vec2, r: x.r * s })) }));
}

interface Sample {
  t: number;
  ok: boolean;
  lab: Float32Array; // 3 per lane point (NaN off-frame / untracked)
  ev?: { llr: Float64Array; colour: Int16Array };
}

// One lane hypothesis: slot geometry (reference-frame px, offset applied), samples, appearance.
interface LaneGeometry {
  points: Vec2[];
  slotOfPoint: number[];
  centres: Vec2[];
  radiusPx: number[];
  visible: number[];
}

interface LaneVariant extends LaneGeometry {
  shift: { across: number; along: number; drop: number };
  samples: Sample[];
  app: RampAppearance | null;
}

interface Ramp {
  alliance: RampAlliance;
  lane: RampLane; // the lane at the first laneDrops height
  centres: Vec2[]; // its projected slot centres
  radiusPx: number[];
  tracker: ViewTracker;
  H: Homography;
  variants: LaneVariant[];
  chosen: number; // variant the last results() counted with
  align: { t: number; offset: number; size: number }[]; // ARTIFACTS measured around the placed lane (radii across, width / automatic)
  frames: number;
  fallbacks: number;
}

export class RampScorer {
  private cv: CV;
  private model: FieldModel;
  private cam: CameraSolution;
  private opts: RampScorerOptions;
  private ramps: Ramp[];
  private globalTracker: ViewTracker; // whole view: staged ARTIFACTS + fallback for the RAMPS
  private fieldMotion: FieldMotion; // robots moving on the FIELD: where the match is in the video
  private globalH: Homography = IDENTITY;
  private best: { t: number; frame: Frame; H: Homography; score: number } | null = null;
  private firstGood: number | null = null;
  private calT: number | null = null;
  private countStart: number | null = null;
  private staged: StagedColours = { purple: [], green: [] };
  // Every frame where the pre-staged ARTIFACTS are seen, with their colours: when the match start
  // becomes known later (found from the FIELD, or set by hand while counting) the counter
  // calibrates there, exactly as if it had been given the start up front (calibrateAt).
  private calCandidates: { t: number; score: number; obs: StagedObservation }[] = [];
  private calibratedAt: number | null = null; // the match start calibrateAt used
  private calibratedLatest = 0; // ...and the latest start it allowed for
  // self-check measurements of queued ARTIFACTS, per RAMP (with the lane variant they were made on)
  private checks = new Map<RampAlliance, { t: number; variant: number; m: ArtifactMeasure }[]>();
  private lastCheckT = -Infinity;
  private lastT = -Infinity;
  phase: ScorerPhase = "finding-staged";

  // `cam` is the camera pose in `reference` (the frame ROI placement locked on).
  constructor(cv: CV, model: FieldModel, cam: CameraSolution, reference: Frame, alliances: RampAlliance[], opts: Partial<RampScorerOptions> = {}) {
    this.cv = cv;
    this.model = model;
    this.cam = cam;
    this.opts = { ...DEFAULT_RAMP_SCORER_OPTIONS, ...opts };
    // whole-view tracker: places the staged ARTIFACTS for colour calibration (so it needs full
    // working resolution — a coarser one shifts the colour samples) and stands in for a RAMP
    // tracker that lost its view
    this.globalTracker = new ViewTracker(cv, reference, { ...this.opts.tracker, maxCorners: 150 });
    this.fieldMotion = new FieldMotion(cv, model, cam, reference);
    this.ramps = alliances.flatMap((alliance) => {
      const ramp = model.ramps.find((r) => r.alliance === alliance);
      if (!ramp) return [];
      const geometry = (drop: number): LaneGeometry & { lane: RampLane } => {
        const lane = buildLane(model, ramp, cam, reference, CENTRE_ABOVE_RAIL - drop);
        const points: Vec2[] = [];
        const slotOfPoint: number[] = [];
        lane.slots.forEach((sl, k) => sl.points.forEach((pt) => (points.push(pt), slotOfPoint.push(k))));
        const centres = lane.slots.map((sl) => projectPoint(sl.centre, cam.pose, cam.intrinsics).uv);
        return { lane, points, slotOfPoint, centres, radiusPx: lane.slots.map((sl) => sl.radiusPx), visible: lane.slots.map((sl) => sl.visibleShare) };
      };
      const drops = this.opts.laneDrops.length ? this.opts.laneDrops : [0];
      const geoms = drops.map((d) => ({ drop: d, g: geometry(d) }));
      const primary = geoms[0].g;
      if (!primary.points.length) return [];
      const xs = primary.points.map((pt) => pt[0]), ys = primary.points.map((pt) => pt[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const e = this.opts.regionPad * Math.max(x1 - x0, y1 - y0, 8);
      // the RAMP's own GOAL panels, blocker and RAMP surface: rigid field structure that settles
      // which homography is right when the tracker's re-anchor and its chain disagree
      const goal = model.goals.find((g) => g.alliance === alliance);
      const verifyPolys = [...(goal ? [...goal.panels.body, goal.panels.blocker] : []), ramp.surfaceCorners]
        .map((poly) => poly.map((q) => projectPoint(q, cam.pose, cam.intrinsics)))
        .filter((poly) => poly.every((q) => q.depth > 1))
        .map((poly) => poly.map((q) => q.uv as [number, number]));
      const tracker = new ViewTracker(cv, reference, { ...this.opts.tracker, region: [x0 - e, y0 - e, x1 + e, y1 + e], verifyPolys });
      const variants = geoms.flatMap(({ drop, g }) => (g.points.length ? this.laneVariants(g, drop) : []));
      return [{ alliance, lane: primary.lane, centres: primary.centres, radiusPx: primary.radiusPx, tracker, H: IDENTITY, variants, chosen: 0, align: [], frames: 0, fallbacks: 0 }];
    });
  }

  // A lane plus the same lane moved by laneSearch ball radii across and along the RAMP.
  private laneVariants(g: LaneGeometry, drop: number): LaneVariant[] {
    const make = (offset: Vec2, across: number, along: number): LaneVariant => ({
      points: g.points.map((pt) => [pt[0] + offset[0], pt[1] + offset[1]] as Vec2),
      slotOfPoint: g.slotOfPoint,
      centres: g.centres.map((pt) => [pt[0] + offset[0], pt[1] + offset[1]] as Vec2),
      radiusPx: g.radiusPx,
      visible: g.visible,
      shift: { across, along, drop },
      samples: [],
      app: null,
    });
    const out = [make([0, 0], 0, 0)];
    const d = this.opts.laneSearch;
    const seen = g.radiusPx.filter((r) => r > 0);
    if (d <= 0 || !seen.length) return out;
    const r = seen.reduce((a, b) => a + b, 0) / seen.length;
    const u: Vec2 = [g.centres[SLOTS - 1][0] - g.centres[0][0], g.centres[SLOTS - 1][1] - g.centres[0][1]];
    const L = Math.hypot(u[0], u[1]) || 1;
    const along: Vec2 = [u[0] / L, u[1] / L];
    const across: Vec2 = [-along[1], along[0]];
    for (const sg of [-1, 1]) {
      out.push(make([sg * d * r * across[0], sg * d * r * across[1]], sg * d, 0));
      out.push(make([sg * d * r * along[0], sg * d * r * along[1]], 0, sg * d));
    }
    // lanes for the alignment (laneAlignRadii), half a radius apart beyond the search
    for (let a = d + 0.5; a <= this.opts.laneAlignRadii + 1e-9; a += 0.5) for (const sg of [-1, 1]) out.push(make([sg * a * r * across[0], sg * a * r * across[1]], sg * a, 0));
    return out;
  }

  get alliances(): RampAlliance[] {
    return this.ramps.map((r) => r.alliance);
  }

  get calibrationTime(): number | null {
    return this.calT;
  }

  push(frame: Frame, t: number) {
    // A seek backwards (live replay): forget what comes after, it will be seen again.
    if (t < this.lastT - 1e-3) {
      for (const r of this.ramps) for (const v of r.variants) v.samples = v.samples.filter((s) => s.t < t);
      for (const [a, list] of this.checks) this.checks.set(a, list.filter((c) => c.t < t));
      for (const r of this.ramps) r.align = r.align.filter((x) => x.t < t);
      this.lastCheckT = -Infinity;
    }
    this.lastT = t;
    // all trackers share the tracker work width: convert the frame to grey once
    const grey = workGrey(this.cv, frame, this.opts.tracker.workWidth);
    try {
      const g = this.globalTracker.update(frame, grey);
      if (g.ok) this.globalH = g.H;
      for (const r of this.ramps) {
        const u = r.tracker.update(frame, grey);
        if (u.ok) r.H = u.H;
        else if (g.ok) r.H = g.H;
        const ok = u.ok || g.ok;
        r.frames++;
        if (!u.ok && g.ok) r.fallbacks++;
        for (const v of r.variants) {
          const lab = new Float32Array(v.points.length * 3);
          v.points.forEach((p, i) => {
            if (!ok) lab[i * 3] = lab[i * 3 + 1] = lab[i * 3 + 2] = NaN;
            else {
              const q = applyH(r.H, p);
              labAt(frame, q[0], q[1], lab, i * 3);
            }
          });
          v.samples.push({ t, ok, lab });
        }
      }
    } finally {
      grey.delete();
    }
    this.fieldMotion.push(frame, t);
    if (this.phase === "counting" && this.countStart != null && t >= this.countStart && t >= this.lastCheckT + this.opts.checkEverySec) {
      this.lastCheckT = t;
      this.checkArtifacts(frame, t);
    }
    // the pre-staged ARTIFACTS in this frame (and their colours where they are seen)
    const obs = this.calibratedAt == null || this.phase === "finding-staged" ? stagedObservation(frame, this.cam, this.model, this.globalH) : null;
    if (obs && obs.score > 0 && this.calibratedAt == null) this.calCandidates.push({ t, score: obs.score, obs });
    if (this.phase === "finding-staged") this.findStaged(frame, t, obs!.score);
  }

  // Calibrate at the match start. The pre-staged ARTIFACTS are seen best — all in place, nobody
  // in front of them — around the start, and the RAMPS are empty then. The window runs from
  // calibrationLookbackSec before the start to calibrationGraceSec after it (a video can fade in
  // on the field right at the start). The calibration frame is the one in it closest to the
  // start among those showing nearly as many staged ARTIFACTS as the best; the colours come from
  // every frame of the window (each staged ARTIFACT weighted by how long it was seen); the empty
  // RAMP is learned just after the calibration frame; and counting runs from the start (or from
  // `countFrom`, when the start is only an estimate and the match may have begun earlier). When
  // the video starts after the match did, the first frames after the start are used. Everything
  // already seen is counted again with it. Returns false when nothing changed.
  // `latest`: when the start is only known to lie between `start` and `latest` (the match clock
  // could not see AUTO begin, so the transition may have been 8 or 15 s), the window reaches to
  // `latest` too, for a video whose field only comes into view at the start; the frame is still
  // chosen closest to `start`, which is before the match under either transition.
  calibrateAt(start: number, countFrom = start, latest = start): boolean {
    if (this.calibratedAt != null && Math.abs(this.calibratedAt - start) < 1e-3 && Math.abs(this.calibratedLatest - latest) < 1e-3 && Math.abs((this.countStart ?? -1) - (countFrom > 0 ? countFrom : this.calT ?? -1)) < 1e-3) return false;
    const o = this.opts;
    const last = Math.max(start, latest);
    let pool = this.calCandidates.filter((c) => c.t >= start - o.calibrationLookbackSec - 1e-6 && c.t <= last + o.calibrationGraceSec + 1e-6);
    if (!pool.length) pool = this.calCandidates.filter((c) => c.t > start && c.t <= last + o.calibrationSearchSec);
    let calT: number;
    if (pool.length) {
      const top = Math.max(...pool.map((c) => c.score));
      const good = pool.filter((c) => c.score >= 0.9 * top);
      calT = good.reduce((a, b) => (Math.abs(b.t - start) < Math.abs(a.t - start) ? b : a)).t;
    } else calT = Math.max(0, start);
    // the colours from every frame of the window, each staged ARTIFACT weighted by how long it
    // was seen (calibration.stagedColours)
    const staged = stagedColours(pool.map((c) => c.obs), this.model);
    // The self-check and lane-alignment measurements made so far stay, unless this replaces the
    // provisional calibration or moves the calibration frame: once the match window is final it
    // can still shift by a fraction of a second as more of the match is seen, and each shift
    // calls this again.
    if (this.calibratedAt == null || this.calT == null || Math.abs(calT - this.calT) > 0.5) {
      this.checks.clear();
      for (const r of this.ramps) r.align = [];
    }
    this.calibratedAt = start;
    this.calibratedLatest = latest;
    this.staged = staged;
    this.calT = calT;
    this.countStart = countFrom < start ? Math.max(0, countFrom) : start > 0 ? Math.max(start, calT) : calT;
    this.best = null;
    this.phase = "counting";
    for (const r of this.ramps)
      for (const v of r.variants) {
        v.app = null;
        for (const smp of v.samples) smp.ev = undefined;
      }
    return true;
  }

  // Where the match is in this video (start, TELEOP, buzzer), found from the robots' motion on
  // the FIELD so far (matchClock.ts); null until AUTO, the transition and some TELEOP were seen.
  // `duration`: the video's length.
  matchWindow(duration: number): MatchWindow | null {
    return detectMatchWindow(this.fieldMotion.samples, duration, this.lastT);
  }

  get motionSamples(): MotionSample[] {
    return this.fieldMotion.samples;
  }

  private findStaged(frame: Frame, t: number, score: number) {
    const o = this.opts;
    if (t >= o.matchStart - 3) {
      if (score > 0 && this.firstGood == null) this.firstGood = t;
      if (score > (this.best?.score ?? 0)) this.best = { t, frame: { data: new Uint8ClampedArray(frame.data), width: frame.width, height: frame.height }, H: this.globalH, score };
    }
    // Told the match start: calibrate there, the same way as when it is found later.
    if (o.matchStart > 0) {
      if (t >= o.matchStart + o.calibrationGraceSec && (this.calCandidates.some((c) => c.t >= o.matchStart - o.calibrationLookbackSec) || t >= o.matchStart + o.calibrationSearchSec)) this.calibrateAt(o.matchStart);
      return;
    }
    const done = this.firstGood != null ? t >= this.firstGood + o.calibrationBestOfSec : t >= o.matchStart + o.calibrationSearchSec;
    if (!done) return;
    // Staged ARTIFACTS seen: colours from the best frame. Otherwise (the video starts after the
    // ARTIFACTS were picked up, or they are out of view) default colours, low confidence.
    this.staged = this.best && this.firstGood != null ? stagedArtifactLab([this.best.frame], this.cam, this.model, this.best.H) : { purple: [], green: [] };
    this.calT = this.best && this.firstGood != null ? this.best.t : Math.max(0, o.matchStart);
    this.countStart = o.matchStart > 0 ? Math.max(o.matchStart, this.calT) : this.calT;
    this.best = null;
    this.phase = "counting";
  }

  // The empty-RAMP appearance needs emptySec of frames after the calibration frame.
  private appearance(v: LaneVariant): RampAppearance | null {
    if (v.app || this.calT == null) return v.app;
    const until = this.calT + this.opts.emptySec;
    if (this.lastT < until) return null;
    const empty = v.samples.filter((s) => s.ok && s.t >= this.calT! - 1e-6 && s.t <= until + 1e-6).map((s) => s.lab);
    v.app = learnAppearance(v.slotOfPoint, v.radiusPx, v.visible, empty, this.staged, this.opts.queue);
    return v.app;
  }

  private countVariant(r: Ramp, v: LaneVariant): RampResult | null {
    const app = this.appearance(v);
    if (!app || this.countStart == null) return null;
    const fps = this.opts.queue.fps;
    const counted = v.samples.filter((s) => s.t >= this.countStart! - 0.5 / fps);
    if (!counted.length) return null;
    const bins = Math.round((counted[counted.length - 1].t - this.countStart) * fps) + 1;
    const llr = new Float64Array(bins * SLOTS);
    const colour = new Int16Array(bins * SLOTS);
    const filled = new Int8Array(bins);
    let ok = 0;
    for (const s of counted) {
      const b = Math.max(0, Math.round((s.t - this.countStart) * fps));
      if (b >= bins) continue;
      s.ev ??= frameEvidence(s.lab, app, this.opts.queue);
      llr.set(s.ev.llr, b * SLOTS);
      colour.set(s.ev.colour, b * SLOTS);
      filled[b] = 1;
      if (s.ok) ok++;
    }
    // frames skipped (slow live playback): hold the last observation
    for (let b = 1; b < bins; b++)
      if (!filled[b]) {
        llr.copyWithin(b * SLOTS, (b - 1) * SLOTS, b * SLOTS);
        colour.copyWithin(b * SLOTS, (b - 1) * SLOTS, b * SLOTS);
      }
    const count = countRamp({ llr, colour }, app, v.radiusPx, ok / counted.length, this.opts.queue);
    return { alliance: r.alliance, t0: this.countStart, fps, count, llr, pointsPerSlot: app.pointsPerSlot };
  }

  // The lane positions whose decoded queue explains the evidence best are all plausible; a single
  // winner flips with small pose errors, so the count is their consensus (median of the top
  // consensusOf by score), reported with that lane's events and evidence.
  results(): RampResult[] {
    const out: RampResult[] = [];
    for (const r of this.ramps) {
      // the lanes around the placed one, or around where the ARTIFACTS were found to queue
      const al = this.alignment(r);
      const moved = al && Math.abs(al.offset) > this.opts.laneSearch + 0.25;
      const near = (v: LaneVariant) => (moved ? v.shift.along === 0 && Math.abs(v.shift.across - al!.offset) <= 0.75 : Math.abs(v.shift.across) <= this.opts.laneSearch + 1e-9);
      const all = r.variants.map((v, i) => ({ i, v })).filter((x) => near(x.v)).map(({ i, v }) => ({ i, res: this.countVariant(r, v) })).filter((x): x is { i: number; res: RampResult } => !!x.res);
      if (!all.length) continue;
      const top = all.sort((a, b) => b.res.count.score - a.res.count.score).slice(0, Math.max(1, this.opts.consensusOf));
      const pick = [...top].sort((a, b) => a.res.count.total - b.res.count.total)[(top.length - 1) >> 1];
      r.chosen = pick.i;
      out.push(pick.res);
    }
    return out;
  }

  autoParams(): RampAutoParams[] {
    return this.ramps.map((r) => {
      const v = r.variants[r.chosen];
      const app = this.appearance(v);
      const seen = r.radiusPx.filter((x, k) => x > 0 && r.lane.slots[k].points.length > 0);
      const rad = seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0;
      const mid = Math.floor(SLOTS / 2);
      const pitch = Math.hypot(r.centres[mid + 1][0] - r.centres[mid][0], r.centres[mid + 1][1] - r.centres[mid][1]);
      const sig = app ? [...app.emptySigma].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b) : [];
      const counted = v.samples.filter((s) => this.countStart == null || s.t >= this.countStart);
      const ok = counted.filter((s) => s.ok).length;
      return {
        alliance: r.alliance,
        ballRadiusPx: rad,
        artifactAreaPx: Math.PI * r.radiusPx[mid] * r.radiusPx[mid],
        slotPitchPx: pitch,
        visibleSlots: r.lane.slots.filter((s) => s.points.length > 0).length,
        slotWeight: app?.slotWeight ?? [],
        purple: app?.purple ?? [0, 0, 0],
        green: app?.green ?? [0, 0, 0],
        purpleTolerance: app?.purpleSigma ?? 0,
        greenTolerance: app?.greenSigma ?? 0,
        emptyNoise: sig.length ? sig[sig.length >> 1] : 0,
        colourSource: app?.colourSource ?? "defaults",
        stagedSamples: app?.stagedSamples ?? { purple: this.staged.purple.length, green: this.staged.green.length },
        laneShift: v.shift,
        laneAlignment: this.alignment(r),
        calibrationTime: this.calT,
        countStart: this.countStart,
        trackedShare: counted.length ? ok / counted.length : 1,
        fallbackShare: r.frames ? r.fallbacks / r.frames : 0,
        reanchors: r.tracker.reanchors,
        check: (() => {
          const all = this.checks.get(r.alliance) ?? [];
          const mine = all.filter((c) => c.variant === r.chosen);
          return summarizeChecks((mine.length >= 5 ? mine : all).map((c) => c.m));
        })(),
      };
    });
  }

  // Self-check: measure the ARTIFACTS the counter sees queued in this frame (slots whose evidence
  // clearly says ARTIFACT), on the lane it counts with, against the automatic size, lane and colours.
  private checkArtifacts(frame: Frame, t: number) {
    const cfg = { ...DEFAULT_ARTIFACT_CHECK_CONFIG, lightWeight: this.opts.queue.lightWeight, minChroma: this.opts.queue.minChroma };
    for (const r of this.ramps) {
      // the lane being counted: the aligned one once the ARTIFACTS were found off the placed lane
      const al = this.alignment(r);
      const vi = al && Math.abs(al.offset) > this.opts.laneSearch + 0.25 ? this.nearestAcross(r, al.offset) : r.chosen;
      const v = r.variants[vi];
      const app = this.appearance(v);
      const last = v.samples[v.samples.length - 1];
      if (!app || !last || !last.ok || last.t !== t) continue;
      last.ev ??= frameEvidence(last.lab, app, this.opts.queue);
      const list = this.checks.get(r.alliance) ?? [];
      for (let k = 0; k < SLOTS; k++) {
        if (!(v.radiusPx[k] > 0) || last.ev.llr[k] / Math.max(1, app.pointsPerSlot[k]) < 0.5) continue;
        const c = applyH(r.H, v.centres[k]);
        const nb = applyH(r.H, v.centres[k + 1 < SLOTS ? k + 1 : k - 1]);
        const toward: Vec2 = k + 1 < SLOTS ? nb : [2 * c[0] - nb[0], 2 * c[1] - nb[1]];
        const e = applyH(r.H, [v.centres[k][0] + v.radiusPx[k], v.centres[k][1]]);
        const m = measureArtifact(frame, c, toward, Math.hypot(e[0] - c[0], e[1] - c[1]), app, cfg);
        if (m) list.push({ t, variant: vi, m });
      }
      if (list.length > 600) list.splice(0, list.length - 600);
      this.checks.set(r.alliance, list);
      if (this.opts.laneAlignRadii > 0) this.alignObservations(r, frame, t, cfg);
    }
  }

  // Lane alignment (laneAlignRadii): ARTIFACTS measured around the placed lane, kept when the
  // lane position they sit at says "not the empty RAMP" there in this frame.
  private alignObservations(r: Ramp, frame: Frame, t: number, cfg: typeof DEFAULT_ARTIFACT_CHECK_CONFIG) {
    const v0 = r.variants[0];
    const across = r.variants.filter((v) => v.shift.along === 0 && v.shift.drop === v0.shift.drop);
    const wide = { ...cfg, searchRadii: this.opts.laneAlignRadii + 0.5 };
    for (let k = 0; k < SLOTS; k++) {
      if (!(v0.radiusPx[k] > 0)) continue;
      const c = applyH(r.H, v0.centres[k]);
      const nb = applyH(r.H, v0.centres[k + 1 < SLOTS ? k + 1 : k - 1]);
      const toward: Vec2 = k + 1 < SLOTS ? nb : [2 * c[0] - nb[0], 2 * c[1] - nb[1]];
      const e = applyH(r.H, [v0.centres[k][0] + v0.radiusPx[k], v0.centres[k][1]]);
      const app0 = this.appearance(v0);
      if (!app0) return;
      for (const m of measureArtifacts(frame, c, toward, Math.hypot(e[0] - c[0], e[1] - c[1]), app0, wide)) {
        if (m.size < 0.6 || m.size > 1.6) continue;
        // the lane position nearest to it, and what that lane's evidence says in this frame
        const v = across.reduce((a, b) => (Math.abs(b.shift.across - m.offset) < Math.abs(a.shift.across - m.offset) ? b : a));
        if (Math.abs(v.shift.across - m.offset) > 0.5) continue;
        const app = this.appearance(v);
        const last = v.samples[v.samples.length - 1];
        if (!app || !last || !last.ok || last.t !== t) continue;
        last.ev ??= frameEvidence(last.lab, app, this.opts.queue);
        if (last.ev.llr[k] / Math.max(1, app.pointsPerSlot[k]) < 0.5) continue;
        r.align.push({ t, offset: m.offset, size: m.size });
      }
    }
    if (r.align.length > 2000) r.align.splice(0, r.align.length - 2000);
  }

  // Index of the lane variant (no shift along) nearest `offset` radii across.
  private nearestAcross(r: Ramp, offset: number): number {
    let best = 0;
    r.variants.forEach((v, i) => {
      if (v.shift.along === 0 && Math.abs(v.shift.across - offset) < Math.abs(r.variants[best].shift.across - offset)) best = i;
    });
    return best;
  }

  // Where the ARTIFACTS queue relative to the placed lane (radii across), once enough agree.
  private alignment(r: Ramp): { offset: number; observations: number } | null {
    const o = r.align.map((x) => x.offset).sort((a, b) => a - b);
    if (o.length < this.opts.alignMinObs || new Set(r.align.map((x) => Math.floor(x.t))).size < this.opts.alignMinSeconds) return null;
    const q = (p: number) => o[Math.round(p * (o.length - 1))];
    if (q(0.75) - q(0.25) > this.opts.alignMaxSpread) return null;
    const sizes = r.align.map((x) => x.size).sort((a, b) => a - b);
    const size = sizes[sizes.length >> 1];
    if (size < 0.75 || size > 1.35) return null;
    return { offset: q(0.5), observations: o.length };
  }

  // Each RAMP's strip in the frame last pushed (the v2 counter's input, rampStrip.ts), on the lane
  // being counted (the aligned one once the ARTIFACTS were found off the placed lane), or null
  // where the camera view was not followed in that frame. Call right after push() with the same
  // frame.
  strips(frame: Frame): { alliance: RampAlliance; strip: Uint8Array | null }[] {
    return this.ramps.map((r) => {
      const al = this.alignment(r);
      const v = r.variants[al && Math.abs(al.offset) > this.opts.laneSearch + 0.25 ? this.nearestAcross(r, al.offset) : r.chosen];
      const last = v.samples[v.samples.length - 1];
      if (!last?.ok) return { alliance: r.alliance, strip: null };
      const cs = v.centres.map((c) => applyH(r.H, c));
      const rs = v.centres.map((c, k) => {
        const e = applyH(r.H, [c[0] + v.radiusPx[k], c[1]]);
        return Math.hypot(e[0] - cs[k][0], e[1] - cs[k][1]);
      });
      if (rs.some((x) => !(x > 0.5))) return { alliance: r.alliance, strip: null };
      return { alliance: r.alliance, strip: cutStrip(frame, cs, rs) };
    });
  }

  // Where each slot is now (on the chosen lane), and what the last frame said about it.
  laneViews(): LaneView[] {
    return this.ramps.map((r) => {
      const v = r.variants[r.chosen];
      const last = v.samples[v.samples.length - 1];
      const app = v.app;
      if (last && app && !last.ev) last.ev = frameEvidence(last.lab, app, this.opts.queue);
      return {
        alliance: r.alliance,
        tracked: last?.ok ?? false,
        slots: v.centres.map((c, k) => {
          const q = applyH(r.H, c);
          const e = applyH(r.H, [c[0] + v.radiusPx[k], c[1]]);
          return { c: q, r: Math.hypot(e[0] - q[0], e[1] - q[1]), llr: last?.ev ? last.ev.llr[k] / Math.max(1, app!.pointsPerSlot[k]) : 0 };
        }),
      };
    });
  }

  dispose() {
    this.globalTracker.dispose();
    this.fieldMotion.dispose();
    for (const r of this.ramps) r.tracker.dispose();
  }
}
