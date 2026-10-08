"use client";

// Debug view of the RAMP queue counter: per RAMP, what the counter measured about THIS video
// (all automatic — nothing to tune by hand) and a slot-by-time picture of the evidence with
// the decoded queue level, so a wrong count can be traced to the moment it went wrong.

import { useEffect, useRef } from "react";
import { labToRgb, SLOTS } from "@/lib/scouting/rampState";
import type { RampAutoParams, RampResult } from "@/lib/scouting/rampScorer";

function fmt(t: number | null): string {
  if (t == null || !Number.isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

const CONF_COLOUR = { high: "#4ade80", medium: "#fbbf24", low: "#f87171" } as const;

// Slots (0 = GATE end, bottom) against time; red = looks like an ARTIFACT, blue = looks
// empty, dark = unclear/blocked. White line: decoded queue level. Yellow ticks: ARTIFACTS seen
// rolling in while the GATE was open.
function Kymograph({ result }: { result: RampResult }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const T = result.count.path.length;
    const W = Math.max(1, Math.min(720, T));
    const RH = 8;
    c.width = W;
    c.height = SLOTS * RH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(W, SLOTS * RH);
    const per = T / W;
    for (let x = 0; x < W; x++) {
      const t0 = Math.floor(x * per), t1 = Math.max(t0 + 1, Math.floor((x + 1) * per));
      for (let k = 0; k < SLOTS; k++) {
        let v = 0;
        for (let t = t0; t < t1; t++) v += result.llr[t * SLOTS + k] / Math.max(1, result.pointsPerSlot[k]);
        v /= t1 - t0;
        const a = Math.min(1, Math.abs(v) / 2);
        const col = v > 0 ? [255 * a, 50 * a, 50 * a] : [40 * a, 90 * a, 255 * a];
        for (let y = 0; y < RH; y++) img.data.set([...col.map(Math.round), 255], (((SLOTS - 1 - k) * RH + y) * W + x) * 4);
      }
      let lv = 0;
      for (let t = t0; t < t1; t++) lv = Math.max(lv, result.count.path[t]);
      const y = Math.min(SLOTS * RH - 1, SLOTS * RH - lv * RH);
      img.data.set([255, 255, 255, 255], (y * W + x) * 4);
    }
    for (const a of result.count.artifacts)
      if (a.source === "entry") {
        const x = Math.min(W - 1, Math.floor(a.frame / per));
        for (let y = 0; y < 5; y++) img.data.set([255, 230, 0, 255], (y * W + x) * 4);
      }
    ctx.putImageData(img, 0, 0);
  }, [result]);
  return <canvas ref={ref} className="h-24 w-full rounded border border-white/10 bg-black" style={{ imageRendering: "pixelated" }} />;
}

function Swatch({ lab, label }: { lab: [number, number, number]; label: string }) {
  const [r, g, b] = labToRgb(lab);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-3 w-3 rounded-full border border-white/30" style={{ background: `rgb(${r},${g},${b})` }} />
      {label}
    </span>
  );
}

function RampCard({ auto, result }: { auto: RampAutoParams; result: RampResult | undefined }) {
  const colour = auto.alliance === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  const q = result?.count.quality;
  const entries = result ? result.count.artifacts.filter((a) => a.source === "entry").length : 0;
  const w = auto.slotWeight.filter((x) => x > 0);
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: colour }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-black uppercase" style={{ color: colour }}>
          {auto.alliance} ramp
        </span>
        {q && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ color: "#04140c", background: CONF_COLOUR[q.confidence] }}>
            {q.confidence} confidence
          </span>
        )}
      </div>
      {result ? <Kymograph result={result} /> : <p className="text-[11px] text-white/40">Calibrating — waiting for the start of the match…</p>}
      <dl className="mt-2 grid grid-cols-1 gap-y-0.5 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Classified counted</dt>
          <dd className="tabular-nums font-bold" style={{ color: colour }}>
            {result ? `${result.count.total} (${result.count.total - entries} queued · ${entries} rolled through)` : "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Clump size (auto)</dt>
          <dd className="tabular-nums text-white/80">
            1 artifact ≈ {auto.artifactAreaPx.toFixed(0)} px² (Ø {(2 * auto.ballRadiusPx).toFixed(1)} px) · slot pitch {auto.slotPitchPx.toFixed(1)} px
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Sensitivity (auto)</dt>
          <dd className="tabular-nums text-white/80">
            evidence weight {w.length ? `${Math.min(...w).toFixed(2)}–${Math.max(...w).toFixed(2)}×` : "—"} · colour tol ±{auto.purpleTolerance.toFixed(0)}/±{auto.greenTolerance.toFixed(0)} · RAMP noise ±{auto.emptyNoise.toFixed(1)}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Artifact colours</dt>
          <dd className="flex items-center gap-2 text-white/80">
            <Swatch lab={auto.purple} label="purple" />
            <Swatch lab={auto.green} label="green" />
            <span className="text-white/40">
              {auto.colourSource === "staged-artifacts" ? `from ${auto.stagedSamples.purple + auto.stagedSamples.green} staged @ ${fmt(auto.calibrationTime)}` : "defaults"}
            </span>
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Visible slots · camera</dt>
          <dd className="tabular-nums text-white/80">
            {auto.visibleSlots}/{SLOTS} · followed {(100 * auto.trackedShare).toFixed(0)}%{auto.fallbackShare > 0.005 ? ` (${(100 * auto.fallbackShare).toFixed(0)}% by the whole view)` : ""} · re-anchored {auto.reanchors}×
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Lane fit (auto)</dt>
          <dd className="tabular-nums text-white/80">
            {auto.laneShift.across === 0 && auto.laneShift.along === 0
              ? "as placed"
              : [
                  auto.laneShift.across ? `${auto.laneShift.across > 0 ? "+" : ""}${auto.laneShift.across} ball across` : "",
                  auto.laneShift.along ? `${auto.laneShift.along > 0 ? "+" : ""}${auto.laneShift.along} ball along` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-white/40">Counting from</dt>
          <dd className="tabular-nums text-white/80">{fmt(auto.countStart)}</dd>
        </div>
      </dl>
      {q && q.notes.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-200/80">
          {q.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RampDebug({ auto, results }: { auto: RampAutoParams[]; results: RampResult[] }) {
  if (!auto.length) return <p className="text-[11px] text-white/40">The RAMP counter has not run yet — start live detection or the offline analysis.</p>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {auto.map((a) => (
        <RampCard key={a.alliance} auto={a} result={results.find((r) => r.alliance === a.alliance)} />
      ))}
    </div>
  );
}
