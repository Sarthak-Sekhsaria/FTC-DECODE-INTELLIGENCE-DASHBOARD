// RAMP queue counter for Auto Scouting (DOM-free, unit-testable).
//
// CLASSIFIED ARTIFACTS are counted from what the RAMP holds, not from blobs crossing a line:
// the lower RAMP queues up to 9 ARTIFACTS against the GATE (CM §9.8.2) and only empties when
// a robot opens the GATE. So the queue level (how many of the 9 slots hold a ball) rises one
// ARTIFACT at a time and drops only at a release — every rise between releases is one
// CLASSIFIED ARTIFACT. ARTIFACTS that roll straight through while the GATE is held open never
// raise the queue, so balls seen rolling in from the top are counted too, and each fill period
// takes whichever of the two saw more.
//
// Per frame, every visible sample point of every slot (rampState.buildLane) is compared with
//   - the empty RAMP at that point (learned from the first moments of the match), and
//   - the ARTIFACT colours of this video (sampled at the pre-staged ARTIFACTS, calibration.ts)
// giving a per-slot "ball vs empty" log-likelihood ratio. Something that is neither (a person,
// a robot, a referee's shirt) is far from both and says nothing. The queue level over the whole
// match is then decoded jointly (Viterbi) under the RAMP's physics, so brief flicker, balls
// rolling past and people walking behind cannot make up ARTIFACTS on their own.
//
// All thresholds adapt to the video: colours and their spread come from this video's staged
// ARTIFACTS, the empty-RAMP appearance and its noise from this RAMP, and how much each slot's
// evidence counts from how many real pixels the ball covers in this view.

import { SLOTS, type Lab } from "./rampState.ts";

export interface RampQueueConfig {
  fps: number; // evidence rate; the costs below are per frame at this rate
  lightWeight: number; // weight of L* against a*, b* (shadows / lighting change brightness)
  outlierSigma: number; // a sample further than this (in sigmas) from a model is "neither"
  minEmptySigma: number; // floor on the per-point empty-RAMP spread (tracking jitter, noise)
  minBallSigma: number; // floor on the ARTIFACT colour spread (the RAMP is lit unlike the floor)
  defaultBallSigma: number; // spread used when no staged ARTIFACT could be sampled
  minChroma: number; // an ARTIFACT pixel keeps at least this share of the staged colourfulness
  pixelCell: number; // px between samples that are really independent (compression blocks)
  evidenceWeight: number; // per-frame evidence weight: neighbouring frames are highly correlated
  incrementCost: number; // -log P(one more ARTIFACT joins the queue in a frame)
  jumpCost: number; // extra cost when more than one ARTIFACT joins in the same frame
  releaseCost: number; // -log P(the GATE opens in a frame)
  partialReleaseCost: number; // extra cost per ARTIFACT still queued after a release
  rollingCost: number; // evidence a ball above the queue needs before it is not "rolling past"
  hiddenCap: number; // the most one queued slot that looks empty can cost (it may be hidden)
  releaseDrop: number; // a release drops the level by at least this many ARTIFACTS...
  releaseDrain: number; // ...and drains at least this share of the queue (balls leave from the GATE end)
  drainSec: number; // after a release, the queue takes this long to roll out
  holdSec: number; // with well-resolved balls, a queue level counts only once it has lasted this long...
  holdMinRadiusPx: number; // ...where "well resolved" is a ball radius of at least this many pixels
  entryEvidence: number; // per-point evidence for "a ball is here" when tracking entries
  entryTopSlots: number; // an entry starts in the top slots...
  entryMinTravel: number; // ...and rolls at least this many slots down (or reaches the queue)
  entryMaxSlotsPerSec: number;
  entryMaxGapSec: number; // a track may miss this long (motion blur) and continue
}

