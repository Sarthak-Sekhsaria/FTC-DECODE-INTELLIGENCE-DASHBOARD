export default function FieldBackdrop() {
  return (
    <svg
      viewBox="0 0 400 240"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <rect width="400" height="240" fill="#0a0f0c" />
      {Array.from({ length: 9 }).map((_, i) => (
        <line key={`v${i}`} x1={(i + 1) * 40} y1="0" x2={(i + 1) * 40} y2="240" stroke="#1b2420" strokeWidth="1" />
      ))}
      {Array.from({ length: 5 }).map((_, i) => (
        <line key={`h${i}`} x1="0" y1={(i + 1) * 40} x2="400" y2={(i + 1) * 40} stroke="#1b2420" strokeWidth="1" />
      ))}

      <polygon points="0,0 55,0 0,55" fill="var(--scout-blue)" opacity="0.55" />
      <polygon points="400,0 345,0 400,55" fill="var(--scout-red)" opacity="0.55" />

      <polyline points="30,120 200,40 370,120" fill="none" stroke="#3a463f" strokeWidth="2" />
      <polyline points="30,120 200,200 370,120" fill="none" stroke="#3a463f" strokeWidth="2" />

      <rect x="4" y="60" width="7" height="120" fill="var(--scout-red)" opacity="0.8" />
      <rect x="389" y="60" width="7" height="120" fill="var(--scout-blue)" opacity="0.8" />

      <rect x="150" y="140" width="42" height="42" fill="none" stroke="var(--scout-red)" strokeWidth="2.5" opacity="0.85" />
      <rect x="208" y="140" width="42" height="42" fill="none" stroke="var(--scout-blue)" strokeWidth="2.5" opacity="0.85" />
    </svg>
  );
}
