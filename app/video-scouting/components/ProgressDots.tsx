"use client";

const PHASE_LABELS = ["Team Select", "Autonomous", "Teleop", "Endgame"];

export default function ProgressDots({ currentPhase, onReset }: { currentPhase: number; onReset: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-1 gap-2" aria-label={`Phase ${currentPhase + 1} of ${PHASE_LABELS.length}: ${PHASE_LABELS[currentPhase]}`}>
        {PHASE_LABELS.map((label, i) => (
          <div
            key={label}
            className="h-1.5 flex-1 rounded-full transition-colors"
            style={{ background: i <= currentPhase ? "var(--scout-accent)" : "var(--scout-border)" }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onReset}
        title="Reset session"
        aria-label="Reset session"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/50 transition hover:border-white/30 hover:text-white/80"
      >
        ×
      </button>
    </div>
  );
}
