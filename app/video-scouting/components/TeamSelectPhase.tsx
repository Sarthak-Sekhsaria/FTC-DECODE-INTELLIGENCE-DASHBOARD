"use client";

import PhaseCard from "./PhaseCard";
import type { Alliance, StartPosition } from "@/lib/scouting/types";

function SelectButton({
  label,
  active,
  onClick,
  accent,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  accent: "red" | "blue" | "green";
}) {
  const activeBg =
    accent === "red" ? "var(--scout-red)" : accent === "blue" ? "var(--scout-blue)" : "var(--scout-accent)";
  const activeText = accent === "green" ? "#04140c" : "#fff";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-xl border-2 py-4 text-center text-base font-bold tracking-wide transition"
      style={
        active
          ? { background: activeBg, borderColor: activeBg, color: activeText }
          : { background: "transparent", borderColor: "var(--scout-border)", color: "#9aa39d" }
      }
    >
      {label}
    </button>
  );
}

export default function TeamSelectPhase({
  teamNumber,
  alliance,
  startPosition,
  onTeamNumberChange,
  onAllianceChange,
  onStartPositionChange,
  onInitialize,
}: {
  teamNumber: string;
  alliance: Alliance | null;
  startPosition: StartPosition | null;
  onTeamNumberChange: (v: string) => void;
  onAllianceChange: (v: Alliance) => void;
  onStartPositionChange: (v: StartPosition) => void;
  onInitialize: () => void;
}) {
  const canInitialize = teamNumber.trim() !== "" && alliance !== null && startPosition !== null;

  return (
    <div className="flex flex-col gap-5">
      <PhaseCard title="Team Information">
        <label className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Team #</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={teamNumber}
            onChange={(e) => onTeamNumberChange(e.target.value)}
            placeholder="e.g. 12087"
            className="rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-lg font-medium text-white outline-none transition focus:border-transparent focus:ring-2"
            style={{ boxShadow: "none" }}
            onFocus={(e) => (e.currentTarget.style.boxShadow = "0 0 0 2px var(--scout-accent)")}
            onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
          />
        </label>

        <div className="mt-5">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/50">Alliance</span>
          <div className="flex gap-3">
            <SelectButton label="Red" active={alliance === "red"} onClick={() => onAllianceChange("red")} accent="red" />
            <SelectButton label="Blue" active={alliance === "blue"} onClick={() => onAllianceChange("blue")} accent="blue" />
          </div>
        </div>
      </PhaseCard>

      <PhaseCard title="Match Start">
        <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/50">Start Position</span>
        <div className="flex gap-3">
          <SelectButton
            label="Far Start"
            active={startPosition === "far"}
            onClick={() => onStartPositionChange("far")}
            accent="green"
          />
          <SelectButton
            label="Near Start"
            active={startPosition === "near"}
            onClick={() => onStartPositionChange("near")}
            accent="green"
          />
        </div>
      </PhaseCard>

      <button
        type="button"
        onClick={onInitialize}
        disabled={!canInitialize}
        className="flex items-center justify-center gap-2 rounded-xl py-4 text-base font-black uppercase tracking-wide text-black transition disabled:cursor-not-allowed disabled:opacity-30"
        style={{ background: "var(--scout-accent)" }}
      >
        Initialize <span aria-hidden>›</span>
      </button>
    </div>
  );
}
