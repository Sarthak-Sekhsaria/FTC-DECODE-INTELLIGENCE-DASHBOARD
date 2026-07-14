import { NextRequest, NextResponse } from "next/server";
import { getTeamAnalysis, type TeamAnalysisError } from "@/lib/teamAnalysis/report";

export const runtime = "nodejs";

function err(code: TeamAnalysisError["code"], message: string, status: number) {
  return NextResponse.json<TeamAnalysisError>({ ok: false, code, message }, { status });
}

// GET /api/team-analysis/:team[?refresh=1]
// Validates the team number, then returns a structured DECODE-season report (or a
// typed error) built purely from verified FTCScout data. Results are cached; pass
// ?refresh=1 to force a rebuild.
export async function GET(req: NextRequest, { params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;

  if (!/^\d+$/.test(team)) {
    return err("INVALID_TEAM", "Team number must contain digits only.", 400);
  }
  const n = Number(team);
  if (!Number.isInteger(n) || n <= 0) {
    return err("INVALID_TEAM", "Please enter a valid positive team number.", 400);
  }

  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    const { result } = await getTeamAnalysis(n, refresh);
    if (!result.ok) {
      const status = result.code === "TEAM_NOT_FOUND" || result.code === "NO_DECODE_DATA" ? 404 : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (e) {
    return err("UPSTREAM_ERROR", `Failed to reach FTCScout: ${(e as Error).message}`, 502);
  }
}
