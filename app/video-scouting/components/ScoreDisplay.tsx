export default function ScoreDisplay({ label, score }: { label: string; score: number }) {
  return (
    <div
      className="flex items-center justify-between rounded-xl border px-5 py-3"
      style={{ borderColor: "var(--scout-accent-dim)", background: "rgba(34,255,160,0.06)" }}
    >
      <span className="text-xs font-semibold uppercase tracking-wider text-white/50">{label}</span>
      <span className="text-2xl font-black tabular-nums" style={{ color: "var(--scout-accent)" }}>
        {score}
      </span>
    </div>
  );
}
