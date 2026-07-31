import { useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { UserPlus, X } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { useFriends } from "@/queries/social-queries";
import { getCallController } from "@/stores/call-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * "Add person" picker for an active DM call (ADR 0012 §6 — seamless upgrade). Pick
 * a friend and the call moves into a NEW group without dropping media: the server
 * rebinds the group's voice channel to the ongoing LiveKit room, and our own
 * `call.upgraded` re-points the surface. The DM's message history stays private.
 *
 * Excludes the person already in the call (`excludeUserId`). Only mutual friends
 * appear — the server re-checks the inviter↔invitee friendship anyway.
 */
export function AddPersonSheet({
  visible,
  excludeUserId,
  onClose,
}: {
  visible: boolean;
  excludeUserId: UserId | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { data: friends, isLoading } = useFriends();
  const [pendingId, setPendingId] = useState<UserId | null>(null);

  const candidates = (friends ?? []).filter((f) => f.user.id !== excludeUserId);

  const addPerson = (userId: UserId) => {
    if (pendingId) return;
    setPendingId(userId);
    void getCallController()
      .upgrade({ inviteeUserId: userId })
      .then(() => {
        // The surface swap + navigation happen when our own `call.upgraded` lands;
        // just close the picker.
        onClose();
      })
      .catch(() => {
        // The controller's onError already logged it; let the user retry.
      })
      .finally(() => setPendingId(null));
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:call.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
      >
        {/* Stop taps inside the sheet from dismissing it. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            paddingBottom: insets.bottom + space.md,
            maxHeight: "70%",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: space.lg,
              paddingTop: space.lg,
              paddingBottom: space.sm,
            }}
          >
            <Text variant="display" style={{ flex: 1, color: colors.fg, fontSize: 17, fontWeight: "700" }}>
              {t("mobile:call.addPersonTitle")}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel={t("mobile:call.close")}>
              <X size={22} color={colors.fgMuted} />
            </Pressable>
          </View>
          <Text
            style={{
              color: colors.fgMuted,
              fontSize: 13,
              paddingHorizontal: space.lg,
              paddingBottom: space.md,
            }}
          >
            {t("mobile:call.addPersonSubtitle")}
          </Text>

          {isLoading ? (
            <View style={{ padding: space.xl, alignItems: "center" }}>
              <ActivityIndicator color={colors.fgFaint} />
            </View>
          ) : candidates.length === 0 ? (
            <Text
              style={{
                color: colors.fgFaint,
                fontSize: 14,
                textAlign: "center",
                paddingHorizontal: space.lg,
                paddingVertical: space.xl,
              }}
            >
              {t("mobile:call.addPersonEmpty")}
            </Text>
          ) : (
            <FlatList
              data={candidates}
              keyExtractor={(f) => f.user.id}
              contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}
              renderItem={({ item }) => {
                const name = item.user.displayName || item.user.username;
                const busy = pendingId === item.user.id;
                return (
                  <Pressable
                    onPress={() => addPerson(item.user.id)}
                    disabled={!!pendingId}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile:call.a11yAddPerson")}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      paddingVertical: space.md,
                      opacity: pressed ? 0.7 : pendingId && !busy ? 0.5 : 1,
                    })}
                  >
                    <Avatar name={name} size={40} uri={item.user.avatarUrl} />
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" }}
                    >
                      {name}
                    </Text>
                    {busy ? (
                      <ActivityIndicator color={colors.accent} size="small" />
                    ) : (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space.xs,
                          paddingHorizontal: space.md,
                          paddingVertical: space.xs,
                          borderRadius: radius.pill,
                          backgroundColor: colors.accentSurface,
                        }}
                      >
                        <UserPlus size={15} color={colors.accent} />
                        <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                          {t("mobile:call.add")}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
