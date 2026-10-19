/**
 * The outcome of one profile Save, as the save bar reports it.
 *
 * A Save runs up to three independent requests in order (avatar upload, banner
 * upload, one PATCH for name/bio/removals). Each lands or fails on its own, so
 * "some changes didn't save" is only true when at least one landed. The bar
 * used to say it whenever anything failed — including the most common failure
 * of all, a single PATCH sent while offline, where NOTHING was saved (§26).
 */
export type ProfileSaveStep = "avatar" | "banner" | "profile";

export interface ProfileSaveStepResult {
  id: ProfileSaveStep;
  ok: boolean;
}

export type ProfileSaveOutcome =
  /** Every step landed (or there was nothing to send). */
  | { kind: "ok" }
  /** Every step failed — nothing reached the server. */
  | { kind: "total"; failed: ProfileSaveStep[] }
  /** Some steps landed, some did not — both lists in Save order. */
  | { kind: "partial"; saved: ProfileSaveStep[]; failed: ProfileSaveStep[] };

export function summarizeProfileSave(results: readonly ProfileSaveStepResult[]): ProfileSaveOutcome {
  const saved = results.filter((r) => r.ok).map((r) => r.id);
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  if (failed.length === 0) return { kind: "ok" };
  if (saved.length === 0) return { kind: "total", failed };
  return { kind: "partial", saved, failed };
}