export const DEFAULT_RAMP_QUEUE_CONFIG: RampQueueConfig = {
  fps: 15,
  lightWeight: 0.5,
  outlierSigma: 3,
  minEmptySigma: 6,
  minBallSigma: 12,
  defaultBallSigma: 18,
  minChroma: 0.3,
  pixelCell: 2,
  evidenceWeight: 0.3,
  incrementCost: 5,
  jumpCost: 1,
  releaseCost: 14,
  partialReleaseCost: 2,
  rollingCost: 25,
  hiddenCap: 20,
  releaseDrop: 2,
  releaseDrain: 0,
  drainSec: 1,
  holdSec: 0.5,
  holdMinRadiusPx: 6,
  entryEvidence: 0.8,
  entryTopSlots: 3,
  entryMinTravel: 1.5,
  entryMaxSlotsPerSec: 30,
  entryMaxGapSec: 0.25,
};

// Fallback ARTIFACT colours (median of the staged-ARTIFACT samples over the eight benchmark
// videos in docs/auto-roi-placement.md), used only when this video's staged ARTIFACTS could
// not be seen; the wider defaultBallSigma covers the venue-to-venue spread.
export const FALLBACK_PURPLE: Lab = [46, 29, -15];
export const FALLBACK_GREEN: Lab = [58, -37, 11];

export type ArtifactColourName = "purple" | "green";

// ---- appearance ------------------------------------------------------------------------

export interface RampAppearance {
  points: number; // sample points on the lane
  slotOfPoint: Uint8Array;
  pointsPerSlot: number[];
  emptyLab: Float32Array; // per point, empty-RAMP median (3 per point; NaN if never seen)
  emptySigma: Float32Array; // per point
  purple: Lab;
  green: Lab;
  purpleSigma: number;
  greenSigma: number;
  purpleChroma: number;
  greenChroma: number;
  slotWeight: number[]; // per slot evidence weight (independent pixels / sample points)
  colourSource: "staged-artifacts" | "defaults";
  stagedSamples: { purple: number; green: number };
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

function weightedDist2(cfg: RampQueueConfig, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): number {
  const dl = (a[ai] - b[bi]) * cfg.lightWeight;
  const da = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  return dl * dl + da * da + db * db;
}

// Median of xs with weights w: the first x, in order, past half the total weight (with equal
// weights the same element as median() above).
function weightedMedian(xs: number[], w: number[]): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const half = w.reduce((a, b) => a + b, 0) / 2;
  let acc = 0;
  for (const i of idx) if ((acc += w[i]) > half) return xs[i];
  return xs[idx[idx.length - 1]];
}

// Median of a chi-square variable with 3 degrees of freedom: the squared distance of a 3-D
// normal sample from its mean is sigma^2 times it, so sigma = sqrt(median d^2 / 2.366).
const MEDIAN_CHI2_3 = 2.366;

// The colour of one ARTIFACT colour (median of the samples) and how far its pixels stray (RMS,
// at least minBallSigma). A sample far from the rest — something else seen where an ARTIFACT
// is staged — neither moves the colour (median) nor widens the tolerance: samples beyond 3
// sigma of a robust spread estimate are left out of the RMS. `weights`: how many frames each
// sample stands for (default 1).
function colourModel(samples: Lab[], fallback: Lab, cfg: RampQueueConfig, weights?: number[]): { mu: Lab; sigma: number; ok: boolean } {
  if (samples.length < 2) return { mu: fallback, sigma: cfg.defaultBallSigma, ok: false };
  const w = weights && weights.length === samples.length ? weights : samples.map(() => 1);
  const mu: Lab = [0, 1, 2].map((c) => weightedMedian(samples.map((s) => s[c]), w)) as Lab;
  const d2 = samples.map((s) => weightedDist2(cfg, s, 0, mu, 0));
  const robust = Math.sqrt(weightedMedian(d2, w) / MEDIAN_CHI2_3);
  const limit = 9 * Math.max(robust, cfg.minBallSigma) ** 2;
  let sw = 0, sd = 0;
  d2.forEach((d, i) => {
    if (d > limit) return;
    sw += w[i];
    sd += w[i] * d;
  });
  return { mu, sigma: Math.max(cfg.minBallSigma, Math.sqrt(sd / sw)), ok: true };
}

