import type { DemliBridge } from "./index";

declare global {
  interface Window {
    demli: DemliBridge;
  }
}

export {};
