"use client";

import { useState, type ReactNode } from "react";
import { levelToConfidence, type Confidence, type TeamAnalysisReport } from "@/lib/teamAnalysis/report";
import type { NormalizedMatch } from "@/lib/teamAnalysis/matches";
import type { OutlierMatch, PerformanceStats, RoleScores } from "@/lib/teamAnalysis/stats";
import type { AwardItem } from "@/lib/teamAnalysis/awards";
import type {
  AllianceRecruitment,
  CounterStrategy,
  NarrativeProfile,
  NarrativeStrategy,
  NarrativeStrength,
  NarrativeVerdict,
  NarrativeWeakness,
  PhaseAnalysis,
  RobotRole,
  ScoutingQuestions,
  Severity,
} from "@/lib/teamAnalysis/narrativeSchema";
import { Collapsible, ConfidenceBadge, KV, PercentBar, ScoreBar, StatBox, TierBadge, useAccordion } from "./ui";

export type NarrativeStatus = "idle" | "loading" | "ready" | "error" | "unavailable";

// ---- export helpers ---------------------------------------------------------

function reportToMarkdown(r: TeamAnalysisReport, profile: NarrativeProfile | null, strategy: NarrativeStrategy | null): string {
  const L: string[] = [];
  const li = (xs: string[]) => xs.forEach((x) => L.push(`- ${x}`));

  L.push(`# #${r.team.number} ${r.team.name} — ${r.season.name} ${r.season.years} Scouting Dossier`);
  L.push("");
  L.push(`**Tier:** ${r.grade} — ${r.gradeLabel} · **Overall confidence:** ${r.overallConfidence.label} (${r.overallConfidence.score}/100)`);
  L.push(`*Data as of ${new Date(r.generatedAt).toLocaleString()} · source: FTCScout · DECODE ${r.season.years} only*`);
  L.push("");

  if (profile) {
    L.push("## Executive Summary");
    L.push(profile.executiveSummary);
    L.push("");
  }

  L.push("## Headline");
  L.push("| Metric | Value |");
  L.push("| --- | --- |");
  for (const s of r.headline) L.push(`| ${s.label} | ${s.value}${s.sub ? ` (${s.sub})` : ""} |`);
  L.push("");

  if (r.stats) {
    const s = r.stats;
    L.push("## Performance Statistics");
    L.push("| Metric | Value |");
    L.push("| --- | --- |");
    const rows: [string, string | number][] = [
      ["Record", `${s.wins}–${s.losses}–${s.ties} (${s.winRatePct ?? "—"}% win)`],
      ["Quals / Playoffs", `${s.qualMatches} / ${s.playoffMatches}`],
      ["Playoff win rate", s.playoffWinRatePct === null ? "—" : `${s.playoffWinRatePct}%`],
      ["Avg / Median score", `${s.avgScore} / ${s.medianScore}`],
      ["Max / Min", `${s.maxScore} / ${s.minScore}`],
      ["Score σ", s.scoreStdDev],
      ["Avg margin", s.avgMargin],
      ["Avg auto / teleop / base", `${s.avgAuto} / ${s.avgTeleop} / ${s.avgBase}`],
      ["Avg penalties", s.avgPenaltiesCommitted],
      ["Consistency", `${s.consistencyScore}/100`],
      ["Improvement", s.improvementScore === null ? "n/a" : `${s.improvementScore}/100`],
    ];
    for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
    L.push(`\n_${s.improvementNote}_`);
    L.push("");
  }

  if (profile) {
    const role = profile.role;
    L.push("## Robot Role Classification");
    L.push(`**Archetype:** ${role.archetype}`);
    L.push(`\n**Primary:** ${role.primary} · **Secondary:** ${role.secondary}`);
    L.push(`\n${role.reasoning}`);
    if (role.idealResponsibilities.length) {
      L.push("\n*Ideal responsibilities:*");
      li(role.idealResponsibilities);
    }
    if (role.notSuitedFor.length) {
      L.push("\n*May not be suited for:*");
      li(role.notSuitedFor);
    }
    L.push("");

    const phase = (title: string, p: PhaseAnalysis) => {
      L.push(`## ${title}`);
      L.push(p.summary);
      L.push(`\n**Scoring strength:** ${p.strength}`);
      L.push(`\n**Consistency:** ${p.consistency}`);
      if (p.observations.length) {
        L.push("\n*Observations:*");
        li(p.observations);
      }
      L.push("");
    };
    phase("Autonomous Analysis", profile.autonomous);
    phase("TeleOp Analysis", profile.teleop);

    L.push("## Strengths");
    for (const s of profile.strengths) {
      L.push(`### ${s.title} _(${s.confidence})_`);
      L.push(s.claim);
      li(s.evidence);
      if (s.limitations.length) L.push(`\n_Caveats: ${s.limitations.join(" ")}_`);
      L.push("");
    }
    L.push("## Weaknesses & Risk Areas");
    for (const w of profile.weaknesses) {
      L.push(`### ${w.title} _(${w.severity} severity · ${w.confidence})_`);
      L.push(w.risk);
      li(w.evidence);
      L.push(`\n**Legal counter:** ${w.exploit}`);
      L.push("");
    }
  }

  if (strategy) {
    const c = strategy.counter;
    L.push("## How to Beat This Team");
    L.push(`**Game plan:** ${c.gamePlan}`);
    L.push(`\n**Top threat:** ${c.topThreat}`);
    L.push(`\n**Counter their autonomous:** ${c.autoCounter}`);
    L.push(`\n**Counter their teleop:** ${c.teleopCounter}`);
    if (c.legalDefense.length) {
      L.push("\n*Legal defensive assignments:*");
      li(c.legalDefense);
    }
    if (c.doNotDo.length) {
      L.push("\n*Do NOT do:*");
      li(c.doNotDo);
    }
    if (c.risksOfThisPlan.length) L.push(`\n_Risks of this plan: ${c.risksOfThisPlan.join(" · ")}_`);
    L.push("");

    const a = strategy.alliance;
    L.push("## How to Recruit Them as a Partner");
    L.push(`**${a.verdict}**`);
    if (a.whyPickThem.length) {
      L.push("\n*Why pick them:*");
      li(a.whyPickThem);
    }
    if (a.whatYouProvide.length) {
      L.push("\n*What you must bring to complement them:*");
      li(a.whatYouProvide);
    }
    L.push(`\n**Role on your alliance:** ${a.roleOnYourAlliance}`);
    L.push(`\n**How to approach them:** ${a.pitchNotes}`);
    L.push(`\n_Backup consideration: ${a.backupConsideration}_`);
    L.push("");

    const q = strategy.scoutingQuestions;
    L.push("## Pre-Match Scouting Questions");
    L.push("*Pit questions:*");
    q.pit.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    L.push("\n*Strategy & coordination questions:*");
    q.strategy.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    L.push(`\n_Why these questions: ${q.rationale}_`);
    L.push("");
  }

  if (r.bestMatches.length || r.concerningMatches.length) {
    L.push("## Notable Matches");
    if (r.bestMatches.length) {
      L.push("**Best:**");
      li(r.bestMatches.map((o) => `${o.match.levelLabel} ${o.match.matchNum} @ ${o.match.eventName}: ${o.reason}`));
    }
    if (r.concerningMatches.length) {
      L.push("\n**Concerning:**");
      li(r.concerningMatches.map((o) => `${o.match.levelLabel} ${o.match.matchNum} @ ${o.match.eventName}: ${o.reason}`));
    }
    L.push("");
  }

  if (r.awards.length) {
    L.push("## Awards");
    li(r.awards.map((a) => `${a.label} (${a.placementLabel}) — ${a.eventName}`));
    L.push("");
  }

  L.push("## Events");
  L.push("| Date | Event | Rank | Record | OPR | Avg |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const e of r.events) L.push(`| ${e.start} | ${e.name} | #${e.rank} | ${e.record} | ${e.oprTotal} | ${e.avgTotalPoints} |`);
  L.push("");

  if (profile) {
    const v = profile.verdict;
    L.push("## Final Verdict");
    L.push(`**Tier:** ${v.tier} · **Alliance rec:** ${v.allianceRecommendation}`);
    L.push(`\n**Greatest strength:** ${v.greatestStrength}`);
    L.push(`\n**Greatest weakness:** ${v.greatestWeakness}`);
    L.push(`\n${v.paragraph}`);
    L.push(`\n> ${v.oneSentence}`);
    L.push("");
  }

  L.push("## Data Quality & Limitations");
  li(r.dataQuality.limitations);
  L.push(`\n_${r.dataQuality.explanation}_`);
  L.push("");
  L.push("---");
  L.push(`*Generated ${new Date(r.generatedAt).toLocaleString()} · FTC DECODE Team Intelligence · data from FTCScout · AI narrative by Claude · DECODE ${r.season.years} only*`);
  return L.join("\n");
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function matchHistoryCsv(matches: NormalizedMatch[]): string {
  const head = ["event", "level", "match", "alliance", "partners", "opponents", "score", "oppScore", "result", "margin", "auto", "teleop", "base", "penalties", "surrogate"];
  const rows = matches.map((m) =>
    [m.eventName, m.levelLabel, m.matchNum, m.alliance, m.partners.join(" "), m.opponents.join(" "), m.allianceScore, m.opponentScore, m.result, m.margin, m.auto, m.teleop, m.base, m.penaltiesCommitted, m.surrogate]
      .map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v))
      .join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

// ---- small helpers ----------------------------------------------------------

const shortEvent = (name: string) => (name.length > 26 ? name.slice(0, 24) + "…" : name);
const RESULT_COLOR: Record<string, string> = { W: "#34d399", L: "#fb7185", T: "#94a3b8" };
const SEV_COLOR: Record<Severity, string> = { low: "#94a3b8", medium: "#fbbf24", high: "#fb7185" };

const Spinner = () => <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white/70" />;

function AiState({ status, error }: { status: NarrativeStatus; error: string | null }) {
  if (status === "ready" || status === "idle") return null;
  if (status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-white/50">
        <Spinner /> Generating this analysis from the verified data…
      </p>
    );
  }
  if (status === "unavailable") {
    return <p className="text-sm text-white/45">{error ?? "AI analysis is unavailable. The deterministic dossier is complete on its own."}</p>;
  }
  return <p className="text-sm text-amber-300/70">AI analysis could not be generated{error ? `: ${error}` : "."} The deterministic dossier is complete on its own.</p>;
}

function Bullets({ items, marker = "›", color = "var(--ftc-blue)" }: { items: string[]; marker?: string; color?: string }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2">
          <span style={{ color }}>{marker}</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- deterministic section views -------------------------------------------

function StatsSection({ stats }: { stats: PerformanceStats }) {
  const items: [string, string | number][] = [
    ["Total matches", stats.totalMatches],
    ["Qual / Playoff", `${stats.qualMatches} / ${stats.playoffMatches}`],
    ["Record", `${stats.wins}–${stats.losses}–${stats.ties}`],
    ["Win rate", stats.winRatePct === null ? "—" : `${stats.winRatePct}%`],
    ["Playoff win rate", stats.playoffWinRatePct === null ? "—" : `${stats.playoffWinRatePct}%`],
    ["Avg score", stats.avgScore],
    ["Median score", stats.medianScore],
    ["Max / Min", `${stats.maxScore} / ${stats.minScore}`],
    ["Score σ", stats.scoreStdDev],
    ["Avg opponent", stats.avgOpponentScore],
    ["Avg margin", stats.avgMargin],
    ["Margin σ", stats.marginStdDev],
    ["Avg auto", stats.avgAuto],
    ["Avg teleop", stats.avgTeleop],
    ["Avg base", stats.avgBase],
    ["Avg penalties", `${stats.avgPenaltiesCommitted} (σ ${stats.penaltyStdDev})`],
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3">
        {items.map(([k, v]) => (
          <KV key={k} k={k} v={v} />
        ))}
      </div>
      <div className="mt-4 grid gap-3 border-t pt-3 sm:grid-cols-2" style={{ borderColor: "var(--panel-border)" }}>
        <ScoreBar label="Consistency" value={stats.consistencyScore} color="linear-gradient(90deg, var(--ftc-blue), #4aa3ff)" />
        {stats.improvementScore !== null && <ScoreBar label="Improvement (50 = flat)" value={stats.improvementScore} color="linear-gradient(90deg, #34d399, #4aa3ff)" />}
      </div>
      <p className="mt-2 text-xs text-white/40">{stats.improvementNote}</p>
    </div>
  );
}

function RoleRatings({ roles }: { roles: RoleScores }) {
  const rows: { label: string; value: number; risk?: boolean }[] = [
    { label: "Autonomous", value: roles.autonomous },
    { label: "TeleOp", value: roles.teleop },
    { label: "Endgame / Base", value: roles.endgame },
    { label: "Consistency", value: roles.consistency },
    { label: "Penalty safety", value: roles.penaltySafety },
    { label: "Alliance value", value: roles.allianceValue },
    { label: "Playoff readiness", value: roles.playoffReadiness },
    { label: "Upside", value: roles.upside },
    { label: "Risk (higher = riskier)", value: roles.risk, risk: true },
  ];
  return (
    <div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {rows.map((r) => (
          <ScoreBar key={r.label} label={r.label} value={r.value} color={r.risk ? "linear-gradient(90deg, #fbbf24, #fb7185)" : "linear-gradient(90deg, var(--ftc-blue), #4aa3ff)"} />
        ))}
      </div>
      <p className="mt-3 text-xs text-white/40">
        Inferred, alliance-level ratings — not a measure of this team&apos;s isolated robot contribution. Scoring phases use national OPR
        percentiles; the rest are documented blends of the deterministic stats.
      </p>
    </div>
  );
}

function MatchHistory({ matches }: { matches: NormalizedMatch[] }) {
  const [filter, setFilter] = useState<"all" | "qual" | "playoff">("all");
  const shown = matches.filter((m) => filter === "all" || m.level === filter);
  const chips: { id: typeof filter; label: string }[] = [
    { id: "all", label: `All (${matches.length})` },
    { id: "qual", label: `Quals (${matches.filter((m) => m.level === "qual").length})` },
    { id: "playoff", label: `Playoffs (${matches.filter((m) => m.level === "playoff").length})` },
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {chips.map((c) => (
          <button key={c.id} type="button" onClick={() => setFilter(c.id)} className="chip" style={filter === c.id ? { borderColor: "var(--ftc-blue)", color: "var(--ftc-blue)" } : undefined}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="max-h-[26rem] overflow-auto rounded-lg border" style={{ borderColor: "var(--panel-border)" }}>
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="sticky top-0 bg-[var(--panel)] text-[10px] uppercase tracking-wide text-white/40">
            <tr>
              {["Match", "Event", "All", "Partners", "Opponents", "Score", "A / T / B", "Pen"].map((h) => (
                <th key={h} className="px-2.5 py-2 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((m, i) => (
              <tr key={`${m.eventCode}-${m.levelLabel}-${m.matchNum}-${i}`} className="border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                <td className="whitespace-nowrap px-2.5 py-1.5 text-white/70">
                  {m.levelLabel} {m.matchNum}
                  {m.surrogate && <span className="ml-1 text-[9px] text-white/35">(surr)</span>}
                </td>
                <td className="px-2.5 py-1.5 text-white/55">{shortEvent(m.eventName)}</td>
                <td className="px-2.5 py-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: m.alliance === "Red" ? "var(--scout-red)" : "var(--ftc-blue)" }} title={m.alliance} />
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-white/60">{m.partners.join(", ") || "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-white/60">{m.opponents.join(", ") || "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-1.5 font-semibold tabular-nums" style={{ color: RESULT_COLOR[m.result] }}>
                  {m.allianceScore}–{m.opponentScore} {m.result}
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-white/55">{m.auto} / {m.teleop} / {m.base}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-white/50">{m.penaltiesCommitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NotableCard({ o, accent }: { o: OutlierMatch; accent: string }) {
  const m = o.match;
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold" style={{ color: accent }}>{m.levelLabel} {m.matchNum}</span>
        <span className="text-[11px] text-white/40">{shortEvent(m.eventName)}</span>
      </div>
      <p className="mt-1 text-xs text-white/70">{o.reason}</p>
      <p className="mt-1 text-[11px] text-white/40">{m.alliance} · vs {m.opponents.join(", ") || "—"} · z {o.z >= 0 ? "+" : ""}{o.z}</p>
    </div>
  );
}

function NotableMatches({ best, concerning }: { best: OutlierMatch[]; concerning: OutlierMatch[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#34d399" }}>Best matches</p>
        <div className="flex flex-col gap-2">
          {best.length ? best.map((o, i) => <NotableCard key={i} o={o} accent="#34d399" />) : <p className="text-xs text-white/40">Not enough matches to select highlights.</p>}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#fbbf24" }}>Concerning matches</p>
        <div className="flex flex-col gap-2">
          {concerning.length ? concerning.map((o, i) => <NotableCard key={i} o={o} accent="#fbbf24" />) : <p className="text-xs text-white/40">No notably concerning matches stood out.</p>}
        </div>
      </div>
    </div>
  );
}

function AwardsView({ awards }: { awards: AwardItem[] }) {
  if (!awards.length) return <p className="text-sm text-white/45">No DECODE-season awards on record for this team.</p>;
  return (
    <div className="flex flex-col gap-2">
      {awards.map((a, i) => (
        <div key={i} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
          <span className="font-semibold text-white/85">
            {a.label} <span className="text-xs font-normal text-white/45">· {a.placementLabel}</span>
          </span>
          <span className="text-xs text-white/45">{shortEvent(a.eventName)}{a.divisionName ? ` · ${a.divisionName}` : ""}</span>
        </div>
      ))}
      <p className="mt-1 text-xs text-white/40">Judged/competition recognition — not a direct measure of match performance.</p>
    </div>
  );
}

function Unavailable({ text }: { text: string }) {
  return <p className="text-sm text-white/45">{text}</p>;
}

// ---- AI section views -------------------------------------------------------

function AiConf({ level }: { level: NarrativeStrength["confidence"] }) {
  return <ConfidenceBadge confidence={levelToConfidence(level)} />;
}

function StrengthsView({ items }: { items: NarrativeStrength[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((s, i) => (
        <div key={i} className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--panel-border)" }}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-white/90">{s.title}</span>
            <AiConf level={s.confidence} />
          </div>
          <p className="text-sm text-white/70">{s.claim}</p>
          {s.evidence.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Evidence</p>
              <Bullets items={s.evidence} marker="›" />
            </div>
          )}
          {s.limitations.length > 0 && <p className="mt-2 text-xs text-white/40">Caveats: {s.limitations.join(" ")}</p>}
        </div>
      ))}
    </div>
  );
}

function WeaknessesView({ items }: { items: NarrativeWeakness[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((w, i) => (
        <div key={i} className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--panel-border)" }}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-white/90">{w.title}</span>
            <span className="flex items-center gap-2">
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase" style={{ color: SEV_COLOR[w.severity], borderColor: SEV_COLOR[w.severity] }}>{w.severity}</span>
              <AiConf level={w.confidence} />
            </span>
          </div>
          <p className="text-sm text-white/70">{w.risk}</p>
          {w.evidence.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Evidence</p>
              <Bullets items={w.evidence} marker="›" color="#fbbf24" />
            </div>
          )}
          <p className="mt-2 text-xs text-white/50"><span className="text-white/40">Legal counter:</span> {w.exploit}</p>
        </div>
      ))}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">{children}</p>;
}

function RoleClassification({ role }: { role: RobotRole }) {
  return (
    <div>
      <div className="mb-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--ftc-blue-dim)", background: "rgba(0,114,206,0.10)" }}>
        <Label>Archetype</Label>
        <p className="text-sm font-semibold text-white/85">{role.archetype}</p>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{ color: "var(--ftc-blue)", borderColor: "var(--ftc-blue-dim)", background: "rgba(0,114,206,0.12)" }}>Primary: {role.primary}</span>
        <span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold text-white/70" style={{ borderColor: "var(--panel-border)" }}>Secondary: {role.secondary}</span>
        <AiConf level={role.confidence} />
      </div>
      <p className="mb-3 text-sm text-white/70">{role.reasoning}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Ideal responsibilities</Label>
          <Bullets items={role.idealResponsibilities} />
        </div>
        <div>
          <Label>May not be suited for</Label>
          <Bullets items={role.notSuitedFor} marker="○" color="#94a3b8" />
        </div>
      </div>
    </div>
  );
}

function PhaseView({ phase }: { phase: PhaseAnalysis }) {
  return (
    <div>
      <p className="text-sm text-white/75">{phase.summary}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
          <Label>Scoring strength</Label>
          <p className="text-sm text-white/70">{phase.strength}</p>
        </div>
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
          <Label>Consistency</Label>
          <p className="text-sm text-white/70">{phase.consistency}</p>
        </div>
      </div>
      {phase.observations.length > 0 && (
        <div className="mt-3">
          <Label>Key observations</Label>
          <Bullets items={phase.observations} />
        </div>
      )}
      <div className="mt-3"><AiConf level={phase.confidence} /></div>
    </div>
  );
}

function CounterView({ c }: { c: CounterStrategy }) {
  return (
    <div>
      <div className="mb-3 rounded-lg border px-3 py-2" style={{ borderColor: "rgba(251,113,133,0.35)", background: "rgba(251,113,133,0.06)" }}>
        <Label>Game plan to beat them</Label>
        <p className="mt-0.5 text-sm text-white/80">{c.gamePlan}</p>
      </div>
      <p className="mb-3 text-sm text-white/65"><span className="text-white/40">Top threat to neutralize:</span> {c.topThreat}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
          <Label>Counter their autonomous</Label>
          <p className="text-sm text-white/70">{c.autoCounter}</p>
        </div>
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
          <Label>Counter their teleop</Label>
          <p className="text-sm text-white/70">{c.teleopCounter}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Legal defensive assignments</Label>
          <Bullets items={c.legalDefense} marker="›" color="#fb7185" />
        </div>
        <div>
          <Label>Do NOT do this</Label>
          <Bullets items={c.doNotDo} marker="✕" color="#fbbf24" />
        </div>
      </div>
      {c.risksOfThisPlan.length > 0 && (
        <p className="mt-3 text-xs text-white/45">Risks of this plan: {c.risksOfThisPlan.join(" · ")}</p>
      )}
      <div className="mt-2"><AiConf level={c.confidence} /></div>
    </div>
  );
}

function AllianceView({ a }: { a: AllianceRecruitment }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border px-3 py-1 text-sm font-bold" style={{ color: "#34d399", borderColor: "#34d399", background: "rgba(52,211,153,0.1)" }}>{a.verdict}</span>
        <AiConf level={a.confidence} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Why pick them</Label>
          <Bullets items={a.whyPickThem} color="#34d399" />
        </div>
        <div>
          <Label>What you must bring to complement them</Label>
          <Bullets items={a.whatYouProvide} marker="○" color="#fbbf24" />
        </div>
      </div>
      <p className="mt-3 text-sm text-white/70"><span className="text-white/40">Role on your alliance:</span> {a.roleOnYourAlliance}</p>
      <div className="mt-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--panel-border)" }}>
        <Label>How to approach them in selection</Label>
        <p className="text-sm text-white/70">{a.pitchNotes}</p>
      </div>
      <p className="mt-2 text-xs text-white/45">Backup consideration: {a.backupConsideration}</p>
    </div>
  );
}

function ScoutingQuestionsView({ q }: { q: ScoutingQuestions }) {
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Pit questions (capability &amp; reliability)</Label>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-white/70 marker:text-white/35">
            {q.pit.map((x, i) => <li key={i}>{x}</li>)}
          </ol>
        </div>
        <div>
          <Label>Strategy &amp; coordination questions</Label>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-white/70 marker:text-white/35">
            {q.strategy.map((x, i) => <li key={i}>{x}</li>)}
          </ol>
        </div>
      </div>
      <p className="mt-3 border-t pt-3 text-xs text-white/45" style={{ borderColor: "var(--panel-border)" }}>
        <span className="text-white/35">Why these questions: </span>{q.rationale}
      </p>
    </div>
  );
}

function VerdictView({ v }: { v: NarrativeVerdict }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        <KV k="Tier" v={v.tier} />
        <KV k="Alliance rec." v={v.allianceRecommendation} />
        <KV k="Greatest strength" v={v.greatestStrength} />
        <KV k="Greatest weakness" v={v.greatestWeakness} />
      </div>
      <p className="mt-3 border-t pt-3 text-sm text-white/75" style={{ borderColor: "var(--panel-border)" }}>{v.paragraph}</p>
      <p className="mt-2 text-sm font-semibold italic" style={{ color: "var(--ftc-blue)" }}>“{v.oneSentence}”</p>
    </div>
  );
}

