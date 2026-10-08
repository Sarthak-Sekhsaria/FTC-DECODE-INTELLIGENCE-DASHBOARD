/* eslint-disable @typescript-eslint/no-explicit-any */
// Placement method A — AprilTag anchor. Detects the GOAL AprilTags (36h11, CM
// §9.10) and turns their corners into 2D<->3D correspondences for solvePose().

import type { CV } from "./cv.ts";
import { release } from "./cv.ts";
import type { Vec2 } from "./geometry.ts";
import type { FieldModel } from "./fieldModel.ts";
import type { Correspondence } from "./pose.ts";

export interface FrameImage {
  data: Uint8ClampedArray; // RGBA, row-major
  width: number;
  height: number;
}

export interface TagDetection {
  id: number;
  corners: [Vec2, Vec2, Vec2, Vec2]; // TL, TR, BR, BL (native px)
  sidePx: number; // shortest side
  source: "full" | "crop";
}

export interface AprilTagConfig {
  minTagSidePx: number;
  // Crops (normalized x, y, w, h) retried at higher scale when the full frame finds
  // nothing: GOALS sit in the far corners, i.e. usually the upper part / sides.
  retryCrops: [number, number, number, number][];
  cropTargetWidth: number; // upscale crops so they are about this wide
  maxUpscale: number;
}

export const DEFAULT_APRILTAG_CONFIG: AprilTagConfig = {
  minTagSidePx: 20,
  retryCrops: [
    [0, 0, 1, 0.6],
    [0, 0, 0.55, 0.65],
    [0.45, 0, 0.55, 0.65],
    [0, 0, 0.5, 1],
    [0.5, 0, 0.5, 1],
  ],
  cropTargetWidth: 1600,
  maxUpscale: 4,
};

function makeDetector(cv: CV) {
  const dict = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11); // CM §9.10: 36h11 family
  const params = new cv.aruco_DetectorParameters();
  params.minMarkerPerimeterRate = 0.01; // allow small tags in wide shots
  params.adaptiveThreshWinSizeMin = 3;
  params.adaptiveThreshWinSizeMax = 33;
  params.adaptiveThreshWinSizeStep = 6;
  params.cornerRefinementMethod = 1; // CORNER_REFINE_SUBPIX
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  const det = new cv.aruco_ArucoDetector(dict, params, refine);
  return { det, dispose: () => release(det, refine, params, dict) };
}

function detectOn(cv: CV, det: any, gray: any): { id: number; pts: number[] }[] {
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rej = new cv.MatVector();
  try {
    det.detectMarkers(gray, corners, ids, rej);
    const out: { id: number; pts: number[] }[] = [];
    for (let i = 0; i < corners.size(); i++) {
      const c = corners.get(i);
      out.push({ id: ids.data32S[i], pts: Array.from(c.data32F as Float32Array) });
      c.delete();
    }
    return out;
  } finally {
    release(corners, ids, rej);
  }
}

function toDetection(id: number, pts: number[], sx: number, sy: number, ox: number, oy: number, source: "full" | "crop"): TagDetection {
  const c = [0, 1, 2, 3].map((i) => [pts[2 * i] / sx + ox, pts[2 * i + 1] / sy + oy] as Vec2) as TagDetection["corners"];
  const sides = [0, 1, 2, 3].map((i) => Math.hypot(c[i][0] - c[(i + 1) % 4][0], c[i][1] - c[(i + 1) % 4][1]));
  return { id, corners: c, sidePx: Math.min(...sides), source };
}

// Detect every 36h11 tag. Full frame first; if no FIELD-MODEL tag is found, retry
// on upscaled crops. Duplicates (same id) keep the largest detection.
export function detectAprilTags(cv: CV, frame: FrameImage, model: FieldModel, cfg: AprilTagConfig = DEFAULT_APRILTAG_CONFIG): TagDetection[] {
  const known = new Set(model.tags.map((t) => t.id));
  const { det, dispose } = makeDetector(cv);
  const rgba = cv.matFromImageData(frame);
  const gray = new cv.Mat();
  const found = new Map<number, TagDetection>();
  const keep = (d: TagDetection) => {
    const prev = found.get(d.id);
    if (!prev || d.sidePx > prev.sidePx) found.set(d.id, d);
  };
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    for (const r of detectOn(cv, det, gray)) keep(toDetection(r.id, r.pts, 1, 1, 0, 0, "full"));
    if (![...found.keys()].some((id) => known.has(id))) {
      for (const [nx, ny, nw, nh] of cfg.retryCrops) {
        const x = Math.round(nx * frame.width);
        const y = Math.round(ny * frame.height);
        const w = Math.min(frame.width - x, Math.round(nw * frame.width));
        const h = Math.min(frame.height - y, Math.round(nh * frame.height));
        if (w < 16 || h < 16) continue;
        const s = Math.min(cfg.maxUpscale, Math.max(1.5, cfg.cropTargetWidth / w));
        const roi = gray.roi(new cv.Rect(x, y, w, h));
        const big = new cv.Mat();
        try {
          cv.resize(roi, big, new cv.Size(Math.round(w * s), Math.round(h * s)), 0, 0, cv.INTER_CUBIC);
          for (const r of detectOn(cv, det, big)) keep(toDetection(r.id, r.pts, s, s, x, y, "crop"));
        } finally {
          release(roi, big);
        }
      }
    }
  } finally {
    release(rgba, gray);
    dispose();
  }
  return [...found.values()];
}

export interface MethodAResult {
  detections: TagDetection[];
  used: TagDetection[];
  correspondences: Correspondence[];
  reason?: string;
}

// Turn detections into correspondences using only tags that exist in the model
// (GOAL tags 20/24; OBELISK tags are excluded by the model) and are large enough.
export function tagCorrespondences(detections: TagDetection[], model: FieldModel, cfg: AprilTagConfig = DEFAULT_APRILTAG_CONFIG): MethodAResult {
  const byId = new Map(model.tags.map((t) => [t.id, t]));
  const modelTags = detections.filter((d) => byId.has(d.id));
  if (!modelTags.length) return { detections, used: [], correspondences: [], reason: "no GOAL AprilTag (ID 20/24) detected" };
  const used = modelTags.filter((d) => d.sidePx >= cfg.minTagSidePx);
  if (!used.length) {
    const biggest = Math.max(...modelTags.map((d) => d.sidePx));
    return { detections, used: [], correspondences: [], reason: `GOAL tag too small (${biggest.toFixed(0)} px < ${cfg.minTagSidePx} px)` };
  }
  const correspondences: Correspondence[] = [];
  for (const d of used) {
    const t = byId.get(d.id)!;
    d.corners.forEach((p, i) => correspondences.push({ image: p, world: t.corners[i], label: `tag${d.id}.${["BR", "BL", "TL", "TR"][i]}` }));
  }
  return { detections, used, correspondences };
}
