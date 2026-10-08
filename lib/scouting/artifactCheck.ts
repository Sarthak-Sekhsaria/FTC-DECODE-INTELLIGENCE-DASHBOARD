// Self-check of the automatic calibration on the ARTIFACTS themselves (DOM-free, unit-tested).
//
// Everything the RAMP counter uses is set automatically: the size of an ARTIFACT on each RAMP
// (from the camera pose), where the queue lies (the placed lane) and the ARTIFACT colours (from
// the pre-staged ARTIFACTS). While the match runs, every ARTIFACT the counter sees queued is
// measured in the picture, independently of those numbers' sources:
//   - its width across the lane (the run of ARTIFACT-coloured pixels through it; the dark holes
//     of the whiffle ball are bridged) against the automatic size;
//   - how far its middle lies from the lane, in ball radii;
//   - how far its colour is from the automatic colour, in units of the automatic tolerance.
// The medians tell the user, on every video, whether the automatic values fit this video.

import { rgbToLab, type Lab } from "./rampState.ts";
import type { Vec2 } from "./placement/geometry.ts";
import type { Frame } from "./calibration.ts";

export interface ArtifactColours {
  purple: Lab;
  green: Lab;
  purpleSigma: number;
  greenSigma: number;
  purpleChroma: number;
  greenChroma: number;
}

export interface ArtifactMeasure {
  size: number; // measured width / automatic diameter
  offset: number; // middle of the ARTIFACT from the lane, in ball radii (signed, across the lane)
  colour: number; // colour distance from the automatic colour, in automatic tolerances
}

export interface ArtifactCheck {
  measured: number;
  size: number; // medians of the above
  offset: number;
  colour: number;
}

export interface ArtifactCheckConfig {
  lightWeight: number; // brightness counts this much in colour distances (as in the counter)
  minChroma: number; // an ARTIFACT pixel keeps at least this share of the colour's colourfulness
  // a pixel within this many tolerances of an ARTIFACT colour is ARTIFACT; at 3 the blue RAMPS'
  // structure beside the queue passed for purple and the ARTIFACTS measured ~1.9x their size
  maxSigma: number;
  searchRadii: number; // the ARTIFACT's middle is looked for this many radii either side of the lane
  holeRadii: number; // gaps up to this many radii inside a run are the ball's holes
}

export const DEFAULT_ARTIFACT_CHECK_CONFIG: ArtifactCheckConfig = {
  lightWeight: 0.5,
  minChroma: 0.3,
  maxSigma: 2,
  searchRadii: 1.5,
  holeRadii: 0.35,
};

// Lab of the frame at (x, y), bilinear.
function labAtF(f: Frame, x: number, y: number): Lab | null {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= f.width || y0 + 1 >= f.height) return null;
  const fx = x - x0, fy = y - y0;
  const c = [0, 0, 0];
  const add = (dx: number, dy: number, w: number) => {
    const i = ((y0 + dy) * f.width + x0 + dx) * 4;
    c[0] += w * f.data[i];
    c[1] += w * f.data[i + 1];
    c[2] += w * f.data[i + 2];
  };
  add(0, 0, (1 - fx) * (1 - fy));
  add(1, 0, fx * (1 - fy));
  add(0, 1, (1 - fx) * fy);
  add(1, 1, fx * fy);
  return rgbToLab(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]));
}

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

// Measure the ARTIFACT the counter sees at a slot: `centre` is the slot centre in the frame,
// `toward` the next slot's (the lane direction), `r` the automatic ball radius (px). Null when
// no ARTIFACT-coloured run lies near the lane; the widest run when there are several.
export function measureArtifact(frame: Frame, centre: Vec2, toward: Vec2, r: number, col: ArtifactColours, cfg: ArtifactCheckConfig = DEFAULT_ARTIFACT_CHECK_CONFIG): ArtifactMeasure | null {
  const all = measureArtifacts(frame, centre, toward, r, col, cfg);
  return all.length ? all.reduce((a, b) => (b.size > a.size ? b : a)) : null;
}

