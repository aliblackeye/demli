/**
 * Full-screen game overlay — mounts when an active game or end result exists.
 * Uses a Modal-like absolute fill over the app, matching the desktop z-30
 * overlay pattern but in RN terms.
 */

import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { X, Trophy } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { useGameStore } from "@/stores/game-store";
import { useChatStore } from "@/stores/chat-store";
import { MinesweeperBoard } from "./MinesweeperBoard";
import { colors, radius, space } from "@/theme/theme";

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

export function GameOverlay() {
  const { t } = useAppTranslation();
  const activeGame = useGameStore((s) => s.activeGame);
  const lastResult = useGameStore((s) => s.lastResult);
  const dismissResult = useGameStore((s) => s.dismissResult);

  const winnerName = useUserName(lastResult?.winnerUserId ?? undefined);

  const visible = activeGame || lastResult;

  const handleClose = useCallback(() => {
    dismissResult();
  }, [dismissResult]);

  if (!visible) return null;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
        elevation: 30,
        backgroundColor: "rgba(13,13,13,0.97)",
      }}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.stroke,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
            {t("games.minesweeperFlags")}
          </Text>
          <Text style={{ color: colors.fgSubtle, fontSize: 12 }}>MSN</Text>
        </View>
        {!activeGame && (
          <Touchable
            onPress={handleClose}
            pressedTone={colors.washStrong}
            hitSlop={8}
            style={{
              width: 32,
              height: 32,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={18} color={colors.fgMuted} />
          </Touchable>
        )}
      </View>

      {/* Content */}
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingVertical: space.lg,
        }}
      >
        {activeGame ? (
          <MinesweeperBoard />
        ) : lastResult ? (
          <View style={{ alignItems: "center", gap: space.md, paddingHorizontal: space.xl }}>
            <Text style={{ color: colors.fg, fontSize: 18, fontWeight: "700" }}>
              {t("games.gameOver")}
            </Text>
            <Text
              style={{
                color: colors.fgMuted,
                fontSize: 24,
                fontWeight: "700",
                fontVariant: ["tabular-nums"],
              }}
            >
              {lastResult.scores["1"] ?? 0} – {lastResult.scores["2"] ?? 0}
            </Text>
            {lastResult.winnerUserId && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Trophy size={18} color="#fbbf24" />
                <Text style={{ color: colors.fgMuted, fontSize: 14 }}>
                  {t("games.winner")}: {winnerName}
                </Text>
              </View>
            )}
            <Touchable
              onPress={handleClose}
              pressedTone={colors.washStrong}
              style={{
                marginTop: space.sm,
                paddingHorizontal: space.lg,
                paddingVertical: space.xs,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.strokeStrong,
              }}
            >
              <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "500" }}>
                {t("games.close")}
              </Text>
            </Touchable>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
