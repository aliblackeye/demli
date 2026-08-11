/**
 * Referanstaki kademeli backdrop-blur (8 katman) — ölçülen:
 * blur(0.5→16px) + kaydırılmış linear-gradient mask şeritleri,
 * en üstte tam maskeli düz katman. Üst varyantta gradyanlar "to top".
 */
const LAYERS: Array<{ blur: number | null; from: number; to: number }> = [
  { blur: 0.5, from: 0, to: 20 },
  { blur: 1, from: 15, to: 35 },
  { blur: 2, from: 30, to: 50 },
  { blur: 4, from: 45, to: 65 },
  { blur: 8, from: 60, to: 80 },
  { blur: 16, from: 75, to: 100 },
];

export function ProgressiveBlur({
  position,
  height,
}: {
  position: "top" | "bottom";
  height: number;
}) {
  const dir = position === "top" ? "to top" : "to bottom";
  return (
    <div
      aria-hidden
      className={
        "pointer-events-none fixed inset-x-0 z-[1] " +
        (position === "top" ? "top-0" : "bottom-0")
      }
      style={{ height }}
    >
      {LAYERS.map((l, i) => (
        <div
          key={i}
          className="absolute inset-0"
          style={{
            backdropFilter: `blur(${l.blur}px)`,
            WebkitBackdropFilter: `blur(${l.blur}px)`,
            WebkitMaskImage: `linear-gradient(${dir}, rgba(0,0,0,0) ${l.from}%, rgb(0,0,0) ${l.to}%)`,
            maskImage: `linear-gradient(${dir}, rgba(0,0,0,0) ${l.from}%, rgb(0,0,0) ${l.to}%)`,
          }}
        />
      ))}
    </div>
  );
}
