"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import type { ScoutingReport } from "@/lib/scouting/types";

// sessionStorage is a browser-only, external (non-React) store, so it's read via
// useSyncExternalStore rather than useEffect+setState: this gets the real value on
// the client's first render (no post-mount loading flash) while still returning a
// safe null snapshot during SSR/hydration.
function subscribe() {
  return () => {};
}

function getSnapshot() {
  return sessionStorage.getItem("scouting_result");
}

function getServerSnapshot() {
  return null;
}

function parseResult(raw: string | null): ScoutingReport | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScoutingReport;
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-2xl border p-6"
      style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}
    >
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-white/45">{title}</h2>
      {children}
    </section>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-white/40">{label}</p>
      <p className="text-xl font-black" style={{ color: accent ?? "#fff" }}>
        {value}
      </p>
    </div>
  );
}

function BulletList({ items, dotColor }: { items: string[]; dotColor: string }) {
  if (items.length === 0) return <p className="text-sm text-white/40">None noted.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-[15px] leading-relaxed text-white/85">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} />
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function ScoutingResultPage() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const report = parseResult(raw);

  if (!report) {
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <p className="text-lg font-semibold text-white/70">No scouting report found.</p>
        <p className="max-w-sm text-sm text-white/40">
          Start a new scouting session to generate a team description.
        </p>
        <Link
          href="/video-scouting/manual"
          className="mt-2 rounded-xl px-6 py-3 text-sm font-bold uppercase tracking-wide text-black"
          style={{ background: "var(--scout-accent)" }}
        >
          Start Scouting
        </Link>
      </main>
    );
  }

  const accent = report.alliance === "red" ? "var(--scout-red)" : "var(--scout-blue)";
  const baseStatusLabel = report.baseStatus.charAt(0).toUpperCase() + report.baseStatus.slice(1);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-5 px-4 py-8">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm font-medium text-white/40 transition hover:text-white/70">
          ← Dashboard
        </Link>
        <Link
          href="/video-scouting/manual"
          className="text-sm font-medium transition"
          style={{ color: "var(--scout-accent)" }}
        >
          New Session →
        </Link>
      </div>

      {/* 1. Header / Team Snapshot */}
      <div
        className="rounded-2xl border p-6"
        style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-white/40">Scouting Report</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-3xl font-black text-white">Team {report.teamNumber}</h1>
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide"
            style={{ background: `${accent}22`, color: accent }}
          >
            {report.alliance} alliance
          </span>
          <span className="text-xs font-medium text-white/40">
            {report.startPosition === "far" ? "Far Start" : "Near Start"}
          </span>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-2">
          <StatTile label="Auto" value={report.autonomousScore} />
          <StatTile label="Teleop" value={report.teleopScore} />
          <StatTile label="Endgame" value={report.endgameScore} />
          <StatTile label="Total" value={report.totalScore} accent="var(--scout-accent)" />
        </div>

        <div className="mt-4 flex gap-6 text-sm">
          <div>
            <span className="text-white/40">Driver Power </span>
            <span className="font-bold text-white">{report.driverPowerPct}%</span>
          </div>
          <div>
            <span className="text-white/40">Base Status </span>
            <span className="font-bold text-white">{baseStatusLabel}</span>
          </div>
        </div>
      </div>

      {/* 2-4. Phase analyses */}
      <Section title="Autonomous Analysis">
        <p className="text-[15px] leading-relaxed text-white/85">{report.autonomousAnalysis}</p>
      </Section>
      <Section title="Teleop Analysis">
        <p className="text-[15px] leading-relaxed text-white/85">{report.teleopAnalysis}</p>
      </Section>
      <Section title="Endgame Analysis">
        <p className="text-[15px] leading-relaxed text-white/85">{report.endgameAnalysis}</p>
      </Section>

      {/* 5-6. Strengths / weaknesses */}
      <Section title="Strengths">
        <BulletList items={report.strengths} dotColor="var(--scout-accent)" />
      </Section>
      <Section title="Weaknesses / Concerns">
        <BulletList items={report.weaknesses} dotColor="#f59e0b" />
      </Section>

      {/* 7-8. Strategy */}
      <Section title="How to Counter This Team">
        <p className="text-[15px] leading-relaxed text-white/85">{report.counterStrategy}</p>
      </Section>
      <Section title="Partner Strategy">
        <p className="text-[15px] leading-relaxed text-white/85">{report.partnerStrategy}</p>
      </Section>

      {/* 9. Tactical notes */}
      <Section title="Tactical Notes">
        <p className="text-[15px] leading-relaxed text-white/85">
          {report.tacticalNotes.trim() || "No tactical notes entered."}
        </p>
      </Section>

      {/* 10. Final summary */}
      <section className="rounded-2xl border border-white/15 bg-white/5 p-6">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">Final Summary</h2>
        <p className="text-lg leading-relaxed text-white">{report.finalSummary}</p>
      </section>

      <p className="text-center text-xs text-white/30">
        Saved to <span className="font-mono">{report.savedPath}</span>
      </p>
    </main>
  );
}
