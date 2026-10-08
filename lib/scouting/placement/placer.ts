// Orchestrates automatic ROI placement over the first usable frames of a video:
// try method A (AprilTag) then B (field plane) per frame, take the per-corner
// MEDIAN of the resulting ROIs across frames, then lock. Also hosts method C
// (4-tap) and the method-B2 hook for a future trained keypoint model. Every method
// ends in the same correspondence -> solvePose -> projectAllRamps path.

import type { CV } from "./cv.ts";
import { median, projectPoint, type Vec2 } from "./geometry.ts";
import type { Alliance, FieldModel } from "./fieldModel.ts";
import { detectAprilTags, tagCorrespondences, DEFAULT_APRILTAG_CONFIG, type AprilTagConfig, type FrameImage, type TagDetection } from "./apriltag.ts";
import { evaluatePoseOnFrame, runFieldPlane, DEFAULT_FIELD_PLANE_CONFIG, type FieldPlaneConfig, type FieldPlaneDebug } from "./fieldPlane.ts";
import { fieldInView, DEFAULT_MARKING_CONFIG, type PoseEvaluation } from "./markings.ts";
import {
  DEFAULT_POSE_CONFIG,
  DEFAULT_SANITY,
  errorAtReference,
  poseIsPlausible,
  projectAllRamps,
  solvePose,
  type Correspondence,
  type PoseConfig,
  type PoseSolution,
  type RampRoi,
  type SanityConfig,
  type ScoringDirection,
} from "./pose.ts";

export type MethodId = "A" | "B" | "B2" | "C" | "D";

export const METHOD_LABEL: Record<MethodId, string> = {
  A: "AprilTag anchor",
  B: "Field-plane anchor",
  B2: "Keypoint model",
  C: "4-tap corners",
  D: "Manual placement",
};

export interface PlacementConfig {
  pose: PoseConfig;
  sanity: SanityConfig;
  apriltag: AprilTagConfig;
  fieldPlane: FieldPlaneConfig;
  maxReprojErrorPxA: number; // accept method A only under this mean error (px at ERROR_REFERENCE_WIDTH, pose.ts)
  maxReprojErrorPxB: number;
  maxReprojErrorPxC: number;
  lowConfidenceErrorPx: number; // above this the result is shown in the warning colour
  targetFrames: number; // "first ~30 usable frames"
  sampleStepSec: number;
  maxAttempts: number;
  minUsableFrames: number;
  maxSeconds: number; // wall-clock budget for one placement run, counted from the first frame that placed...
  maxSearchSeconds: number; // ...while no frame has placed yet, keep searching the video this long
  firstPlacedBudgetSec: number; // after the first frame of a view places, at least this long to gather more
  // the time budgets above never end the search before this many frames were looked at: on a
  // slow or busy computer a 1080p frame can take 30 s, and 180 s were then only 6 frames (Brisbane
  // 13 failed that way while it places from 32 frames when the computer is idle)
  minAttemptsBeforeTimeout: number;
  skipAAfterFailures: number; // once B works and A failed this many times, stop retrying A
  coldFramesB: number; // method-B frames solved from scratch before tracking starts (majority vote)
  consistencyTol: number; // max ROI corner disagreement (fraction of frame) within one locked group
  noFieldStepSec: number; // sampling step while the field is not in view yet
  failStepSec: number; // sampling step after a frame where no method found the field...
  maxFailStepSec: number; // ...doubling with every further failure in a row, up to this
  sameShotDiff: number; // mean grey difference (0..255) below which a frame counts as the same shot
  sameShotRetrySec: number; // ... but a failed shot is searched again after this much video (a transient failure)
  sameShotMaxRetrySec: number; // each repeated failure of the same shot doubles that wait, up to this
  weakEvidence: number; // a method-B pose explaining less than this (frameEvidence) is not re-solved on the same shot
  maxTagDisagreementPx: number; // a floor fit must reproject the seen tag corners within this to be fused (reference px)
}

