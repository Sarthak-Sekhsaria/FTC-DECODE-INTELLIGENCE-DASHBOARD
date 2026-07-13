export default function NavButtons({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  nextLoading,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
}) {
  return (
    <div className="flex gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-xl border border-white/15 py-4 text-sm font-bold uppercase tracking-wide text-white/60 transition hover:border-white/30 hover:text-white/90"
        >
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled || nextLoading}
        className="flex flex-[2] items-center justify-center gap-2 rounded-xl py-4 text-sm font-bold uppercase tracking-wide text-black transition disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: "var(--scout-accent)" }}
      >
        {nextLoading ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
        ) : (
          <>
            {nextLabel} <span aria-hidden>›</span>
          </>
        )}
      </button>
    </div>
  );
}
