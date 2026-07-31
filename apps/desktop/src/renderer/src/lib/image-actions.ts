import type { Attachment } from "@demli/types";

/**
 * "Save image" / "Copy image" for a picture shared in chat — the renderer half.
 *
 * The renderer has no filesystem and no clipboard-image access on either
 * surface. It only names the image it is ALREADY showing and hands that to the
 * platform bridge (`window.demli.images`), which is the Electron preload on
 * desktop and the browser adapter from @demli/app-ui on web. Main
 * re-validates everything and owns the save dialog / clipboard write; see
 * apps/desktop/src/main/image-actions.ts.
 *
 * The types are DERIVED from the bridge so they can never drift, and so the
 * renderer never imports across the `main/` boundary (same trick as
 * ./update-status.ts).
 */

type ImagesBridge = Window["demli"]["images"];
export type ImageActionTarget = Parameters<ImagesBridge["save"]>[0];
type SaveResult = Awaited<ReturnType<ImagesBridge["save"]>>;
type CopyResult = Awaited<ReturnType<ImagesBridge["copy"]>>;
type FailureReason = Extract<SaveResult | CopyResult, { status: "error" }>["reason"];

/** File extension offered for each whitelisted image MIME. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Prefix for generated names, so a saved file is recognisable in Downloads. */
const NAME_PREFIX = "demli-image";

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * Build the file name offered in the save dialog.
 *
 * The original upload name is NOT recoverable: `attachments` stores a random
 * UUID object key and the DTO carries no `filename` (ADR 0008 — the storage
 * layout is server-internal), so there is nothing on the wire to reuse. We
 * therefore generate a stable, sortable one from the attachment's own creation
 * time, plus a short id suffix — without it, two images posted in the same
 * SECOND (the normal multi-select upload) would both default to the same name
 * and the second save would offer to overwrite the first.
 */
export function imageFileName(attachment: Attachment): string {
  const extension = EXTENSION_BY_MIME[attachment.mime] ?? "png";
  const parsed = new Date(attachment.createdAt);
  const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const suffix = attachment.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4) || "0000";
  return `${NAME_PREFIX}-${stamp}-${suffix}.${extension}`;
}

/** Build the bridge payload for one image attachment and its resolved URL. */
export function imageActionTarget(attachment: Attachment, url: string): ImageActionTarget {
  return { url, mime: attachment.mime, fileName: imageFileName(attachment) };
}

/** The platform bridge, or null when there is none (tests, pre-preload paint). */
export function imagesBridge(): ImagesBridge | null {
  if (typeof window === "undefined") return null;
  return window.demli?.images ?? null;
}

/**
 * Can this surface save an image at all?
 *
 * Not just "is the bridge up": a desktop build that pinned no storage origin has
 * a fail-closed download allow-list in main, so every save would return
 * `blocked_url`. The bridge reports that as `saveSupported: false` and the entry
 * is omitted rather than shown broken (CLAUDE.md §35).
 */
export function canSaveImage(): boolean {
  return imagesBridge()?.saveSupported === true;
}

/**
 * Can this surface put an image on the CLIPBOARD? A browser needs
 * `ClipboardItem` + `navigator.clipboard.write`, which older Safari and Firefox
 * lack; desktop additionally needs the pinned storage allow-list that makes the
 * bytes fetchable at all. When false the menu entry is not rendered — a copy
 * button that cannot copy is a dead button (CLAUDE.md §35).
 */
export function canCopyImage(): boolean {
  return imagesBridge()?.copySupported === true;
}

// ---------------------------------------------------------------------------
// Outcome -> user-facing notice
// ---------------------------------------------------------------------------

/**
 * Every line an image action can produce. A closed union (not `string`) so the
 * toast can pass it straight to the typed `t()` and a typo cannot compile.
 */
export type ImageActionNoticeKey =
  | "desktop:attachments.saved"
  | "desktop:attachments.copied"
  | "desktop:attachments.saveFailed"
  | "desktop:attachments.copyFailed"
  | "desktop:attachments.copyUnsupported";

/** A one-line result to show the user. */
export interface ImageActionNotice {
  tone: "ok" | "error";
  key: ImageActionNoticeKey;
}

/**
 * Map a failure to the sentence the user sees. Deliberately coarse: the only
 * distinction worth making to a human is "this format cannot be copied" versus
 * "it did not work" (CLAUDE.md §26 — never a raw reason code, never a stack).
 */
function failureKey(action: "save" | "copy", reason: FailureReason): ImageActionNoticeKey {
  if (action === "copy" && reason === "unsupported_format") {
    return "desktop:attachments.copyUnsupported";
  }
  return action === "save" ? "desktop:attachments.saveFailed" : "desktop:attachments.copyFailed";
}

/**
 * Run a save through a bridge and reduce it to a notice.
 *
 * `null` means SAY NOTHING — the outcome of a cancelled dialog. Dismissing the
 * picker is a normal user choice, not an error, and the founder's ask was that
 * cancelling simply drops the action.
 */
export async function runImageSave(
  bridge: ImagesBridge,
  target: ImageActionTarget,
): Promise<ImageActionNotice | null> {
  let result: SaveResult;
  try {
    result = await bridge.save(target);
  } catch {
    return { tone: "error", key: "desktop:attachments.saveFailed" };
  }
  if (result.status === "canceled") return null;
  if (result.status === "saved") return { tone: "ok", key: "desktop:attachments.saved" };
  return { tone: "error", key: failureKey("save", result.reason) };
}

/** Run a copy through a bridge and reduce it to a notice. */
export async function runImageCopy(
  bridge: ImagesBridge,
  target: ImageActionTarget,
): Promise<ImageActionNotice | null> {
  let result: CopyResult;
  try {
    result = await bridge.copy(target);
  } catch {
    return { tone: "error", key: "desktop:attachments.copyFailed" };
  }
  if (result.status === "copied") return { tone: "ok", key: "desktop:attachments.copied" };
  return { tone: "error", key: failureKey("copy", result.reason) };
}

// ---------------------------------------------------------------------------
// Notice fan-out (mirrors the outbox/blocked-send toast seams)
// ---------------------------------------------------------------------------

type NoticeListener = (notice: ImageActionNotice) => void;

let noticeListener: NoticeListener | null = null;

/**
 * Register the single root-level toast that reports image-action outcomes.
 * Module-level (not a store) for the same reason OutboxChannelGoneToast is:
 * nothing else in the app ever reads it, so it must not cause re-renders
 * anywhere else (CLAUDE.md §27).
 */
export function setImageActionNoticeListener(listener: NoticeListener | null): void {
  noticeListener = listener;
}

function emit(notice: ImageActionNotice | null): void {
  if (notice && noticeListener) noticeListener(notice);
}

/** Save `target`, then report the outcome to the root toast. */
export async function saveImage(target: ImageActionTarget): Promise<void> {
  const bridge = imagesBridge();
  if (!bridge) return;
  emit(await runImageSave(bridge, target));
}

/** Copy `target` to the clipboard, then report the outcome to the root toast. */
export async function copyImage(target: ImageActionTarget): Promise<void> {
  const bridge = imagesBridge();
  if (!bridge) return;
  emit(await runImageCopy(bridge, target));
}
