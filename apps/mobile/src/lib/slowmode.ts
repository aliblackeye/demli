/**
 * Slow-mode preset table + helpers, shared by the channel-settings selector and
 * the composer indicators (M7). The preset list mirrors the desktop M7c UI so a
 * channel configured on one platform snaps to the same choices on the other.
 * The API caps slowmode at 21600s (6h); every preset value stays within range.
 */

export interface SlowmodePreset {
  /** Seconds between messages per non-owner member; 0 = off. */
  value: number;
  label: string;
}

/** Preset intervals offered in channel settings (0 = off … 6h = API max). */
export const SLOWMODE_PRESETS: SlowmodePreset[] = [
  { value: 0, label: "Off" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "1m" },
  { value: 120, label: "2m" },
  { value: 300, label: "5m" },
  { value: 600, label: "10m" },
  { value: 900, label: "15m" },
  { value: 1800, label: "30m" },
  { value: 3600, label: "1h" },
  { value: 7200, label: "2h" },
  { value: 21600, label: "6h" },
];

/**
 * Snap an arbitrary second value to the nearest preset. The API only ever
 * receives preset values from our UI, but a channel could carry any 0–21600
 * value (set elsewhere), so we snap on load rather than show an off-list choice.
 */
export function snapToPreset(seconds: number): number {
  let best = SLOWMODE_PRESETS[0]!.value;
  let bestDelta = Math.abs(seconds - best);
  for (const preset of SLOWMODE_PRESETS) {
    const delta = Math.abs(seconds - preset.value);
    if (delta < bestDelta) {
      best = preset.value;
      bestDelta = delta;
    }
  }
  return best;
}

/** Compact human label for an interval in seconds (e.g. 90 → "1m 30s"). */
export function formatSlowmodeInterval(seconds: number): string {
  if (seconds <= 0) return "off";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs) parts.push(`${secs}s`);
  return parts.join(" ");
}
