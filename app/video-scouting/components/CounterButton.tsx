"use client";

type Accent = "green" | "red" | "blue" | "gray";

const ACCENT_STYLES: Record<Accent, { border: string; bg: string; text: string; badgeBg: string; badgeText: string }> = {
  green: {
    border: "var(--scout-accent)",
    bg: "rgba(34,255,160,0.08)",
    text: "var(--scout-accent)",
    badgeBg: "var(--scout-accent)",
    badgeText: "#04140c",
  },
  red: {
    border: "var(--scout-red)",
    bg: "rgba(239,68,68,0.08)",
    text: "var(--scout-red)",
    badgeBg: "var(--scout-red)",
    badgeText: "#fff",
  },
  blue: {
    border: "var(--scout-blue)",
    bg: "rgba(59,130,246,0.08)",
    text: "var(--scout-blue)",
    badgeBg: "var(--scout-blue)",
    badgeText: "#fff",
  },
  gray: {
    border: "var(--scout-border)",
    bg: "rgba(255,255,255,0.03)",
    text: "#d6dbd8",
    badgeBg: "#3a4440",
    badgeText: "#fff",
  },
};

export default function CounterButton({
  label,
  sublabel,
  count,
  onIncrement,
  accent = "green",
  size = "md",
}: {
  label: string;
  sublabel?: string;
  count: number;
  onIncrement: () => void;
  accent?: Accent;
  size?: "md" | "lg";
}) {
  const styles = ACCENT_STYLES[accent];
  const padding = size === "lg" ? "py-6" : "py-4";

  return (
    <button
      type="button"
      onClick={onIncrement}
      className={`relative w-full rounded-2xl border-2 ${padding} px-4 text-center transition active:scale-[0.97]`}
      style={{ borderColor: styles.border, background: styles.bg }}
    >
      <span
        className="absolute -top-2.5 -right-2.5 flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-sm font-extrabold shadow"
        style={{ background: styles.badgeBg, color: styles.badgeText }}
      >
        {count}
      </span>
      <span className="block text-base font-bold tracking-wide" style={{ color: styles.text }}>
        {label}
      </span>
      {sublabel && <span className="mt-0.5 block text-xs text-white/40">{sublabel}</span>}
    </button>
  );
}
