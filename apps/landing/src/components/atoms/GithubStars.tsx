"use client";

import { useEffect, useState } from "react";
import { MaskIcon } from "./MaskIcon";

export const GITHUB_URL = "https://github.com/aliblackeye/demli";

/**
 * GitHub yıldız sayısı — istemci tarafında bir kez çekilir; erişilemezse
 * sayı gösterilmez, bağlantı yine çalışır. Sayı ~saatlik önbelleklenir ki
 * her ziyaret API kotası yemesin.
 */
export function useGithubStars(): number | null {
  const [yildiz, setYildiz] = useState<number | null>(null);
  useEffect(() => {
    const KEY = "demli.gh-stars";
    try {
      const sakli = sessionStorage.getItem(KEY);
      if (sakli) {
        setYildiz(Number(sakli));
        return;
      }
    } catch {
      // sessionStorage yoksa her ziyarette çekilir
    }
    fetch("https://api.github.com/repos/aliblackeye/demli")
      .then((r) => (r.ok ? r.json() : null))
      .then((veri) => {
        const n = veri && typeof veri.stargazers_count === "number" ? veri.stargazers_count : null;
        if (n !== null) {
          setYildiz(n);
          try {
            sessionStorage.setItem(KEY, String(n));
          } catch {
            // önbelleksiz devam
          }
        }
      })
      .catch(() => {
        // sayı yoksa bağlantı sayısız görünür
      });
  }, []);
  return yildiz;
}

/** Nav/pill içinde "★ N" rozeti — sayı gelmediyse yalnız yıldız. */
export function GithubStarBadge({ className = "" }: { className?: string }) {
  const yildiz = useGithubStars();
  return (
    <span className={"inline-flex items-center gap-1 " + className}>
      <MaskIcon name="star" size={12} color="#eab30a" />
      {yildiz !== null ? (
        <span className="text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5]">
          {yildiz}
        </span>
      ) : null}
    </span>
  );
}
