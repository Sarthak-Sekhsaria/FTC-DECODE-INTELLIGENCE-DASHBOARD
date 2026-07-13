"use client";

import PhaseCard from "./PhaseCard";
import FieldBackdrop from "./FieldBackdrop";
import ScoreDisplay from "./ScoreDisplay";
import CounterButton from "./CounterButton";
import NavButtons from "./NavButtons";
import type { TeleopStats } from "@/lib/scouting/types";

export default function TeleopPhase({
  stats,
  onArtifact,
  onHumanPlayer1,
  onHumanPlayer2,
  onBack,
  onNext,
}: {
  stats: TeleopStats;
  onArtifact: () => void;
  onHumanPlayer1: () => void;
  onHumanPlayer2: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black tracking-wide text-white">Teleop Phase</h2>
      </div>

      <PhaseCard>
        <div className="mb-4 aspect-[5/3] w-full overflow-hidden rounded-xl border border-white/10">
          <FieldBackdrop />
        </div>
        <ScoreDisplay label="Teleop Score" score={stats.score} />
      </PhaseCard>

      <PhaseCard title="Scoring Actions">
        <div className="flex flex-col gap-3">
          <CounterButton
            label="Artifacts"
            sublabel="+3 pts each"
            count={stats.artifacts}
            onIncrement={onArtifact}
            accent="green"
            size="lg"
          />
        </div>
      </PhaseCard>

      <PhaseCard title="Human Player">
        <div className="grid grid-cols-2 gap-3">
          <CounterButton
            label="Human Player 1"
            sublabel="tracked only · 0 pts"
            count={stats.humanPlayer1}
            onIncrement={onHumanPlayer1}
            accent="red"
          />
          <CounterButton
            label="Human Player 2"
            sublabel="tracked only · 0 pts"
            count={stats.humanPlayer2}
            onIncrement={onHumanPlayer2}
            accent="blue"
          />
        </div>
      </PhaseCard>

      <NavButtons onBack={onBack} onNext={onNext} nextLabel="Endgame" />
    </div>
  );
}
