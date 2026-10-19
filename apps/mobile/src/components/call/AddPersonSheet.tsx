import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { RotateCcw, UserPlus, UserX, Users } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonList } from "@/components/Skeleton";
import { useFriends } from "@/queries/social-queries";
import { getCallController } from "@/stores/call-store";
import { colors, radius, space } from "@/theme/theme";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { toast } from "../ui/Toast";
import { Touchable } from "../ui/Touchable";

/**
 * "Add person" picker for an active DM call (ADR 0012 §6 — seamless upgrade). Pick
 * a friend and the call moves into a NEW group without dropping media: the server
 * rebinds the group's voice channel to the ongoing LiveKit room, and our own
 * `call.upgraded` re-points the surface. The DM's message history stays private.
 *
 * Excludes the person already in the call (`excludeUserId`). Only mutual friends
 * appear — the server re-checks the inviter↔invitee friendship anyway.
 *
 * Drawn on the kit's draggable Sheet. Every state is designed: friends loading
 * (skeleton rows, announced once), the list failed to load (an error block
 * with a retry — never the "nobody to add" copy, which would be a false claim),
 * nobody to add (an empty block, not a blank card), one request in flight
 * (that row shows the spinner, the others step back to 40% and stop taking taps), and a refused upgrade (a toast that says the call
 * is still on — before this, a failure simply did nothing).
 *
 * The rows are rendered inside the sheet's own scroll body: a friend list is a
 * few dozen rows at most, and a second virtualized list inside the sheet would
 * fight its drag-to-dismiss gesture.
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
  const { data: friends, isLoading, isError, isFetching, refetch } = useFriends();
  // A failed REFETCH over a list we already have keeps showing that list; only a
  // load that produced nothing at all is the error state.
  const loadFailed = isError && friends === undefined;
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
        // The controller's onError already logged the cause; tell the person the
        // call itself is fine and that trying again is safe.
        toast({
          title: t("mobile:call.addPersonFailed"),
          description: t("mobile:call.addPersonFailedHint"),
          variant: "danger",
        });
      })
      .finally(() => setPendingId(null));
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile:call.addPersonTitle")}
      description={t("mobile:call.addPersonSubtitle")}
      snapPoints={candidates.length > 6 ? ["60%", "90%"] : undefined}
    >
      {isLoading ? (
        <SkeletonList count={4} leadingSize={40} leadingRadius={radius.pill} />
      ) : loadFailed ? (
        <EmptyState
          compact
          tone="error"
          icon={<UserX size={22} color={colors.danger} strokeWidth={2} />}
          title={t("mobile:call.addPersonLoadFailed")}
          subtitle={t("mobile:call.addPersonLoadFailedHint")}
          action={
            <Button
              variant="secondary"
              icon={RotateCcw}
              label={t("buttons.retry")}
              loading={isFetching}
              onPress={() => void refetch()}
            />
          }
        />
      ) : candidates.length === 0 ? (
        <EmptyState
          compact
          icon={<Users size={22} color={colors.fgMuted} strokeWidth={2} />}
          title={t("mobile:call.addPersonEmpty")}
        />
      ) : (
        candidates.map((item) => {
          const name = item.user.displayName || item.user.username;
          const busy = pendingId === item.user.id;
          const waiting = pendingId !== null && !busy;
          return (
            <Touchable
              key={item.user.id}
              onPress={() => addPerson(item.user.id)}
              disabled={pendingId !== null}
              // Only the OTHER rows look "off" while one request is in flight; the
              // busy row stays at full ink with its spinner.
              dimmed={waiting}
              haptic="light"
              accessibilityRole="button"
              accessibilityLabel={`${t("mobile:call.add")}: ${name}`}
              accessibilityState={{ busy }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                minHeight: 56,
                paddingHorizontal: space.sm,
                borderRadius: radius.lg,
                borderCurve: "continuous",
              }}
            >
              <Avatar name={name} size="md" uri={item.user.avatarUrl} />
              <Text type="body" tone="default" numberOfLines={1} style={{ flex: 1, fontWeight: "500" }}>
                {name}
              </Text>
              {busy ? (
                <View style={{ width: 72, alignItems: "center" }}>
                  <ActivityIndicator color={colors.accent} size="small" />
                </View>
              ) : (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    paddingHorizontal: space.md,
                    minHeight: 32,
                    borderRadius: radius.pill,
                    backgroundColor: colors.accentSurface,
                  }}
                >
                  <UserPlus size={15} color={colors.accent} strokeWidth={2} />
                  <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                    {t("mobile:call.add")}
                  </Text>
                </View>
              )}
            </Touchable>
          );
        })
      )}
    </Sheet>
  );
}
