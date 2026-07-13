"use client";

import { type RefObject } from "react";
import type { ScoringDirection } from "@/lib/scouting/cvDetector";
import type { AllianceColor } from "@/lib/scouting/autoTypes";

export interface GateDiag {
  detector: "inactive" | "running" | "paused";
  candidates: number; // artifact-shaped objects found this frame
  crossingThisFrame: number;
  totalCrossings: number; // accepted crossings so far
  present: boolean;
  lastEvent: string | null;
  flashWall: number; // Date.now() of the last COUNTED, drives the flash banner
}

export interface Diag {
  framesAnalyzed: number;
  lastProcessedTime: number;
  status: string;
  red: GateDiag;
  blue: GateDiag;
  log: string[];
}

function GateCard({
  color,
  label,
  g,
  framesAnalyzed,
  artifactCount,
  artifactScore,
  cropRef,
  maskRef,
  dir,
  onReverse,
}: {
  color: string;
  label: string;
  g: GateDiag;
  framesAnalyzed: number;
  artifactCount: number;
  artifactScore: number;
  cropRef: RefObject<HTMLCanvasElement | null>;
  maskRef: RefObject<HTMLCanvasElement | null>;
  dir: ScoringDirection;
  onReverse: () => void;
}) {
  const running = g.detector === "running";
  const flashing = Date.now() - g.flashWall < 700;
  return (
    <div className="relative rounded-xl border p-3" style={{ borderColor: color }}>
      {flashing && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl text-sm font-black uppercase"
          style={{ background: "rgba(34,255,160,0.18)", color: "var(--scout-accent)" }}
        >
          {label.split(" ")[0]} artifact counted +3
        </div>
      )}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-black uppercase" style={{ color }}>
          {label}
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px] font-bold"
          style={{ color: running ? "var(--scout-accent)" : "#6b7280" }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: running ? "var(--scout-accent)" : "#6b7280" }} />
          {running ? "RUNNING" : g.detector === "paused" ? "PAUSED" : "INACTIVE"}
        </span>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <p className="mb-0.5 text-[9px] uppercase tracking-wide text-white/35">Crop + candidates</p>
          <canvas ref={cropRef} className="h-20 w-full rounded border border-white/10 bg-black object-contain" />
        </div>
        <div>
          <p className="mb-0.5 text-[9px] uppercase tracking-wide text-white/35">Colour mask</p>
          <canvas ref={maskRef} className="h-20 w-full rounded border border-white/10 bg-black object-contain" />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <div className="flex justify-between"><dt className="text-white/40">Frames processed</dt><dd className="tabular-nums text-white/80">{framesAnalyzed}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Detector running</dt><dd style={{ color: running ? "#4ade80" : "rgba(255,255,255,0.5)" }}>{running ? "Yes" : "No"}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Objects found</dt><dd className="tabular-nums text-white/80">{g.candidates}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Crossing this frame</dt><dd className="tabular-nums text-white/80">{g.crossingThisFrame}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Total crossings</dt><dd className="tabular-nums text-white/80">{g.totalCrossings}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Artifact count</dt><dd className="tabular-nums text-white/80">{artifactCount}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Artifact score</dt><dd className="tabular-nums font-bold" style={{ color }}>{artifactScore}</dd></div>
        <div className="flex justify-between"><dt className="text-white/40">Last event</dt><dd className="text-white/70">{g.lastEvent ?? "None"}</dd></div>
      </dl>

      <div className="mt-2 flex items-center justify-end">
        <button type="button" onClick={onReverse} className="chip">
          Dir: {dir === "downward" ? "↓ down" : "↑ up"} · reverse
        </button>
      </div>
    </div>
  );
}

