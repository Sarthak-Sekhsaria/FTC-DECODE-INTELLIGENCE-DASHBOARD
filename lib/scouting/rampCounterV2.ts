// The v2 RAMP counter (DOM-free; the networks are passed in, see rampModels.ts).
//
// Every frame, each RAMP's lane is cut into a strip (rampStrip.ts) and the strip detector says
// where along the lane ARTIFACTS are (36 bins). Those responses are kept on a 15 fps grid per
// RAMP, with whether the RAMP was seen in that frame (followed by the camera tracker). The entry
// counter reads the grid and says how many ARTIFACTS came onto the RAMP at each frame. Every CLASSIFIED ARTIFACT comes onto the
// RAMP at the top and rolls down it: onto the queue, or straight out through an open GATE. So
// counting what comes on counts both, where the v1 queue counter only saw the queue grow.
//
// Detection runs in batches off the frame loop (flush), and the entry counter is re-run only
// over the frames whose responses changed, plus its reach either side.

import { LANE_BINS, type RampModels } from "./rampModels.ts";

export const V2_FPS = 15;
// The smallest RAMP the count can be relied on for: ARTIFACTS this many px apart along the RAMP
// (its slot pitch in the frames the counter works on). Every RAMP below it (240p videos, 4-5 px)
// was far off, either way: 7 / 33 against 4 / 22, 58 against 5, 64 / 35 against 85 / 47. The
// page does not score such a RAMP (as one out of the picture) and shows the estimate as unreliable.
export const MIN_RELIABLE_ARTIFACT_PX = 6;
// how far the entry counter looks either side of a frame (frames), and the context it is given
const REACH = 18;
const CONTEXT = 40;
const BATCH = 32;

export type Alliance = "red" | "blue";

interface Timeline {
  q: Float32Array; // frames x LANE_BINS
  valid: Uint8Array; // frames: the RAMP was seen and its strip detected
  lam: Float32Array; // frames: ARTIFACTS that came on at that frame
  frames: number; // grid length in use
  dirty: [number, number] | null; // frames whose responses changed since the last entry run
}

export interface V2Event {
  alliance: Alliance;
  t: number; // video seconds the ARTIFACT came onto the RAMP
}

function grow(tl: Timeline, n: number) {
  if (n <= tl.valid.length) return;
  const cap = Math.max(n, Math.ceil(tl.valid.length * 1.5), 1024);
  const q = new Float32Array(cap * LANE_BINS);
  q.set(tl.q);
  const valid = new Uint8Array(cap);
  valid.set(tl.valid);
  const lam = new Float32Array(cap);
  lam.set(tl.lam);
  tl.q = q;
  tl.valid = valid;
  tl.lam = lam;
}

export class RampCounterV2 {
  private timelines = new Map<Alliance, Timeline>();
  private pending: { alliance: Alliance; frame: number; strip: Uint8Array }[] = [];
  private busy: Promise<void> | null = null;

  // useRamp: frames whose strip the detector does not take for a RAMP count as unseen. Off: on
  // views the detector was not trained on it also turned real RAMPS away (Israel playoff blue,
  // 67 CLASSIFIED, 2% of frames taken for a RAMP), so a followed frame is a seen frame.
  constructor(private models: RampModels, private useRamp = false) {}

  reset() {
    this.timelines.clear();
    this.pending = [];
  }

  private timeline(a: Alliance): Timeline {
    let tl = this.timelines.get(a);
    if (!tl) {
      tl = { q: new Float32Array(0), valid: new Uint8Array(0), lam: new Float32Array(0), frames: 0, dirty: null };
      this.timelines.set(a, tl);
    }
    return tl;
  }

  // One RAMP in one frame: its strip, or null when the RAMP was not followed in it.
  add(alliance: Alliance, t: number, strip: Uint8Array | null) {
    const frame = Math.round(t * V2_FPS);
    if (frame < 0) return;
    const tl = this.timeline(alliance);
    grow(tl, frame + 1);
    tl.frames = Math.max(tl.frames, frame + 1);
    if (strip) this.pending.push({ alliance, frame, strip });
    else {
      tl.valid[frame] = 0;
      tl.q.fill(0, frame * LANE_BINS, (frame + 1) * LANE_BINS);
      this.markDirty(tl, frame);
    }
  }