export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
  pose: DEFAULT_POSE_CONFIG,
  sanity: DEFAULT_SANITY,
  apriltag: DEFAULT_APRILTAG_CONFIG,
  fieldPlane: DEFAULT_FIELD_PLANE_CONFIG,
  maxReprojErrorPxA: 3,
  maxReprojErrorPxB: 4,
  maxReprojErrorPxC: 25,
  lowConfidenceErrorPx: 2,
  targetFrames: 30,
  sampleStepSec: 0.2,
  maxAttempts: 150,
  minUsableFrames: 5,
  maxSeconds: 60,
  maxSearchSeconds: 180,
  firstPlacedBudgetSec: 45,
  minAttemptsBeforeTimeout: 20,
  skipAAfterFailures: 5,
  coldFramesB: 3,
  consistencyTol: 0.03,
  noFieldStepSec: 0.75,
  failStepSec: 1,
  maxFailStepSec: 8,
  sameShotDiff: 6,
  // A broadcast's results graphic (red and blue score panels) can pass for the field at about
  // 0.23-0.27; lock frames of real field views measured 0.48-1.37 on 17 videos, and only 5 of
  // 129 placed real frames fell between 0.25 and 0.4.
  weakEvidence: 0.4,
  sameShotRetrySec: 2,
  sameShotMaxRetrySec: 16,
  maxTagDisagreementPx: 6,
};

export interface FramePlacement {
  time: number;
  method: MethodId;
  solution: PoseSolution;
  rois: RampRoi[];
  correspondences: Correspondence[];
  tags?: TagDetection[];
  fieldPlane?: FieldPlaneDebug;
  evaluation?: PoseEvaluation; // acceptance-test measurements (method B)
  // Set when a method-A result was fitted jointly with the floor points found by method B on
  // the same frame (the tags pin the camera's position, the floor its field of view).
  assistedBy?: "B";
}

export interface FrameAttempt {
  time: number;
  method: MethodId;
  ok: boolean;
  reason?: string;
  reprojError?: number;
}

// ---- method B2 hook (not built) -----------------------------------------------
// A future trained keypoint model (field / ramp corners) plugs in here: it only has
// to return 2D<->3D correspondences for points that exist in the field model; the
// shared solvePose -> projectAllRamps path does the rest.
export interface KeypointModel {
  name: string;
  detect(frame: FrameImage, model: FieldModel): Correspondence[];
}
let keypointModel: KeypointModel | null = null;
export function registerKeypointModel(m: KeypointModel | null) {
  keypointModel = m;
}

// ---- per-frame placement --------------------------------------------------------

type SolveOutcome = { ok: true; sol: PoseSolution; rois: RampRoi[] } | { ok: false; reason: string; reprojError?: number };

function fromCorrespondences(cv: CV, corrs: Correspondence[], frame: { width: number; height: number }, model: FieldModel, cfg: PlacementConfig, maxErr: number): SolveOutcome {
  const sol = solvePose(cv, corrs, frame.width, frame.height, { ...cfg.pose, fitDistortion: true }, poseIsPlausible);
  if (!sol) return { ok: false, reason: "pose solve failed or camera would be below the floor" };
  const err = errorAtReference(sol.reprojError, frame.width);
  if (err > maxErr) return { ok: false, reason: `reprojection error ${err.toFixed(2)} px${err !== sol.reprojError ? " (at 640 px wide)" : ""} > ${maxErr} px`, reprojError: sol.reprojError };
  const { rois, rejected } = projectAllRamps(model, sol, cfg.sanity);
  if (!rois.length) return { ok: false, reason: `no ramp passed sanity checks (${rejected.map((r) => `${r.alliance}: ${r.reason}`).join("; ")})`, reprojError: sol.reprojError };
  return { ok: true, sol, rois };
}

