import type { PresenceStatus, SelectablePresenceStatus } from "@demli/types";

/**
 * Your chosen status as OTHER people see it. "Invisible" is a choice you make,
 * not something anyone else can observe: to them you are offline. Every self
 * surface that previews "what others see" (the custom-status preview, your own
 * profile card, the settings identity card) goes through this, so none of them
 * can show a green dot while you are Do Not Disturb or hidden.
 */
export function presenceAsOthersSeeIt(status: SelectablePresenceStatus): PresenceStatus {
  return status === "invisible" ? "offline" : status;
}
