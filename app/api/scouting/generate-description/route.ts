import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { fetchTeamResearch, formatTeamResearchForPrompt, DECODE_SEASON } from "@/lib/ftcscout";
import { SCOUTING_DESCRIPTION_SYSTEM_PROMPT } from "@/lib/scouting/prompt";
import { SUBMIT_SCOUTING_REPORT_TOOL, type ScoutingReportNarrative } from "@/lib/scouting/reportSchema";
import { totalScore, type ScoutingSession, type ScoutingReport } from "@/lib/scouting/types";

export const runtime = "nodejs";

function isValidSession(s: unknown): s is ScoutingSession {
  if (!s || typeof s !== "object") return false;
  const session = s as Partial<ScoutingSession>;
  return (
    typeof session.teamNumber === "number" &&
    Number.isInteger(session.teamNumber) &&
    session.teamNumber > 0 &&
    (session.alliance === "red" || session.alliance === "blue") &&
    (session.startPosition === "far" || session.startPosition === "near") &&
    !!session.autonomous &&
    !!session.teleop &&
    !!session.endgame
  );
}

function buildUserMessage(session: ScoutingSession, ftcScoutContext: string, total: number): string {
  const { autonomous, teleop, endgame } = session;
  const lines: string[] = [];

  lines.push(`Team ${session.teamNumber} — ${session.alliance.toUpperCase()} alliance, ${session.startPosition} start.`);
  lines.push(`Total scouted score this match: ${total} (autonomous ${autonomous.score} + teleop ${teleop.score} + endgame ${endgame.score}).`);
  lines.push("");
  lines.push("Autonomous:");
  lines.push(`- Artifacts scored: ${autonomous.artifacts} (${autonomous.artifacts * 3} pts)`);
  lines.push(`- Pattern actions: ${autonomous.pattern} (${autonomous.pattern * 2} pts)`);
  lines.push(`- Gate cycles: ${autonomous.gate} (tracked only, 0 pts)`);
  lines.push(`- Autonomous score: ${autonomous.score}`);
  lines.push("");
  lines.push("Teleop:");
  lines.push(`- Artifacts scored: ${teleop.artifacts} (${teleop.artifacts * 3} pts)`);
  lines.push(`- Human Player 1 actions: ${teleop.humanPlayer1} (tracked only, 0 pts)`);
  lines.push(`- Human Player 2 actions: ${teleop.humanPlayer2} (tracked only, 0 pts)`);
  lines.push(`- Teleop score: ${teleop.score}`);
  lines.push("");
  lines.push("Endgame:");
  lines.push(`- Driver Power: ${endgame.driverPowerPct}%`);
  lines.push(`- Base status: ${endgame.baseStatus} (${endgame.score} pts)`);
  if (endgame.minorFouls > 0 || endgame.majorFouls > 0) {
    lines.push(`- Minor fouls: ${endgame.minorFouls}`);
    lines.push(`- Major fouls: ${endgame.majorFouls}`);
  }
  // Intentionally omitted when both are 0: no foul data at all is given to the
  // model, so it has nothing to reference and cannot comment on "no fouls" either.
  if (endgame.tacticalNotes.trim()) {
    lines.push(`- Scout's tactical notes: "${endgame.tacticalNotes.trim()}"`);
  }
  lines.push("");
  lines.push(`--- FTCScout season ${DECODE_SEASON} context for team ${session.teamNumber} ---`);
  lines.push(ftcScoutContext);
  lines.push("");
  lines.push("Call the submit_scouting_report tool now with the full structured report.");

  return lines.join("\n");
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Defensive normalization for the tool-call output. Tool-call arguments are
// generated text, not a strictly validated payload — on rare occasions Claude
// returns a field with the wrong shape for an array field: one long string
// (newline- or comma-separated) instead of a real array, or a placeholder
// token (e.g. "<![CDATA[]]>", "<UNKNOWN>") instead of real content — most
// often for a team with essentially nothing notable in that category. Coerce
// and filter rather than crash or leak the placeholder into the saved report.
const JUNK_ITEM_RE = /^(<[^>]*>|n\/a|none noted?|none|unknown|null|undefined)\.?$/i;
const CDATA_RE = /^<!\[CDATA\[.*\]\]>$/i;

function splitIntoItems(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/,\s+(?=[A-Z])/))
    .map((s) => s.replace(/^[-•*]\s*/, "").trim());
}

function ensureStringArray(value: unknown): string[] {
  const items: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? splitIntoItems(value)
      : [];

  return items
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !CDATA_RE.test(s) && !JUNK_ITEM_RE.test(s));
}

function ensureString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeNarrative(raw: ScoutingReportNarrative): ScoutingReportNarrative {
  return {
    autonomousAnalysis: ensureString(raw.autonomousAnalysis, "No autonomous analysis was generated."),
    teleopAnalysis: ensureString(raw.teleopAnalysis, "No teleop analysis was generated."),
    endgameAnalysis: ensureString(raw.endgameAnalysis, "No endgame analysis was generated."),
    strengths: ensureStringArray(raw.strengths),
    weaknesses: ensureStringArray(raw.weaknesses),
    counterStrategy: ensureString(raw.counterStrategy, "Not enough data to suggest a counter-strategy."),
    partnerStrategy: ensureString(raw.partnerStrategy, "Not enough data to suggest a partner strategy."),
    finalSummary: ensureString(raw.finalSummary, "No summary was generated."),
  };
}