// `floorSearchFailed`: the joint floor fit found no field floor in the frame at all, so method
// B, the same search without the tags, need not run on this frame. (When the floor is there
// but the fit with the tags fails, method B may still place the frame: a lens the pinhole
// model cannot follow can put the tags and the floor at odds.)
// `tagOnly`: the placement rests on the tag corners alone (no joint floor fit), so its field of
// view is only weakly determined; method B is still tried on the frame.
export function placeWithMethodA(cv: CV, frame: FrameImage, model: FieldModel, cfg: PlacementConfig, time: number, prior?: PoseSolution, floorColour?: [number, number, number] | null): { placement?: FramePlacement; attempt: FrameAttempt; floorSearchFailed?: boolean; tagOnly?: boolean } {
  const tags = detectAprilTags(cv, frame, model, cfg.apriltag);
  const tc = tagCorrespondences(tags, model, cfg.apriltag);
  if (!tc.correspondences.length) return { attempt: { time, method: "A", ok: false, reason: tc.reason } };
  const r = fromCorrespondences(cv, tc.correspondences, frame, model, cfg, cfg.maxReprojErrorPxA);
  if (!r.ok) return { attempt: { time, method: "A", ok: false, reason: r.reason, reprojError: r.reprojError } };
  let placement: FramePlacement = { time, method: "A", solution: r.sol, rois: r.rois, correspondences: tc.correspondences, tags };
  let fused = false;
  // Every pose must agree with the GOAL colours and the field floor (the alignment's acceptance
  // test, less the floor tape, a fine-alignment cue that may be hidden). Fitting a few tag
  // corners closely does not by itself pin the camera down: with one tag the focal length can
  // trade off against distance, and a joint fit that sees little floor tape can settle on a
  // wrong field of view that still matches the tag (a synthetic low side view: FOV 33.5 deg for
  // a 75 deg camera, GOAL overlap 27% against 89% for the true pose).
  const misfit = (sol: PoseSolution): string | null => {
    const ev = evaluatePoseOnFrame(cv, frame, model, sol, cfg.fieldPlane, floorColour);
    const mc = DEFAULT_MARKING_CONFIG;
    const gross = (ev.goals.length > 0 && ev.goalWorst < mc.minGoalIoU) || ev.floor.explained < mc.minFloorExplained || ev.floor.filled < mc.minFloorFilled;
    return gross ? (ev.reason ?? "pose disagrees with the field") : null;
  };
  let floorSearchFailed = false;
  // The tag corners pin the camera's position but not its field of view: the GOAL tags sit
  // at one end of the field at nearly the same depth, so the focal length trades off against
  // distance. Measured on 7 real videos with two or three tags in view, the tag-only fit was
  // within 0.1 px of its best over 12-16 deg of FOV (Hawaii, Bedford, Lake Orion) and over the
  // whole 30-110 deg range (DC1, Marshall); on Hawaii the tags alone chose 41 deg where the
  // floor says 54, which put the far RAMP's lane 1.5 ARTIFACTS off. With one tag (4 coplanar
  // points) the FOV is not refined at all. So the floor (tape / grid) is always fitted jointly
  // with the tag corners — a full search on the first frame, tracking from the previous fused
  // frame after that — and the result is used when it also agrees with the tag corners.
  {
    // seeded with the tag-only pose (or the previous fused frame): it is already close, and the
    // fit refines the field of view from the floor and the GOALS
    let b = runFieldPlane(cv, frame, model, cfg.fieldPlane, cfg.pose, cfg.sanity, cfg.maxReprojErrorPxB, prior ?? r.sol, undefined, tc.correspondences, floorColour);
    if (!b.solution && !prior) b = runFieldPlane(cv, frame, model, cfg.fieldPlane, cfg.pose, cfg.sanity, cfg.maxReprojErrorPxB, undefined, undefined, tc.correspondences, floorColour);
    floorSearchFailed = !b.solution && /no field floor/.test(b.reason ?? "");
    const tagAgreement = (sol: PoseSolution) =>
      tc.correspondences.reduce((sum, c) => {
        const p = projectPoint(c.world, sol.pose, sol.intrinsics).uv;
        return sum + Math.hypot(p[0] - c.image[0], p[1] - c.image[1]);
      }, 0) / tc.correspondences.length;
    if (b.solution && b.correspondences.length >= cfg.fieldPlane.minMatches && errorAtReference(tagAgreement(b.solution), frame.width) <= cfg.maxTagDisagreementPx) {
      // (the marking variant already includes the tag corners in its correspondences)
      const both = b.variant === "markings" ? b.correspondences : [...tc.correspondences, ...b.correspondences];
      const rb = fromCorrespondences(cv, both, frame, model, cfg, Math.max(cfg.maxReprojErrorPxA, cfg.maxReprojErrorPxB));
      if (rb.ok && !misfit(rb.sol)) {
        placement = { ...placement, solution: rb.sol, rois: rb.rois, correspondences: both, fieldPlane: b.debug, assistedBy: "B" };
        fused = true;
      }
    }
  }
  // A tag-only pose that does not fit the field leaves the frame to method B. One that does
  // is kept, but its field of view is only the tags' guess: the caller still tries method B on
  // the frame and prefers it when it places (`tagOnly`).
  if (!fused) {
    const bad = misfit(placement.solution);
    if (bad) return { attempt: { time, method: "A", ok: false, reason: `tag pose does not fit the field: ${bad}`, reprojError: placement.solution.reprojError }, floorSearchFailed };
  }
  return { placement, attempt: { time, method: "A", ok: true, reprojError: placement.solution.reprojError }, floorSearchFailed, tagOnly: !fused };
}

