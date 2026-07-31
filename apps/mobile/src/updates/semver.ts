/**
 * Tiny, dependency-free semver comparison for the native-update check.
 *
 * We deliberately do NOT pull in the `semver` npm package: the only versions we
 * compare are our own `runtimeVersion` strings (`major.minor.patch`, e.g.
 * "1.3.0"), and adding a native-free helper keeps the mobile dependency surface
 * flat (an OTA/native-update requirement — no new modules in the shipped APK).
 *
 * Scope: numeric dot-separated versions only. Pre-release / build metadata
 * (`-beta`, `+sha`) is out of scope — we never publish those as runtimeVersions.
 */

/** True for a plain numeric dotted version like "1", "1.3", or "1.3.0". */
export function isValidVersion(input: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(input.trim());
}

/** Split "1.3.0" → [1,3,0]; any non-numeric/negative segment collapses to 0. */
function parseParts(version: string): number[] {
  return version
    .trim()
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
}

/**
 * Compare two versions numerically, segment by segment. Missing trailing
 * segments are treated as 0, so "1.3" and "1.3.0" are EQUAL. Returns a sign:
 *   < 0  when `a` is older than `b`
 *     0  when they are equal
 *   > 0  when `a` is newer than `b`
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseParts(a);
  const pb = parseParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** `current` strictly precedes `target` (i.e. an update to `target` exists). */
export function isOlder(current: string, target: string): boolean {
  return compareVersions(current, target) < 0;
}