  private markDirty(tl: Timeline, frame: number) {
    tl.dirty = tl.dirty ? [Math.min(tl.dirty[0], frame), Math.max(tl.dirty[1], frame)] : [frame, frame];
  }

  get pendingStrips(): number {
    return this.pending.length;
  }

  // Detect the strips waiting, then (unless `recount` is false) re-count where the responses
  // changed. Calls made while one is running wait for it (one at a time). Live counting detects
  // every few frames and re-counts about once a second.
  flush(recount = true): Promise<void> {
    const run = async () => {
      // only the strips waiting now: live, new ones keep arriving while these are detected, and
      // they are the next flush's (else this one would never get to the re-count)
      let left = this.pending.length;
      while (left > 0) {
        const batch = this.pending.splice(0, Math.min(BATCH, left));
        left -= batch.length;
        const d = await this.models.detect(batch.map((b) => b.strip));
        batch.forEach((b, i) => {
          const tl = this.timeline(b.alliance);
          // a strip that is not a RAMP (the lane beside it, something in front of it) is not seen
          const seen = !this.useRamp || d.ramp[i] > 0.5;
          if (seen) tl.q.set(d.q.subarray(i * LANE_BINS, (i + 1) * LANE_BINS), b.frame * LANE_BINS);
          else tl.q.fill(0, b.frame * LANE_BINS, (b.frame + 1) * LANE_BINS);
          tl.valid[b.frame] = seen ? 1 : 0;
          this.markDirty(tl, b.frame);
        });
      }
      if (recount) for (const tl of this.timelines.values()) await this.recount(tl);
    };
    const prev = this.busy ?? Promise.resolve();
    const next = prev.then(run, run);
    const done: Promise<void> = next.finally(() => {
      if (this.busy === done) this.busy = null;
    });
    this.busy = done;
    return next;
  }

  private async recount(tl: Timeline) {
    if (!tl.dirty) return;
    const [d0, d1] = tl.dirty;
    tl.dirty = null;
    const o0 = Math.max(0, d0 - REACH), o1 = Math.min(tl.frames - 1, d1 + REACH); // frames whose count changes
    const i0 = Math.max(0, o0 - CONTEXT), i1 = Math.min(tl.frames - 1, o1 + CONTEXT); // what the counter is shown
    const T = i1 - i0 + 1;
    const valid = new Float32Array(T);
    for (let k = 0; k < T; k++) valid[k] = tl.valid[i0 + k];
    const lam = await this.models.entries(tl.q.subarray(i0 * LANE_BINS, (i1 + 1) * LANE_BINS), valid, T);
    tl.lam.set(lam.subarray(o0 - i0, o1 - i0 + 1), o0);
  }

  // ARTIFACTS that came onto the RAMP in [start, end] (video seconds): the expected number.
  count(alliance: Alliance, start: number, end: number): number {
    const tl = this.timelines.get(alliance);
    if (!tl) return 0;
    let s = 0;
    const a = Math.max(0, Math.ceil(start * V2_FPS - 1e-6)), b = Math.min(tl.frames - 1, Math.floor(end * V2_FPS + 1e-6));
    for (let f = a; f <= b; f++) s += tl.lam[f];
    return s;
  }

  // One event per counted ARTIFACT in [start, end]: when the running count passes k - 0.5, so the
  // number of events is the rounded count.
  events(alliance: Alliance, start: number, end: number): V2Event[] {
    const tl = this.timelines.get(alliance);
    if (!tl) return [];
    const out: V2Event[] = [];
    let s = 0;
    const a = Math.max(0, Math.ceil(start * V2_FPS - 1e-6)), b = Math.min(tl.frames - 1, Math.floor(end * V2_FPS + 1e-6));
    for (let f = a; f <= b; f++) {
      s += tl.lam[f];
      while (s >= out.length + 0.5) out.push({ alliance, t: f / V2_FPS });
    }
    return out;
  }

  // Share of the frames in [start, end] where the RAMP was seen (and detected).
  seenShare(alliance: Alliance, start: number, end: number): number {
    const tl = this.timelines.get(alliance);
    if (!tl) return 0;
    const a = Math.max(0, Math.ceil(start * V2_FPS)), b = Math.min(tl.frames - 1, Math.floor(end * V2_FPS));
    if (b < a) return 0;
    let n = 0;
    for (let f = a; f <= b; f++) n += tl.valid[f];
    return n / (b - a + 1);
  }
}
