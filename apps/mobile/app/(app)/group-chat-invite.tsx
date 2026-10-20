import { useState } from "react";
import { ScrollView, Share, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, Link2, Share2, Trash2 } from "lucide-react-native";
import {
  canRevokeGroupChatInvite,
  inviteUsage,
  prefersDaysWording,
} from "@demli/client-core";
import type { GroupId, Invite } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { buildInviteLink } from "@/lib/deep-links";
import {
  useCreateGroupChatInvite,
  useGroupChatDetails,
  useGroupChatInvites,
  useRevokeGroupChatInvite,
} from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, motion, radius, space } from "@/theme/theme";

/** How long a freshly minted link lives, and how many people it admits. */
const INVITE_EXPIRES_HOURS = 24 * 7;
const INVITE_MAX_USES = 25;
/** How long the copy button stays in its "copied" state. */
const COPY_RESET_MS = 1_600;

/**
 * Human summary of a link's limits. The ARITHMETIC is not here — `inviteUsage`
 * in @demli/client-core clamps a past expiry to zero and counts uses left, so
 * desktop and mobile cannot drift into one of them showing "-3 hours". This
 * function only chooses words.
 */
function inviteLimits(invite: Invite, t: AppTFunction): string {
  const usage = inviteUsage(invite);
  const parts: string[] = [];

  if (usage.hoursLeft === null) {
    parts.push(t("mobile:invite.neverExpires"));
  } else if (prefersDaysWording(usage)) {
    parts.push(t("mobile:invite.expiresInDays", { days: usage.daysLeft }));
  } else {
    parts.push(t("mobile:invite.expiresInHours", { hours: usage.hoursLeft }));
  }

  if (usage.usesLeft === null) {
    parts.push(t("mobile:invite.unlimitedUses"));
  } else {
    parts.push(t("mobile:invite.usesLeft", { left: usage.usesLeft, max: usage.maxUses }));
  }

  return parts.join(" · ");
}

/**
 * Invite links for a flat group chat (M18, ADR 0005) — mobile's parity of the
 * desktop `GroupChatInviteDialog`.
 *
 * The link format and the redeem endpoint are the SAME ones a server invite uses
 * (`POST /invites/:code/redeem` branches on the group's kind), so the product has
 * exactly one deep-link shape. This screen never builds a URL itself: it asks
 * `buildInviteLink`, the one mobile builder, whose host/path the native intent
 * filters are registered for.
 *
 * The asymmetry that makes this screen different from the server invite screen
 * is the API's, not a design choice: ANY member may mint a link, but only the
 * OWNER may revoke one. So a plain member gets no revoke control at all rather
 * than one the server would answer 403 to (§35) — and the decision comes from the
 * shared `canRevokeGroupChatInvite` rule, so the two platforms cannot disagree.
 *
 * It LISTS links instead of minting one on open (which is what the server invite
 * screen does): a group chat's links are revocable, so a member needs to see what
 * is currently live before adding another.
 */
