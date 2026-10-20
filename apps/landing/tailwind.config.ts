import type { Config } from "tailwindcss";

// Landing token'ları — globals.css :root ile aynı; vurgu Demli mercanı.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    // Referans breakpoint'leri: ≤809 mobil · 810–1439 tablet/dar masaüstü · ≥1440 geniş
    screens: {
      tb: "810px",
      dt: "1440px",
    },
    extend: {
      colors: {
        base: "#0d0d0d",
        "base-translucent": "#0d0d0db8",
        surface: "#171717",
        "surface-translucent": "#171717b8",
        "surface-2": "#262626",
        line: "#404040",
        "text-primary": "#f5f5f5",
        "text-secondary": "#a3a3a3",
        "text-dim": "#737373",
        accent: "#ff8464",
        star: "#eab30a",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        display: ["Onest", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