export function placeWithMethodB(cv: CV, frame: FrameImage, model: FieldModel, cfg: PlacementConfig, time: number, prior?: PoseSolution, floorColour?: [number, number, number] | null): { placement?: FramePlacement; attempt: FrameAttempt; debug: FieldPlaneDebug; floorColour?: [number, number, number] | null } {
  const b = runFieldPlane(cv, frame, model, cfg.fieldPlane, cfg.pose, cfg.sanity, cfg.maxReprojErrorPxB, prior, undefined, [], floorColour);
  if (!b.solution) return { attempt: { time, method: "B", ok: false, reason: b.reason }, debug: b.debug };
  return {
    placement: { time, method: "B", solution: b.solution, rois: b.rois, correspondences: b.correspondences, fieldPlane: b.debug, evaluation: b.evaluation },
    attempt: { time, method: "B", ok: true, reprojError: b.solution.reprojError },
    debug: b.debug,
    floorColour: b.floorColour,
  };
}

// Method C — the user tapped the 4 FIELD corners in model order (red-goal corner,
// then clockwise from above). Coplanar 4-point pose with the assumed FOV.
export function placeFromTaps(cv: CV, taps: Vec2[], frame: { width: number; height: number }, model: FieldModel, cfg: PlacementConfig = DEFAULT_PLACEMENT_CONFIG, time = 0): { placement?: FramePlacement; reason?: string } {
  if (taps.length !== model.perimeterCorners.length) return { reason: `need ${model.perimeterCorners.length} taps` };
  const corrs: Correspondence[] = taps.map((p, i) => ({ image: p, world: model.perimeterCorners[i].point, label: model.perimeterCorners[i].label }));
  const r = fromCorrespondences(cv, corrs, frame, model, cfg, cfg.maxReprojErrorPxC);
  if (!r.ok) return { reason: r.reason };
  return { placement: { time, method: "C", solution: r.sol, rois: r.rois, correspondences: corrs } };
}

// ---- aggregation / lock ---------------------------------------------------------

export interface LockedRoi {
  alliance: Alliance;
  quad: Vec2[]; // normalized
  zone: RampRoi["zone"];
  direction: ScoringDirection;
  warnings: string[];
}

