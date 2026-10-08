"use client";

// What the RAMP counter measured about THIS video, shown to the user (not only in Debug):
// everything is automatic, so this is where the user can see that it measured sensible values
// and why a count may be less certain.
//   - ARTIFACT size on each RAMP (the "clump size"): from the camera pose, per slot.
//   - Sensitivity: how much each slot's evidence counts, from how many real pixels its ball
//     covers in this view (far, small or partly hidden slots count less).
//   - ARTIFACT colours and how far a pixel may stray from them: from the pre-staged ARTIFACTS.
//   - The empty RAMP's look and noise: from the RAMP just after calibration.
//   - The self-check: the ARTIFACTS queued during the match, measured in the picture against
//     the automatic size, lane and colours (artifactCheck.ts).

import { labToRgb, SLOTS } from "@/lib/scouting/rampState";
import type { RampAutoParams, RampResult } from "@/lib/scouting/rampScorer";
import { checkVerdict } from "@/lib/scouting/artifactCheck";

function fmt(t: number | null): string {
  if (t == null || !Number.isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

const CONF_COLOUR = { high: "#4ade80", medium: "#fbbf24", low: "#f87171" } as const;

function Swatch({ lab }: { lab: [number, number, number] }) {
  const [r, g, b] = labToRgb(lab);
  return <span className="inline-block h-3 w-3 rounded-full border border-white/30 align-middle" style={{ background: `rgb(${r},${g},${b})` }} />;
}

// Per-slot evidence weight, slot 1 (GATE end) to slot 9; a missing bar is a slot the camera cannot see.
function SensitivityBars({ weights, colour }: { weights: number[]; colour: string }) {
  return (
    <span className="inline-flex h-5 items-end gap-[2px] align-middle" aria-label={`per-slot sensitivity ${weights.map((w) => w.toFixed(2)).join(", ")}`}>
      {Array.from({ length: SLOTS }, (_, k) => {
        const w = weights[k] ?? 0;
        return <span key={k} title={`slot ${k + 1}: ${w > 0 ? `${w.toFixed(2)}×` : "not in view"}`} className="inline-block w-[5px] rounded-sm" style={{ height: `${Math.max(2, Math.round(20 * w))}px`, background: w > 0 ? colour : "rgba(255,255,255,0.15)" }} />;
      })}
    </span>
  );
}

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-0.5 py-1">
      <dt className="text-white/45">{label}</dt>
      <dd className="text-white/85">
        {children}
        {note && <span className="block text-[10px] text-white/35">{note}</span>}
      </dd>
    </div>
  );
}

