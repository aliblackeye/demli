import type { Config } from "tailwindcss";

// Appzen token'ları (docs/appzen-clone-reference.md) — birebir klon paleti.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
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
        accent: "#22c55e",
        star: "#eab30a",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        display: ["var(--font-display)", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
