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

/** 1200 → "1.2k" biçimi (Onyx tarzı çip için) */
export function yildizBicimle(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
  }
  return String(n);
}

/** Nav/pill içinde "★ N" rozeti — sayı gelmediyse yalnız yıldız. */
export function GithubStarBadge({ className = "" }: { className?: string }) {
  const yildiz = useGithubStars();
  return (
    <span className={"inline-flex items-center gap-1 " + className}>
      <MaskIcon name="star" size={12} color="#eab30a" />
      {yildiz !== null ? (
        <span className="text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5]">
          {yildizBicimle(yildiz)}
        </span>
      ) : null}
    </span>
  );
}

/** GitHub işareti (Invertocat) — repoya bağlantı için standart kullanım. */
function GithubIsareti({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="flex-shrink-0"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M24.0199 0C10.7375 0 0 10.8167 0 24.1983C0 34.895 6.87988 43.9495 16.4241 47.1542C17.6174 47.3951 18.0545 46.6335 18.0545 45.9929C18.0545 45.4319 18.0151 43.509 18.0151 41.5055C11.3334 42.948 9.94198 38.6209 9.94198 38.6209C8.86818 35.8164 7.27715 35.0956 7.27715 35.0956C5.09022 33.6132 7.43645 33.6132 7.43645 33.6132C9.86233 33.7735 11.1353 36.0971 11.1353 36.0971C13.2824 39.7827 16.7422 38.7413 18.1341 38.1002C18.3328 36.5377 18.9695 35.456 19.6455 34.8552C14.3163 34.2942 8.70937 32.211 8.70937 22.9161C8.70937 20.2719 9.66321 18.1086 11.1746 16.4261C10.9361 15.8253 10.1008 13.3409 11.4135 10.0157C11.4135 10.0157 13.4417 9.3746 18.0146 12.4996C19.9725 11.9699 21.9916 11.7005 24.0199 11.6982C26.048 11.6982 28.1154 11.979 30.0246 12.4996C34.5981 9.3746 36.6262 10.0157 36.6262 10.0157C37.9389 13.3409 37.1031 15.8253 36.8646 16.4261C38.4158 18.1086 39.3303 20.2719 39.3303 22.9161C39.3303 32.211 33.7234 34.2539 28.3544 34.8552C29.2296 35.6163 29.9848 37.0583 29.9848 39.3421C29.9848 42.5871 29.9454 45.1915 29.9454 45.9924C29.9454 46.6335 30.383 47.3951 31.5758 47.1547C41.12 43.9491 47.9999 34.895 47.9999 24.1983C48.0392 10.8167 37.2624 0 24.0199 0Z"
        fill="#e5e5e5"
      />
    </svg>
  );
}

/** Nav'daki GitHub bağlantısı: Invertocat + yıldız sayısı çipi. */
export function GithubNavLink({ ariaLabel }: { ariaLabel: string }) {
  const yildiz = useGithubStars();
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className="flex flex-row items-center gap-2 transition-opacity duration-200 hover:opacity-60"
    >
      <GithubIsareti size={24} />
      {yildiz !== null ? (
        <span className="flex min-h-[26px] min-w-[44px] items-center justify-center rounded-[10px] bg-surface-2 px-2">
          <span className="text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5]">
            {yildizBicimle(yildiz)}
          </span>
        </span>
      ) : null}
    </a>
  );
}
