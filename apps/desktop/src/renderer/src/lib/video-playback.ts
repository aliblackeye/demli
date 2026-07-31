/**
 * Reliably START playback of a LOCAL self-preview <video> after its `srcObject`
 * has been set — the browser/Electron autoplay-parity fix.
 *
 * Electron's renderer autoplays media unconditionally (its `autoplayPolicy`
 * defaults to `no-user-gesture-required`), so on desktop it was enough to assign
 * `srcObject` to an `<video autoPlay muted>` and let the attribute start it. A
 * BROWSER does not behave the same: even for MUTED media, assigning `srcObject`
 * AFTER mount — in a `useEffect` or an async `getUserMedia`/`getDisplayMedia`
 * callback, which is exactly how the local tiles work — frequently does NOT
 * re-trigger the `autoplay` attribute, so the element just stays black. It is
 * worst on iOS 12 / Safari 12 (a stated web target), which never autostarts a
 * programmatically-assigned srcObject at all. That is the founder's web-only
 * "kendi yayınımı/kameramı göremiyorum" self-view bug.
 *
 * REMOTE tiles never hit this because livekit's `track.attach()` already calls
 * `element.play()` (with retries) internally — only the LOCAL raw-`srcObject`
 * tiles skipped it. This helper does the same explicit `play()`, retried once
 * metadata is ready (covers the srcObject-set-before-metadata race), and swallows
 * the autoplay-policy rejection so a preview can never surface a raw error (§26).
 *
 * Desktop is unaffected: `play()` on an already-playing element resolves as a
 * no-op, so this only ADDS the missing kick the browser needs.
 */
export function startLocalPreviewPlayback(el: HTMLVideoElement): void {
  const play = (): void => {
    // Autoplay policy / not-yet-ready — a later `loadedmetadata` retry (or, worst
    // case, the next user gesture) starts it; never treat this as an error.
    void el.play().catch(() => undefined);
  };
  play();
  // Some engines (Safari 12; Chromium when srcObject is set right after mount) only
  // accept play() once metadata has loaded. `once` self-cleans after it fires; if
  // the element unmounts first the listener is GC'd with it.
  el.addEventListener("loadedmetadata", play, { once: true });
}
