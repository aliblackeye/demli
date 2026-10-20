/**
 * İkonlar SVG mask + zemin rengiyle boyanır: mask dosyası public/glyphs
 * altında (Demli'nin kendi çizdiği SVG'ler), renk düz background-color.
 */
export function MaskIcon({
  name,
  size = 24,
  width,
  height,
  color,
  className = "",
}: {
  name: string;
  size?: number;
  /** Kare olmayan ikonlar için (inline stil sınıfları ezer) */
  width?: number;
  height?: number;
  color: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={className}
      style={{
        width: width ?? size,
        height: height ?? size,
        backgroundColor: color,
        WebkitMaskImage: `url(/glyphs/${name}.svg)`,
        maskImage: `url(/glyphs/${name}.svg)`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
