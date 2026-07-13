// Browser computer-vision primitives for Auto Scouting.
//
// Pure, DOM-free logic (unit-testable without a canvas):
//   1. analyzeZonePixels — quick "is any artifact colour present / how much"
//      summary of a gate crop (coverage, matched-pixel count, dominant colour).
//   2. detectCandidates — connected-components blob detection that returns EVERY
//      separate artifact-shaped region in the crop (not just the largest), each
//      with a centre, bounding box, area and colour.
//   3. GateMultiTracker — lightweight per-candidate tracking (nearest-neighbour
//      match across the last few frames) that emits one +3 crossing per artifact
//      as its centre moves from the field side of the scoring line to the goal
//      side. No global "gate occupied / waiting for clear" lock, so several
//      artifacts can cross together or back-to-back and each still counts once.
//   4. computeMaskImage — an RGBA mask of matched pixels for the debug preview.
//
// Only the two calibrated gate crops are ever analyzed — never the whole field.
// Colours are user-calibratable (sampling), the single biggest accuracy lever.

export type DetectedColor = "purple" | "green" | "unknown";

export interface ColorTarget {
  label: "purple" | "green";
  hue: number; // 0..360 centre hue
  tol: number; // +/- hue tolerance in degrees
}

export const DEFAULT_TARGETS: ColorTarget[] = [
  { label: "purple", hue: 285, tol: 45 },
  { label: "green", hue: 130, tol: 50 },
];

export interface ZoneObservation {
  present: boolean; // coverage >= minCoverage this frame
  color: DetectedColor;
  centroidX: number; // 0 (left) .. 1 (right) of the crop
  centroidY: number; // 0 (top) .. 1 (bottom) of the crop
  coverage: number; // fraction of sampled pixels matching a target colour
  matchedPixels: number; // count of matched pixels (sampled)
}

export interface ZoneAnalysisConfig {
  targets: ColorTarget[];
  minSat: number;
  minVal: number;
  minCoverage: number;
  sampleStride: number;
}

export const DEFAULT_ZONE_CONFIG: ZoneAnalysisConfig = {
  targets: DEFAULT_TARGETS,
  minSat: 0.25,
  minVal: 0.18,
  minCoverage: 0.03,
  sampleStride: 2,
};

// --- RGB -> HSV (h in [0,360), s,v in [0,1]) ---
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function classifyPixel(
  r: number,
  g: number,
  b: number,
  targets: ColorTarget[],
  minSat: number,
  minVal: number,
): DetectedColor {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < minSat || v < minVal) return "unknown";
  for (const t of targets) {
    if (hueDistance(h, t.hue) <= t.tol) return t.label;
  }
  return "unknown";
}

export function targetFromSample(r: number, g: number, b: number, label: "purple" | "green", tol = 32): ColorTarget {
  const [h] = rgbToHsv(r, g, b);
  return { label, hue: h, tol };
}

// pixels: RGBA row-major for a `width`x`height` crop.
export function analyzeZonePixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  config: ZoneAnalysisConfig = DEFAULT_ZONE_CONFIG,
): ZoneObservation {
  let purple = 0;
  let green = 0;
  let weightedX = 0;
  let weightedY = 0;
  let matched = 0;
  let sampled = 0;
  const stride = Math.max(1, config.sampleStride);

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      sampled++;
      const c = classifyPixel(pixels[i], pixels[i + 1], pixels[i + 2], config.targets, config.minSat, config.minVal);
      if (c === "unknown") continue;
      matched++;
      weightedX += x;
      weightedY += y;
      if (c === "purple") purple++;
      else green++;
    }
  }

  const coverage = sampled === 0 ? 0 : matched / sampled;
  const present = coverage >= config.minCoverage && matched > 0;
  const centroidX = matched === 0 ? 0.5 : weightedX / matched / Math.max(1, width);
  const centroidY = matched === 0 ? 0.5 : weightedY / matched / Math.max(1, height);
  const color: DetectedColor = !present ? "unknown" : purple >= green ? "purple" : "green";

  return { present, color, centroidX, centroidY, coverage, matchedPixels: matched };
}

// RGBA mask (matched pixels highlighted) for the debug preview. Not sampled/strided
// — one output pixel per source pixel — since it is only run on demand or throttled.
export function computeMaskImage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  config: ZoneAnalysisConfig = DEFAULT_ZONE_CONFIG,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const c = classifyPixel(pixels[j], pixels[j + 1], pixels[j + 2], config.targets, config.minSat, config.minVal);
    if (c === "purple") {
      out[j] = 200; out[j + 1] = 80; out[j + 2] = 255; out[j + 3] = 255;
    } else if (c === "green") {
      out[j] = 60; out[j + 1] = 230; out[j + 2] = 120; out[j + 3] = 255;
    } else {
      out[j] = 10; out[j + 1] = 12; out[j + 2] = 12; out[j + 3] = 255;
    }
  }
  return out;
}

