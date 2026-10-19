import { useEffect } from "react";
import { ScrollView, Share, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Clock, CloudOff, Copy, Link2, Share2, Users } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import type { Invite } from "@demli/types";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Text } from "@/components/ui/Text";
import { toast } from "@/components/ui/toast-store";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { buildInviteLink } from "@/lib/deep-links";
import { useCreateInvite } from "@/queries/chat-queries";
import { colors, motion, radius, space } from "@/theme/theme";

const INVITE_EXPIRES_HOURS = 24 * 7;
const INVITE_MAX_USES = 25;

/** Expiry line from the real server-issued value. */
function inviteExpiry(invite: Invite, t: AppTFunction): string {
  if (!invite.expiresAt) return t("mobile:invite.neverExpires");
  const hours = Math.max(0, Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000));
  return hours >= 48
    ? t("mobile:invite.expiresInDays", { days: Math.round(hours / 24) })
    : t("mobile:invite.expiresInHours", { hours });
}

/** Uses line from the real server-issued value. */
function inviteUses(invite: Invite, t: AppTFunction): string {
  if (invite.maxUses === null) return t("mobile:invite.unlimitedUses");
  const left = Math.max(0, invite.maxUses - invite.useCount);
  return t("mobile:invite.usesLeft", { left, max: invite.maxUses });
}

/**
 * Create + share an invite for a group you own/belong to. Mints a fresh invite
 * on mount (mirrors the desktop InviteDialog), then surfaces the shareable link
 * and the raw code with one-tap copy and the native Share sheet. Presented as a
 * modal from the group screen header.
 *
 * Koyu Masa: the link in a raised card with its own copy control, the code as a
 * wide-tracked pill, the real limits (expiry, uses left) as two quiet lines, and
 * copy confirmed by a toast + haptic. Minting draws the card's shape; a failure
 * says so with a retry.
 */
export default function InviteScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId ?? null;
  const insets = useSafeAreaInsets();

  const createInvite = useCreateInvite(groupId);
  const { mutate } = createInvite;

  useEffect(() => {
    if (groupId) mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES });
  }, [groupId, mutate]);

  const invite = createInvite.data?.invite;
  const link = invite ? buildInviteLink(invite.code) : "";

  const copy = (value: string, what: "link" | "code") => {
    if (!value) return;
    void Clipboard.setStringAsync(value).then(() => {
      haptics.light();
      toast({
        key: "invite-copied",
        variant: "success",
        title: what === "link" ? t("mobile:invite.linkCopied") : t("mobile:invite.codeCopied"),
        duration: 2000,
      });
    });
  };

  const onShare = () => {
    if (!invite) return;
    const serverName = params.name ?? t("mobile:invite.shareServerFallback");
    void Share.share({
      message: t("mobile:invite.shareMessage", { server: serverName, link, code: invite.code }),
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.app }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.lg + insets.bottom, gap: space.xl }}
    >
      <Stack.Screen
        options={{
          title: params.name ? t("mobile:invite.titleNamed", { name: params.name }) : t("mobile:invite.titleGeneric"),
        }}
      />

      {createInvite.isPending ? (
        <View accessible accessibilityLabel={t("mobile:invite.creating")} accessibilityState={{ busy: true }} style={{ gap: space.lg }}>
          <Skeleton width="80%" height={16} />
          <Skeleton width="100%" height={64} radius={radius.xl} />
          <Skeleton width="50%" height={40} radius={radius.pill} />
          <Skeleton width="100%" height={52} radius={radius.cta} />
        </View>
      ) : null}

      {createInvite.isError ? (
        <EmptyState
          tone="error"
          icon={<CloudOff size={22} color={colors.danger} />}
          title={t("mobile:invite.createErrorTitle")}
          subtitle={localizeError(createInvite.error, t)}
          action={
            <Button
              label={t("common:buttons.retry")}
              variant="secondary"
              size="sm"
              onPress={() => mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES })}
            />
          }
        />
      ) : null}

      {invite ? (
        <Animated.View entering={FadeIn.duration(motion.duration.arrival).reduceMotion(ReduceMotion.System)} style={{ gap: space.xl }}>
          <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
            {t("mobile:invite.intro")}
          </Text>

          <View>
            <SectionEyebrow>{t("mobile:invite.linkLabel")}</SectionEyebrow>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                paddingLeft: space.lg,
                paddingRight: space.xs,
                paddingVertical: space.sm,
                minHeight: 60,
                borderRadius: radius.xl,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
              }}
            >
              <Link2 size={18} color={colors.accent} strokeWidth={2} />
              <Text selectable type="ui" tone="default" numberOfLines={2} style={{ flex: 1, fontWeight: "500" }}>
                {link}
              </Text>
              <IconButton icon={Copy} label={t("mobile:invite.copyLink")} onPress={() => copy(link, "link")} />
            </View>
          </View>

          <View>
            <SectionEyebrow>{t("mobile:invite.codeLabel")}</SectionEyebrow>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm + 2, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised }}>
                <Text selectable type="subheading" tone="display" style={{ letterSpacing: 2, fontVariant: ["tabular-nums"] }}>
                  {invite.code}
                </Text>
              </View>
              <IconButton icon={Copy} label={t("mobile:invite.copyCode")} onPress={() => copy(invite.code, "code")} />
            </View>
          </View>

          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Clock size={15} color={colors.fgFaint} strokeWidth={2} />
              <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                {inviteExpiry(invite, t)}
              </Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Users size={15} color={colors.fgFaint} strokeWidth={2} />
              <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                {inviteUses(invite, t)}
              </Text>
            </View>
          </View>

          <Button label={t("mobile:invite.share")} icon={Share2} variant="accent" size="lg" block onPress={onShare} />
        </Animated.View>
      ) : null}
    </ScrollView>
  );
}
