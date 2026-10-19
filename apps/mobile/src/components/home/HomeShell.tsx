import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGroups } from "@/queries/chat-queries";
import { resolveSelectedServerId, useHomeShellStore } from "@/stores/home-shell-store";
import { colors, radius } from "@/theme/theme";
import { HomePanel } from "./HomePanel";
import { ServerRail } from "./ServerRail";

/**
 * The unified Home surface (founder directive): a left vertical server RAIL and
 * a right PANEL, side by side. It replaces the old
 * separate "Home" and "Servers" tabs — the rail is now the top-level switch
 * between the DM list and each server's channels, and tapping a channel / DM
 * still pushes the existing full-screen chat over these tabs.
 *
 * Koyu Masa "island" frame, the phone reading of the desktop AppShell: the page
 * is pure black, the rail sits directly on it, and the panel is one island of
 * the base tone with the card radius on its leading corner — depth from surface
 * tone, no border, no shadow.
 *
 * This owns the single subscription to the persisted selection; it resolves a
 * stale stored id (a server since left) back to Home and passes the resolved
 * value to both children so the rail highlight and the panel content can never
 * disagree.
 */
export function HomeShell() {
  const insets = useSafeAreaInsets();
  const rawSelected = useHomeShellStore((s) => s.selectedServerId);
  const selectServer = useHomeShellStore((s) => s.selectServer);
  const groups = useGroups();

  const resolved = useMemo(() => {
    const ids = groups.data
      ? groups.data.filter((g) => g.kind === "server").map((g) => g.id)
      : null;
    return resolveSelectedServerId(rawSelected, ids);
  }, [rawSelected, groups.data]);

  // Self-heal a stale persisted selection once the server list has loaded, so a
  // server the user left never leaves the rail pointing at a group that 404s.
  useEffect(() => {
    if (rawSelected === null || !groups.data) return;
    const stillAMember = groups.data.some((g) => g.id === rawSelected && g.kind === "server");
    if (!stillAMember) selectServer(null);
  }, [rawSelected, groups.data, selectServer]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.rail }}>
      <View style={{ flex: 1, flexDirection: "row", paddingTop: insets.top }}>
        <ServerRail selectedServerId={resolved} />
        <View
          style={{
            flex: 1,
            backgroundColor: colors.app,
            borderTopLeftRadius: radius.card,
            borderCurve: "continuous",
            overflow: "hidden",
          }}
        >
          <HomePanel selectedServerId={resolved} />
        </View>
      </View>
    </View>
  );
}
