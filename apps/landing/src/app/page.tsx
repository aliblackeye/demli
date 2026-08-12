"use client";

import dynamic from "next/dynamic";

/**
 * Sayfa tamamen istemci tarafında kurulur (eski Vite landing ile aynı model):
 * i18n istemci tercihiyle çözülür, SEO'yu layout'taki meta taşır. ssr:false
 * ayrıca react-i18next'in build prerender'ında çift-React'e düşmesini önler.
 */
const HomeTemplate = dynamic(
  () => import("@/components/templates/HomeTemplate").then((m) => m.HomeTemplate),
  { ssr: false },
);

export default function HomePage() {
  return <HomeTemplate />;
}
