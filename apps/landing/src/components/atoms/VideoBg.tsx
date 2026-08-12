"use client";

import { useEffect, useRef } from "react";

/**
 * Performans: sayfadaki 6+ webm aynı anda oynayınca bölüm geçişlerinde
 * takılma oluyor. Referans davranışına uygun olarak video yalnız
 * viewport'a yakınken oynar; uzaklaşınca durdurulur.
 */
export function VideoBg({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) v.play().catch(() => {});
          else v.pause();
        }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      src={src}
      loop
      muted
      playsInline
      preload="metadata"
      className={className}
    />
  );
}
