/**
 * External-link IPC contract (renderer -> main).
 *
 * Shared by `main/external-link.ts` and the preload bridge so the channel name
 * and payload shape have exactly one definition. Types only + one frozen channel
 * map — no Electron import, so the preload can pull this in without dragging
 * main-process modules into its bundle.
 */

/** The channels this feature owns. */
export const EXTERNAL_LINK_CHANNELS = {
  open: "external-link:open",
} as const;

/**
 * Open ONE url in the user's OS browser.
 *
 * Deliberately not a `shell` namespace: the renderer gets this one verb and
 * nothing else — no `openPath`, no `showItemInFolder`, no `trashItem`. The url
 * is re-validated in main (bounded length, http(s) only, no embedded
 * credentials) and the sender must be the top frame of one of our own windows.
 *
 * Resolves `true` when the OS accepted the url, `false` when it was refused or
 * the handoff failed. Never rejects, so a caller can fire it and forget it.
 */
export interface ExternalLinksBridge {
  open(url: string): Promise<boolean>;
}