// --- Artifact candidate (blob) detection ---

export interface Candidate {
  centerX: number; // 0..1 within the crop
  centerY: number; // 0..1 within the crop
  width: number; // 0..1 (bbox width / crop width)
  height: number; // 0..1 (bbox height / crop height)
  area: number; // 0..1 (matched-pixel area / crop area)
  color: DetectedColor;
  matchedPixels: number; // sampled matched pixels in this blob
}

export interface CandidateConfig extends ZoneAnalysisConfig {
  // A blob must cover at least this fraction of the crop to be a candidate — filters
  // out specular/noise flecks. Scaled down by the sensitivity control in the UI.
  minAreaFrac: number;
}

export const DEFAULT_CANDIDATE_CONFIG: CandidateConfig = {
  ...DEFAULT_ZONE_CONFIG,
  minAreaFrac: 0.01,
};

// Connected-components (8-connectivity) on a strided grid of the crop. Purple and
// green are kept as separate labels, so two artifacts of different colours that
// touch are still returned as two candidates. Returns every candidate above the
// minimum area, sorted largest-first — never only the biggest one.
export function detectCandidates(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG,
): Candidate[] {
  const stride = Math.max(1, config.sampleStride);
  const gw = Math.ceil(width / stride);
  const gh = Math.ceil(height / stride);
  if (gw <= 0 || gh <= 0) return [];

  // Classify every grid cell: 0 = none, 1 = purple, 2 = green.
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(width - 1, gx * stride);
      const y = Math.min(height - 1, gy * stride);
      const i = (y * width + x) * 4;
      const c = classifyPixel(pixels[i], pixels[i + 1], pixels[i + 2], config.targets, config.minSat, config.minVal);
      grid[gy * gw + gx] = c === "purple" ? 1 : c === "green" ? 2 : 0;
    }
  }

  const labels = new Int32Array(gw * gh).fill(-1);
  const stack: number[] = [];
  const candidates: Candidate[] = [];
  const gridCells = gw * gh;
  const minCells = Math.max(2, Math.floor(config.minAreaFrac * gridCells));

  let nextLabel = 0;
  for (let start = 0; start < gridCells; start++) {
    if (grid[start] === 0 || labels[start] !== -1) continue;
    const colorCode = grid[start];
    const label = nextLabel++;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = gw;
    let maxX = -1;
    let minY = gh;
    let maxY = -1;

    while (stack.length) {
      const idx = stack.pop()!;
      const cx = idx % gw;
      const cy = (idx / gw) | 0;
      count++;
      sumX += cx;
      sumY += cy;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const nIdx = ny * gw + nx;
          if (labels[nIdx] !== -1 || grid[nIdx] !== colorCode) continue;
          labels[nIdx] = label;
          stack.push(nIdx);
        }
      }
    }

    if (count < minCells) continue;
    candidates.push({
      centerX: sumX / count / Math.max(1, gw - 1),
      centerY: sumY / count / Math.max(1, gh - 1),
      width: (maxX - minX + 1) / gw,
      height: (maxY - minY + 1) / gh,
      area: count / gridCells,
      color: colorCode === 1 ? "purple" : "green",
      matchedPixels: count,
    });
  }

  candidates.sort((a, b) => b.area - a.area);
  return candidates;
}

// --- Gate scoring-line crossing (multi-artifact) ---
export type ScoringDirection = "downward" | "upward";
export type LineSide = "field" | "goal";

export function sideOfLine(centerY: number, line: number, direction: ScoringDirection): LineSide {
  const below = centerY >= line;
  if (direction === "downward") return below ? "goal" : "field";
  return below ? "field" : "goal";
}

export interface TrackerConfig {
  line: number; // scoring line, 0..1 within the crop (compared to centerY)
  direction: ScoringDirection; // which way across the line scores
  maxMatchDist: number; // max normalized centre distance to link a candidate to a track
  maxMissing: number; // frames a track can be unseen before it is dropped
  singleArtifactArea?: number; // approx normalized area of ONE artifact (for multi-blob estimate)
  maxClump?: number; // cap on balls a single blob may represent (tames spikes/variance)
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  line: 0.5,
  direction: "downward",
  maxMatchDist: 0.45,
  maxMissing: 6,
};

// Artifacts travel mostly ALONG the scoring direction (vertically in the crop),
// so we tolerate a large vertical step between frames but keep horizontal (lane)
// separation strict — this both survives fast crossings and keeps two artifacts
// in different lanes from being confused for one.
const X_WEIGHT = 2.0;

