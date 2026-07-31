import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, Link2, Share2, Trash2 } from "lucide-react-native";
import {
  canRevokeGroupChatInvite,
  inviteUsage,
  prefersDaysWording,
} from "@demli/client-core";
import type { GroupId, Invite } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { localizeError } from "@/lib/errors";
import { buildInviteLink } from "@/lib/deep-links";
import {
  useCreateGroupChatInvite,
  useGroupChatDetails,
  useGroupChatInvites,
  useRevokeGroupChatInvite,
} from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space } from "@/theme/theme";

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

function FieldLabel({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.fgMuted, fontSize: 12, fontWeight: "600" }}>{children}</Text>
  );
}

/** A read-only, long-press-selectable link on a raised surface. */
function ValueBox({ value }: { value: string }) {
  return (
    <View
      style={{
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.sm,
        borderCurve: "continuous",
        paddingHorizontal: space.md,
        paddingVertical: space.md,
      }}
    >
      <Text selectable style={{ color: colors.fg, fontSize: 14 }}>
        {value}
      </Text>
    </View>
  );
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
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.xl + insets.bottom,
        gap: space.xl,
      }}
    >
      <Stack.Screen
        options={{ title: t("mobile:groupChatInvite.title", { group: groupName }) }}
      />

      <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}>
        {t("mobile:groupChatInvite.description")}
      </Text>

      {error ? (
        <View
          style={{
            backgroundColor: colors.dangerSurface,
            borderRadius: radius.sm,
            padding: space.md,
          }}
        >
          <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
            {localizeError(error, t)}
          </Text>
        </View>
      ) : null}

      {invitesQuery.isPending ? (
        <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.lg }}>
          <ActivityIndicator color={colors.fgFaint} />
          <Text style={{ color: colors.fgMuted, fontSize: 14 }}>
            {t("mobile:groupChatInvite.loading")}
          </Text>
        </View>
      ) : null}

      {!invitesQuery.isPending && invites.length === 0 ? (
        <Text style={{ color: colors.fgMuted, fontSize: 14 }}>
          {t("mobile:groupChatInvite.empty")}
        </Text>
      ) : null}

      {invites.map((invite) => (
        <View key={invite.id} style={{ gap: space.sm }}>
          <FieldLabel>{t("mobile:groupChatInvite.linkLabel")}</FieldLabel>
          <ValueBox value={buildInviteLink(invite.code)} />

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button variant="ghost" onPress={() => onCopy(invite)} style={{ flex: 1 }}>
              {copiedId === invite.id ? (
                <Check size={18} color={colors.online} />
              ) : (
                <Copy size={18} color={colors.fg} />
              )}
              <Text
                style={{
                  color: copiedId === invite.id ? colors.online : colors.fg,
                  fontSize: 15,
                  fontWeight: "600",
                }}
              >
                {copiedId === invite.id ? t("buttons.copied") : t("buttons.copy")}
              </Text>
            </Button>
            <Button onPress={() => onShare(invite)} style={{ flex: 1 }}>
              <Share2 size={18} color={colors.onAccent} />
              <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "600" }}>
                {t("mobile:invite.share")}
              </Text>
            </Button>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ flex: 1, color: colors.fgFaint, fontSize: 12 }}>
              {inviteLimits(invite, t)}
            </Text>

            {/* Owner only. A member never sees this at all — a revoke the API
                would answer 403 to is not a disabled button, it is no button. */}
            {canRevoke ? (
              confirmingRevoke === invite.id ? (
                <View style={{ flexDirection: "row", gap: space.xs }}>
                  <Pressable
                    onPress={() =>
                      revokeInvite.mutate(invite.id, {
                        onSuccess: () => setConfirmingRevoke(null),
                      })
                    }
                    disabled={busy}
                    accessibilityRole="button"
                    style={({ pressed }) => ({
                      minHeight: 44,
                      justifyContent: "center",
                      paddingHorizontal: space.md,
                      borderRadius: radius.sm,
                      borderCurve: "continuous",
                      backgroundColor: colors.dangerSurface,
                      opacity: busy ? 0.5 : pressed ? 0.8 : 1,
                    })}
                  >
                    <Text style={{ color: colors.danger, fontSize: 13, fontWeight: "700" }}>
                      {t("mobile:groupChatInvite.revokeConfirm")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setConfirmingRevoke(null)}
                    disabled={busy}
                    accessibilityRole="button"
                    style={({ pressed }) => ({
                      minHeight: 44,
                      justifyContent: "center",
                      paddingHorizontal: space.md,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                      {t("buttons.cancel")}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setConfirmingRevoke(invite.id)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile:groupChatInvite.revoke")}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    minHeight: 44,
                    paddingHorizontal: space.md,
                    opacity: busy ? 0.5 : pressed ? 0.6 : 1,
                  })}
                >
                  <Trash2 size={16} color={colors.fgMuted} />
                  <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                    {t("mobile:groupChatInvite.revoke")}
                  </Text>
                </Pressable>
              )
            ) : null}
          </View>

          {confirmingRevoke === invite.id ? (
            <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 17 }}>
              {t("mobile:groupChatInvite.revokeBody")}
            </Text>
          ) : null}
        </View>
      ))}

      {/* Creating is open to EVERY member — a group chat has no roles, and the
          owner already controls who stays. Never gated on `canRevoke`. */}
      <Button
        variant={invites.length > 0 ? "ghost" : "primary"}
        onPress={onCreate}
        disabled={busy}
        loading={createInvite.isPending}
      >
        {createInvite.isPending ? null : (
          <Link2 size={18} color={invites.length > 0 ? colors.fg : colors.onAccent} />
        )}
        <Text
          style={{
            color: invites.length > 0 ? colors.fg : colors.onAccent,
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {createInvite.isPending
            ? t("mobile:groupChatInvite.creating")
            : t("mobile:groupChatInvite.create")}
        </Text>
      </Button>

      {!canRevoke && invites.length > 0 ? (
        <Text style={{ color: colors.fgFaint, fontSize: 12, textAlign: "center" }}>
          {t("mobile:groupChatInvite.ownerOnlyRevoke")}
        </Text>
      ) : null}
    </ScrollView>
  );
}