// `emptySamples`: lane samples (3 Lab values per point, NaN when off-frame) from frames where
// the RAMP is empty — the first moments of the match. `staged`: ARTIFACT colours sampled at
// the pre-staged ARTIFACTS (calibration.stagedArtifactLab).
export function learnAppearance(
  slotOfPoint: ArrayLike<number>,
  radiusPx: number[],
  visibleShare: number[],
  emptySamples: Float32Array[],
  staged: { purple: Lab[]; green: Lab[]; purpleWeight?: number[]; greenWeight?: number[] },
  cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG,
): RampAppearance {
  const P = slotOfPoint.length;
  const emptyLab = new Float32Array(P * 3).fill(NaN);
  const emptySigma = new Float32Array(P).fill(cfg.minEmptySigma);
  for (let i = 0; i < P; i++) {
    const obs = emptySamples.filter((s) => !Number.isNaN(s[i * 3]));
    if (!obs.length) continue;
    for (let c = 0; c < 3; c++) emptyLab[i * 3 + c] = median(obs.map((s) => s[i * 3 + c]));
    // the RMS spread: something passing in front of the RAMP during the window makes those
    // points less sensitive, which is the safe side (a median-based spread made Hawaii 720p red
    // count 96-109 against 81-82, official 85)
    const rms = Math.sqrt(obs.reduce((a, s) => a + weightedDist2(cfg, s, i * 3, emptyLab, i * 3), 0) / obs.length);
    emptySigma[i] = Math.max(cfg.minEmptySigma, rms);
  }
  const pointsPerSlot = new Array(SLOTS).fill(0);
  for (let i = 0; i < P; i++) pointsPerSlot[slotOfPoint[i]]++;
  // Sample points closer than ~pixelCell apart repeat the same (compressed) pixels, so a slot
  // whose ball covers few pixels must not speak with the voice of all its points.
  const slotWeight = pointsPerSlot.map((n, k) => {
    if (cfg.pixelCell <= 0 || !n) return 1;
    const px = (Math.PI * radiusPx[k] * radiusPx[k] * (visibleShare[k] ?? 1)) / (cfg.pixelCell * cfg.pixelCell);
    return Math.min(1, px / n);
  });
  const p = colourModel(staged.purple, FALLBACK_PURPLE, cfg, staged.purpleWeight);
  const g = colourModel(staged.green, FALLBACK_GREEN, cfg, staged.greenWeight);
  return {
    points: P,
    slotOfPoint: Uint8Array.from(slotOfPoint),
    pointsPerSlot,
    emptyLab,
    emptySigma,
    purple: p.mu,
    green: g.mu,
    purpleSigma: p.sigma,
    greenSigma: g.sigma,
    purpleChroma: Math.hypot(p.mu[1], p.mu[2]),
    greenChroma: Math.hypot(g.mu[1], g.mu[2]),
    slotWeight,
    colourSource: p.ok && g.ok ? "staged-artifacts" : "defaults",
    stagedSamples: { purple: staged.purple.length, green: staged.green.length },
  };
}

// ---- per-frame evidence --------------------------------------------------------------

export interface FrameEvidence {
  llr: Float64Array; // per slot: log P(ball) / P(empty), summed over its points
  colour: Int16Array; // per slot: purple-looking minus green-looking points
}

// `sample`: this frame's Lab at every lane point (NaN when the point is off-frame).
export function frameEvidence(sample: ArrayLike<number>, app: RampAppearance, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): FrameEvidence {
  const llr = new Float64Array(SLOTS);
  const colour = new Int16Array(SLOTS);
  const cap = cfg.outlierSigma * cfg.outlierSigma;
  const pS2 = app.purpleSigma * app.purpleSigma, gS2 = app.greenSigma * app.greenSigma;
  for (let i = 0; i < app.points; i++) {
    const j = i * 3;
    if (Number.isNaN(sample[j]) || Number.isNaN(app.emptyLab[j])) continue;
    const k = app.slotOfPoint[i];
    const dE = Math.min(cap, weightedDist2(cfg, sample, j, app.emptyLab, j) / (app.emptySigma[i] * app.emptySigma[i]));
    // an ARTIFACT is strongly coloured: greys (hair, clothes, shadow) are never a ball
    const chroma = Math.hypot(sample[j + 1], sample[j + 2]);
    const dP = chroma >= cfg.minChroma * app.purpleChroma ? weightedDist2(cfg, sample, j, app.purple, 0) / pS2 : Infinity;
    const dG = chroma >= cfg.minChroma * app.greenChroma ? weightedDist2(cfg, sample, j, app.green, 0) / gS2 : Infinity;
    const dB = Math.min(cap, dP, dG);
    // both capped at the outlier level, so something far from both says nothing
    llr[k] += 0.5 * (dE - dB) * app.slotWeight[k];
    if (dB < cap && dB < dE) colour[k] += dP <= dG ? 1 : -1;
  }
  return { llr, colour };
}

