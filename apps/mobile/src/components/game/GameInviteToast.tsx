/**
 * Floating toast for incoming game invites — uses the native toast system
 * rather than a custom fixed overlay (unlike desktop which uses a CSS
 * positioned div). Auto-dismisses after 60 s matching the server invite TTL.
 */

import { useCallback, useEffect } from "react";
import { View } from "react-native";
import { Gamepad2, X } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { Glass } from "@/components/ui/Glass";
import { useGameStore } from "@/stores/game-store";
import { useChatStore } from "@/stores/chat-store";
import { useGameAccept, useGameDecline } from "@/queries/game-queries";
import { colors, radius, space } from "@/theme/theme";

const INVITE_TTL_MS = 60_000;

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

export function GameInviteToast() {
  const { t } = useAppTranslation();
  const invite = useGameStore((s) => s.pendingInvite);
  const dismissInvite = useGameStore((s) => s.dismissInvite);
  const acceptMut = useGameAccept();
  const declineMut = useGameDecline();

  const inviterName = useUserName(invite?.inviterUserId);

  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(dismissInvite, INVITE_TTL_MS);
    return () => clearTimeout(timer);
  }, [invite, dismissInvite]);

  const handleAccept = useCallback(() => {
    if (!invite) return;
    acceptMut.mutate(invite.gameId);
    dismissInvite();
  }, [invite, acceptMut, dismissInvite]);

  const handleDecline = useCallback(() => {
    if (!invite) return;
    declineMut.mutate(invite.gameId);
    dismissInvite();
  }, [invite, declineMut, dismissInvite]);

  if (!invite) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        bottom: 80,
        left: space.md,
        right: space.md,
        zIndex: 50,
      }}
    >
      <Glass
        strong
        style={{
          borderRadius: radius.xl,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingVertical: space.sm,
          paddingLeft: space.md,
          paddingRight: space.xs,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: "rgba(16,185,129,0.15)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Gamepad2 size={20} color="#34d399" />
        </View>

        <View style={{ flex: 1, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}
          >
            {t("games.inviteFrom", { name: inviterName })}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 12 }}>
            {t("games.minesweeperFlags")}
          </Text>
        </View>

        <Touchable
          onPress={handleAccept}
          pressedTone="rgba(16,185,129,0.2)"
          style={{
            paddingHorizontal: space.md,
            paddingVertical: 6,
            borderRadius: radius.md,
            backgroundColor: "rgba(16,185,129,0.8)",
          }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {t("games.accept")}
          </Text>
        </Touchable>

        <Touchable
          onPress={handleDecline}
          pressedTone={colors.washStrong}
          hitSlop={6}
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <X size={16} color={colors.fgMuted} />
        </Touchable>
      </Glass>
    </View>
  );
}
