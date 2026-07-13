"use client";

import PhaseCard from "./PhaseCard";
import FieldBackdrop from "./FieldBackdrop";
import ScoreDisplay from "./ScoreDisplay";
import CounterButton from "./CounterButton";
import NavButtons from "./NavButtons";
import type { AutonomousStats } from "@/lib/scouting/types";

export default function AutonomousPhase({
  stats,
  onArtifact,
  onPattern,
  onGate,
  onBack,
  onNext,
}: {
  stats: AutonomousStats;
  onArtifact: () => void;
  onPattern: () => void;
  onGate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black tracking-wide text-white">Autonomous Phase</h2>
      </div>

      <PhaseCard>
        <div className="mb-4 aspect-[5/3] w-full overflow-hidden rounded-xl border border-white/10">
          <FieldBackdrop />
        </div>
        <ScoreDisplay label="Autonomous Score" score={stats.score} />
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
          <CounterButton
            label="Pattern"
            sublabel="+2 pts each · blue box"
            count={stats.pattern}
            onIncrement={onPattern}
            accent="blue"
          />
          <CounterButton
            label="Gate"
            sublabel="tracked only · 0 pts"
            count={stats.gate}
            onIncrement={onGate}
            accent="gray"
          />
        </div>
      </PhaseCard>

      <NavButtons onBack={onBack} onNext={onNext} nextLabel="Teleop Phase" />
    </div>
  );
}
