import { View } from "react-native";
import { Redirect } from "expo-router";
import { useAuthStore } from "@/stores/auth-store";
import { colors } from "@/theme/theme";

/**
 * Boot gate. While the persisted session is being validated this renders only the
 * app backdrop — the branded boot splash (app/_layout.tsx) is already overlaid on
 * top of the whole stack with the real progress bar, so drawing a second splash
 * here would double it up. Once the session settles we redirect into the authed
 * stack or the sign-in screen.
 *
 * The splash cannot outlive this state: its `session` phase is exactly the auth
 * store leaving "initializing", so by the time the overlay fades one of the two
 * redirects below has already fired.
 */
export default function Index() {
  const status = useAuthStore((s) => s.status);

  if (status === "initializing") {
    return <View style={{ flex: 1, backgroundColor: colors.app }} />;
  }

  if (status === "authenticated") return <Redirect href="/groups" />;
  return <Redirect href="/sign-in" />;
}
