import { useEffect } from "react";
import { useUiStore } from "../stores/ui-store";

/**
 * Ctrl/Cmd+F toggles the message-search panel for whichever conversation is
 * mounted — a server channel, a DM, or a group DM.
 *
 * One hook rather than a copy per view: the shortcut used to be registered
 * inside the server ChatView only, which meant pressing Ctrl+F in a DM did
 * nothing at all while the identical search capability existed one route away.
 * A shortcut that works on one surface and silently fails on its siblings is the
 * kind of half-wired affordance §35 exists to prevent.
 *
 * Registered on `window` and unconditional for the mounted view: exactly one
 * conversation view is mounted at a time, so the listeners never stack.
 */
export function useChannelSearchHotkey(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        useUiStore.getState().toggleChannelSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
