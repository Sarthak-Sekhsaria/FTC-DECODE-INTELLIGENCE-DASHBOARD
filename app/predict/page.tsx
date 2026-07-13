"use client";

import { useState } from "react";
import Link from "next/link";
import AllianceForm, { AllianceFormValues } from "@/app/components/AllianceForm";
import PredictionDashboard from "@/app/components/PredictionDashboard";
import type { MatchPrediction } from "@/lib/predictionSchema";

const initialValues: AllianceFormValues = {
  redTeam1: "",
  redTeam2: "",
  blueTeam1: "",
  blueTeam2: "",
};

export default function PredictPage() {
  const [values, setValues] = useState<AllianceFormValues>(initialValues);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<MatchPrediction | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    setPrediction(null);
    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redTeam1: Number(values.redTeam1),
          redTeam2: Number(values.redTeam2),
          blueTeam1: Number(values.blueTeam1),
          blueTeam2: Number(values.blueTeam2),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Prediction request failed.");
      }
      setPrediction(data as MatchPrediction);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10 md:py-16">
      <Link
        href="/"
        className="w-fit text-sm font-medium text-white/50 transition hover:text-white/80"
      >
        ← Back to Dashboard
      </Link>

      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/40">
          FIRST Tech Challenge · DECODE Season
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          <span style={{ color: "var(--ftc-red)" }}>Match</span>{" "}
          <span className="text-white">Winner</span>{" "}
          <span style={{ color: "var(--ftc-blue)" }}>Predictor</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-white/60">
          Enter two Red Alliance teams and two Blue Alliance teams. The agent researches each
          team&apos;s DECODE season performance and predicts the likely winner.
        </p>
      </header>

      <AllianceForm values={values} onChange={setValues} onSubmit={handleSubmit} loading={loading} />

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !prediction && (
        <div className="flex flex-col items-center gap-3 py-10 text-white/50">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <p>Pulling DECODE stats from FTCScout and analyzing the matchup…</p>
        </div>
      )}

      {prediction && <PredictionDashboard prediction={prediction} />}
    </main>
  );
}
