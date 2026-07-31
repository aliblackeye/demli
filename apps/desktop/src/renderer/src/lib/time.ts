import type { AppTFunction } from "./i18n";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "14:32" — gutter timestamp for grouped messages. */
export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/**
 * Compact human duration for slow-mode intervals/countdowns: "5s", "1m",
 * "1m 30s", "2h". Used for the composer's slow-mode indicator and countdown.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/**
 * "Today at 14:32" / "Yesterday at 09:10" / "12.05.2026 14:32". Takes the app's
 * `t` (like errors.ts) so the relative-day prefix is localized; the clock/date
 * parts come from `Intl` and follow the device locale.
 */
export function formatMessageTimestamp(iso: string, t: AppTFunction): string {
  const date = new Date(iso);
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const dayDiff = Math.round((today - day) / 86_400_000);
  const time = timeFormat.format(date);
  if (dayDiff === 0) return t("desktop:chat.timeToday", { time });
  if (dayDiff === 1) return t("desktop:chat.timeYesterday", { time });
  return `${dateFormat.format(date)} ${time}`;
}
