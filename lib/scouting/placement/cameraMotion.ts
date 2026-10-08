/* eslint-disable @typescript-eslint/no-explicit-any */
// Camera-moved check for a locked ROI. Keeps a small set of trackable feature
// points from the lock frame and periodically tracks them into the current frame
// (pyramidal Lucas–Kanade). Only a CONSISTENT shift of most of the scene (a single
// homography explaining the majority of points and moving the frame corners past
// a threshold), or losing almost every point (a cut), counts as the camera moving.
// A robot covering a tag or a handful of features changes only a minority of
// points and does not trigger a re-run.

import type { CV } from "./cv.ts";
import { release } from "./cv.ts";
import { median } from "./geometry.ts";
import type { FrameImage } from "./apriltag.ts";

export interface MotionConfig {
  workWidth: number;
  maxCorners: number;
  quality: number;
  minDistance: number;
  shiftFrac: number; // consistent shift beyond this fraction of the frame width = moved
  minValidFraction: number; // fewer tracked points than this = scene changed
  minInlierFraction: number; // share of tracked points one homography must explain
  minPoints: number;
}

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  workWidth: 320,
  maxCorners: 80,
  quality: 0.01,
  minDistance: 8,
  shiftFrac: 0.02,
  minValidFraction: 0.3,
  minInlierFraction: 0.5,
  minPoints: 12,
};

export interface MotionCheck {
  moved: boolean;
  reason: string;
  validFraction: number;
  inlierFraction: number;
  shiftPx: number; // in work pixels
}

function toSmallGray(cv: CV, frame: FrameImage, workWidth: number) {
  const rgba = cv.matFromImageData(frame);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const s = Math.min(1, workWidth / frame.width);
  if (s < 1) cv.resize(gray, gray, new cv.Size(Math.round(frame.width * s), Math.round(frame.height * s)), 0, 0, cv.INTER_AREA);
  rgba.delete();
  return gray;
}

export class CameraMotionMonitor {
  private ref: any;
  private pts: any;
  private n: number;

  constructor(
    private cv: CV,
    refFrame: FrameImage,
    private cfg: MotionConfig = DEFAULT_MOTION_CONFIG,
  ) {
    this.ref = toSmallGray(cv, refFrame, cfg.workWidth);
    this.pts = new cv.Mat();
    cv.goodFeaturesToTrack(this.ref, this.pts, cfg.maxCorners, cfg.quality, cfg.minDistance);
    this.n = this.pts.rows;
  }

  get featureCount() {
    return this.n;
  }

  check(frame: FrameImage): MotionCheck {
    const cv = this.cv;
    const none = (reason: string): MotionCheck => ({ moved: false, reason, validFraction: 1, inlierFraction: 1, shiftPx: 0 });
    if (this.n < this.cfg.minPoints) return none("too few reference features to judge camera motion");
    const cur = toSmallGray(cv, frame, this.cfg.workWidth);
    const next = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    try {
      cv.calcOpticalFlowPyrLK(this.ref, cur, this.pts, next, status, err, new cv.Size(21, 21), 3);
      const a = this.pts.data32F as Float32Array;
      const b = next.data32F as Float32Array;
      const st = status.data as Uint8Array;
      const src: number[] = [];
      const dst: number[] = [];
      const disp: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (!st[i]) continue;
        src.push(a[2 * i], a[2 * i + 1]);
        dst.push(b[2 * i], b[2 * i + 1]);
        disp.push(Math.hypot(b[2 * i] - a[2 * i], b[2 * i + 1] - a[2 * i + 1]));
      }
      const tracked = disp.length;
      const validFraction = tracked / this.n;
      const thr = this.cfg.shiftFrac * this.ref.cols;
      if (validFraction < this.cfg.minValidFraction) {
        return { moved: true, reason: `lost ${Math.round((1 - validFraction) * 100)}% of reference features (camera cut or large move)`, validFraction, inlierFraction: 0, shiftPx: NaN };
      }
      const medDisp = median(disp);
      if (tracked < 4) return none("too few tracked features");
      const sm = cv.matFromArray(tracked, 1, cv.CV_32FC2, src);
      const dm = cv.matFromArray(tracked, 1, cv.CV_32FC2, dst);
      const mask = new cv.Mat();
      let H: any = null;
      try {
        H = cv.findHomography(sm, dm, cv.RANSAC, 3, mask);
        const inl = mask.rows ? (mask.data as Uint8Array).reduce((s: number, v: number) => s + (v ? 1 : 0), 0) : 0;
        const inlierFraction = inl / tracked;
        let shift = 0;
        if (H && H.rows === 3) {
          const h = H.data64F as Float64Array;
          const W = this.ref.cols;
          const Hh = this.ref.rows;
          const corners = [[0, 0], [W, 0], [W, Hh], [0, Hh]];
          shift =
            corners.reduce((s, [x, y]) => {
              const w = h[6] * x + h[7] * y + h[8];
              return s + Math.hypot((h[0] * x + h[1] * y + h[2]) / w - x, (h[3] * x + h[4] * y + h[5]) / w - y);
            }, 0) / 4;
        }
        if (inlierFraction >= this.cfg.minInlierFraction && shift > thr) {
          return { moved: true, reason: `scene shifted consistently by ~${shift.toFixed(1)} px (${Math.round(inlierFraction * 100)}% of features agree)`, validFraction, inlierFraction, shiftPx: shift };
        }
        if (inlierFraction < this.cfg.minInlierFraction && medDisp > thr) {
          return { moved: true, reason: "most features moved inconsistently (camera cut)", validFraction, inlierFraction, shiftPx: medDisp };
        }
        return { moved: false, reason: "camera steady", validFraction, inlierFraction, shiftPx: shift };
      } finally {
        release(sm, dm, mask, H);
      }
    } finally {
      release(cur, next, status, err);
    }
  }

  dispose() {
    release(this.ref, this.pts);
  }
}
