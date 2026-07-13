"use client";

import { FormEvent } from "react";

export interface AllianceFormValues {
  redTeam1: string;
  redTeam2: string;
  blueTeam1: string;
  blueTeam2: string;
}

interface Props {
  values: AllianceFormValues;
  onChange: (values: AllianceFormValues) => void;
  onSubmit: () => void;
  loading: boolean;
}

function TeamInput({
  label,
  value,
  onChange,
  accent,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  accent: "red" | "blue";
}) {
  const ring = accent === "red" ? "focus:ring-ftc-red" : "focus:ring-ftc-blue";
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-white/60">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        placeholder="e.g. 12087"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-lg border border-white/10 bg-black/30 px-4 py-2.5 text-lg font-medium text-white outline-none transition focus:border-transparent focus:ring-2 ${ring}`}
      />
    </label>
  );
}

export default function AllianceForm({ values, onChange, onSubmit, loading }: Props) {
  const set = (key: keyof AllianceFormValues) => (v: string) => onChange({ ...values, [key]: v });

  const canSubmit =
    values.redTeam1.trim() !== "" &&
    values.redTeam2.trim() !== "" &&
    values.blueTeam1.trim() !== "" &&
    values.blueTeam2.trim() !== "" &&
    !loading;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div
          className="rounded-2xl border p-5"
          style={{ borderColor: "var(--ftc-red-dim)", background: "linear-gradient(160deg, rgba(228,0,43,0.12), rgba(228,0,43,0.02))" }}
        >
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-ftc-red">
            <span className="h-2.5 w-2.5 rounded-full bg-ftc-red" />
            Red Alliance
          </h2>
          <div className="flex flex-col gap-4">
            <TeamInput label="Red Team 1" value={values.redTeam1} onChange={set("redTeam1")} accent="red" />
            <TeamInput label="Red Team 2" value={values.redTeam2} onChange={set("redTeam2")} accent="red" />
          </div>
        </div>

        <div
          className="rounded-2xl border p-5"
          style={{ borderColor: "var(--ftc-blue-dim)", background: "linear-gradient(160deg, rgba(0,114,206,0.12), rgba(0,114,206,0.02))" }}
        >
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-ftc-blue">
            <span className="h-2.5 w-2.5 rounded-full bg-ftc-blue" />
            Blue Alliance
          </h2>
          <div className="flex flex-col gap-4">
            <TeamInput label="Blue Team 1" value={values.blueTeam1} onChange={set("blueTeam1")} accent="blue" />
            <TeamInput label="Blue Team 2" value={values.blueTeam2} onChange={set("blueTeam2")} accent="blue" />
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="group relative w-full overflow-hidden rounded-xl py-4 text-lg font-bold tracking-wide text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: "linear-gradient(90deg, var(--ftc-red) 0%, #4b1a52 50%, var(--ftc-blue) 100%)",
        }}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Researching teams & predicting…
          </span>
        ) : (
          "Predict Match Winner"
        )}
      </button>
    </form>
  );
}
