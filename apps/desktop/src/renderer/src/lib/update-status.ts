import { useEffect } from "react";
import { create } from "zustand";
import { notifyUpdateReady } from "../notifications/notification-manager";

/**
 * The app-update lifecycle, as the renderer sees it.
 *
 * Main owns electron-updater (apps/desktop/src/main/auto-update.ts) and pushes
 * every transition over the validated `window.demli.updates` bridge. This
 * module is the renderer's SINGLE subscription to it: one module-level store, one
 * IPC listener, however many components read it (the top-right UpdateBadge, the
 * settings panel, the critical overlay, the login-screen footer).
 *
 * The status type is derived from the bridge itself so it can never drift, and so
 * the renderer never imports across the `main/` boundary.
 */
export type UpdateStatus = Awaited<
  ReturnType<Window["demli"]["updates"]["getStatus"]>
>;

/**
 * `seeded` is NOT cosmetic: the initial value below is `disabled`, which is also
 * a real status (an unpackaged run). Without a flag, a consumer that must act on
 * "the updater is off" — the startup-update flow — would act on the placeholder
 * one render before the bridge has answered. So it stays false until main has
 * genuinely told us something.
 */
const useUpdateStore = create<{ status: UpdateStatus; seeded: boolean }>(() => ({
  status: { kind: "disabled" },
  seeded: false,
}));

let initialized = false;

/**
 * Subscribe once (module-level) to main's status pushes and seed the current
 * status. Idempotent, and a no-op when there is no bridge (the web build, where
 * `updates` is an honest disabled stub).
 */
function ensureInit(): void {
  if (initialized) {
    return;
  }
  const bridge = window.demli?.updates;
  if (!bridge) {
    return;
  }
  initialized = true;
  bridge.onStatus((status) => {
    useUpdateStore.setState({ status, seeded: true });
    // Native "update ready" toast — only fires on a live transition (not the
    // seed below), when unfocused, and is deduped by version in the manager.
    if (status.kind === "ready") {
      notifyUpdateReady(status.version, status.critical);
    }
  });
  // Seed from main's last-known status (covers views that mount after events).
  // Intentionally does NOT notify: only live transitions raise a toast. The
  // guard matters because this promise can resolve AFTER a live push has already
  // landed — without it, a stale snapshot would overwrite the newer truth.
  void bridge
    .getStatus()
    .then((status) =>
      useUpdateStore.setState((prev) => (prev.seeded ? prev : { status, seeded: true })),
    )
    .catch(() => undefined);
}

/** Read the live update status, subscribing on first use. */
export function useUpdateStatus(): UpdateStatus {
  useEffect(() => {
    ensureInit();
  }, []);
  return useUpdateStore((s) => s.status);
}

/**
 * Has main actually reported a status yet? Only the startup-update flow needs
 * this — every other consumer is happy to render `disabled` until the real
 * answer arrives, because for them it means the same thing: nothing to do.
 */
export function useUpdateStatusSeeded(): boolean {
  useEffect(() => {
    ensureInit();
  }, []);
  return useUpdateStore((s) => s.seeded);
}

/** Ask main to check the feed. Failures surface as an `error` status push. */
export function checkForUpdates(): void {
  void window.demli?.updates.check().catch(() => undefined);
}

/**
 * The single contextual action: from `available` it starts the download, from
 * `ready` it installs and restarts. Main is state-guarded, so calling it in any
 * other state is a no-op rather than a surprise restart.
 */
export function downloadOrInstall(): void {
  void window.demli?.updates.downloadAndInstall().catch(() => undefined);
}

/** Is this status a mandatory update that should drive the blocking overlay? */
export function isCriticalActive(status: UpdateStatus): boolean {
  return (
    (status.kind === "available" ||
      status.kind === "downloading" ||
      status.kind === "ready") &&
    status.critical
  );
}
