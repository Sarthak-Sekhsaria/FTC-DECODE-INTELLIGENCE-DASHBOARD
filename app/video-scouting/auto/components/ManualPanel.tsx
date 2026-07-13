"use client";

import type { AllianceColor, AllianceManualEntry, RobotBaseStatus } from "@/lib/scouting/autoTypes";
import { DECODE_RULES } from "@/lib/scouting/decodeRules";

function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  accent,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 text-white/70"
      >
        −
      </button>
      <span className="w-6 text-center text-base font-black tabular-nums text-white">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-7 w-7 items-center justify-center rounded-lg border text-white/70"
        style={{ borderColor: accent, color: accent }}
      >
        +
      </button>
    </div>
  );
}

const BASE_OPTS: { value: RobotBaseStatus; label: string }[] = [
  { value: "none", label: "None" },
  { value: "partial", label: "Partial" },
  { value: "full", label: "Full" },
];

function BaseSelect({
  label,
  value,
  onChange,
  accent,
}: {
  label: string;
  value: RobotBaseStatus;
  onChange: (v: RobotBaseStatus) => void;
  accent: string;
}) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/45">{label}</span>
      <div className="flex gap-1.5">
        {BASE_OPTS.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className="flex-1 rounded-lg border py-1.5 text-xs font-bold transition"
              style={
                active
                  ? { background: accent, borderColor: accent, color: "#04140c" }
                  : { background: "transparent", borderColor: "var(--scout-border)", color: "#9aa39d" }
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AllianceManual({
  color,
  entry,
  onChange,
}: {
  color: AllianceColor;
  entry: AllianceManualEntry;
  onChange: (patch: Partial<AllianceManualEntry>) => void;
}) {
  const accent = color === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: accent }}>
      <p className="mb-3 text-sm font-black uppercase tracking-wide" style={{ color: accent }}>
        {color} Alliance
      </p>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/60">
            Robots left (LEAVE, +{DECODE_RULES.points.leavePerRobot} ea)
          </span>
          <Stepper value={entry.robotsLeft} onChange={(v) => onChange({ robotsLeft: v })} max={2} accent={accent} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/60">
            Pattern artifacts (×{DECODE_RULES.points.patternPerArtifact})
          </span>
          <Stepper
            value={entry.patternArtifacts}
            onChange={(v) => onChange({ patternArtifacts: v })}
            max={9}
            accent={accent}
          />
        </div>
        <div className="my-1 h-px bg-white/10" />
        <BaseSelect
          label={`Robot 1 base (partial ${DECODE_RULES.points.basePartialPerRobot} / full ${DECODE_RULES.points.baseFullPerRobot})`}
          value={entry.baseRobot1}
          onChange={(v) => onChange({ baseRobot1: v })}
          accent={accent}
        />
        <BaseSelect
          label="Robot 2 base"
          value={entry.baseRobot2}
          onChange={(v) => onChange({ baseRobot2: v })}
          accent={accent}
        />
        {entry.baseRobot1 === "full" && entry.baseRobot2 === "full" && (
          <p className="text-[11px]" style={{ color: "var(--scout-accent)" }}>
            +{DECODE_RULES.points.baseBothFullBonus} both-robots-full bonus applied
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/60">Manual adjustment (±)</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onChange({ manualAdjustment: entry.manualAdjustment - 1 })}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 text-white/70"
            >
              −
            </button>
            <span className="w-8 text-center text-base font-black tabular-nums text-white">
              {entry.manualAdjustment}
            </span>
            <button
              type="button"
              onClick={() => onChange({ manualAdjustment: entry.manualAdjustment + 1 })}
              className="flex h-7 w-7 items-center justify-center rounded-lg border text-white/70"
              style={{ borderColor: accent, color: accent }}
            >
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ManualPanel({
  red,
  blue,
  onChangeRed,
  onChangeBlue,
}: {
  red: AllianceManualEntry;
  blue: AllianceManualEntry;
  onChangeRed: (patch: Partial<AllianceManualEntry>) => void;
  onChangeBlue: (patch: Partial<AllianceManualEntry>) => void;
}) {
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-white/45">Pattern · Leave · Endgame</h3>
        <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
          Manually entered
        </span>
      </div>
      <p className="mb-3 text-[11px] text-white/35">
        These are not detected by the model — enter them from the video as you review the match.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AllianceManual color="red" entry={red} onChange={onChangeRed} />
        <AllianceManual color="blue" entry={blue} onChange={onChangeBlue} />
      </div>
    </div>
  );
}
