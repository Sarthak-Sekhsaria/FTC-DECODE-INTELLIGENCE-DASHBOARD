// Per-video persistence of a confirmed ROI placement (browser localStorage), so
// reopening the same video restores it instantly. A per-viewer convenience only:
// every read/write is wrapped so private windows / blocked storage just skip it.

import type { Pose } from "./geometry.ts";
import type { Alliance } from "./fieldModel.ts";
import type { MethodId } from "./placer.ts";
import type { ScoringDirection } from "./pose.ts";

const KEY_PREFIX = "autoScout.roi.v1:";
const LOG_KEY = "autoScout.roiLog.v1";

export interface SavedZone {
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
}

export interface SavedPlacement {
  version: 1;
  savedAt: string;
  videoKey: string;
  method: MethodId;
  fovDeg: number | null;
  // the camera of the saved pose (the representative frame's; fovDeg above is the median over
  // the frames used): its FOV and lens distortion (geometry.Intrinsics.k1)
  poseFovDeg?: number | null;
  k1?: number | null;
  fovRefined?: boolean;
  fovWellConstrained?: boolean;
  reprojError: number | null;
  pose: Pose | null;
  lockTime: number;
  rois: { alliance: Alliance; quad: [number, number][] | null; zone: SavedZone; direction: ScoringDirection; enabled: boolean }[];
}

export interface PlacementLogEntry {
  at: string;
  video: string;
  method: MethodId | "none";
  reprojError: number | null;
  fovDeg: number | null;
  framesUsed: number;
  framesTried: number;
  confidence: "high" | "low" | "failed";
  note?: string;
}

export function videoKey(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function loadPlacement(key: string): SavedPlacement | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (!raw) return null;
    const p = JSON.parse(raw) as SavedPlacement;
    return p && p.version === 1 && Array.isArray(p.rois) ? p : null;
  } catch {
    return null;
  }
}

export function savePlacement(p: SavedPlacement) {
  try {
    localStorage.setItem(KEY_PREFIX + p.videoKey, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function clearPlacement(key: string) {
  try {
    localStorage.removeItem(KEY_PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

export function appendPlacementLog(e: PlacementLogEntry) {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const list: PlacementLogEntry[] = raw ? JSON.parse(raw) : [];
    list.push(e);
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-100)));
  } catch {
    /* storage unavailable */
  }
}

export function readPlacementLog(): PlacementLogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
