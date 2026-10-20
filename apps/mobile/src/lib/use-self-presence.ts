import type { PresenceStatus } from "@demli/types";
import { useAuthStore } from "@/stores/auth-store";
import { useSelfPresenceStore } from "@/stores/self-presence-store";
import { presenceAsOthersSeeIt } from "./presence-view";

/**
 * The signed-in account's chosen status (the status picker's store, keyed by
 * user id so an account switch shows that account's pick — same read as the
 * You tab), mapped to what others see. A one-value selector: a status change
 * re-renders only the surfaces that draw your own dot (§27).
 */
export function useSelfPresenceAsSeen(): PresenceStatus {
  const meId = useAuthStore((s) => s.user?.id);
  const chosen = useSelfPresenceStore((s) => (meId ? (s.statusByUser[meId] ?? "online") : "online"));
  return presenceAsOthersSeeIt(chosen);
}
