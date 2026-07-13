// Anthropic tool schema used to force a structured scouting report out of the
// model. Only narrative fields are requested here — scores, driver power, base
// status, and tactical notes are computed/copied directly from the scouted
// session in app/api/scouting/generate-description/route.ts, never authored by
// the model, so they can't drift from the actual data.

export interface ScoutingReportNarrative {
  autonomousAnalysis: string;
  teleopAnalysis: string;
  endgameAnalysis: string;
  strengths: string[];
  weaknesses: string[];
  counterStrategy: string;
  partnerStrategy: string;
  finalSummary: string;
}

export const SUBMIT_SCOUTING_REPORT_TOOL = {
  name: "submit_scouting_report",
  description: "Submit the complete, structured scouting report narrative for this team's match.",
  input_schema: {
    type: "object" as const,
    properties: {
      autonomousAnalysis: {
        type: "string",
        description:
          "2-4 sentences on autonomous: strong/average/weak contribution, whether they relied more on artifacts or pattern scoring, whether they used gate actions, and how useful their auto is strategically.",
      },
      teleopAnalysis: {
        type: "string",
        description:
          "2-4 sentences on teleop: how active they were, whether artifact scoring was strong or low, whether human player actions were involved, and what their cycle rhythm seems like.",
      },
      endgameAnalysis: {
        type: "string",
        description:
          "2-3 sentences on endgame: driver control quality based on Driver Power, endgame reliability based on base status, and whether they're valuable late-match.",
      },
      strengths: {
        type: "array",
        items: { type: "string" },
        description:
          "3-6 short bullet points, each grounded in the actual scouted data (e.g. 'Strong artifact output in teleop'). Never invent a strength the data doesn't support.",
      },
      weaknesses: {
        type: "array",
        items: { type: "string" },
        description:
          "3-6 short bullet points on weaknesses/concerns, each grounded in the actual scouted data. Only include a foul-related item if foul data was actually given to you — otherwise never mention fouls.",
      },
      counterStrategy: {
        type: "string",
        description:
          "3-5 sentences on how an opposing alliance could legally reduce this team's impact, based on their actual strengths/weaknesses above (e.g. building an early auto lead if their auto is weak, applying clean legal pressure if driver power is low). Must stay realistic and fully within FTC competition rules — never suggest illegal contact, blocking, or rule-breaking of any kind.",
      },
      partnerStrategy: {
        type: "string",
        description:
          "2-4 sentences on how this team could be used effectively as an alliance partner, based on their actual data (e.g. which phase to let them focus on, what kind of partner would complement them).",
      },
      finalSummary: {
        type: "string",
        description:
          "3-5 sentences: overall value of the team, their best role, their biggest concern, and whether they look like a strong partner, risky partner, or defensive target.",
      },
    },
    required: [
      "autonomousAnalysis",
      "teleopAnalysis",
      "endgameAnalysis",
      "strengths",
      "weaknesses",
      "counterStrategy",
      "partnerStrategy",
      "finalSummary",
    ],
  },
};
