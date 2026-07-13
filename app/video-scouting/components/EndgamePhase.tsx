"use client";

import PhaseCard from "./PhaseCard";
import NavButtons from "./NavButtons";
import { BASE_STATUS_POINTS, type BaseStatus, type EndgameStats } from "@/lib/scouting/types";

function FoulStepper({
  label,
  value,
  onDecrement,
  onIncrement,
}: {
  label: string;
  value: number;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-4">
      <span className="text-xs font-semibold uppercase tracking-wide text-white/50">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onDecrement}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 text-lg font-bold text-white/70 transition hover:border-white/30"
        >
          −
        </button>
        <span className="w-8 text-center text-xl font-black tabular-nums text-white">{value}</span>
        <button
          type="button"
          onClick={onIncrement}
          className="flex h-9 w-9 items-center justify-center rounded-lg border text-lg font-bold transition"
          style={{ borderColor: "var(--scout-red)", color: "var(--scout-red)" }}
        >
          +
        </button>
      </div>
    </div>
  );
}

const BASE_STATUS_OPTIONS: { value: BaseStatus; label: string }[] = [
  { value: "none", label: "None" },
  { value: "partial", label: "Partial" },
  { value: "full", label: "Full" },
];

export default function EndgamePhase({
  stats,
  onChange,
  onBack,
  onCommit,
  committing,
}: {
  stats: EndgameStats;
  onChange: (updater: (prev: EndgameStats) => EndgameStats) => void;
  onBack: () => void;
  onCommit: () => void;
  committing: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-white/60" style={{ fontSize: 11 }}>
          🛡
        </span>
        <h2 className="text-lg font-black tracking-wide text-white">Endgame Matrix</h2>
      </div>

      <PhaseCard>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Driver Power</span>
          <span className="text-xl font-black" style={{ color: "var(--scout-accent)" }}>
            {stats.driverPowerPct}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={stats.driverPowerPct}
          onChange={(e) => {
            const driverPowerPct = Number(e.target.value);
            onChange((s) => ({ ...s, driverPowerPct }));
          }}
          className="mt-3 w-full accent-[var(--scout-accent)]"
          style={{ accentColor: "var(--scout-accent)" }}
        />
      </PhaseCard>

      <PhaseCard title="Base Status">
        <div className="flex gap-3">
          {BASE_STATUS_OPTIONS.map((opt) => {
            const active = stats.baseStatus === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  onChange((s) => ({ ...s, baseStatus: opt.value, score: BASE_STATUS_POINTS[opt.value] }))
                }
                className="flex-1 rounded-xl border-2 py-3 text-center text-sm font-bold transition"
                style={
                  active
                    ? { background: "var(--scout-accent)", borderColor: "var(--scout-accent)", color: "#04140c" }
                    : { background: "transparent", borderColor: "var(--scout-border)", color: "#9aa39d" }
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-white/35">None = 0 pts · Partial = 5 pts · Full = 10 pts</p>
      </PhaseCard>

      <div className="flex gap-3">
        <FoulStepper
          label="Minor Foul"
          value={stats.minorFouls}
          onDecrement={() => onChange((s) => ({ ...s, minorFouls: Math.max(0, s.minorFouls - 1) }))}
          onIncrement={() => onChange((s) => ({ ...s, minorFouls: s.minorFouls + 1 }))}
        />
        <FoulStepper
          label="Major Foul"
          value={stats.majorFouls}
          onDecrement={() => onChange((s) => ({ ...s, majorFouls: Math.max(0, s.majorFouls - 1) }))}
          onIncrement={() => onChange((s) => ({ ...s, majorFouls: s.majorFouls + 1 }))}
        />
      </div>

      <PhaseCard title="Tactical Notes">
        <textarea
          value={stats.tacticalNotes}
          onChange={(e) => {
            const tacticalNotes = e.target.value;
            onChange((s) => ({ ...s, tacticalNotes }));
          }}
          placeholder="Describe robot patterns..."
          rows={4}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-white placeholder:text-white/30 outline-none focus:border-transparent"
          style={{ boxShadow: "none" }}
          onFocus={(e) => (e.currentTarget.style.boxShadow = "0 0 0 2px var(--scout-accent)")}
          onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
        />
      </PhaseCard>

      <NavButtons onBack={onBack} onNext={onCommit} nextLabel="Commit Intel" nextLoading={committing} />
    </div>
  );
}
