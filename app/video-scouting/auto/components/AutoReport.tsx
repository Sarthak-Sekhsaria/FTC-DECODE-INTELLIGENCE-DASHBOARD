"use client";

import type { AllianceScore, ScoreEvent } from "@/lib/scouting/autoTypes";
import { DECODE_RULES } from "@/lib/scouting/decodeRules";

function fmt(t: number): string {
  if (!Number.isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Breakdown({ color, score }: { color: "red" | "blue"; score: AllianceScore }) {
  const accent = color === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  const rows: [string, number][] = [
    ["Artifacts scored", score.artifacts],
    ["Artifact pts", score.artifactPoints],
    ["Pattern pts", score.patternPoints],
    ["Leave pts", score.leavePoints],
    ["Endgame pts", score.endgamePoints],
    ["Manual adjustment", score.manualAdjustment],
  ];
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: accent }}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-black uppercase" style={{ color: accent }}>
          {color}
        </span>
        <span className="text-3xl font-black text-white">{score.total}</span>
      </div>
      {rows.map(([label, val]) => (
        <div key={label} className="flex justify-between text-xs text-white/55">
          <span>{label}</span>
          <span className="tabular-nums">{val}</span>
        </div>
      ))}
    </div>
  );
}

export default function AutoReport({
  videoName,
  meta,
  events,
  redScore,
  blueScore,
}: {
  videoName: string;
  meta: { duration: number; width: number; height: number };
  events: ScoreEvent[];
  redScore: AllianceScore;
  blueScore: AllianceScore;
}) {
  const accepted = events.filter((e) => e.status !== "rejected");
  const low = accepted.filter((e) => e.confidence === "low").length;
  const corrected = events.filter((e) => e.status === "confirmed" || e.status === "rejected" || e.method === "manual").length;

  const winner =
    redScore.total === blueScore.total
      ? "Tie"
      : redScore.total > blueScore.total
        ? "RED Alliance"
        : "BLUE Alliance";
  const winnerColor =
    winner === "RED Alliance" ? "var(--scout-red)" : winner === "BLUE Alliance" ? "var(--scout-blue)" : "#fff";

  return (
    <div className="rounded-2xl border p-6" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-white/45">Final Analysis Report</h3>
      <p className="mb-4 text-[11px] text-white/35">
        Rules: {DECODE_RULES.manualVersion} · Team Update {DECODE_RULES.teamUpdate}
      </p>

      <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/55">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <span>Video: <span className="text-white/80">{videoName || "—"}</span></span>
          <span>Duration: <span className="text-white/80">{fmt(meta.duration)}</span></span>
          <span>Resolution: <span className="text-white/80">{meta.width}×{meta.height}</span></span>
        </div>
      </div>

      <div className="mb-4 rounded-xl border p-3 text-center" style={{ borderColor: winnerColor }}>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">Predicted match result</p>
        <p className="text-2xl font-black" style={{ color: winnerColor }}>
          {winner}
          {winner !== "Tie" && (
            <span className="ml-2 text-base text-white/70">
              {Math.max(redScore.total, blueScore.total)}–{Math.min(redScore.total, blueScore.total)}
            </span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Breakdown color="red" score={redScore} />
        <Breakdown color="blue" score={blueScore} />
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-white/45">Confidence summary</p>
        <p className="text-xs text-white/55">
          {accepted.length} accepted event(s) · {low} low-confidence · {corrected} reviewed/corrected/manual.
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-amber-300/80">Limitations</p>
        <ul className="list-disc pl-4 text-xs text-white/55">
          <li>Artifact scoring is from experimental color-detection CV — verify against the video.</li>
          <li>Classified vs. overflow is not distinguished automatically; mark overflow events in review.</li>
          <li>Pattern, LEAVE, and endgame BASE values are manually entered.</li>
          <li>DEPOT scoring is not captured in this version.</li>
        </ul>
      </div>
    </div>
  );
}
