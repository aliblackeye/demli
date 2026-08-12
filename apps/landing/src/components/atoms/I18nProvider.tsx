"use client";

import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { createLandingI18n } from "../../lib/i18n";

/**
 * Landing i18n sağlayıcısı — örnek hazır olana dek hiçbir metin basılmaz
 * (yanlış dilde bir kare göstermektense boş kare; katalog yereldir, bekleme
 * milisaniyeliktir).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [ornek, setOrnek] = useState<I18nInstance | null>(null);

  useEffect(() => {
    let iptal = false;
    createLandingI18n().then((i) => {
      if (!iptal) setOrnek(i);
    });
    return () => {
      iptal = true;
    };
  }, []);

  if (!ornek) return null;
  return <I18nextProvider i18n={ornek}>{children}</I18nextProvider>;
}
