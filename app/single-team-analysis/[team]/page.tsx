"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { TeamAnalysisError, TeamAnalysisReport } from "@/lib/teamAnalysis/report";
import type { NarrativeProfile, NarrativeStrategy } from "@/lib/teamAnalysis/narrativeSchema";
import ReportView, { type NarrativeStatus } from "../components/ReportView";

const STAGES = [
  "Validating team number",
  "Retrieving DECODE events",
  "Retrieving match results",
  "Calculating statistics",
  "Assembling scouting dossier",
];

function LoadingStages() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    // Advance the visible stage on an estimate while the single request runs.
    // No fake percentages — just which step we're likely on. Holds on the last.
    const t = setInterval(() => setActive((a) => Math.min(a + 1, STAGES.length - 1)), 750);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-2xl border p-6"
      style={{ borderColor: "var(--panel-border)", background: "var(--panel)" }}
    >
      {STAGES.map((s, i) => {
        const done = i < active;
        const now = i === active;
        return (
          <div key={s} className="flex items-center gap-3">
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[11px]"
              style={{
                background: done ? "rgba(52,211,153,0.15)" : now ? "rgba(0,114,206,0.15)" : "rgba(255,255,255,0.05)",
                color: done ? "#34d399" : now ? "var(--ftc-blue)" : "rgba(255,255,255,0.3)",
              }}
            >
              {done ? "✓" : now ? <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : "○"}
            </span>
            <span className={done ? "text-sm text-white/50" : now ? "text-sm font-medium text-white/90" : "text-sm text-white/30"}>
              {s}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ErrorState({ error, teamNumber, onRetry }: { error: TeamAnalysisError; teamNumber: string; onRetry: () => void }) {
  const title =
    error.code === "TEAM_NOT_FOUND"
      ? `Team ${teamNumber} not found`
      : error.code === "NO_DECODE_DATA"
        ? "No DECODE data yet"
        : error.code === "INVALID_TEAM"
          ? "Invalid team number"
          : "Couldn't reach the data source";
  const canRetry = error.code === "UPSTREAM_ERROR";
  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border p-8 text-center"
      style={{ borderColor: "rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.06)" }}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-2xl text-red-300">!</span>
      <div>
        <h2 className="text-lg font-bold text-white">{title}</h2>
        <p className="mt-1 text-sm text-white/55">{error.message}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {canRetry && (
          <button type="button" onClick={onRetry} className="chip" style={{ borderColor: "var(--ftc-blue)", color: "var(--ftc-blue)" }}>
            Retry
          </button>
        )}
        <Link href="/single-team-analysis" className="chip">
          Analyze a different team
        </Link>
      </div>
    </div>
  );
}

export default function TeamReportPage() {
  const params = useParams<{ team: string }>();
  // Keyed by team so navigating between teams remounts with a fresh loading
  // state instead of briefly showing the previous team's report.
  return <TeamReport key={params.team} team={params.team} />;
}

function TeamReport({ team }: { team: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [report, setReport] = useState<TeamAnalysisReport | null>(null);
  const [error, setError] = useState<TeamAnalysisError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // AI narrative (Phase 3) loads AFTER the deterministic report renders, so the
  // dossier is usable immediately and a missing key / failure degrades gracefully.
  const [profile, setProfile] = useState<NarrativeProfile | null>(null);
  const [strategy, setStrategy] = useState<NarrativeStrategy | null>(null);
  const [narrativeStatus, setNarrativeStatus] = useState<Exclude<NarrativeStatus, "loading">>("idle");
  const [narrativeError, setNarrativeError] = useState<string | null>(null);

  // When set, the next report + narrative fetch bypass the server cache. Stays a
  // ref so toggling it doesn't itself re-run effects; reloadKey drives the refetch.
  const forceRefresh = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/team-analysis/${team}${forceRefresh.current ? "?refresh=1" : ""}`);
        const data = (await res.json()) as TeamAnalysisReport | TeamAnalysisError;
        if (cancelled) return;
        if (!res.ok || data.ok === false) {
          setError(data.ok === false ? data : { ok: false, code: "UPSTREAM_ERROR", message: "Unexpected error." });
          setStatus("error");
          return;
        }
        setReport(data);
        setStatus("ready");
        // Remember this team for the input page's recent-searches list.
        try {
          const raw = localStorage.getItem("sta:recent-teams");
          const prev: number[] = raw ? JSON.parse(raw) : [];
          const n = Number(team);
          localStorage.setItem("sta:recent-teams", JSON.stringify([n, ...prev.filter((r) => r !== n)].slice(0, 6)));
        } catch {
          /* ignore storage errors */
        }
      } catch (e) {
        if (!cancelled) {
          setError({ ok: false, code: "UPSTREAM_ERROR", message: (e as Error).message });
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [team, reloadKey]);

  // Kick off the AI narrative once the deterministic report is ready. First
  // setState happens after the await, so no synchronous set-state-in-effect.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/team-analysis/${team}/narrative${forceRefresh.current ? "?refresh=1" : ""}`, { method: "POST" });
        const data = await res.json();
        if (cancelled) return;
        if (data?.code === "NO_API_KEY") {
          setNarrativeStatus("unavailable");
          setNarrativeError(data.message);
          return;
        }
        if (!res.ok || !data?.ok) {
          setNarrativeStatus("error");
          setNarrativeError(data?.message ?? "AI analysis failed.");
          return;
        }
        setProfile(data.profile ?? null);
        setStrategy(data.strategy ?? null);
        setNarrativeStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setNarrativeStatus("error");
          setNarrativeError((e as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, team, reloadKey]);

  function retry() {
    setStatus("loading");
    setError(null);
    setReport(null);
    setProfile(null);
    setStrategy(null);
    setNarrativeStatus("idle");
    setNarrativeError(null);
    setReloadKey((k) => k + 1);
  }

  function handleRefresh() {
    forceRefresh.current = true;
    retry();
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10 md:py-14">
      <Link href="/single-team-analysis" className="w-fit text-sm font-medium text-white/50 transition hover:text-white/80">
        ← New analysis
      </Link>

      {status === "loading" && (
        <div className="flex flex-col items-center gap-4 py-8">
          <p className="text-sm text-white/50">
            Analyzing team <span className="font-semibold text-white/80">#{team}</span> — DECODE 2025–2026
          </p>
          <LoadingStages />
        </div>
      )}

      {status === "error" && error && <ErrorState error={error} teamNumber={team} onRetry={retry} />}

      {status === "ready" && report && (
        <ReportView
          report={report}
          profile={profile}
          strategy={strategy}
          narrativeStatus={narrativeStatus === "idle" ? "loading" : narrativeStatus}
          narrativeError={narrativeError}
          onRefresh={handleRefresh}
        />
      )}
    </main>
  );
}