const RULE = "-".repeat(44);

function section(title: string, body: string): string {
  return `${RULE}\n${title}\n${RULE}\n${body.trim()}\n`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "None noted this match.";
  return items.map((item) => `- ${item}`).join("\n");
}

// Pure string formatting — no LLM call — so saving the report never costs any
// additional tokens beyond the single generation call already made above.
function formatReportAsText(report: ScoutingReport): string {
  const parts: string[] = [];

  parts.push("=".repeat(44));
  parts.push(" FTC DECODE SCOUTING REPORT");
  parts.push("=".repeat(44));
  parts.push("");
  parts.push("TEAM SNAPSHOT");
  parts.push(`  Team Number:      ${report.teamNumber}`);
  parts.push(`  Alliance:         ${report.alliance.toUpperCase()}`);
  parts.push(`  Start Position:   ${report.startPosition === "far" ? "Far Start" : "Near Start"}`);
  parts.push("");
  parts.push(`  AUTONOMOUS SCORE: ${report.autonomousScore}`);
  parts.push(`  TELEOP SCORE:     ${report.teleopScore}`);
  parts.push(`  ENDGAME SCORE:    ${report.endgameScore}`);
  parts.push(`  ${"-".repeat(24)}`);
  parts.push(`  TOTAL SCORE:      ${report.totalScore}`);
  parts.push("");
  parts.push(`  Driver Power:     ${report.driverPowerPct}%`);
  parts.push(`  Base Status:      ${report.baseStatus.charAt(0).toUpperCase()}${report.baseStatus.slice(1)}`);
  parts.push("");
  parts.push(section("AUTONOMOUS ANALYSIS", report.autonomousAnalysis));
  parts.push(section("TELEOP ANALYSIS", report.teleopAnalysis));
  parts.push(section("ENDGAME ANALYSIS", report.endgameAnalysis));
  parts.push(section("STRENGTHS", bulletList(report.strengths)));
  parts.push(section("WEAKNESSES / CONCERNS", bulletList(report.weaknesses)));
  parts.push(section("HOW TO COUNTER THIS TEAM", report.counterStrategy));
  parts.push(section("PARTNER STRATEGY / HOW TO USE THEM", report.partnerStrategy));
  parts.push(
    section(
      "TACTICAL NOTES",
      report.tacticalNotes.trim() ? report.tacticalNotes.trim() : "No tactical notes entered.",
    ),
  );
  parts.push(section("FINAL SUMMARY", report.finalSummary));
  parts.push(`Generated: ${report.timestamp}`);

  return parts.join("\n");
}

export async function POST(req: NextRequest) {
  let body: { session?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidSession(body.session)) {
    return NextResponse.json({ error: "Missing or invalid scouting session data." }, { status: 400 });
  }
  const session = body.session;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  let ftcScoutContext: string;
  try {
    const research = await fetchTeamResearch(session.teamNumber, DECODE_SEASON);
    ftcScoutContext = formatTeamResearchForPrompt(research);
  } catch (err) {
    ftcScoutContext = `FTCScout lookup failed (${(err as Error).message}). Season context is unavailable — describe only the scouted match.`;
  }

  const total = totalScore(session);
  const userMessage = buildUserMessage(session, ftcScoutContext, total);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  let narrative: ScoutingReportNarrative;
  try {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: SCOUTING_DESCRIPTION_SYSTEM_PROMPT,
      tools: [SUBMIT_SCOUTING_REPORT_TOOL],
      tool_choice: { type: "tool", name: "submit_scouting_report" },
      messages: [{ role: "user", content: userMessage }],
    });
    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return NextResponse.json({ error: "Claude did not return a structured report." }, { status: 502 });
    }
    narrative = normalizeNarrative(toolUse.input as ScoutingReportNarrative);
  } catch (err) {
    return NextResponse.json({ error: `Claude API request failed: ${(err as Error).message}` }, { status: 502 });
  }

  const timestamp = new Date().toISOString();
  const safeTs = safeTimestamp();
  const sessionId = `team_${session.teamNumber}_${safeTs}`;
  const dirPath = path.join(process.cwd(), "Team_Descriptions");
  const txtPath = path.join(dirPath, `${sessionId}.txt`);
  const jsonPath = path.join(dirPath, `${sessionId}.json`);

  const report: ScoutingReport = {
    sessionId,
    timestamp,
    savedPath: `Team_Descriptions/${sessionId}.txt`,
    teamNumber: session.teamNumber,
    alliance: session.alliance,
    startPosition: session.startPosition,
    autonomousScore: session.autonomous.score,
    teleopScore: session.teleop.score,
    endgameScore: session.endgame.score,
    totalScore: total,
    driverPowerPct: session.endgame.driverPowerPct,
    baseStatus: session.endgame.baseStatus,
    tacticalNotes: session.endgame.tacticalNotes,
    ...narrative,
    session,
  };

  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(txtPath, formatReportAsText(report), "utf-8");
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  } catch (err) {
    return NextResponse.json(
      { error: `Report was generated but could not be saved to disk: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return NextResponse.json(report);
}
