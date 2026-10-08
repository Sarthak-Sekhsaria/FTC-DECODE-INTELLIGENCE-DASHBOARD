"use client";

// Status + controls for automatic RAMP ROI placement. Shows the five UI states:
//  1. "Finding field…" while placement runs
//  2. success: method + confidence, Confirm
//  3. low confidence: warning colour + suggestion to check/nudge
//  4. A and B failed: straight to the 4-tap flow
//  5. confirmed: counting can start

import { METHOD_LABEL, type MethodId } from "@/lib/scouting/placement/placer";

export type PlacementStage = "idle" | "finding" | "proposed" | "tapping" | "confirmed" | "unplaced";

export interface PlacementSummary {
  method: MethodId;
  assistedBy?: "B";
  reprojError: number | null;
  fovDeg: number | null;
  fovRefined: boolean;
  fovWellConstrained: boolean;
  framesUsed: number;
  framesTried: number;
  confidence: "high" | "low";
  notes: string[];
  alliances: ("red" | "blue")[];
  nudged: boolean;
  restored: boolean;
}

export default function RoiPlacementPanel({
  stage,
  progress,
  summary,
  failure,
  countingActive,
  debugOn,
  onConfirm,
  onRefind,
  onStartTaps,
  onToggleDebug,
}: {
  stage: PlacementStage;
  progress: { attempts: number; usable: number; target: number } | null;
  summary: PlacementSummary | null;
  failure: string | null;
  countingActive: boolean;
  debugOn: boolean;
  onConfirm: () => void;
  onRefind: () => void;
  onStartTaps: () => void;
  onToggleDebug: () => void;
}) {
  const low = summary?.confidence === "low";
  const accent = stage === "confirmed" ? "var(--scout-accent)" : low ? "#f59e0b" : stage === "proposed" ? "#38bdf8" : "var(--scout-border)";
  const methodText = summary
    ? summary.nudged
      ? `${METHOD_LABEL.D} (nudged from ${summary.method})`
      : `${summary.method} · ${METHOD_LABEL[summary.method]}${summary.assistedBy ? " + floor grid" : ""}`
    : null;

  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: accent, background: "var(--scout-panel)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-white/45">Ramp ROI placement</h3>
          <p className="mt-1 text-sm font-semibold" style={{ color: accent === "var(--scout-border)" ? "#fff" : accent }}>
            {stage === "idle" && "Waiting for video"}
            {stage === "finding" && (
              <span className="inline-flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
                Finding field…{progress ? ` ${progress.usable}/${progress.target} usable frames (${progress.attempts} checked)` : ""}
              </span>
            )}
            {stage === "proposed" && (low ? "Placed with LOW confidence — check the ramp boxes" : "Ramp ROI placed — confirm to start counting")}
            {stage === "tapping" && "Automatic placement failed — tap the 4 field corners on the video"}
            {stage === "confirmed" && (summary?.restored ? "ROI restored for this video — counting enabled" : "ROI confirmed — counting enabled")}
            {stage === "unplaced" && "No ROI yet — tap the field corners or drag the boxes"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {stage === "proposed" && (
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide text-black"
              style={{ background: low ? "#f59e0b" : "var(--scout-accent)" }}
            >
              Confirm ROI
            </button>
          )}
          {stage === "unplaced" && (
            <button type="button" onClick={onConfirm} className="chip" title="Use the boxes as they are now (manual placement)">
              Use current boxes
            </button>
          )}
          <button type="button" onClick={onRefind} disabled={countingActive || stage === "finding"} className="chip disabled:opacity-40" title={countingActive ? "Stop counting before re-running placement" : undefined}>
            Re-find field
          </button>
          <button type="button" onClick={onStartTaps} disabled={countingActive || stage === "finding" || stage === "tapping"} className="chip disabled:opacity-40">
            Tap corners
          </button>
          <button type="button" onClick={onToggleDebug} className="chip" style={debugOn ? { borderColor: "var(--scout-accent)", color: "var(--scout-accent)" } : undefined}>
            Field debug: {debugOn ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      {summary && stage !== "finding" && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-white/55">
          <span>
            Method <span className="font-semibold text-white/85">{methodText}</span>
          </span>
          <span>
            Reprojection error{" "}
            <span className="font-semibold tabular-nums" style={{ color: low ? "#f59e0b" : "#fff" }}>
              {summary.reprojError == null ? "—" : `${summary.reprojError.toFixed(2)} px`}
            </span>
          </span>
          <span>
            FOV <span className="tabular-nums text-white/85" title={summary.fovRefined && !summary.fovWellConstrained ? "All reference points are on the floor, so FOV and camera height trade off; the ramp ROI is still reliable." : undefined}>{summary.fovDeg == null ? "—" : `${summary.fovDeg.toFixed(1)}°${!summary.fovRefined ? " (assumed)" : summary.fovWellConstrained ? " (fitted)" : " (fitted, weakly constrained)"}`}</span>
          </span>
          {summary.framesTried > 1 && (
            <span>
              Frames <span className="tabular-nums text-white/85">{summary.framesUsed}/{summary.framesTried}</span> (median-locked)
            </span>
          )}
          <span>
            Ramps{" "}
            {summary.alliances.map((a) => (
              <span key={a} className="ml-1 font-bold uppercase" style={{ color: a === "red" ? "var(--scout-red)" : "var(--scout-blue)" }}>
                {a}
              </span>
            ))}
          </span>
        </div>
      )}

      {low && stage === "proposed" && summary && (
        <ul className="mt-2 list-disc pl-5 text-[11px] text-amber-300/80">
          {summary.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          <li>Drag a box (or its corner) to nudge it onto the ramp, then Confirm.</li>
        </ul>
      )}
      {failure && (stage === "tapping" || stage === "unplaced") && <p className="mt-2 text-[11px] text-white/45">Why: {failure}</p>}
      {stage !== "confirmed" && stage !== "idle" && (
        <p className="mt-2 text-[11px] text-white/35">Counting (live or offline) unlocks once the ROI is confirmed.</p>
      )}
    </div>
  );
}
