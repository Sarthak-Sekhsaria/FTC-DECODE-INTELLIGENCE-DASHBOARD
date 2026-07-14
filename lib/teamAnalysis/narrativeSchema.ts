// Structured shape of the AI narrative layer, plus the Anthropic tool schemas that
// force the model to return it. The model reasons ONLY over the deterministic
// report digest it is given — it does not research from memory.
//
// The narrative is generated in TWO smaller parallel tool-calls (a "profile" pass
// and a "strategy" pass) rather than one giant schema: a single deeply-nested
// schema of this size reliably confuses the model into emitting malformed output,
// whereas each half stays at a complexity the model handles cleanly.

export type NarrativeConfidence = "very-high" | "high" | "medium" | "low" | "very-low";
export type Severity = "low" | "medium" | "high";

export interface NarrativeStrength {
  title: string;
  claim: string;
  evidence: string[];
  confidence: NarrativeConfidence;
  limitations: string[];
}

export interface NarrativeWeakness {
  title: string;
  risk: string;
  evidence: string[];
  severity: Severity;
  exploit: string;
  confidence: NarrativeConfidence;
}

// Robot role classification (in-depth).
export interface RobotRole {
  archetype: string;
  primary: string;
  secondary: string;
  reasoning: string;
  idealResponsibilities: string[];
  notSuitedFor: string[];
  confidence: NarrativeConfidence;
}

// Reused for the Autonomous and TeleOp deep-dives.
export interface PhaseAnalysis {
  summary: string;
  strength: string;
  consistency: string;
  observations: string[];
  confidence: NarrativeConfidence;
}

// "How to beat this team" — the counter game plan.
export interface CounterStrategy {
  gamePlan: string;
  topThreat: string;
  autoCounter: string;
  teleopCounter: string;
  legalDefense: string[];
  doNotDo: string[];
  risksOfThisPlan: string[];
  confidence: NarrativeConfidence;
}

// "How to get them as an alliance partner" — recruitment fit.
export interface AllianceRecruitment {
  verdict: string;
  whyPickThem: string[];
  whatYouProvide: string[];
  roleOnYourAlliance: string;
  pitchNotes: string;
  backupConsideration: string;
  confidence: NarrativeConfidence;
}

export interface ScoutingQuestions {
  pit: string[];
  strategy: string[];
  rationale: string;
}

export interface NarrativeVerdict {
  tier: string;
  greatestStrength: string;
  greatestWeakness: string;
  allianceRecommendation: string;
  paragraph: string;
  oneSentence: string;
}

// Pass 1 output.
export interface NarrativeProfile {
  executiveSummary: string;
  role: RobotRole;
  autonomous: PhaseAnalysis;
  teleop: PhaseAnalysis;
  strengths: NarrativeStrength[];
  weaknesses: NarrativeWeakness[];
  verdict: NarrativeVerdict;
  dataNotes: string[];
}

// Pass 2 output.
export interface NarrativeStrategy {
  counter: CounterStrategy;
  alliance: AllianceRecruitment;
  scoutingQuestions: ScoutingQuestions;
}

export type TeamNarrative = NarrativeProfile & NarrativeStrategy;

// ---- runtime validation -----------------------------------------------------
// The model occasionally returns malformed/partial tool input (e.g. a nested
// object emitted as a string). Never trust, cache, or render such output.

const str = (v: unknown) => typeof v === "string" && v.length > 0;
const arr = (v: unknown) => Array.isArray(v) && v.length > 0;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function isValidProfile(n: unknown): n is NarrativeProfile {
  if (!obj(n)) return false;
  return (
    str(n.executiveSummary) &&
    obj(n.role) && str(n.role.archetype) &&
    obj(n.autonomous) && str(n.autonomous.summary) &&
    obj(n.teleop) && str(n.teleop.summary) &&
    arr(n.strengths) &&
    arr(n.weaknesses) &&
    obj(n.verdict) && str(n.verdict.paragraph)
  );
}

export function isValidStrategy(n: unknown): n is NarrativeStrategy {
  if (!obj(n)) return false;
  return (
    obj(n.counter) && str(n.counter.gamePlan) &&
    obj(n.alliance) && str(n.alliance.verdict) &&
    obj(n.scoutingQuestions) && arr(n.scoutingQuestions.pit) && arr(n.scoutingQuestions.strategy)
  );
}

export function isCompleteNarrative(n: unknown): n is TeamNarrative {
  return isValidProfile(n) && isValidStrategy(n);
}

// ---- tool schemas -----------------------------------------------------------

const CONFIDENCE = {
  type: "string",
  enum: ["very-high", "high", "medium", "low", "very-low"],
  description: "Confidence in this specific claim, per the report's evidence.",
};

const strengthSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short, specific strength title." },
    claim: { type: "string", description: "The claim, using hedged language (e.g. 'The data suggests…')." },
    evidence: { type: "array", items: { type: "string" }, description: "1–3 specific data points from the digest that support the claim." },
    confidence: CONFIDENCE,
    limitations: { type: "array", items: { type: "string" }, description: "Caveats — especially the alliance-level limitation where relevant." },
  },
  required: ["title", "claim", "evidence", "confidence", "limitations"],
};

const weaknessSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    risk: { type: "string", description: "The risk, in neutral, respectful language." },
    evidence: { type: "array", items: { type: "string" } },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    exploit: { type: "string", description: "How an opposing alliance could LEGALLY take advantage, within FTC rules." },
    confidence: CONFIDENCE,
  },
  required: ["title", "risk", "evidence", "severity", "exploit", "confidence"],
};

