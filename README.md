# FTC DECODE Match Predictor

A web app that predicts the winner of an FTC (FIRST Tech Challenge) DECODE-season match
given two Red Alliance team numbers and two Blue Alliance team numbers.

- **Research**: pulls each team's DECODE-season stats (record, OPR, rank, autonomous/TeleOp
  scoring, consistency, trend) live from the [FTCScout](https://ftcscout.org) public API.
- **Prediction**: feeds that research to Claude (Anthropic API) using a scouting-analyst
  system prompt, and gets back a structured prediction via a forced tool call.
- **UI**: red/blue alliance input form and a results dashboard (winner, confidence, score
  range, team-by-team breakdown, alliance compatibility, risk factors, final summary).

## Getting started

1. Install dependencies (already done if you're reading this right after setup):

   ```bash
   npm install
   ```

2. Add your Anthropic API key:

   ```bash
   cp .env.local.example .env.local
   # then edit .env.local and paste your key from https://console.anthropic.com/
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000), enter four FTC team numbers, and
   click **Predict Match Winner**.

## How it works

- [`lib/ftcscout.ts`](lib/ftcscout.ts) — queries the FTCScout GraphQL API for each team's
  current-season record, OPR breakdown, and event-by-event results, and formats it into a
  research dossier.
- [`lib/systemPrompt.ts`](lib/systemPrompt.ts) — the match-prediction agent's system prompt.
- [`lib/predictionSchema.ts`](lib/predictionSchema.ts) — the JSON shape of a prediction and
  the Anthropic tool schema used to force structured output.
- [`app/api/predict/route.ts`](app/api/predict/route.ts) — fetches research for all four
  teams, calls Claude, and returns the structured prediction.
- [`app/page.tsx`](app/page.tsx) and [`app/components/`](app/components) — the form and
  dashboard UI.

## Notes

- FTCScout needs no API key. If a team number has no DECODE-season data, the app tells
  Claude so explicitly and Claude is instructed to flag missing/estimated data rather than
  invent it.
- The season constant (`DECODE_SEASON` in `lib/ftcscout.ts`) is FTCScout's season key for
  the 2025-2026 DECODE season. Update it when a new season starts.