// ---- report -----------------------------------------------------------------

type SectionDef =
  | { id: string; title: string; kind: "det"; confidence: Confidence; node: ReactNode }
  | { id: string; title: string; kind: "ai"; node: ReactNode };

export default function ReportView({
  report,
  profile,
  strategy,
  narrativeStatus,
  narrativeError,
  onRefresh,
}: {
  report: TeamAnalysisReport;
  profile: NarrativeProfile | null;
  strategy: NarrativeStrategy | null;
  narrativeStatus: NarrativeStatus;
  narrativeError: string | null;
  onRefresh?: () => void;
}) {
  const r = report;
  // The narrative is generated in two halves that can succeed independently. Render
  // whichever half is present; if the fetch finished but a half is missing, show a
  // per-part "use Refresh" note for its sections instead of failing everything.
  const partErr = "This part of the AI analysis couldn't be generated — use Refresh to try again.";
  const profileStatus: NarrativeStatus = narrativeStatus === "ready" && !profile ? "error" : narrativeStatus;
  const strategyStatus: NarrativeStatus = narrativeStatus === "ready" && !strategy ? "error" : narrativeStatus;
  const profileErr = narrativeStatus === "ready" && !profile ? partErr : narrativeError;
  const strategyErr = narrativeStatus === "ready" && !strategy ? partErr : narrativeError;
  const profileNode = (render: (p: NarrativeProfile) => ReactNode): ReactNode =>
    profile ? render(profile) : <AiState status={profileStatus} error={profileErr} />;
  const strategyNode = (render: (s: NarrativeStrategy) => ReactNode): ReactNode =>
    strategy ? render(strategy) : <AiState status={strategyStatus} error={strategyErr} />;

  const sections: SectionDef[] = [
    {
      id: "snapshot",
      title: "Team Snapshot",
      kind: "det",
      confidence: r.snapshotConfidence,
      node: (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Identity</p>
            <div className="flex flex-col gap-1.5">
              <KV k="Team" v={`#${r.team.number}`} />
              <KV k="Organization" v={r.team.organization || "—"} />
              <KV k="Location" v={r.team.location || "—"} />
              <KV k="Rookie year" v={r.team.rookieYear ?? "—"} />
            </div>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">National OPR percentiles</p>
            <div className="flex flex-col gap-2.5">
              {r.percentiles.map((p) => <PercentBar key={p.label} label={p.label} value={p.value} />)}
            </div>
          </div>
          <ul className="flex flex-col gap-1.5 border-t pt-3 sm:col-span-2" style={{ borderColor: "var(--panel-border)" }}>
            {r.snapshot.map((b, i) => (
              <li key={i} className="flex gap-2"><span style={{ color: "var(--ftc-blue)" }}>›</span><span>{b}</span></li>
            ))}
          </ul>
        </div>
      ),
    },
    {
      id: "stats",
      title: "Performance Statistics",
      kind: "det",
      confidence: r.statsConfidence,
      node: r.stats ? <StatsSection stats={r.stats} /> : <Unavailable text="Match-level score data was unavailable for this team, so detailed statistics could not be computed." />,
    },
    {
      id: "events",
      title: "Event-by-Event Breakdown",
      kind: "det",
      confidence: r.eventsConfidence,
      node: (
        <div className="flex flex-col gap-2.5">
          {r.events.map((e) => (
            <div key={e.code} className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--panel-border)" }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-white/90">{e.name}</span>
                <span className="text-xs text-white/40">{e.start} · {e.type}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 text-xs sm:grid-cols-3">
                <KV k="Rank" v={`#${e.rank}`} />
                <KV k="Record" v={e.record} />
                <KV k="Ranking pts" v={e.rankingPoints} />
                <KV k="Avg score" v={e.avgTotalPoints} />
                <KV k="Auto / Tele" v={`${e.avgAutoPoints} / ${e.avgDcPoints}`} />
                <KV k="OPR" v={e.oprTotal} />
                <KV k="Max score" v={e.maxScore} />
                <KV k="Avg penalties" v={e.avgPenaltyCommitted} />
                <KV k="Consistency (CV)" v={e.consistency} />
              </div>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "matches",
      title: "Complete Match History",
      kind: "det",
      confidence: r.matchesConfidence,
      node: r.matches.length ? <MatchHistory matches={r.matches} /> : <Unavailable text="Per-match records were unavailable for this team from FTCScout." />,
    },
    {
      id: "trend",
      title: "Performance Trends",
      kind: "det",
      confidence: r.trend.confidence,
      node: (() => {
        const maxOpr = Math.max(1, ...r.trend.points.map((p) => p.opr));
        return (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold" style={{ color: "var(--ftc-blue)", borderColor: "var(--ftc-blue-dim)", background: "rgba(0,114,206,0.12)" }}>{r.trend.headline}</span>
              <span className="text-xs text-white/45">{r.trend.note}</span>
            </div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Event OPR progression</p>
            <div className="flex flex-col gap-2">
              {r.trend.points.map((p, i) => (
                <div key={i}>
                  <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-white/60">{p.event}</span>
                    <span className="tabular-nums text-white/80">{p.opr}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${(p.opr / maxOpr) * 100}%`, background: "linear-gradient(90deg, var(--ftc-blue), #4aa3ff)" }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })(),
    },
    {
      id: "role",
      title: "Robot Role Classification",
      kind: "ai",
      node: (
        <div>
          {profile ? <RoleClassification role={profile.role} /> : <AiState status={profileStatus} error={profileErr} />}
          {r.roleScores && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Inferred role ratings</p>
              <RoleRatings roles={r.roleScores} />
            </div>
          )}
        </div>
      ),
    },
    { id: "autonomous", title: "Autonomous Analysis", kind: "ai", node: profileNode((p) => <PhaseView phase={p.autonomous} />) },
    { id: "teleop", title: "TeleOp Analysis", kind: "ai", node: profileNode((p) => <PhaseView phase={p.teleop} />) },
    { id: "strengths", title: "Strengths", kind: "ai", node: profileNode((p) => <StrengthsView items={p.strengths} />) },
    { id: "weaknesses", title: "Weaknesses & Risk Areas", kind: "ai", node: profileNode((p) => <WeaknessesView items={p.weaknesses} />) },
    {
      id: "notable",
      title: "Best & Concerning Matches",
      kind: "det",
      confidence: r.notableConfidence,
      node: r.hasMatchData ? <NotableMatches best={r.bestMatches} concerning={r.concerningMatches} /> : <Unavailable text="Requires match-level data, which was unavailable for this team." />,
    },
    { id: "counter", title: "How to Beat This Team", kind: "ai", node: strategyNode((s) => <CounterView c={s.counter} />) },
    { id: "alliance", title: "How to Recruit Them as a Partner", kind: "ai", node: strategyNode((s) => <AllianceView a={s.alliance} />) },
    { id: "scouting", title: "Pre-Match Scouting Questions", kind: "ai", node: strategyNode((s) => <ScoutingQuestionsView q={s.scoutingQuestions} />) },
    { id: "awards", title: "Awards & Recognition", kind: "det", confidence: r.awardsConfidence, node: <AwardsView awards={r.awards} /> },
    {
      id: "quality",
      title: "Data Quality & Confidence",
      kind: "det",
      confidence: r.dataQuality.confidence,
      node: (
        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Sources used</p>
              <ul className="flex flex-col gap-1">
                {r.dataQuality.sourcesUsed.map((s, i) => (
                  <li key={i} className="flex gap-2"><span className="text-emerald-400">✓</span><span>{s}</span></li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-white/50">Events found <span className="font-semibold text-white/80">{r.dataQuality.eventsFound}</span> · Matches found <span className="font-semibold text-white/80">{r.dataQuality.matchesFound}</span></p>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Not yet included</p>
              <ul className="flex flex-col gap-1">
                {r.dataQuality.missing.map((s, i) => (
                  <li key={i} className="flex gap-2 text-white/55"><span className="text-white/30">○</span><span>{s}</span></li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">Limitations</p>
            <ul className="flex flex-col gap-1">
              {r.dataQuality.limitations.map((l, i) => (
                <li key={i} className="flex gap-2 text-white/60"><span className="text-amber-400/80">!</span><span>{l}</span></li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-white/50">{r.dataQuality.explanation}</p>
          </div>
        </div>
      ),
    },
    { id: "verdict", title: "Final Scouting Verdict", kind: "ai", node: profileNode((p) => <VerdictView v={p.verdict} />) },
  ];

  const allIds = sections.map((s) => s.id);
  const { open, allOpen, toggle, toggleAll } = useAccordion(allIds, ["snapshot"]);
  const [copied, setCopied] = useState(false);
  const base = `team_${r.team.number}_DECODE`;

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(r, profile, strategy));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  const overallShort = r.overallConfidence.label.replace(" confidence", "");

  return (
    <div className="flex flex-col gap-4">
      {/* Header dossier card */}
      <div className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "linear-gradient(160deg, rgba(0,114,206,0.14), rgba(11,18,32,0.25))" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-2xl font-black" style={{ color: "var(--ftc-blue)" }}>#{r.team.number}</span>
              <span className="text-2xl font-black text-white">{r.team.name}</span>
            </div>
            <p className="mt-1 text-sm text-white/55">
              {r.season.name} ({r.season.years}) · scouting dossier · overall confidence: <span className="font-semibold text-white/75">{overallShort}</span>
            </p>
            {(r.team.organization || r.team.location) && (
              <p className="mt-0.5 text-xs text-white/40">
                {[r.team.organization, r.team.location].filter(Boolean).join(" · ")}{r.team.rookieYear ? ` · rookie ${r.team.rookieYear}` : ""}
              </p>
            )}
          </div>
          <TierBadge grade={r.grade} label={r.gradeLabel} />
        </div>
      </div>

      {/* Headline stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {r.headline.map((s) => <StatBox key={s.label} label={s.label} value={s.value} sub={s.sub} />)}
      </div>

      {/* Executive Summary (AI) */}
      <div className="rounded-2xl border p-4" style={{ borderColor: "rgba(192,132,252,0.30)", background: "linear-gradient(160deg, rgba(192,132,252,0.10), rgba(11,18,32,0.20))" }}>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "#c084fc" }}>Executive Summary</span>
          <ConfidenceBadge ai />
        </div>
        {profile ? (
          <p className="text-sm leading-relaxed text-white/80">{profile.executiveSummary}</p>
        ) : profileStatus === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-white/50"><Spinner /> Generating from the verified data…</p>
        ) : (
          <p className="text-sm text-white/45">{profileErr ?? "AI analysis is unavailable — the deterministic dossier below is complete on its own."}</p>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={copyReport} className="chip">{copied ? "Copied ✓" : "Copy report"}</button>
        <button type="button" onClick={() => download(`${base}.md`, reportToMarkdown(r, profile, strategy), "text/markdown")} className="chip">Export .md</button>
        <button type="button" onClick={() => download(`${base}.json`, JSON.stringify({ ...r, narrative: { ...(profile ?? {}), ...(strategy ?? {}) } }, null, 2), "application/json")} className="chip">Export .json</button>
        {r.matches.length > 0 && (
          <button type="button" onClick={() => download(`${base}_matches.csv`, matchHistoryCsv(r.matches), "text/csv")} className="chip">Export matches .csv</button>
        )}
        {onRefresh && (
          <button type="button" onClick={onRefresh} className="chip" title="Bypass the cache and rebuild from fresh FTCScout data">↻ Refresh</button>
        )}
        <button type="button" onClick={toggleAll} className="chip ml-auto">{allOpen ? "Collapse all" : "Expand all"}</button>
      </div>

      {/* Sections */}
      <div className="flex flex-col gap-2.5">
        {sections.map((s, i) =>
          s.kind === "ai" ? (
            <Collapsible key={s.id} index={i + 1} title={s.title} ai open={open.has(s.id)} onToggle={() => toggle(s.id)}>
              {s.node}
            </Collapsible>
          ) : (
            <Collapsible key={s.id} index={i + 1} title={s.title} confidence={s.confidence} open={open.has(s.id)} onToggle={() => toggle(s.id)}>
              {s.node}
            </Collapsible>
          ),
        )}
      </div>

      <p className="mt-1 text-center text-[11px] text-white/30">
        Generated {new Date(r.generatedAt).toLocaleString()} · data from FTCScout · AI narrative by Claude · DECODE {r.season.years} only
      </p>
    </div>
  );
}
