import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Share, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, Share2 } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import type { Invite } from "@demli/types";
import { Button } from "@/components/Button";
import { localizeError } from "@/lib/errors";
import { buildInviteLink } from "@/lib/deep-links";
import { useCreateInvite } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

const INVITE_EXPIRES_HOURS = 24 * 7;
const INVITE_MAX_USES = 25;

/** Human summary of an invite's limits, from the real server-issued values. */
function inviteLimits(invite: Invite, t: AppTFunction): string {
  const parts: string[] = [];
  if (invite.expiresAt) {
    const hours = Math.max(
      0,
      Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 3_600_000),
    );
    parts.push(
      hours >= 48
        ? t("mobile:invite.expiresInDays", { days: Math.round(hours / 24) })
        : t("mobile:invite.expiresInHours", { hours }),
    );
  } else {
    parts.push(t("mobile:invite.neverExpires"));
  }
  if (invite.maxUses !== null) {
    const left = Math.max(0, invite.maxUses - invite.useCount);
    parts.push(t("mobile:invite.usesLeft", { left, max: invite.maxUses }));
  } else {
    parts.push(t("mobile:invite.unlimitedUses"));
  }
  return parts.join(" · ");
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.fgMuted, fontSize: 12, fontWeight: "600" }}>{children}</Text>
  );
}

/** A read-only, long-press-selectable value on a raised surface. */
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
      <Text
        selectable
        style={{ color: colors.fg, fontSize: 15, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * Create + share an invite for a group you own/belong to. Mints a fresh invite
 * on mount (mirrors the desktop InviteDialog), then surfaces the shareable link
 * and the raw code. Copy is via long-press-select or the native Share sheet.
 * Presented as a modal from the group screen header.
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

  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    if (!link) return;
    void Clipboard.setStringAsync(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const onShare = () => {
    if (!invite) return;
    const serverName = params.name ?? t("mobile:invite.shareServerFallback");
    void Share.share({
      message: t("mobile:invite.shareMessage", {
        server: serverName,
        link,
        code: invite.code,
      }),
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.app }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.lg + insets.bottom,
        gap: space.xl,
      }}
    >
      <Stack.Screen
        options={{
          title: params.name
            ? t("mobile:invite.titleNamed", { name: params.name })
            : t("mobile:invite.titleGeneric"),
        }}
      />

      {createInvite.isPending ? (
        <View style={{ paddingTop: space.xl, alignItems: "center", gap: space.md }}>
          <ActivityIndicator color={colors.fgFaint} />
          <Text style={{ color: colors.fgMuted, fontSize: 14 }}>{t("mobile:invite.creating")}</Text>
        </View>
      ) : null}

      {createInvite.isError ? (
        <View style={{ gap: space.md }}>
          <View
            style={{
              backgroundColor: colors.dangerSurface,
              borderRadius: radius.sm,
              padding: space.md,
            }}
          >
            <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
              {localizeError(createInvite.error, t)}
            </Text>
          </View>
          <Button
            label={t("buttons.retry")}
            variant="ghost"
            onPress={() => mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES })}
          />
        </View>
      ) : null}

      {invite ? (
        <>
          <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}>
            {t("mobile:invite.intro")}
          </Text>

          <View style={{ gap: space.sm }}>
            <FieldLabel>{t("mobile:invite.linkLabel")}</FieldLabel>
            <ValueBox value={link} />
          </View>

          <View style={{ gap: space.sm }}>
            <FieldLabel>{t("mobile:invite.codeLabel")}</FieldLabel>
            <ValueBox value={invite.code} />
          </View>

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button variant="ghost" onPress={onCopy} style={{ flex: 1 }}>
              {copied ? (
                <Check size={18} color={colors.online} />
              ) : (
                <Copy size={18} color={colors.fg} />
              )}
              <Text
                style={{
                  color: copied ? colors.online : colors.fg,
                  fontSize: 15,
                  fontWeight: "600",
                }}
              >
                {copied ? t("buttons.copied") : t("buttons.copy")}
              </Text>
            </Button>
            <Button onPress={onShare} style={{ flex: 1 }}>
              <Share2 size={18} color={colors.onAccent} />
              <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "600" }}>
                {t("mobile:invite.share")}
              </Text>
            </Button>
          </View>

          <Text style={{ color: colors.fgFaint, fontSize: 13, textAlign: "center" }}>
            {inviteLimits(invite, t)}.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