export interface LockedPlacement {
  method: MethodId;
  rois: LockedRoi[];
  representative: FramePlacement; // the frame closest to the median (pose, FOV, debug)
  framesUsed: number;
  framesTried: number;
  reprojError: number; // median across the frames used
  fovDeg: number;
  fovRefined: boolean;
  // false when every reference point lies on the floor: then FOV and camera height
  // trade off almost perfectly, so the fitted FOV is only weakly determined. The GOAL
  // silhouettes (up to 53.75 in tall) break that tie whenever a GOAL was matched.
  fovWellConstrained: boolean;
  confidence: "high" | "low";
  confidenceNotes: string[];
  lockTime: number;
}

const ORDER: MethodId[] = ["A", "B", "B2", "C"];

// Two frames agree when every ramp both placed has all four corners within `tol` (fraction
// of the frame) and they share at least one ramp.
function framesAgree(a: FramePlacement, b: FramePlacement, tol: number): boolean {
  return (
    a.rois.every((ra) => {
      const rb = b.rois.find((x) => x.alliance === ra.alliance);
      return !rb || ra.quad.every((p, i) => Math.hypot(p[0] - rb.quad[i][0], p[1] - rb.quad[i][1]) <= tol);
    }) && a.rois.some((ra) => b.rois.some((rb) => rb.alliance === ra.alliance))
  );
}

// How much one frame's placement is worth as evidence. Tag and tap placements are exact
// correspondences (1). A field-plane (B) placement is weighted by how much of the image the
// model explained: the GOAL overlaps (summed, so seeing both GOALS counts more), the tape
// agreement scaled by how much tape was checked, and the share of the detected floor inside
// the field. A lookalike that barely passes the acceptance test — e.g. a match-results
// graphic whose red / blue panels pass for a GOAL — then counts for little against views
// of the field that the model explains well.
export function frameEvidence(f: FramePlacement): number {
  const ev = f.evaluation;
  if (f.method !== "B" || !ev) return 1;
  const goals = ev.goals.reduce((s, g) => s + g.iou, 0);
  const tape = 0.2 + 0.8 * ev.tapeRatio * Math.min(1, ev.tapeVisible / 200);
  return Math.max(0.01, goals * tape * ev.floor.explained);
}

// The group of mutually consistent frames carrying the most evidence (by default each frame
// counts once; first one wins ties).
export function largestConsistentGroup(frames: FramePlacement[], tol: number, weight: (f: FramePlacement) => number = () => 1): FramePlacement[] {
  let used = frames;
  let best = -1;
  for (const f of frames) {
    const group = frames.filter((g) => framesAgree(f, g, tol));
    const w = group.reduce((s, g) => s + weight(g), 0);
    if (w > best) {
      best = w;
      used = group;
    }
  }
  return used;
}

