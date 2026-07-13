export default function PhaseCard({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border p-5"
      style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}
    >
      {title && (
        <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-white/45">{title}</h3>
      )}
      {children}
    </div>
  );
}
