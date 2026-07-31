import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Live software-keyboard height in window px (0 when hidden).
 *
 * Why not KeyboardAvoidingView: with `edgeToEdgeEnabled` Android neither
 * applies the legacy `adjustResize` nor feeds KAV's "padding" behavior a
 * keyboard inset, so a KAV-wrapped composer stays buried under the IME
 * (founder bug: "ne yazdığımı göremiyorum"). The Keyboard events carry
 * `endCoordinates.height` reliably on BOTH platforms, so screens pad by this
 * value instead. iOS uses the `will` events for a smoother ride; Android only
 * emits `did*`.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
