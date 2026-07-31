import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogOut, Monitor, Smartphone } from "lucide-react-native";
import type { SessionSummary } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { Screen } from "@/components/Screen";
import { getApi } from "@/lib/clients";
import { localizeError } from "@/lib/errors";
import { queryKeys } from "@/lib/query-client";
import { logoutActiveAccount } from "@/lib/account-manager";
import type { AppTFunction } from "@/lib/i18n";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * "Oturumlar" — the active-sessions screen (M15), the mobile mirror of the
 * desktop SessionsSettings. Lists every login session (device + platform + "last
 * seen"), flags the current one, and closes another session or every OTHER
 * session (confirmed). Closing the CURRENT session logs this device out.
 */

/** Compact, Hermes-safe "last seen" (no Intl.RelativeTimeFormat). */
function formatLastSeen(iso: string, t: AppTFunction): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 45) return t("mobile:accounts.sessions.justNow");
  const min = Math.round(sec / 60);
  if (min < 60) return t("mobile:accounts.sessions.minutesAgo", { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("mobile:accounts.sessions.hoursAgo", { count: hr });
  const day = Math.round(hr / 24);
  return t("mobile:accounts.sessions.daysAgo", { count: day });
}

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: SessionSummary;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const { t } = useAppTranslation();
  const Icon = session.platform === "mobile" ? Smartphone : Monitor;
  const deviceName =
    session.deviceName ??
    (session.platform === "mobile"
      ? t("mobile:accounts.sessions.unknownMobile")
      : t("mobile:accounts.sessions.unknownDevice"));

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <Icon size={22} color={colors.fgMuted} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, fontWeight: "600", flexShrink: 1 }}>
            {deviceName}
          </Text>
          {session.current ? (
            <Text
              style={{
                color: colors.online,
                fontSize: typography.size.badge,
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {t("mobile:accounts.sessions.current")}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: colors.fgFaint, fontSize: 13, marginTop: 2 }}>
          {t("mobile:accounts.sessions.lastSeen", { when: formatLastSeen(session.lastSeenAt, t) })}
        </Text>
      </View>
      <Pressable
        onPress={onRevoke}
        disabled={revoking}
        hitSlop={8}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          opacity: revoking ? 0.5 : pressed ? 0.6 : 1,
        })}
      >
        {revoking ? (
          <ActivityIndicator size="small" color={colors.danger} />
        ) : (
          <LogOut size={16} color={colors.danger} />
        )}
        <Text style={{ color: colors.danger, fontSize: 13, fontWeight: "600" }}>
          {session.current
            ? t("mobile:accounts.sessions.signOutThis")
            : t("mobile:accounts.sessions.revoke")}
        </Text>
      </Pressable>
    </View>
  );
}

export default function ActiveSessionsScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => getApi().listSessions(),
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => getApi().revokeSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
    onError: (err: unknown) =>
      Alert.alert(t("mobile:accounts.sessions.errorTitle"), localizeError(err, t)),
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => getApi().revokeOtherSessions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
    onError: (err: unknown) =>
      Alert.alert(t("mobile:accounts.sessions.errorTitle"), localizeError(err, t)),
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const otherCount = sessions.filter((s) => !s.current).length;

  const onRevoke = (session: SessionSummary): void => {
    if (session.current) {
      void logoutActiveAccount();
      return;
    }
    revokeMutation.mutate(session.id);
  };

  const onRevokeOthers = (): void => {
    Alert.alert(
      t("mobile:accounts.sessions.revokeOthers"),
      t("mobile:accounts.sessions.revokeOthersConfirm"),
      [
        { text: t("mobile:accounts.cancel"), style: "cancel" },
        {
          text: t("mobile:accounts.sessions.revokeOthersConfirmCta"),
          style: "destructive",
          onPress: () => revokeOthersMutation.mutate(),
        },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: space.md,
          paddingBottom: space.md + insets.bottom,
          gap: space.sm,
        }}
      >
        <Text style={{ color: colors.fgMuted, fontSize: 13, paddingHorizontal: space.sm }}>
          {t("mobile:accounts.sessions.description")}
        </Text>

        {sessionsQuery.isLoading ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.lg }}>
            <ActivityIndicator size="small" color={colors.fgMuted} />
            <Text style={{ color: colors.fgFaint, fontSize: 14 }}>
              {t("mobile:accounts.sessions.loading")}
            </Text>
          </View>
        ) : sessionsQuery.isError ? (
          <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.md, padding: space.lg }}>
            <Text style={{ color: colors.danger, fontSize: 14 }}>
              {localizeError(sessionsQuery.error, t)}
            </Text>
          </View>
        ) : sessions.length === 0 ? (
          <Text style={{ color: colors.fgFaint, fontSize: 14, padding: space.lg }}>
            {t("mobile:accounts.sessions.empty")}
          </Text>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onRevoke={() => onRevoke(session)}
              revoking={revokeMutation.isPending && revokeMutation.variables === session.id}
            />
          ))
        )}

        {otherCount > 0 ? (
          <View style={{ paddingTop: space.md }}>
            <Button
              label={t("mobile:accounts.sessions.revokeOthers")}
              variant="ghost"
              loading={revokeOthersMutation.isPending}
              onPress={onRevokeOthers}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