export default function DebugPanel({
  diag,
  redArtifacts,
  blueArtifacts,
  redArtifactPoints,
  blueArtifactPoints,
  redCropRef,
  blueCropRef,
  redMaskRef,
  blueMaskRef,
  redDir,
  blueDir,
  redSingleArea,
  blueSingleArea,
  onRedSingleChange,
  onBlueSingleChange,
  onReverseRed,
  onReverseBlue,
  onTest,
  onResetTest,
  onAnalyzeFrame,
  onClearDetections,
  onExport,
}: {
  diag: Diag;
  redArtifacts: number;
  blueArtifacts: number;
  redArtifactPoints: number;
  blueArtifactPoints: number;
  redCropRef: RefObject<HTMLCanvasElement | null>;
  blueCropRef: RefObject<HTMLCanvasElement | null>;
  redMaskRef: RefObject<HTMLCanvasElement | null>;
  blueMaskRef: RefObject<HTMLCanvasElement | null>;
  redDir: ScoringDirection;
  blueDir: ScoringDirection;
  redSingleArea: number;
  blueSingleArea: number;
  onRedSingleChange: (v: number) => void;
  onBlueSingleChange: (v: number) => void;
  onReverseRed: () => void;
  onReverseBlue: () => void;
  onTest: (alliance: AllianceColor) => void;
  onResetTest: () => void;
  onAnalyzeFrame: () => void;
  onClearDetections: () => void;
  onExport: () => void;
}) {
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-accent-dim)", background: "var(--scout-panel)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--scout-accent)" }}>
          Detection Debug
        </h3>
        <span className="text-[11px] text-white/50">
          Frames: <span className="tabular-nums text-white">{diag.framesAnalyzed}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <GateCard
          color="var(--scout-red)"
          label="Red gate"
          g={diag.red}
          framesAnalyzed={diag.framesAnalyzed}
          artifactCount={redArtifacts}
          artifactScore={redArtifactPoints}
          cropRef={redCropRef}
          maskRef={redMaskRef}
          dir={redDir}
          onReverse={onReverseRed}
        />
        <GateCard
          color="var(--scout-blue)"
          label="Blue gate"
          g={diag.blue}
          framesAnalyzed={diag.framesAnalyzed}
          artifactCount={blueArtifacts}
          artifactScore={blueArtifactPoints}
          cropRef={blueCropRef}
          maskRef={blueMaskRef}
          dir={blueDir}
          onReverse={onReverseBlue}
        />
      </div>

      <p className="mt-3 text-[11px] text-white/50">
        Clump size — one-artifact area per gate (a blob bigger than ~1.6× counts as multiple balls). Lower = counts more.
      </p>
      <div className="mt-1 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--scout-red)" }}>
          Red ({redSingleArea > 0 ? `${(redSingleArea * 100).toFixed(1)}%` : "off"})
          <input type="range" min={0} max={0.08} step={0.0005} value={redSingleArea}
            onChange={(e) => onRedSingleChange(Number(e.target.value))} style={{ accentColor: "var(--scout-red)" }} />
        </label>
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--scout-blue)" }}>
          Blue ({blueSingleArea > 0 ? `${(blueSingleArea * 100).toFixed(1)}%` : "off"})
          <input type="range" min={0} max={0.08} step={0.0005} value={blueSingleArea}
            onChange={(e) => onBlueSingleChange(Number(e.target.value))} style={{ accentColor: "var(--scout-blue)" }} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onTest("red")} className="chip" style={{ borderColor: "var(--scout-red)", color: "var(--scout-red)" }}>
          Test RED artifact
        </button>
        <button type="button" onClick={() => onTest("blue")} className="chip" style={{ borderColor: "var(--scout-blue)", color: "var(--scout-blue)" }}>
          Test BLUE artifact
        </button>
        <button type="button" onClick={onAnalyzeFrame} className="chip" style={{ borderColor: "var(--scout-accent)", color: "var(--scout-accent)" }}>
          Analyze current frame
        </button>
        <button type="button" onClick={onResetTest} className="chip">Reset test scores</button>
        <button type="button" onClick={onClearDetections} className="chip">Clear automatic events</button>
        <button type="button" onClick={onExport} className="chip">Export debug log</button>
      </div>

      {diag.log.length > 0 && (
        <pre className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-2 text-[10px] leading-relaxed text-white/60">
          {diag.log.slice(-50).join("\n")}
        </pre>
      )}
    </div>
  );
}
