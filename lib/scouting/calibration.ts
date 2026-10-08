// Automatic per-video ARTIFACT colour calibration for Auto Scouting (DOM-free, unit-testable).
//
// The counter needs the ARTIFACT colours of THIS video — venue lighting, camera white balance
// and compression all shift them. They are measured from the video itself: at match start the
// 18 pre-staged SPIKE MARK artifacts sit where the manual puts them, with known colours
// (CM §10.3 staging: 3 per SPIKE MARK, from the field middle outward: near GPP, middle PGP,
// far PPG). Projecting them with the camera pose from ROI placement gives exact purple and
// green samples under this venue's lighting, seen by this camera.

import type { FieldModel } from "./placement/fieldModel.ts";
import { projectPoint, type Intrinsics, type Pose, type Vec2, type Vec3 } from "./placement/geometry.ts";
import { rgbToHsv } from "./cvDetector.ts";
import { rgbToLab, type Lab } from "./rampState.ts";
import { applyH, type Homography } from "./viewTracker.ts";

export interface Frame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface CameraSolution {
  pose: Pose;
  intrinsics: Intrinsics;
}

export type ArtifactColour = "purple" | "green";

const ARTIFACT_RADIUS_IN = 2.5; // CM §9.9: 5 in nominal diameter

// ---- pre-staged artifacts ------------------------------------------------------------

export interface StagedArtifact {
  world: Vec3; // ball centre
  colour: ArtifactColour;
}

// CM §10.3 A: 3 ARTIFACTS on each SPIKE MARK, "with the MOTIFS starting from the middle of
// the FIELD and continuing toward the FIELD perimeter": near (audience side) GPP, middle PGP,
// far (GOAL side) PPG. The 3 balls sit along the 10 in SPIKE MARK tape (CM §9.3), 5 in apart.
export function stagedArtifacts(model: FieldModel): StagedArtifact[] {
  const order: Record<string, string> = { front: "GPP", centre: "PGP", back: "PPG" };
  const out: StagedArtifact[] = [];
  for (const m of model.markings) {
    if (!/spike mark/.test(m.name)) continue;
    const key = /front/.test(m.name) ? "front" : /centre/.test(m.name) ? "centre" : "back";
    const [a, b] = m.points;
    const inner = Math.abs(a[0]) < Math.abs(b[0]) ? a : b;
    const outer = inner === a ? b : a;
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      out.push({
        world: [inner[0] + (outer[0] - inner[0]) * t, inner[1] + (outer[1] - inner[1]) * t, ARTIFACT_RADIUS_IN],
        colour: order[key][i] === "G" ? "green" : "purple",
      });
    }
  }
  return out;
}

// Projected centre and radius (px) of a ball of radius `r` at `world`. `warp` maps the pose's
// image (the frame the pose was found in) into the current frame when the camera has moved.
export function projectBall(world: Vec3, cam: CameraSolution, r = ARTIFACT_RADIUS_IN, warp?: Homography): { c: Vec2; r: number } | null {
  const c = projectPoint(world, cam.pose, cam.intrinsics);
  if (c.depth <= 1) return null;
  // radius from the focal length and depth (a sphere projects to ~ f r / depth)
  const rad = (cam.intrinsics.fx * r) / c.depth;
  if (!warp) return { c: c.uv, r: rad };
  const cw = applyH(warp, c.uv);
  const ew = applyH(warp, [c.uv[0] + rad, c.uv[1]]);
  return { c: cw, r: Math.hypot(ew[0] - cw[0], ew[1] - cw[1]) };
}

export function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Broad hue families: anything calibrated must fall inside these. Purple is wide toward
// magenta — under warm venue lighting purple ARTIFACTS read as hue 340-355° (Hawaii 240p) —
// which is safe because every sample is labelled by where the manual stages it.
const FAMILY: Record<ArtifactColour, { centre: number; half: number }> = {
  purple: { centre: 300, half: 65 },
  green: { centre: 130, half: 60 },
};

// Pixels of the inner 60% of a projected ball's disc (edges mix with the floor).
function discPixels(frame: Frame, b: { c: Vec2; r: number }, fn: (i: number) => void) {
  const rr = Math.max(0.8, b.r * 0.6);
  for (let y = Math.floor(b.c[1] - rr); y <= Math.ceil(b.c[1] + rr); y++)
    for (let x = Math.floor(b.c[0] - rr); x <= Math.ceil(b.c[0] + rr); x++) {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      if ((x + 0.5 - b.c[0]) ** 2 + (y + 0.5 - b.c[1]) ** 2 > rr * rr) continue;
      fn((y * frame.width + x) * 4);
    }
}

