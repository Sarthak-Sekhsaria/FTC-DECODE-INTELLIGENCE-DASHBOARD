import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchTeamResearch, formatTeamResearchForPrompt, DECODE_SEASON } from "@/lib/ftcscout";
import { FTC_DECODE_SYSTEM_PROMPT, OUTPUT_FORMAT_INSTRUCTIONS } from "@/lib/systemPrompt";
import { SUBMIT_PREDICTION_TOOL, type MatchPrediction } from "@/lib/predictionSchema";

export const runtime = "nodejs";

interface PredictRequestBody {
  redTeam1: number;
  redTeam2: number;
  blueTeam1: number;
  blueTeam2: number;
}

function parseTeamNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(req: NextRequest) {
  let body: Partial<PredictRequestBody>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const redTeam1 = parseTeamNumber(body.redTeam1);
  const redTeam2 = parseTeamNumber(body.redTeam2);
  const blueTeam1 = parseTeamNumber(body.blueTeam1);
  const blueTeam2 = parseTeamNumber(body.blueTeam2);

  if (!redTeam1 || !redTeam2 || !blueTeam1 || !blueTeam2) {
    return NextResponse.json(
      { error: "All four team numbers (redTeam1, redTeam2, blueTeam1, blueTeam2) are required positive integers." },
      { status: 400 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  let research;
  try {
    research = await Promise.all(
      [redTeam1, redTeam2, blueTeam1, blueTeam2].map((n) => fetchTeamResearch(n, DECODE_SEASON)),
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch team research from FTCScout: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const [redResearch1, redResearch2, blueResearch1, blueResearch2] = research;

  const userMessage = `Red Alliance: ${redTeam1}, ${redTeam2}
Blue Alliance: ${blueTeam1}, ${blueTeam2}

Below is FTC DECODE season (season ${DECODE_SEASON}) research data pulled from FTCScout, a public FTC scouting database that aggregates official FTC Events results, for each of the four teams. Use it as your primary research source per your instructions. Where a team is marked NOT FOUND or has no played events, treat that data as missing and follow your rules for handling missing data.

--- RED ALLIANCE ---

${formatTeamResearchForPrompt(redResearch1)}

${formatTeamResearchForPrompt(redResearch2)}

--- BLUE ALLIANCE ---

${formatTeamResearchForPrompt(blueResearch1)}

${formatTeamResearchForPrompt(blueResearch2)}

Now produce your structured DECODE match prediction by calling the submit_prediction tool.`;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  let message;
  try {
    message = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: `${FTC_DECODE_SYSTEM_PROMPT}\n\n${OUTPUT_FORMAT_INSTRUCTIONS}`,
      tools: [SUBMIT_PREDICTION_TOOL],
      tool_choice: { type: "tool", name: "submit_prediction" },
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Claude API request failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return NextResponse.json({ error: "Claude did not return a structured prediction." }, { status: 502 });
  }

  const prediction = toolUse.input as MatchPrediction;
  return NextResponse.json(prediction);
}
