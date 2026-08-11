/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  // Statik export'ta next/image optimizasyon sunucusu yok; asset'ler zaten
  // yerel ve önceden boyutlandırılmış olacak.
  images: { unoptimized: true },
};

export default nextConfig;