// Is this pixel plausibly the given ARTIFACT colour (coloured, not a grey highlight / edge)?
function inFamily(frame: Frame, i: number, colour: ArtifactColour): boolean {
  const [h, s, v] = rgbToHsv(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
  return s >= 0.12 && v >= 0.08 && hueDist(h, FAMILY[colour].centre) <= FAMILY[colour].half;
}

const med3 = (ls: Lab[]) => [0, 1, 2].map((c) => ls.map((l) => l[c]).sort((p, q) => p - q)[ls.length >> 1]) as Lab;

// What one frame shows at the pre-staged ARTIFACTS. A staged ARTIFACT is seen when at least
// 30% of its inner disc has its staged colour; `labs[k]` is then the median Lab of those pixels
// (null when not seen), k indexing stagedArtifacts(model). `score` counts the ARTIFACTS seen:
// a frame of an intro card, a results graphic or a crowd shot has none, and a uniformly
// coloured title card can fake one colour but not the purple / green pattern, so both colours
// must show up.
export interface StagedObservation {
  purple: number;
  green: number;
  score: number;
  labs: (Lab | null)[];
}

export function stagedObservation(frame: Frame, cam: CameraSolution, model: FieldModel, warp?: Homography): StagedObservation {
  const seen = { purple: 0, green: 0 };
  const labs: (Lab | null)[] = [];
  for (const a of stagedArtifacts(model)) {
    const b = projectBall(a.world, cam, ARTIFACT_RADIUS_IN, warp);
    let n = 0;
    const fam: Lab[] = [];
    if (b && b.r >= 1)
      discPixels(frame, b, (i) => {
        n++;
        if (inFamily(frame, i, a.colour)) fam.push(rgbToLab(frame.data[i], frame.data[i + 1], frame.data[i + 2]));
      });
    const ok = n > 0 && fam.length >= Math.max(1, 0.3 * n);
    if (ok) seen[a.colour]++;
    labs.push(ok ? med3(fam) : null);
  }
  return { ...seen, score: seen.purple >= 2 && seen.green >= 1 ? seen.purple + seen.green : 0, labs };
}

export function stagedVisibility(frame: Frame, cam: CameraSolution, model: FieldModel, warp?: Homography): { purple: number; green: number; score: number } {
  const { purple, green, score } = stagedObservation(frame, cam, model, warp);
  return { purple, green, score };
}

// The ARTIFACT colour samples for the RAMP queue counter from staged observations over a
// stretch of video: each staged ARTIFACT's colour is its median over the frames it was seen in,
// weighted by how many frames that was. ARTIFACTS on their SPIKE MARKS sit still and are seen
// throughout; something that covers a staged position only for a moment counts for little —
// a broadcast overlay's motif icons appearing at the start (DC1: bright green icons over 3 of
// the 6 green positions from the start on), a robot driving past.
export interface StagedColours {
  purple: Lab[];
  green: Lab[];
  purpleWeight?: number[]; // frames each sample's ARTIFACT was seen in (default: 1 each)
  greenWeight?: number[];
}

export function stagedColours(obs: StagedObservation[], model: FieldModel): StagedColours {
  const out = { purple: [] as Lab[], green: [] as Lab[], purpleWeight: [] as number[], greenWeight: [] as number[] };
  stagedArtifacts(model).forEach((a, k) => {
    const seen = obs.map((o) => o.labs[k]).filter((l): l is Lab => !!l);
    if (!seen.length) return;
    out[a.colour].push(med3(seen));
    out[a.colour === "purple" ? "purpleWeight" : "greenWeight"].push(seen.length);
  });
  return out;
}

// Representative Lab colour of every pre-staged ARTIFACT seen in at least half of `frames`
// (median over the inner disc, then over frames), grouped by colour.
export function stagedArtifactLab(frames: Frame[], cam: CameraSolution, model: FieldModel, warp?: Homography): { purple: Lab[]; green: Lab[] } {
  const obs = frames.map((f) => stagedObservation(f, cam, model, warp));
  const out = { purple: [] as Lab[], green: [] as Lab[] };
  stagedArtifacts(model).forEach((a, k) => {
    const seen = obs.map((o) => o.labs[k]).filter((l): l is Lab => !!l);
    if (seen.length && seen.length >= frames.length / 2) out[a.colour].push(med3(seen));
  });
  return out;
}
