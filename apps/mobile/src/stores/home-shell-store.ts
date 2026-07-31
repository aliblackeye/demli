/**
 * Persisted selection for the unified Home shell: the left server RAIL + the
 * right PANEL. This store owns exactly ONE thing — which
 * rail entry is selected — so the founder's "app reopens where I left it" holds
 * across a relaunch.
 *
 * `selectedServerId`:
 *   - `null`  → the Home/DM entry is selected; the panel shows the DM list.
 *   - a GroupId → that server is selected; the panel shows its channel list.
 *
 * Persistence follows the app's established seam (media-settings /
 * participant-volume): zustand `persist` backed by `expo-secure-store`. Reusing
 * SecureStore adds NO native module, so OTA delivery to the installed APK stays
 * intact. SecureStore is async, so on a cold start `selectedServerId` is null
 * until hydration resolves — the panel shows the DM list for one frame, then
 * settles onto the persisted server (see HomeShell's self-heal guard).
 *
 * The pure resolvers below are the tested logic layer (RN rendering is not
 * simulated in this repo — vitest, node env, `src/**\/*.test.ts`).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";

/**
 * Coerce an untrusted persisted value into a valid selection. Anything that is
 * not a non-empty string (legacy blob, `undefined`, a number) reads as the Home
 * entry (`null`). Pure — the persist `merge` and the tests both call it.
 */
export function normalizeSelectedServerId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The selection the shell should actually honor: keep the stored server only
 * while it is still one the user belongs to (`serverIds`), otherwise fall back
 * to Home. Guards against a stale id left behind after leaving/deleting a
 * server — without this the panel would try to load a group that 404s. Pure.
 *
 * `serverIds === null` means the server list has not loaded yet; we hold the
 * stored value rather than prematurely resetting it to Home.
 */
export function resolveSelectedServerId(
  selectedId: string | null,
  serverIds: readonly string[] | null,
): string | null {
  if (selectedId === null) return null;
  if (serverIds === null) return selectedId; // list still loading — don't reset yet
  return serverIds.includes(selectedId) ? selectedId : null;
}

interface HomeShellState {
  /** null = Home/DM entry; a GroupId = that server's channel list. */
  selectedServerId: string | null;
  /** Select a server (or Home when null). No-op when unchanged. */
  selectServer: (serverId: string | null) => void;
}

export const useHomeShellStore = create<HomeShellState>()(
  persist(
    (set, get) => ({
      selectedServerId: null,
      selectServer: (serverId) => {
        if (get().selectedServerId === serverId) return;
        set({ selectedServerId: serverId });
      },
    }),
    {
      name: "demli.home-shell",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ selectedServerId: s.selectedServerId }),
      // Never trust storage blindly — coerce a legacy/garbage blob to a valid id.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<HomeShellState>;
        return { ...current, selectedServerId: normalizeSelectedServerId(p.selectedServerId) };
      },
    },
  ),
);