// ---- queue decoding ------------------------------------------------------------------

function levelScore(llr: ArrayLike<number>, base: number, n: number, cfg: RampQueueConfig): number {
  let s = 0;
  for (let k = 0; k < SLOTS; k++) {
    const v = llr[base + k];
    if (k < n) s += Math.max(v, -cfg.hiddenCap);
    else {
      // above the queue: empty, or a ball rolling down (softplus of the evidence beyond cost)
      const x = v - cfg.rollingCost;
      s += Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)));
    }
  }
  return s * cfg.evidenceWeight;
}

// levelScore for every level 0..SLOTS of one frame into `out`, with one softplus per slot
// instead of one per slot and level. Each sum is added in the same order as levelScore, so the
// values are identical.
function levelScores(llr: ArrayLike<number>, base: number, cfg: RampQueueConfig, below: Float64Array, above: Float64Array, out: Float64Array) {
  for (let k = 0; k < SLOTS; k++) {
    const v = llr[base + k];
    below[k] = Math.max(v, -cfg.hiddenCap);
    const x = v - cfg.rollingCost;
    above[k] = Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)));
  }
  let pre = 0;
  for (let n = 0; n <= SLOTS; n++) {
    let s = pre;
    for (let k = n; k < SLOTS; k++) s += above[k];
    out[n] = s * cfg.evidenceWeight;
    if (n < SLOTS) pre += below[n];
  }
}

function transition(m: number, n: number, cfg: RampQueueConfig): number {
  if (m === n) return 0;
  if (n > m) return -cfg.incrementCost * (n - m) - (n - m > 1 ? cfg.jumpCost : 0);
  return -cfg.releaseCost - cfg.partialReleaseCost * n;
}

