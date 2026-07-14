import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getTeamAnalysis } from "@/lib/teamAnalysis/report";
import { NARRATIVE_SYSTEM_PROMPT, formatReportForNarrative } from "@/lib/teamAnalysis/narrativePrompt";
import {
  SUBMIT_PROFILE_TOOL,
  SUBMIT_STRATEGY_TOOL,
  isValidProfile,
  isValidStrategy,
  type NarrativeProfile,
  type NarrativeStrategy,
} from "@/lib/teamAnalysis/narrativeSchema";
import { TtlCache } from "@/lib/teamAnalysis/cache";

export const runtime = "nodejs";

// The narrative is generated in two independent halves (profile + strategy). Cache
// each half on its own so a Refresh only regenerates the part that failed, and a
// glitch in one half never discards a good other half. Cached 60 min.
const profileCache = new TtlCache<NarrativeProfile>(60 * 60 * 1000);
const strategyCache = new TtlCache<NarrativeStrategy>(60 * 60 * 1000);

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

// POST /api/team-analysis/:team/narrative[?refresh=1]
// Rebuilds (or reuses the cached) deterministic report, then asks Claude for the
// evidence-based narrative from that digest only. Returns whichever halves succeed
// (partial success is fine); the deterministic dossier works without any of it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  if (!/^\d+$/.test(team)) return err("INVALID_TEAM", "Team number must contain digits only.", 400);
  const n = Number(team);
  const key = String(n);
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";

  let profile: NarrativeProfile | null = refresh ? null : profileCache.get(key)?.value ?? null;
  let strategy: NarrativeStrategy | null = refresh ? null : strategyCache.get(key)?.value ?? null;

  // Both halves already cached — nothing to generate.
  if (profile && strategy) return NextResponse.json({ ok: true, profile, strategy });

  if (!process.env.ANTHROPIC_API_KEY) {
    // Serve whatever is cached; only hard-fail when we have nothing at all.
    if (profile || strategy) return NextResponse.json({ ok: true, profile, strategy });
    return err("NO_API_KEY", "AI analysis is unavailable — add ANTHROPIC_API_KEY to .env.local and restart the server.", 503);
  }

  let report;
  try {
    report = (await getTeamAnalysis(n, refresh)).result;
  } catch (e) {
    return err("UPSTREAM_ERROR", `Failed to reach FTCScout: ${(e as Error).message}`, 502);
  }
  if (!report.ok) {
    return NextResponse.json(report, { status: report.code === "TEAM_NOT_FOUND" || report.code === "NO_DECODE_DATA" ? 404 : 400 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const userMessage = formatReportForNarrative(report);

  // Each half is validated; the model occasionally emits malformed tool output, so
  // retry a failed half a couple of times before giving up on it.
  async function generatePart<T>(
    tool: typeof SUBMIT_PROFILE_TOOL | typeof SUBMIT_STRATEGY_TOOL,
    validate: (x: unknown) => x is T,
    maxTokens: number,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: NARRATIVE_SYSTEM_PROMPT,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: userMessage }],
        });
        const toolUse = message.content.find((b) => b.type === "tool_use");
        const candidate = toolUse && toolUse.type === "tool_use" ? toolUse.input : null;
        if (validate(candidate)) return candidate;
        console.error(`[narrative] ${tool.name} attempt ${attempt}: output failed validation`);
      } catch (e) {
        console.error(`[narrative] ${tool.name} attempt ${attempt} error:`, (e as Error).message);
      }
    }
    return null;
  }

  const [nextProfile, nextStrategy] = await Promise.all([
    profile ?? generatePart(SUBMIT_PROFILE_TOOL, isValidProfile, 12000),
    strategy ?? generatePart(SUBMIT_STRATEGY_TOOL, isValidStrategy, 8000),
  ]);
  profile = nextProfile;
  strategy = nextStrategy;

  if (profile) profileCache.set(key, profile);
  if (strategy) strategyCache.set(key, strategy);

  if (!profile && !strategy) {
    return err("AI_ERROR", "Claude returned an incomplete analysis. Use Refresh to try again.", 502);
  }

  return NextResponse.json({ ok: true, profile, strategy });
}
