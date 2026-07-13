"use client";

import type { AllianceScore } from "@/lib/scouting/autoTypes";

function Row({ label, value, strong }: { label: string; value: number | string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "text-white" : "text-white/60"}`}>
      <span className={strong ? "text-sm font-bold uppercase tracking-wide" : "text-xs"}>{label}</span>
      <span className={`tabular-nums ${strong ? "text-lg font-black" : "text-sm font-semibold"}`}>{value}</span>
    </div>
  );
}

function AllianceColumn({
  color,
  score,
}: {
  color: "red" | "blue";
  score: AllianceScore;
}) {
  const accent = color === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  const bg =
    color === "red"
      ? "linear-gradient(160deg, rgba(239,68,68,0.14), rgba(239,68,68,0.02))"
      : "linear-gradient(160deg, rgba(59,130,246,0.14), rgba(59,130,246,0.02))";

  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: accent, background: bg }}>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-black uppercase tracking-wide" style={{ color: accent }}>
          {color} Alliance
        </span>
        <span className="text-4xl font-black tabular-nums text-white">{score.total}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Row label="Artifacts scored" value={score.artifacts} />
        <Row label="Artifact points" value={score.artifactPoints} />
        <div className="my-1 h-px bg-white/10" />
        <Row label="Pattern points" value={score.patternPoints} />
        <Row label="Leave points" value={score.leavePoints} />
        <Row label="Endgame points" value={score.endgamePoints} />
        {score.manualAdjustment !== 0 && <Row label="Manual adjustment" value={score.manualAdjustment} />}
        <div className="my-1 h-px bg-white/10" />
        <Row label="Total score" value={score.total} strong />
      </div>
    </div>
  );
}

export default function Scoreboard({
  red,
  blue,
  latestEvent,
}: {
  red: AllianceScore;
  blue: AllianceScore;
  latestEvent: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/30 px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
          Live Scoreboard
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-white/40">
          {latestEvent ? `Latest: ${latestEvent}` : "No events yet"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AllianceColumn color="red" score={red} />
        <AllianceColumn color="blue" score={blue} />
      </div>
    </div>
  );
}