export interface CrossingEvent {
  trackId: number;
  centerX: number; // where it crossed (used to de-dup simultaneous crossings on replay)
  color: DetectedColor;
  estimatedCount: number; // usually 1; >1 only for an un-separable large blob
  uncertain: boolean; // true when estimatedCount came from area, needs manual review
  confidence: "high" | "medium" | "low";
}

export interface Track {
  id: number;
  x: number; // current normalized centre
  y: number;
  prevY: number; // centre Y last frame (for the field->goal transition)
  area: number;
  color: DetectedColor;
  counted: boolean; // already produced a crossing while alive
  missing: number; // consecutive frames unseen
  seen: number; // frames matched
}

export interface MultiUpdate {
  crossings: CrossingEvent[];
  candidateCount: number;
  tracks: Track[];
}

// One tracker per goal. Each frame it is given ALL detected candidates; it links
// each to the nearest existing track (or starts a new one), then emits a crossing
// for every track whose centre moved from the field side to the goal side and that
// has not already been counted. A counted track stays counted until it leaves the
// crop, so the same artifact never scores twice — but the rest of the crop keeps
// accepting new candidates, so simultaneous / back-to-back artifacts all count.
export class GateMultiTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private cfg: TrackerConfig;

  constructor(cfg: TrackerConfig = DEFAULT_TRACKER_CONFIG) {
    this.cfg = cfg;
  }

  reset() {
    this.tracks = [];
  }

  setConfig(cfg: TrackerConfig) {
    this.cfg = cfg;
  }

  private side(y: number): LineSide {
    return sideOfLine(y, this.cfg.line, this.cfg.direction);
  }

  update(candidates: Candidate[]): MultiUpdate {
    const crossings: CrossingEvent[] = [];
    const usedTrack = new Set<number>();

    // Greedy nearest-neighbour match: each candidate links to the closest unused
    // track within maxMatchDist. Distance is in normalized crop coordinates.
    const matches: { cand: Candidate; track: Track | null }[] = [];
    // Bigger candidates first (already sorted) so dominant blobs claim tracks first.
    for (const cand of candidates) {
      let best: Track | null = null;
      let bestD = this.cfg.maxMatchDist;
      for (const t of this.tracks) {
        if (usedTrack.has(t.id)) continue;
        const dx = (t.x - cand.centerX) * X_WEIGHT;
        const dy = t.y - cand.centerY;
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (best) usedTrack.add(best.id);
      matches.push({ cand, track: best });
    }

    // Apply matches (update existing) and spawn new tracks for unmatched candidates.
    for (const { cand, track } of matches) {
      if (track) {
        track.prevY = track.y;
        track.x = cand.centerX;
        track.y = cand.centerY;
        track.area = cand.area;
        track.color = cand.color;
        track.missing = 0;
        track.seen++;

        if (!track.counted && this.side(track.prevY) === "field" && this.side(track.y) === "goal") {
          track.counted = true;
          crossings.push(this.makeCrossing(track));
        }
      } else {
        this.tracks.push({
          id: this.nextId++,
          x: cand.centerX,
          y: cand.centerY,
          prevY: cand.centerY,
          area: cand.area,
          color: cand.color,
          counted: false,
          missing: 0,
          seen: 1,
        });
      }
    }

    // Age out tracks not matched this frame.
    for (const t of this.tracks) {
      if (!usedTrack.has(t.id)) t.missing++;
    }
    this.tracks = this.tracks.filter((t) => t.missing <= this.cfg.maxMissing);

    return { crossings, candidateCount: candidates.length, tracks: this.tracks.slice() };
  }

  private makeCrossing(track: Track): CrossingEvent {
    // If a single blob is much larger than one calibrated artifact, it is likely
    // several touching artifacts. We surface an estimate but mark it uncertain —
    // we never silently score N points off one blob.
    let estimatedCount = 1;
    let uncertain = false;
    const single = this.cfg.singleArtifactArea;
    if (single && single > 0 && track.area > single * 1.6) {
      // Cap the estimate: a single blob occasionally engulfs the whole (bright, full)
      // column, which would spike the count and swing run-to-run. Real touching-ball
      // bursts are small, so clamp to maxClump (default 4).
      const cap = this.cfg.maxClump ?? 4;
      estimatedCount = Math.min(cap, Math.max(1, Math.round(track.area / single)));
      uncertain = estimatedCount > 1;
    }
    const confidence: "high" | "medium" | "low" =
      track.seen >= 3 ? "high" : track.seen >= 2 ? "medium" : "low";
    return { trackId: track.id, centerX: track.x, color: track.color, estimatedCount, uncertain, confidence };
  }
}