const phaseSchema = (phase: string) => ({
  type: "object",
  properties: {
    summary: { type: "string", description: `Overall ${phase} assessment for this team.` },
    strength: { type: "string", description: `How strong they are in ${phase}, citing figures (percentile, avg points).` },
    consistency: { type: "string", description: `How consistent/reliable their ${phase} output is (event-to-event or within-event).` },
    observations: { type: "array", items: { type: "string" }, description: `2–4 specific, data-backed observations. Include ranking-point relevance where applicable.` },
    confidence: CONFIDENCE,
  },
  required: ["summary", "strength", "consistency", "observations", "confidence"],
});

const roleSchema = {
  type: "object",
  properties: {
    archetype: { type: "string", description: "One-line robot archetype, e.g. 'High-output primary scorer with elite autonomous'." },
    primary: { type: "string", description: "Primary strategic role." },
    secondary: { type: "string" },
    reasoning: { type: "string", description: "Why this classification, from the data (percentiles, scoring split, consistency)." },
    idealResponsibilities: { type: "array", items: { type: "string" } },
    notSuitedFor: { type: "array", items: { type: "string" } },
    confidence: CONFIDENCE,
  },
  required: ["archetype", "primary", "secondary", "reasoning", "idealResponsibilities", "notSuitedFor", "confidence"],
};

const verdictSchema = {
  type: "object",
  properties: {
    tier: { type: "string" },
    greatestStrength: { type: "string" },
    greatestWeakness: { type: "string" },
    allianceRecommendation: { type: "string" },
    paragraph: { type: "string", description: "One-paragraph final verdict." },
    oneSentence: { type: "string", description: "One-sentence scouting summary." },
  },
  required: ["tier", "greatestStrength", "greatestWeakness", "allianceRecommendation", "paragraph", "oneSentence"],
};

export const SUBMIT_PROFILE_TOOL = {
  name: "submit_profile",
  description:
    "Submit the team's evidence-based profile: executive summary, robot role classification, in-depth autonomous and teleop analysis, strengths, weaknesses, and final verdict. Ground every claim in the digest.",
  input_schema: {
    type: "object" as const,
    // Property order matters for generation reliability: keep the array fields
    // ahead of the nested-object fields (a nested object appearing first tends to
    // make the model drift into malformed output).
    properties: {
      executiveSummary: { type: "string", description: "3–5 sentence summary: overall level, top strength and weakness, best role, alliance value." },
      strengths: { type: "array", items: strengthSchema, minItems: 3, maxItems: 6 },
      weaknesses: { type: "array", items: weaknessSchema, minItems: 3, maxItems: 6 },
      role: roleSchema,
      autonomous: phaseSchema("autonomous"),
      teleop: phaseSchema("teleop"),
      verdict: verdictSchema,
      dataNotes: { type: "array", items: { type: "string" }, description: "Notes about missing/uncertain data. Empty array if none." },
    },
    required: ["executiveSummary", "strengths", "weaknesses", "role", "autonomous", "teleop", "verdict", "dataNotes"],
  },
};

const counterSchema = {
  type: "object",
  properties: {
    gamePlan: { type: "string", description: "The overall approach an opposing alliance should take to beat this team." },
    topThreat: { type: "string" },
    autoCounter: { type: "string", description: "How to neutralize or out-pace their autonomous, within the rules." },
    teleopCounter: { type: "string", description: "How to limit their teleop output legally." },
    legalDefense: { type: "array", items: { type: "string" }, description: "Specific LEGAL defensive assignments / pressure points (gracious professionalism)." },
    doNotDo: { type: "array", items: { type: "string" }, description: "Mistakes that would hand this team the match." },
    risksOfThisPlan: { type: "array", items: { type: "string" } },
    confidence: CONFIDENCE,
  },
  required: ["gamePlan", "topThreat", "autoCounter", "teleopCounter", "legalDefense", "doNotDo", "risksOfThisPlan", "confidence"],
};

const allianceSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "Pick value in a short phrase (e.g. 'Elite first-round pick', 'Captain-caliber')." },
    whyPickThem: { type: "array", items: { type: "string" } },
    whatYouProvide: { type: "array", items: { type: "string" }, description: "What a partner must bring to complement them / cover their weaknesses." },
    roleOnYourAlliance: { type: "string", description: "How you would deploy them if allied." },
    pitchNotes: { type: "string", description: "How to approach / what to communicate to them during alliance selection." },
    backupConsideration: { type: "string" },
    confidence: CONFIDENCE,
  },
  required: ["verdict", "whyPickThem", "whatYouProvide", "roleOnYourAlliance", "pitchNotes", "backupConsideration", "confidence"],
};

const scoutingSchema = {
  type: "object",
  properties: {
    pit: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7, description: "Pointed pit-scouting questions specific to this team's numbers (capabilities/reliability/auto options)." },
    strategy: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7, description: "Match-strategy & coordination questions to ask before allying with or facing them." },
    rationale: { type: "string", description: "Why these questions matter for this team specifically (tie to data gaps/uncertainties)." },
  },
  required: ["pit", "strategy", "rationale"],
};

export const SUBMIT_STRATEGY_TOOL = {
  name: "submit_strategy",
  description:
    "Submit the strategy layer: how to BEAT this team (a concrete legal counter game plan), how to RECRUIT them as an alliance partner, and tailored pre-match scouting questions. Ground every point in the digest; keep all defense legal and gracious.",
  input_schema: {
    type: "object" as const,
    properties: {
      counter: counterSchema,
      alliance: allianceSchema,
      scoutingQuestions: scoutingSchema,
    },
    required: ["counter", "alliance", "scoutingQuestions"],
  },
};
