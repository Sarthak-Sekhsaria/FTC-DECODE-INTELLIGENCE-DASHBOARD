// Shared shape of a structured DECODE match prediction, and the Anthropic tool
// schema used to force the model to return it.

export interface TeamBreakdown {
  number: number;
  name: string;
  strengths: string;
  weaknesses: string;
  decodeSummary: string;
  reliability: string;
  bestRole: string;
}

export interface AllianceInput {
  team1: { number: number; name: string };
  team2: { number: number; name: string };
}

export interface MatchPrediction {
  redAlliance: AllianceInput;
  blueAlliance: AllianceInput;
  winner: "Red Alliance" | "Blue Alliance";
  confidence: number;
  redScoreLow: number;
  redScoreHigh: number;
  blueScoreLow: number;
  blueScoreHigh: number;
  whyFavored: string;
  redTeamBreakdowns: [TeamBreakdown, TeamBreakdown];
  blueTeamBreakdowns: [TeamBreakdown, TeamBreakdown];
  allianceCompatibility: string;
  riskFactors: string[];
  confidenceExplanation: string;
  finalSummary: string;
  dataNotes: string[];
}

const teamBreakdownSchema = {
  type: "object",
  properties: {
    number: { type: "integer" },
    name: { type: "string", description: "Team name if known, otherwise 'Unknown'" },
    strengths: { type: "string" },
    weaknesses: { type: "string" },
    decodeSummary: { type: "string", description: "DECODE performance summary" },
    reliability: { type: "string" },
    bestRole: { type: "string", description: "Best role in the alliance (lead scorer / support / etc.)" },
  },
  required: ["number", "name", "strengths", "weaknesses", "decodeSummary", "reliability", "bestRole"],
};

const allianceInputSchema = {
  type: "object",
  properties: {
    team1: {
      type: "object",
      properties: { number: { type: "integer" }, name: { type: "string" } },
      required: ["number", "name"],
    },
    team2: {
      type: "object",
      properties: { number: { type: "integer" }, name: { type: "string" } },
      required: ["number", "name"],
    },
  },
  required: ["team1", "team2"],
};

export const SUBMIT_PREDICTION_TOOL = {
  name: "submit_prediction",
  description:
    "Submit the complete, structured FTC DECODE match prediction for the given alliances.",
  input_schema: {
    type: "object" as const,
    properties: {
      redAlliance: allianceInputSchema,
      blueAlliance: allianceInputSchema,
      winner: { type: "string", enum: ["Red Alliance", "Blue Alliance"] },
      confidence: {
        type: "integer",
        minimum: 50,
        maximum: 100,
        description: "Confidence percentage per the 50-100 scale described in the instructions",
      },
      redScoreLow: { type: "integer" },
      redScoreHigh: { type: "integer" },
      blueScoreLow: { type: "integer" },
      blueScoreHigh: { type: "integer" },
      whyFavored: {
        type: "string",
        description:
          "Main reasons the predicted alliance is favored: scoring strength, autonomous, TeleOp, endgame, consistency, alliance compatibility.",
      },
      redTeamBreakdowns: { type: "array", items: teamBreakdownSchema, minItems: 2, maxItems: 2 },
      blueTeamBreakdowns: { type: "array", items: teamBreakdownSchema, minItems: 2, maxItems: 2 },
      allianceCompatibility: {
        type: "string",
        description: "Comparison of Red teams' synergy vs Blue teams' synergy.",
      },
      riskFactors: {
        type: "array",
        items: { type: "string" },
        description: "Things that could make the prediction wrong.",
      },
      confidenceExplanation: { type: "string" },
      finalSummary: {
        type: "string",
        description: "Short final paragraph in simple language for an FTC team strategist.",
      },
      dataNotes: {
        type: "array",
        items: { type: "string" },
        description: "Notes about missing or estimated data, if any. Empty array if data was complete.",
      },
    },
    required: [
      "redAlliance",
      "blueAlliance",
      "winner",
      "confidence",
      "redScoreLow",
      "redScoreHigh",
      "blueScoreLow",
      "blueScoreHigh",
      "whyFavored",
      "redTeamBreakdowns",
      "blueTeamBreakdowns",
      "allianceCompatibility",
      "riskFactors",
      "confidenceExplanation",
      "finalSummary",
      "dataNotes",
    ],
  },
};
