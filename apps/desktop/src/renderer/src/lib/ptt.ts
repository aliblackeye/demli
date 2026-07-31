/**
 * Push-to-talk key helpers (renderer-level). A true GLOBAL OS shortcut (talk
 * while another app is focused) needs a main-process `globalShortcut`
 * registration — that is a desktop-native follow-up (see the media-quality
 * report). This renderer binding works while the Demli window is focused.
 */

/** Friendly label for a `KeyboardEvent.code` (e.g. "KeyV" → "V", "Backquote" → "`"). */
export function formatPttKey(code: string): string {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const named: Record<string, string> = {
    Space: "Space",
    Backquote: "`",
    ControlLeft: "Ctrl",
    ControlRight: "Ctrl",
    ShiftLeft: "Shift",
    ShiftRight: "Shift",
    AltLeft: "Alt",
    AltRight: "Alt",
    Tab: "Tab",
    CapsLock: "Caps",
    Enter: "Enter",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Minus: "-",
    Equal: "=",
  };
  return named[code] ?? code;
}

/** True when the event target is a text field, so a PTT key press shouldn't fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}