export function aggregatePlacements(frames: FramePlacement[], cfg: PlacementConfig, framesTried = frames.length): LockedPlacement | null {
  if (!frames.length) return null;
  const counts = new Map<MethodId, number>();
  for (const f of frames) counts.set(f.method, (counts.get(f.method) ?? 0) + 1);
  const method = [...counts.entries()].sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))[0][0];
  // Keep only the strongest group of mutually consistent frames: a broadcast can cut
  // between cameras (or show a results graphic) while placement samples, and a median
  // across two different shots would be meaningless.
  const used = largestConsistentGroup(frames.filter((f) => f.method === method), cfg.consistencyTol, frameEvidence);

  const rois: LockedRoi[] = [];
  for (const alliance of ["red", "blue"] as Alliance[]) {
    const withRoi = used.map((f) => f.rois.find((r) => r.alliance === alliance)).filter((r): r is RampRoi => !!r);
    if (withRoi.length < Math.max(1, Math.ceil(used.length / 2))) continue;
    // Median of every ROI corner (and of the counting-zone corners) across frames.
    const quad = [0, 1, 2, 3].map((i) => [median(withRoi.map((r) => r.quad[i][0])), median(withRoi.map((r) => r.quad[i][1]))] as Vec2);
    const x0 = median(withRoi.map((r) => r.zone.x));
    const y0 = median(withRoi.map((r) => r.zone.y));
    const x1 = median(withRoi.map((r) => r.zone.x + r.zone.w));
    const y1 = median(withRoi.map((r) => r.zone.y + r.zone.h));
    const down = withRoi.filter((r) => r.direction === "downward").length;
    rois.push({
      alliance,
      quad,
      zone: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, line: median(withRoi.map((r) => r.zone.line)) },
      direction: down * 2 >= withRoi.length ? "downward" : "upward",
      warnings: [...new Set(withRoi.flatMap((r) => r.warnings))],
    });
  }
  if (!rois.length) return null;

  // Representative frame: the one whose ROIs sit closest to the medians.
  const score = (f: FramePlacement) =>
    rois.reduce((s, lr) => {
      const r = f.rois.find((x) => x.alliance === lr.alliance);
      if (!r) return s + 10;
      return s + r.quad.reduce((q, p, i) => q + Math.hypot(p[0] - lr.quad[i][0], p[1] - lr.quad[i][1]), 0);
    }, 0);
  const representative = [...used].sort((a, b) => score(a) - score(b))[0];

  const reprojError = median(used.map((f) => f.solution.reprojError));
  const notes: string[] = [];
  const refError = errorAtReference(reprojError, representative.solution.intrinsics.width);
  if (refError > cfg.lowConfidenceErrorPx) notes.push(`reprojection error ${refError.toFixed(2)} px${refError !== reprojError ? " (at 640 px wide)" : ""} is above ${cfg.lowConfidenceErrorPx} px`);
  if (!representative.solution.fovRefined) notes.push(`fewer than ${cfg.pose.refineFovMinPoints} reference points — FOV assumed at ${representative.solution.intrinsics.fovDeg}°, so the error score is not meaningful`);
  else if (method === "A" && !representative.assistedBy) notes.push(`field of view from the GOAL tags alone (${representative.solution.intrinsics.fovDeg.toFixed(0)}°): the floor could not confirm it, so RAMPS far from the tags may be off`);
  if (used.length < Math.min(10, cfg.targetFrames) && method !== "C") notes.push(`only ${used.length} usable frame(s)`);
  if (rois.some((r) => r.warnings.length)) notes.push(...rois.flatMap((r) => r.warnings));

  return {
    method,
    rois,
    representative,
    framesUsed: used.length,
    framesTried,
    reprojError,
    fovDeg: median(used.map((f) => f.solution.intrinsics.fovDeg)),
    fovRefined: representative.solution.fovRefined,
    fovWellConstrained: representative.solution.fovRefined && (representative.correspondences.some((c) => Math.abs(c.world[2]) > 1) || (representative.evaluation?.goals.length ?? 0) > 0),
    confidence: notes.length ? "low" : "high",
    confidenceNotes: notes,
    lockTime: representative.time,
  };
}

// ---- run over the video -----------------------------------------------------------

// 32 x 18 grey thumbnail of a frame, for "is this still the same shot?" checks.
export function shotThumbnail(frame: FrameImage): Uint8Array {
  const tw = 32;
  const th = 18;
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / tw));
      const sy = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / th));
      const i = (sy * frame.width + sx) * 4;
      out[y * tw + x] = (frame.data[i] * 3 + frame.data[i + 1] * 6 + frame.data[i + 2]) / 10;
    }
  return out;
}

export function thumbnailDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export interface PlacementProgress {
  attempts: number;
  usable: number;
  target: number;
  time: number;
}

export interface PlacementRun {
  locked: LockedPlacement | null;
  attempts: FrameAttempt[];
  frames: FramePlacement[];
  failureSummary?: string;
  lastFieldPlaneDebug?: FieldPlaneDebug;
  lastTags?: TagDetection[];
}

