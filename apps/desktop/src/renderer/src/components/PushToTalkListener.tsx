import { useEffect, useRef } from "react";
import { useMediaSettings } from "../stores/media-settings";
import { useVoiceStore } from "../stores/voice-store";
import { isTypingTarget } from "../lib/ptt";

/**
 * Always-mounted, render-null listener that implements desktop push-to-talk
 * (Bas-Konuş): while the input mode is `push_to_talk` AND we're in a voice
 * session, holding the configured key opens the mic and releasing it mutes.
 * Renderer-level (fires while the app window is focused); a global OS shortcut is
 * a desktop-native follow-up. Ignored while typing in a text field.
 */
export function PushToTalkListener(): null {
  const inputMode = useMediaSettings((s) => s.audio.inputMode);
  const pttKey = useMediaSettings((s) => s.pttKey);
  const status = useVoiceStore((s) => s.status);
  const setMicActive = useVoiceStore((s) => s.setMicActive);

  const active =
    inputMode === "push_to_talk" &&
    (status === "connected" || status === "joining" || status === "reconnecting");

  // Track the held state so key auto-repeat doesn't spam setMic, and so we can
  // release the mic on cleanup if the mode/session changes mid-hold.
  const heldRef = useRef(false);

  useEffect(() => {
    if (!active) {
      // Leaving PTT mode / the session while holding: make sure we don't leave
      // the mic stuck open.
      if (heldRef.current) {
        heldRef.current = false;
        setMicActive(false);
      }
      return;
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== pttKey || e.repeat || heldRef.current) return;
      if (isTypingTarget(e.target)) return;
      heldRef.current = true;
      setMicActive(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== pttKey || !heldRef.current) return;
      heldRef.current = false;
      setMicActive(false);
    };
    // Releasing focus while holding must drop the mic (no keyup arrives).
    const onBlur = (): void => {
      if (heldRef.current) {
        heldRef.current = false;
        setMicActive(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, pttKey, setMicActive]);

  return null;
}