// Every ARTIFACT-coloured run across the lane at a slot whose middle lies within
// cfg.searchRadii of it (several when something else of ARTIFACT colour is beside the queue).
export function measureArtifacts(frame: Frame, centre: Vec2, toward: Vec2, r: number, col: ArtifactColours, cfg: ArtifactCheckConfig = DEFAULT_ARTIFACT_CHECK_CONFIG): ArtifactMeasure[] {
  if (!(r > 0)) return [];
  const ax = toward[0] - centre[0], ay = toward[1] - centre[1];
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) return [];
  const n: Vec2 = [-ay / al, ax / al];
  const colours = [
    { mu: col.purple, sig: col.purpleSigma, chroma: col.purpleChroma },
    { mu: col.green, sig: col.greenSigma, chroma: col.greenChroma },
  ];
  const dist = (l: Lab, mu: Lab) => Math.sqrt(cfg.lightWeight * cfg.lightWeight * (l[0] - mu[0]) ** 2 + (l[1] - mu[1]) ** 2 + (l[2] - mu[2]) ** 2);
  // which ARTIFACT colour a pixel is (0 purple, 1 green), -1 when neither
  const classOf = (l: Lab | null) => {
    if (!l) return -1;
    const chroma = Math.hypot(l[1], l[2]);
    let best = -1, bd = cfg.maxSigma;
    colours.forEach((c, j) => {
      if (chroma < cfg.minChroma * c.chroma) return;
      const z = dist(l, c.mu) / c.sig;
      if (z < bd) {
        bd = z;
        best = j;
      }
    });
    return best;
  };
  const step = Math.max(0.25, r / 16);
  const reach = cfg.searchRadii + 1;
  const prof: number[] = [];
  for (let o = -reach * r; o <= reach * r + 1e-9; o += step) prof.push(classOf(labAtF(frame, centre[0] + n[0] * o, centre[1] + n[1] * o)));
  const at = (i: number) => -reach * r + i * step;
  const runs: { len: number; mid: number; cls: number }[] = [];
  for (let a = 0; a < prof.length; a++) {
    if (prof[a] < 0) continue;
    let b = a;
    for (;;) {
      let nx = b + 1;
      while (nx < prof.length && prof[nx] < 0 && (nx - b) * step <= cfg.holeRadii * r) nx++;
      if (nx >= prof.length || prof[nx] < 0) break;
      b = nx;
    }
    const len = (b - a + 1) * step, mid = (at(a) + at(b)) / 2;
    if (Math.abs(mid) <= cfg.searchRadii * r) {
      const votes = [0, 0];
      for (let i = a; i <= b; i++) if (prof[i] >= 0) votes[prof[i]]++;
      runs.push({ len, mid, cls: votes[0] >= votes[1] ? 0 : 1 });
    }
    a = b;
  }
  const out: ArtifactMeasure[] = [];
  for (const run of runs) {
    // its colour: the pixels of its colour within half a radius of its middle
    const cx = centre[0] + n[0] * run.mid, cy = centre[1] + n[1] * run.mid;
    const labs: Lab[] = [];
    const s2 = Math.max(0.5, r / 8);
    for (let dy = -0.5 * r; dy <= 0.5 * r + 1e-9; dy += s2)
      for (let dx = -0.5 * r; dx <= 0.5 * r + 1e-9; dx += s2) {
        if (dx * dx + dy * dy > 0.25 * r * r) continue;
        const l = labAtF(frame, cx + dx, cy + dy);
        if (l && classOf(l) === run.cls) labs.push(l);
      }
    if (!labs.length) continue;
    const med: Lab = [0, 1, 2].map((c) => median(labs.map((l) => l[c]))) as Lab;
    const c = colours[run.cls];
    out.push({ size: run.len / (2 * r), offset: run.mid / r, colour: dist(med, c.mu) / c.sig });
  }
  return out;
}

export function summarizeChecks(ms: ArtifactMeasure[]): ArtifactCheck | null {
  if (!ms.length) return null;
  return { measured: ms.length, size: median(ms.map((m) => m.size)), offset: median(ms.map((m) => m.offset)), colour: median(ms.map((m) => m.colour)) };
}

// Does the check say the automatic values fit this video? (display thresholds). The width is a
// coarse measurement — blur at low resolution, the ball's shading and holes, a rail or panel of
// similar colour beside it: on the 17 benchmark videos RAMPS that count right measured 0.44-1.6x
// — so only a gross mismatch is reported; the distance from the lane is the reliable signal.
export function checkVerdict(c: ArtifactCheck): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (Math.abs(c.offset) > 0.6) issues.push(`the ARTIFACTS sit ${Math.abs(c.offset).toFixed(1)} ball radii off the placed lane: the RAMP ROI may be misplaced`);
  if (c.size < 0.4 || c.size > 1.8) issues.push(`the ARTIFACTS measure ${c.size.toFixed(2)}x the automatic size`);
  if (c.colour > 2.5) issues.push(`the ARTIFACTS' colour is ${c.colour.toFixed(1)} tolerances from the calibrated colour`);
  return { ok: !issues.length, issues };
}
