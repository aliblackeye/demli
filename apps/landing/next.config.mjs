/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  // Statik export'ta next/image optimizasyon sunucusu yok; asset'ler zaten
  // yerel ve önceden boyutlandırılmış olacak.
  images: { unoptimized: true },
  // @demli/i18n TS kaynağını doğrudan yayınlar (main: ./src/index.ts).
  // react-i18next/i18next de listede: Next böylece onların 'react'
  // importunu kendi React kopyasına bağlar (çift-React prerender hatası).
  transpilePackages: ["@demli/i18n", "react-i18next", "i18next"],
  webpack: (config) => {
    // Paket ESM tarzı ".js" uzantılı importlar kullanır (./i18next-env.js →
    // i18next-env.ts); webpack'e uzantı eşlemesi öğretilir.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