function RampCard({ auto, result }: { auto: RampAutoParams; result: RampResult | undefined }) {
  const colour = auto.alliance === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  const q = result?.count.quality;
  const calibrated = auto.calibrationTime != null;
  const weights = auto.slotWeight.length ? auto.slotWeight : [];
  const seen = weights.filter((w) => w > 0);
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: colour }}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-black uppercase" style={{ color: colour }}>
          {auto.alliance} ramp
        </span>
        {q && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ color: "#04140c", background: CONF_COLOUR[q.confidence] }}>
            {q.confidence} confidence
          </span>
        )}
      </div>
      <p className="mb-1 text-[11px] text-white/55">
        {!calibrated
          ? "Waiting for the pre-staged ARTIFACTS at the start of the match…"
          : auto.colourSource === "staged-artifacts"
            ? `Calibrated at ${fmt(auto.calibrationTime)} on ${auto.stagedSamples.purple + auto.stagedSamples.green} of the 18 pre-staged ARTIFACTS (${auto.stagedSamples.purple} purple, ${auto.stagedSamples.green} green).`
            : `The pre-staged ARTIFACTS were not visible, so standard ARTIFACT colours are used (less reliable).`}
      </p>
      <dl className="text-[11px]">
        <Row label="ARTIFACT size here" note="clump size: how big one ARTIFACT looks on this RAMP, from the camera pose">
          Ø <span className="tabular-nums font-semibold">{(2 * auto.ballRadiusPx).toFixed(1)} px</span> · 1 ARTIFACT ≈ <span className="tabular-nums">{auto.artifactAreaPx.toFixed(0)} px²</span> · slot pitch <span className="tabular-nums">{auto.slotPitchPx.toFixed(1)} px</span>
        </Row>
        <Row label="Sensitivity per slot" note="slot 1 (GATE) → 9: a slot whose ARTIFACT covers fewer real pixels (far, small or partly hidden) counts for less">
          {seen.length ? (
            <>
              <SensitivityBars weights={weights} colour={colour} /> <span className="tabular-nums">{Math.min(...seen).toFixed(2)}–{Math.max(...seen).toFixed(2)}×</span>
            </>
          ) : (
            <span className="text-white/45">after calibration</span>
          )}
        </Row>
        <Row label="ARTIFACT colours" note="measured on the pre-staged ARTIFACTS; ± is how far a pixel may differ (CIELAB)">
          {calibrated ? (
            <span className="inline-flex flex-wrap items-center gap-x-3">
              <span>
                <Swatch lab={auto.purple} /> purple ±<span className="tabular-nums">{auto.purpleTolerance.toFixed(0)}</span>
              </span>
              <span>
                <Swatch lab={auto.green} /> green ±<span className="tabular-nums">{auto.greenTolerance.toFixed(0)}</span>
              </span>
            </span>
          ) : (
            <span className="text-white/45">after calibration</span>
          )}
        </Row>
        <Row label="Empty RAMP noise" note="how much the empty RAMP's colour varies (lighting, compression, camera shake)">
          {calibrated && auto.emptyNoise > 0 ? <span className="tabular-nums">±{auto.emptyNoise.toFixed(1)}</span> : <span className="text-white/45">after calibration</span>}
        </Row>
        <Row label="Checked on the ARTIFACTS" note="the ARTIFACTS queued in this RAMP, measured in the picture: their width against the automatic size, their distance from the lane, their colour against the calibrated colour">
          {auto.check ? (
            (() => {
              const v = checkVerdict(auto.check);
              return (
                <>
                  <span className="font-semibold" style={{ color: v.ok ? "#4ade80" : "#fbbf24" }}>
                    {v.ok ? "✓ fits" : "⚠ check"}
                  </span>{" "}
                  · <span className="tabular-nums">{auto.check.measured}</span> measured · size <span className="tabular-nums">×{auto.check.size.toFixed(2)}</span> · lane{" "}
                  <span className="tabular-nums">{Math.abs(auto.check.offset).toFixed(2)}</span> radii off · colour <span className="tabular-nums">{auto.check.colour.toFixed(1)}</span> tolerances
                  {v.issues.map((i) => (
                    <span key={i} className="block text-amber-200/80">
                      {i}
                    </span>
                  ))}
                </>
              );
            })()
          ) : (
            <span className="text-white/45">once ARTIFACTS are queued</span>
          )}
        </Row>
        {auto.laneAlignment && Math.abs(auto.laneAlignment.offset) > 0.75 && (
          <Row label="Lane aligned" note="the ARTIFACTS queued off the lane the field model placed (a GOAL and its RAMP can stand inches from their nominal place): counted where they are">
            moved <span className="tabular-nums">{Math.abs(auto.laneAlignment.offset).toFixed(1)}</span> ball radii to where{" "}
            <span className="tabular-nums">{auto.laneAlignment.observations}</span> measured ARTIFACTS queued
          </Row>
        )}
        <Row label="Slots in view · camera">
          <span className="tabular-nums">
            {auto.visibleSlots}/{SLOTS}
          </span>{" "}
          · followed <span className="tabular-nums">{(100 * auto.trackedShare).toFixed(0)}%</span> of frames
        </Row>
      </dl>
      {q && q.notes.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-[11px] text-amber-200/80">
          {q.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RampCalibration({ auto, results }: { auto: RampAutoParams[]; results: RampResult[] }) {
  if (!auto.length)
    return (
      <p className="text-[11px] text-white/45">
        Starts with live detection or the offline analysis: the counter finds the 18 pre-staged ARTIFACTS at the start of the match and measures
        everything below from this video. Nothing needs tuning by hand.
      </p>
    );
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {auto.map((a) => (
        <RampCard key={a.alliance} auto={a} result={results.find((r) => r.alliance === a.alliance)} />
      ))}
    </div>
  );
}