export async function runPlacement(opts: {
  cv: CV;
  model: FieldModel;
  grabFrame: (t: number) => Promise<FrameImage | null>;
  startTime: number;
  duration: number;
  cfg?: PlacementConfig;
  onProgress?: (p: PlacementProgress) => void;
  isCancelled?: () => boolean;
}): Promise<PlacementRun> {
  const cfg = opts.cfg ?? DEFAULT_PLACEMENT_CONFIG;
  const frames: FramePlacement[] = [];
  const attempts: FrameAttempt[] = [];
  const started = Date.now();
  let aFailures = 0;
  let lastFieldPlaneDebug: FieldPlaneDebug | undefined;
  let lastTags: TagDetection[] | undefined;
  let n = 0;
  let step = cfg.sampleStepSec;
  // A video that opens on something else (announcers, a results graphic, the crowd, a phone
  // zoomed in on the GOALS) must not use up the budget before the field view shows up: failures
  // in a row spread the search further into the video, and the short budget only applies once
  // enough frames of one view have placed (until then the search goes on, up to
  // maxSearchSeconds). A placed frame that disagrees with the last one is a new view (the phone
  // zoomed out or turned to the field): it gets a fresh budget to gather its own frames.
  let failsInRow = 0;
  let viewFrames = 0; // placed frames agreeing with the latest placed frame
  // The target counts frames that explain the image (frameEvidence >= weakEvidence; method A
  // always). Weak ones, such as a results graphic that passes for the field, still vote in the
  // lock but do not end the search before the field has been seen.
  let strong = 0;
  let deadline = started + cfg.maxSeconds * 1000;
  const failStep = () => Math.min(cfg.maxFailStepSec, cfg.failStepSec * 2 ** Math.max(0, failsInRow - 1));
  // Thumbnail of the last frame where no method found the field, or found only a pose that
  // explains little of it: frames of the same shot (a static intro card, the previous match's
  // results graphic, an announcer close-up) are skipped without another full search, so a
  // slow device does not spend its time budget re-solving one graphic.
  // A shot that keeps failing (a results graphic shown for 20 s) is re-searched less and less often.
  let floorColour: [number, number, number] | null = null; // Lab of the field floor the video aligned on
  let failedShot = null as { thumb: Uint8Array; time: number; retrySec: number } | null;
  const markFailed = (thumb: Uint8Array, t: number) => {
    const again = failedShot && thumbnailDiff(thumb, failedShot.thumb) < cfg.sameShotDiff;
    failedShot = { thumb, time: t, retrySec: again ? Math.min(cfg.sameShotMaxRetrySec, failedShot!.retrySec * 2) : cfg.sameShotRetrySec };
  };
  const skip = async (t: number, reason: string) => {
    attempts.push({ time: t, method: "A", ok: false, reason });
    step = cfg.noFieldStepSec;
    opts.onProgress?.({ attempts: n + 1, usable: strong, target: cfg.targetFrames, time: t });
    await new Promise((r) => setTimeout(r, 0));
  };
  for (let t = opts.startTime; t <= opts.duration && n < cfg.maxAttempts && strong < cfg.targetFrames; t += step, n++) {
    if (opts.isCancelled?.()) break;
    const now = Date.now();
    if (n >= cfg.minAttemptsBeforeTimeout && (viewFrames >= cfg.minUsableFrames ? now > deadline : now - started > cfg.maxSearchSeconds * 1000)) break;
    const frame = await opts.grabFrame(t);
    if (!frame) continue;
    const thumb = shotThumbnail(frame);
    if (failedShot && t - failedShot.time < failedShot.retrySec && thumbnailDiff(thumb, failedShot.thumb) < cfg.sameShotDiff) {
      await skip(t, "same shot as a frame where the field was not found");
      continue;
    }
    // Skip frames that clearly do not show the field (intro card, replay, crowd)
    // quickly, jumping further ahead until the field appears.
    if (!fieldInView(opts.cv, frame)) {
      await skip(t, "no field in view");
      continue;
    }
    step = cfg.sampleStepSec;
    let placed: FramePlacement | undefined;
    let floorSearched = false;
    let tagOnly = false;
    const skipA = aFailures >= cfg.skipAAfterFailures && frames.some((f) => f.method === "B");
    if (!skipA) {
      const a = placeWithMethodA(opts.cv, frame, opts.model, cfg, t, [...frames].reverse().find((f) => f.assistedBy === "B")?.solution, floorColour);
      attempts.push(a.attempt);
      if (a.placement) {
        placed = a.placement;
        lastTags = a.placement.tags;
        tagOnly = !!a.tagOnly;
      } else aFailures++;
      floorSearched = !!a.floorSearchFailed;
    }
    if ((!placed || tagOnly) && !floorSearched) {
      // The first few method-B frames are solved from scratch; after that, frames are tracked
      // from the pose with the most evidence behind it (the best-explained member of the
      // strongest consistent group), so one wrong solve cannot steer every later frame.
      const bFrames = frames.filter((f) => f.method === "B");
      const prior = bFrames.length < cfg.coldFramesB ? undefined : [...largestConsistentGroup(bFrames, cfg.consistencyTol, frameEvidence)].sort((a, b) => frameEvidence(b) - frameEvidence(a))[0]?.solution;
      const b = placeWithMethodB(opts.cv, frame, opts.model, cfg, t, prior, floorColour);
      attempts.push(b.attempt);
      lastFieldPlaneDebug = b.debug;
      // a tag-only pose gives way to an alignment that explains the frame: that one's field of
      // view comes from the whole field
      if (b.placement && (!placed || frameEvidence(b.placement) >= cfg.weakEvidence)) {
        placed = b.placement;
        // later frames look for the field floor that this well-explained frame aligned on first
        if (frameEvidence(b.placement) >= cfg.weakEvidence && b.floorColour) floorColour = b.floorColour;
      }
    }
    if (!placed && keypointModel) {
      const corrs = keypointModel.detect(frame, opts.model);
      const r = corrs.length >= 4 ? fromCorrespondences(opts.cv, corrs, frame, opts.model, cfg, cfg.maxReprojErrorPxB) : null;
      if (r && r.ok) placed = { time: t, method: "B2", solution: r.sol, rois: r.rois, correspondences: corrs };
      attempts.push({ time: t, method: "B2", ok: !!placed, reason: placed ? undefined : "keypoint model found no usable points" });
    }
    if (placed) {
      const last = frames[frames.length - 1];
      if (!last || !framesAgree(placed, last, cfg.consistencyTol)) {
        viewFrames = 0;
        deadline = Math.max(deadline, Date.now() + cfg.firstPlacedBudgetSec * 1000);
      }
      viewFrames++;
      frames.push(placed);
      if (frameEvidence(placed) < cfg.weakEvidence) {
        markFailed(thumb, t);
        step = cfg.failStepSec;
      } else {
        strong++;
        failedShot = null;
        failsInRow = 0;
      }
    } else {
      // Nothing found the field here: move on faster and do not re-search the same shot.
      markFailed(thumb, t);
      failsInRow++;
      step = failStep();
    }
    opts.onProgress?.({ attempts: n + 1, usable: strong, target: cfg.targetFrames, time: t });
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }

  const locked = frames.length >= cfg.minUsableFrames ? aggregatePlacements(frames, cfg, n) : null;
  let failureSummary: string | undefined;
  if (!locked) {
    const reasons = new Map<string, number>();
    for (const a of attempts) if (!a.ok && a.reason) reasons.set(`${a.method}: ${a.reason}`, (reasons.get(`${a.method}: ${a.reason}`) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, c]) => `${r} (×${c})`);
    failureSummary = frames.length
      ? `only ${frames.length} usable frame(s) (need ${cfg.minUsableFrames}). ${top.join("; ")}`
      : top.join("; ") || "no frames could be analysed";
  }
  return { locked, attempts, frames, failureSummary, lastFieldPlaneDebug, lastTags };
}
