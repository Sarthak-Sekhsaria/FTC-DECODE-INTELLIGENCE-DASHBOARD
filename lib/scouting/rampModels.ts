// The v2 RAMP counter's two small networks, run in the browser with ONNX Runtime Web (WASM):
// - the strip detector (ml/strip/detector.py): one RAMP strip (rampStrip.ts) -> the probability
//   that an ARTIFACT is centred in each of 36 bins along the lane;
// - the entry counter (ml/strip/entry_model.py): those responses over time -> how many ARTIFACTS
//   came onto the RAMP at each frame.
// Browser-only (the runtime is loaded on first use); rampCounterV2.ts holds the logic around them.

import type * as Ort from "onnxruntime-web/wasm";
import { STRIP_H, STRIP_W, stripsToTensor } from "./rampStrip.ts";

export const DETECTOR_URL = "/models/ramp-detector.onnx";
export const ENTRY_URL = "/models/ramp-entries.onnx";
export const LANE_BINS = 36;

let ortP: Promise<typeof Ort> | null = null;
function ort(): Promise<typeof Ort> {
  ortP ??= import("onnxruntime-web/wasm").then((m) => {
    const o = ((m as unknown as { default?: typeof Ort }).default ?? m) as typeof Ort;
    o.env.wasm.wasmPaths = "/api/ort/";
    // threads need a cross-origin isolated page; one thread is enough for these models
    o.env.wasm.numThreads = 1;
    // run in a worker, off the thread that decodes and counts the frames
    o.env.wasm.proxy = true;
    return o;
  });
  return ortP;
}

export interface Detections {
  q: Float32Array; // n x 36: probability an ARTIFACT is centred in each bin along the lane
  ramp: Float32Array; // n: probability the strip shows a RAMP lane at all
}

export interface RampModels {
  detect(strips: Uint8Array[]): Promise<Detections>;
  // q: T x 36 probabilities, valid: T (1 seen / 0 not) -> T expected entries per frame
  entries(q: Float32Array, valid: Float32Array, T: number): Promise<Float32Array>;
}

let modelsP: Promise<RampModels> | null = null;

export function loadRampModels(): Promise<RampModels> {
  modelsP ??= (async () => {
    const o = await ort();
    const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const [det, ent] = await Promise.all([o.InferenceSession.create(DETECTOR_URL, opts), o.InferenceSession.create(ENTRY_URL, opts)]);
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    return {
      async detect(strips: Uint8Array[]) {
        if (!strips.length) return { q: new Float32Array(0), ramp: new Float32Array(0) };
        const x = new o.Tensor("float32", stripsToTensor(strips), [strips.length, 3, STRIP_H, STRIP_W]);
        const out = await det.run({ strip: x });
        const q = Float32Array.from(out.bins.data as Float32Array, sigmoid);
        // a detector without the RAMP output takes every followed strip for a RAMP
        const ramp = out.ramp ? Float32Array.from(out.ramp.data as Float32Array, sigmoid) : new Float32Array(strips.length).fill(1);
        x.dispose();
        out.bins.dispose();
        out.ramp?.dispose();
        return { q, ramp };
      },
      async entries(q: Float32Array, valid: Float32Array, T: number) {
        const data = new Float32Array(2 * T * LANE_BINS);
        data.set(q.subarray(0, T * LANE_BINS), 0);
        for (let t = 0; t < T; t++) data.fill(valid[t], T * LANE_BINS + t * LANE_BINS, T * LANE_BINS + (t + 1) * LANE_BINS);
        const x = new o.Tensor("float32", data, [1, 2, T, LANE_BINS]);
        const out = await ent.run({ q: x });
        const lam = Float32Array.from(out.entries.data as Float32Array);
        x.dispose();
        out.entries.dispose();
        return lam;
      },
    };
  })();
  modelsP.catch(() => (modelsP = null));
  return modelsP;
}
