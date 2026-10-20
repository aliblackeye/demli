/**
 * React bindings for the bottom-chrome geometry in ./bottom-chrome. The math is
 * pure and unit-tested there; these hooks only read the live inputs (safe area,
 * route, whether a voice session is up). Each store subscription selects a single
 * boolean, so a voice status tick never re-renders a tab screen unless the bar
 * actually appears or disappears (§27).
 */
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVoiceStore } from "@/stores/voice-store";
import { bottomChromeClearance, hasLiveVoiceBarSession, isVoiceRoomRoute } from "./bottom-chrome";
import { isTabRoute } from "./tab-bar";

/**
 * Bottom clearance for content INSIDE one of the three tab screens (list padding,
 * floating buttons). A tab screen is only visible while its tab route is the
 * current one, so the route is known; the voice bar is then shown exactly when a
 * voice-channel session is live. Not subscribing to the pathname keeps every
 * tab screen from re-rendering on each navigation.
 */
export function useTabScreenBottomClearance(): number {
  const insets = useSafeAreaInsets();
  const voiceBarShown = useVoiceStore((s) => hasLiveVoiceBarSession(s.roomId, s.status));
  return bottomChromeClearance({ insetsBottom: insets.bottom, onTabRoute: true, voiceBarShown });
}

/**
 * Bottom clearance for a root-level floating surface that can sit over ANY route
 * (the update pill): it reads the route to know whether the tab pill and the voice
 * bar are on screen, and stacks above both.
 */
export function useBottomChromeClearance(): number {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const liveSession = useVoiceStore((s) => hasLiveVoiceBarSession(s.roomId, s.status));
  return bottomChromeClearance({
    insetsBottom: insets.bottom,
    onTabRoute: isTabRoute(pathname),
    voiceBarShown: liveSession && !isVoiceRoomRoute(pathname),
  });
}