// Most likely queue level (0..9) per frame. `llr`: SLOTS values per frame, flattened.
export function decodeQueue(llr: Float64Array, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): Int8Array {
  const T = Math.floor(llr.length / SLOTS), N = SLOTS + 1;
  const path = new Int8Array(T);
  if (!T) return path;
  const back = new Int8Array(T * N);
  const below = new Float64Array(SLOTS), above = new Float64Array(SLOTS), ls = new Float64Array(N);
  let prev = new Float64Array(N);
  let cur = new Float64Array(N);
  levelScores(llr, 0, cfg, below, above, ls);
  for (let n = 0; n < N; n++) prev[n] = ls[n] - (n ? 20 : 0); // RAMPS start empty
  const trans = new Float64Array(N * N);
  for (let m = 0; m < N; m++) for (let n = 0; n < N; n++) trans[m * N + n] = transition(m, n, cfg);
  for (let t = 1; t < T; t++) {
    levelScores(llr, t * SLOTS, cfg, below, above, ls);
    for (let n = 0; n < N; n++) {
      let best = -Infinity;
      let arg = 0;
      for (let m = 0; m < N; m++) {
        const v = prev[m] + trans[m * N + n];
        if (v > best) {
          best = v;
          arg = m;
        }
      }
      back[t * N + n] = arg;
      cur[n] = best + ls[n];
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  let n = 0;
  for (let k = 1; k < N; k++) if (prev[k] > prev[n]) n = k;
  for (let t = T - 1; t >= 0; t--) {
    path[t] = n;
    if (t) n = back[t * N + n];
  }
  return path;
}

// How well a decoded queue explains the evidence (the Viterbi objective of `path`). Used to
// compare lane placements on the same frames: the lane that sits on the balls explains more.
export function pathScore(llr: Float64Array, path: Int8Array, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): number {
  let s = 0;
  for (let t = 0; t < path.length; t++) {
    s += levelScore(llr, t * SLOTS, path[t], cfg);
    if (t) s += transition(path[t - 1], path[t], cfg);
  }
  return s;
}

export interface FillPeriod {
  from: number; // frame the period's entries are counted from
  release: number; // frame the release that ends it was seen (T for the last period)
  queueGain: number;
  queueFrames: number[]; // one frame per ARTIFACT that joined the queue
  entryFrames: number[]; // ARTIFACTS seen rolling in from the top (RAMP not full)
  counted: number; // max(queue gain, entries)
}

// The highest level held for at least `w` frames around each frame (a morphological opening):
// shorter peaks are cut down to the level around them; rises that last, and drops, are kept.
export function heldLevels(path: Int8Array, w: number): Int8Array {
  if (w <= 1 || !path.length) return path;
  const T = path.length;
  const ero = new Int8Array(T);
  for (let t = 0; t < T; t++) {
    let m = 127;
    for (let u = t; u < Math.min(T, t + w); u++) m = Math.min(m, path[u]);
    ero[t] = m; // min over [t, t + w)
  }
  const out = new Int8Array(T);
  for (let t = 0; t < T; t++) {
    let m = -128;
    for (let u = Math.max(0, t - w + 1); u <= t; u++) m = Math.max(m, ero[u]);
    out[t] = m; // max over the windows that contain t
  }
  return out;
}

// Split the decoded level into fill periods. A release is a drop of >= releaseDrop below the
// period's peak; the drain that follows (balls rolling out, drainSec) belongs to the release,
// smaller dips are level noise.
export function fillPeriods(path: Int8Array, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): { queueGain: number; queueFrames: number[]; release: number }[] {
  const out: { queueGain: number; queueFrames: number[]; release: number }[] = [];
  if (!path.length) return out;
  let start = path[0], peak = path[0];
  let frames: number[] = [];
  const rise = (t: number, level: number) => {
    for (let l = peak; l < level; l++) frames.push(t);
    peak = level;
  };
  let t = 1;
  while (t < path.length) {
    if (path[t] > peak) rise(t, path[t]);
    if (path[t] <= peak - cfg.releaseDrop) {
      const end = Math.min(path.length, t + Math.max(1, Math.round(cfg.drainSec * cfg.fps)));
      let low = path[t];
      for (let u = t; u < end; u++) low = Math.min(low, path[u]);
      // a dip near the top of the queue is not the GATE opening: that drains it from the bottom
      if (peak - low < cfg.releaseDrain * peak) {
        t++;
        continue;
      }
      out.push({ queueGain: peak - start, queueFrames: frames, release: t });
      start = peak = low;
      frames = [];
      if (path[end - 1] > low) rise(end - 1, path[end - 1]);
      t = end;
      continue;
    }
    t++;
  }
  out.push({ queueGain: peak - start, queueFrames: frames, release: path.length });
  return out;
}

// ARTIFACTS rolling onto the RAMP from the top: tracks of ball evidence above the queue that
// start in the top slots and move down (or reach the queue). A short miss (motion blur) is
// bridged. Returns the frame each entry was first seen.
export function detectEntries(llr: Float64Array, pointsPerSlot: number[], path: Int8Array, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): number[] {
  type Track = { slot: number; start: number; startT: number; lastT: number; min: number };
  const T = path.length;
  let active: Track[] = [];
  const done: Track[] = [];
  const maxStep = cfg.entryMaxSlotsPerSec / cfg.fps + 0.6;
  const maxGap = Math.max(1, Math.round(cfg.entryMaxGapSec * cfg.fps));
  const isBall = (t: number, k: number) => llr[t * SLOTS + k] / Math.max(1, pointsPerSlot[k]) > cfg.entryEvidence;
  for (let t = 0; t < T; t++) {
    const blobs: number[] = [];
    let k = Math.max(0, path[t]);
    while (k < SLOTS) {
      if (isBall(t, k)) {
        let e = k;
        while (e + 1 < SLOTS && isBall(t, e + 1)) e++;
        blobs.push((k + e) / 2);
        k = e + 1;
      } else k++;
    }
    const used = new Set<Track>();
    // highest blobs first, so the newest entry is not grabbed by an older, lower track
    for (const c of blobs.sort((a, b) => b - a)) {
      let best: Track | null = null;
      let bestD = Infinity;
      for (const tr of active) {
        if (used.has(tr)) continue;
        const drop = tr.slot - c;
        if (drop < -0.6 || drop > maxStep * (t - tr.lastT)) continue;
        if (drop < bestD) {
          bestD = drop;
          best = tr;
        }
      }
      if (best) {
        best.slot = c;
        best.lastT = t;
        best.min = Math.min(best.min, c);
        used.add(best);
      } else active.push({ slot: c, start: c, startT: t, lastT: t, min: c });
    }
    const still: Track[] = [];
    for (const tr of active) (t - tr.lastT > maxGap ? done : still).push(tr);
    active = still;
  }
  done.push(...active);
  return done
    .filter((tr) => tr.start >= SLOTS - cfg.entryTopSlots - 0.01 && (tr.start - tr.min >= cfg.entryMinTravel || tr.min <= path[Math.min(T - 1, tr.lastT)] + 0.6))
    .map((tr) => tr.startT)
    .sort((a, b) => a - b);
}

// ---- counting + confidence -------------------------------------------------------------

export interface CountedArtifact {
  frame: number;
  colour: ArtifactColourName | "unknown";
  source: "queue" | "entry";
}

export type Confidence = "high" | "medium" | "low";

export interface RampQuality {
  confidence: Confidence;
  ballRadiusPx: number; // mean projected ARTIFACT radius on the RAMP
  agreement: number; // share of clear slot observations consistent with the decoded queue
  trackedShare: number; // share of frames the camera view was followed
  notes: string[];
}

export interface RampCount {
  total: number;
  score: number; // pathScore of the decoded queue
  artifacts: CountedArtifact[];
  path: Int8Array;
  periods: FillPeriod[];
  quality: RampQuality;
}

function colourAt(colour: Int16Array, frame: number, slot: number, span: number): ArtifactColourName | "unknown" {
  let v = 0;
  const T = colour.length / SLOTS;
  for (let t = frame; t < Math.min(T, frame + span); t++) v += colour[t * SLOTS + slot];
  return v > 0 ? "purple" : v < 0 ? "green" : "unknown";
}

export function assessQuality(llr: Float64Array, path: Int8Array, app: RampAppearance, radiusPx: number[], trackedShare: number): RampQuality {
  let known = 0, agree = 0;
  for (let t = 0; t < path.length; t++)
    for (let k = 0; k < SLOTS; k++) {
      const v = llr[t * SLOTS + k] / Math.max(1, app.pointsPerSlot[k]);
      if (Math.abs(v) <= 0.5) continue;
      known++;
      if (v > 0 === k < path[t]) agree++;
    }
  const agreement = known ? agree / known : 0;
  const seen = radiusPx.filter((r, k) => r > 0 && app.pointsPerSlot[k] > 0);
  const ballRadiusPx = seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0;
  const notes: string[] = [];
  let confidence: Confidence = "high";
  const lower = (c: Confidence) => {
    const order: Confidence[] = ["high", "medium", "low"];
    if (order.indexOf(c) > order.indexOf(confidence)) confidence = c;
  };
  if (ballRadiusPx < 3.5) {
    lower("low");
    notes.push(`The RAMP is very small in this video (an ARTIFACT is ~${(2 * ballRadiusPx).toFixed(0)} px across) — counts are unreliable; use a closer or higher-resolution video.`);
  } else if (ballRadiusPx < 4.5) {
    lower("medium");
    notes.push(`The RAMP is small in this video (an ARTIFACT is ~${(2 * ballRadiusPx).toFixed(0)} px across).`);
  }
  if (agreement < 0.92) {
    lower("low");
    notes.push(`The RAMP view is noisy or often blocked (${(100 * agreement).toFixed(0)}% of clear observations fit the decoded queue).`);
  } else if (agreement < 0.95) {
    lower("medium");
    notes.push(`Parts of the RAMP are sometimes blocked or unclear (${(100 * agreement).toFixed(0)}% of clear observations fit).`);
  }
  if (trackedShare < 0.85) {
    lower("low");
    notes.push(`The camera view was lost for ${(100 * (1 - trackedShare)).toFixed(0)}% of the match.`);
  } else if (trackedShare < 0.95) {
    lower("medium");
    notes.push(`The camera view was lost for ${(100 * (1 - trackedShare)).toFixed(0)}% of the match.`);
  }
  if (app.colourSource !== "staged-artifacts") {
    lower("medium");
    notes.push("The pre-staged ARTIFACTS were not visible at match start, so default ARTIFACT colours were used.");
  }
  if (app.pointsPerSlot.filter((n) => n > 0).length < SLOTS) notes.push(`${SLOTS - app.pointsPerSlot.filter((n) => n > 0).length} RAMP slot(s) are hidden from this camera.`);
  return { confidence, ballRadiusPx, agreement, trackedShare, notes };
}

// Count the CLASSIFIED ARTIFACTS of one RAMP from its per-frame evidence (frame 0 = match start).
export function countRamp(evidence: { llr: Float64Array; colour: Int16Array }, app: RampAppearance, radiusPx: number[], trackedShare = 1, cfg: RampQueueConfig = DEFAULT_RAMP_QUEUE_CONFIG): RampCount {
  const path = decodeQueue(evidence.llr, cfg);
  const entries = detectEntries(evidence.llr, app.pointsPerSlot, path, cfg);
  // A queued ARTIFACT rests until the GATE opens. With balls big enough in the image for the
  // decoded level to be steady, a level held for less than holdSec is a robot, arm or person
  // passing in front of the RAMP (at 720p their coloured parts pass for balls, and a passer-by
  // can light up all 9 slots in one frame), so it is not counted. With smaller balls the decoded
  // level flickers and brief levels still carry real balls, so none are cut. Measured on 21
  // RAMPS (240p-720p): any radius threshold from 5 to 8 px gave the same gain.
  const seen = radiusPx.filter((r) => r > 0);
  const meanRadius = seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0;
  const held = heldLevels(path, meanRadius >= cfg.holdMinRadiusPx ? Math.round(cfg.holdSec * cfg.fps) : 0);
  const raw = fillPeriods(held, cfg);
  const periods: FillPeriod[] = [];
  const artifacts: CountedArtifact[] = [];
  const span = Math.round(0.5 * cfg.fps);
  let from = 0;
  for (const p of raw) {
    // entries while the RAMP is full are OVERFLOW
    const entryFrames = entries.filter((t) => t >= from && t < p.release && path[t] < SLOTS);
    const counted = Math.max(p.queueGain, entryFrames.length);
    periods.push({ from, release: p.release, queueGain: p.queueGain, queueFrames: p.queueFrames, entryFrames, counted });
    if (p.queueGain >= entryFrames.length) {
      // colour of each new ball: the slot it filled, over the next half second
      let level = p.queueFrames.length ? held[p.queueFrames[0]] - p.queueFrames.filter((f) => f === p.queueFrames[0]).length : 0;
      for (const f of p.queueFrames) {
        artifacts.push({ frame: f, colour: colourAt(evidence.colour, f, Math.max(0, Math.min(SLOTS - 1, level)), span), source: "queue" });
        level++;
      }
    } else for (const f of entryFrames) artifacts.push({ frame: f, colour: "unknown", source: "entry" });
    from = p.release;
  }
  return { total: artifacts.length, score: pathScore(evidence.llr, path, cfg), artifacts, path, periods, quality: assessQuality(evidence.llr, path, app, radiusPx, trackedShare) };
}