export default function GroupChatInviteScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupChatId: string; name?: string }>();
  const groupChatId = (params.groupChatId ?? null) as GroupId | null;
  const insets = useSafeAreaInsets();

  const me = useAuthStore((s) => s.user);
  const { data: details } = useGroupChatDetails(groupChatId);
  const invitesQuery = useGroupChatInvites(groupChatId);
  const createInvite = useCreateGroupChatInvite(groupChatId);
  const revokeInvite = useRevokeGroupChatInvite(groupChatId);

  /** The link whose revoke is awaiting its second tap, or null. */
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  /** The link whose copy button is showing "copied", or null. */
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const canRevoke = canRevokeGroupChatInvite({
    groupOwnerId: details?.group.ownerId,
    viewerId: me?.id,
  });

  const groupName = details?.group.name ?? params.name ?? t("mobile:groupChatInvite.shareGroupFallback");
  const invites = invitesQuery.data ?? [];
  const busy = createInvite.isPending || revokeInvite.isPending;
  // One merged slot: the user cares that something failed, not which of three
  // requests it was, and three separate alerts would stack on a phone.
  const error = invitesQuery.error ?? createInvite.error ?? revokeInvite.error ?? null;

  const onCopy = (invite: Invite) => {
    void Clipboard.setStringAsync(buildInviteLink(invite.code)).then(() => {
      haptics.light();
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), COPY_RESET_MS);
    });
  };

  const onShare = (invite: Invite) => {
    void Share.share({
      message: t("mobile:groupChatInvite.shareMessage", {
        group: groupName,
        link: buildInviteLink(invite.code),
      }),
    });
  };

  const onCreate = () =>
    createInvite.mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.app }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom, gap: space.lg }}
    >
      <Stack.Screen options={{ title: t("mobile:groupChatInvite.title", { group: groupName }) }} />

      <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
        {t("mobile:groupChatInvite.description")}
      </Text>

      {error ? <Banner variant="danger" title={t("mobile:groupChatInvite.errorTitle")} description={localizeError(error, t)} /> : null}

      {invitesQuery.isPending ? (
        <View accessible accessibilityLabel={t("mobile:groupChatInvite.loading")} accessibilityState={{ busy: true }} style={{ gap: space.sm }}>
          <Skeleton width="100%" height={112} radius={radius.xl} />
        </View>
      ) : null}

      {!invitesQuery.isPending && invites.length === 0 ? (
        <EmptyState compact icon={<Link2 size={22} color={colors.fgMuted} />} title={t("mobile:groupChatInvite.empty")} />
      ) : null}

      {invites.map((invite) => (
        <Animated.View
          key={invite.id}
          entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          layout={LinearTransition.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
          style={{ gap: space.md, padding: space.lg, borderRadius: radius.xl, borderCurve: "continuous", backgroundColor: colors.surface }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Link2 size={18} color={colors.accent} strokeWidth={2} />
            <Text selectable type="ui" tone="default" numberOfLines={2} style={{ flex: 1, fontWeight: "500" }}>
              {buildInviteLink(invite.code)}
            </Text>
            <IconButton
              icon={copiedId === invite.id ? Check : Copy}
              active={copiedId === invite.id}
              label={copiedId === invite.id ? t("buttons.copied") : t("mobile:invite.copyLink")}
              onPress={() => onCopy(invite)}
            />
          </View>

          <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
            {inviteLimits(invite, t)}
          </Text>

          {confirmingRevoke === invite.id ? (
            <Text type="meta" tone="muted" style={{ fontWeight: "400", lineHeight: 17 }}>
              {t("mobile:groupChatInvite.revokeBody")}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
            <Button label={t("mobile:invite.share")} icon={Share2} variant="accent" size="sm" onPress={() => onShare(invite)} />

            {/* Owner only. A member never sees this at all — a revoke the API
                would answer 403 to is not a disabled button, it is no button. */}
            {canRevoke ? (
              confirmingRevoke === invite.id ? (
                <>
                  <Button
                    label={t("mobile:groupChatInvite.revokeConfirm")}
                    icon={Trash2}
                    variant="danger"
                    size="sm"
                    haptic="medium"
                    loading={revokeInvite.isPending}
                    disabled={busy && !revokeInvite.isPending}
                    onPress={() =>
                      revokeInvite.mutate(invite.id, {
                        onSuccess: () => setConfirmingRevoke(null),
                      })
                    }
                  />
                  <Button label={t("buttons.cancel")} variant="ghost" size="sm" disabled={busy} onPress={() => setConfirmingRevoke(null)} />
                </>
              ) : (
                <Button
                  label={t("mobile:groupChatInvite.revoke")}
                  icon={Trash2}
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onPress={() => setConfirmingRevoke(invite.id)}
                />
              )
            ) : null}
          </View>
        </Animated.View>
      ))}

      {/* Creating is open to EVERY member — a group chat has no roles, and the
          owner already controls who stays. Never gated on `canRevoke`. */}
      <Button
        variant={invites.length > 0 ? "ghost" : "primary"}
        size="lg"
        block
        icon={Link2}
        label={createInvite.isPending ? t("mobile:groupChatInvite.creating") : t("mobile:groupChatInvite.create")}
        onPress={onCreate}
        disabled={busy}
        loading={createInvite.isPending}
      >
        {/* Label + icon come from props. The explicit closing tag is load-bearing
            for group-chat-invite-wiring.test.ts, which reads this element up to
            its </Button> to prove the create action is never owner-gated. */}
      </Button>

      {!canRevoke && invites.length > 0 ? (
        <Text type="meta" tone="faint" style={{ textAlign: "center", fontWeight: "400" }}>
          {t("mobile:groupChatInvite.ownerOnlyRevoke")}
        </Text>
      ) : null}
    </ScrollView>
  );
}
