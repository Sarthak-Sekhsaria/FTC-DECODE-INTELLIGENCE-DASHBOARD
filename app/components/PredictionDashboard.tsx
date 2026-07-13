import type { MatchPrediction, TeamBreakdown } from "@/lib/predictionSchema";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[var(--panel)] p-5 md:p-6">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-white/50">{title}</h3>
      {children}
    </section>
  );
}

function TeamCard({ team, accent }: { team: TeamBreakdown; accent: "red" | "blue" }) {
  const color = accent === "red" ? "var(--ftc-red)" : "var(--ftc-blue)";
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-base font-bold" style={{ color }}>
          #{team.number}
        </span>
        <span className="font-medium text-white/90">{team.name}</span>
      </div>
      <dl className="flex flex-col gap-2 text-sm text-white/75">
        <div>
          <dt className="font-semibold text-white/50">Strengths</dt>
          <dd>{team.strengths}</dd>
        </div>
        <div>
          <dt className="font-semibold text-white/50">Weaknesses</dt>
          <dd>{team.weaknesses}</dd>
        </div>
        <div>
          <dt className="font-semibold text-white/50">DECODE performance</dt>
          <dd>{team.decodeSummary}</dd>
        </div>
        <div>
          <dt className="font-semibold text-white/50">Reliability</dt>
          <dd>{team.reliability}</dd>
        </div>
        <div>
          <dt className="font-semibold text-white/50">Best role</dt>
          <dd>{team.bestRole}</dd>
        </div>
      </dl>
    </div>
  );
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 90) return "Very high confidence";
  if (confidence >= 75) return "Strongly favored";
  if (confidence >= 60) return "Favored, could still swing";
  if (confidence >= 51) return "Very close match";
  return "Toss-up";
}

export default function PredictionDashboard({ prediction }: { prediction: MatchPrediction }) {
  const winnerIsRed = prediction.winner === "Red Alliance";
  const winnerColor = winnerIsRed ? "var(--ftc-red)" : "var(--ftc-blue)";
  const maxScore = Math.max(prediction.redScoreHigh, prediction.blueScoreHigh, 1);

  return (
    <div className="flex flex-col gap-5">
      {/* Winner banner */}
      <section
        className="rounded-2xl border p-6 text-center shadow-xl md:p-8"
        style={{
          borderColor: winnerColor,
          background: `linear-gradient(160deg, ${winnerIsRed ? "rgba(228,0,43,0.18)" : "rgba(0,114,206,0.18)"}, transparent)`,
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Predicted Winner</p>
        <p className="mt-2 text-4xl font-black tracking-tight" style={{ color: winnerColor }}>
          {prediction.winner}
        </p>
        <div className="mx-auto mt-4 max-w-sm">
          <div className="h-3 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${prediction.confidence}%`, background: winnerColor }}
            />
          </div>
          <p className="mt-2 text-sm text-white/70">
            <span className="font-bold text-white">{prediction.confidence}%</span> confidence —{" "}
            {confidenceLabel(prediction.confidence)}
          </p>
        </div>
      </section>

      {/* Score prediction */}
      <Section title="Final Score Prediction">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[
            { label: "Red Alliance", low: prediction.redScoreLow, high: prediction.redScoreHigh, color: "var(--ftc-red)" },
            { label: "Blue Alliance", low: prediction.blueScoreLow, high: prediction.blueScoreHigh, color: "var(--ftc-blue)" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-semibold" style={{ color: s.color }}>
                {s.label}
              </p>
              <p className="mt-1 text-2xl font-bold text-white">
                {s.low}–{s.high}
              </p>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(s.high / maxScore) * 100}%`, background: s.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Why favored */}
      <Section title="Why This Alliance Is Favored">
        <p className="leading-relaxed text-white/85">{prediction.whyFavored}</p>
      </Section>

      {/* Team breakdowns */}
      <Section title="Team-by-Team Breakdown">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <p className="mb-3 flex items-center gap-2 text-sm font-bold text-ftc-red">
              <span className="h-2 w-2 rounded-full bg-ftc-red" /> Red Alliance
            </p>
            <div className="flex flex-col gap-3">
              {prediction.redTeamBreakdowns.map((t) => (
                <TeamCard key={t.number} team={t} accent="red" />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-3 flex items-center gap-2 text-sm font-bold text-ftc-blue">
              <span className="h-2 w-2 rounded-full bg-ftc-blue" /> Blue Alliance
            </p>
            <div className="flex flex-col gap-3">
              {prediction.blueTeamBreakdowns.map((t) => (
                <TeamCard key={t.number} team={t} accent="blue" />
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Alliance compatibility */}
      <Section title="Alliance Compatibility">
        <p className="leading-relaxed text-white/85">{prediction.allianceCompatibility}</p>
      </Section>

      {/* Risk factors */}
      <Section title="Risk Factors">
        <ul className="flex flex-col gap-2">
          {prediction.riskFactors.map((r, i) => (
            <li key={i} className="flex gap-2 text-white/80">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              {r}
            </li>
          ))}
        </ul>
      </Section>

      {/* Confidence explanation */}
      <Section title="Confidence Explanation">
        <p className="leading-relaxed text-white/85">{prediction.confidenceExplanation}</p>
      </Section>

      {/* Data notes */}
      {prediction.dataNotes.length > 0 && (
        <Section title="Data Notes">
          <ul className="flex flex-col gap-2">
            {prediction.dataNotes.map((n, i) => (
              <li key={i} className="flex gap-2 text-sm text-amber-300/90">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                {n}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Final summary */}
      <section className="rounded-2xl border border-white/15 bg-white/5 p-6">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-white/50">Final Summary</h3>
        <p className="text-lg leading-relaxed text-white">{prediction.finalSummary}</p>
      </section>
    </div>
  );
}
