import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { CloudOff, LogOut, Monitor, MonitorSmartphone, Smartphone } from "lucide-react-native";
import type { SessionSummary } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonList } from "@/components/Skeleton";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { RowIcon, SectionEyebrow } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { getApi } from "@/lib/clients";
import { localizeError } from "@/lib/errors";
import { queryKeys } from "@/lib/query-client";
import { logoutActiveAccount } from "@/lib/account-manager";
import type { AppTFunction } from "@/lib/i18n";
import { colors, motion, radius, space } from "@/theme/theme";

/**
 * "Oturumlar" — the active-sessions screen (M15), the mobile mirror of the
 * desktop SessionsSettings. Lists every login session (device + platform + "last
 * seen") with THIS device first and marked, and closes another session or every
 * OTHER session — each confirmed in a sheet that keeps the request's busy state
 * and error in place. Closing the CURRENT session logs this device out.
 *
 * States: skeleton rows while loading, an error block with retry, an honest
 * empty line, then the list. A closed session leaves the list on the fast fade
 * and the rest close the gap on a layout transition.
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

function deviceNameOf(session: SessionSummary, t: AppTFunction): string {
  return (
    session.deviceName ??
    (session.platform === "mobile" ? t("mobile:accounts.sessions.unknownMobile") : t("mobile:accounts.sessions.unknownDevice"))
  );
}

function SessionRow({ session, onRevoke, revoking }: { session: SessionSummary; onRevoke: () => void; revoking: boolean }) {
  const { t } = useAppTranslation();
  const deviceName = deviceNameOf(session, t);
  return (
    <Animated.View
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      layout={LinearTransition.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: session.current ? colors.selected : colors.surface,
      }}
    >
      <RowIcon icon={session.platform === "mobile" ? Smartphone : Monitor} tone={session.current ? "accent" : "default"} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text type="body" tone="default" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
            {deviceName}
          </Text>
          {session.current ? <Badge variant="success" label={t("mobile:accounts.sessions.current")} /> : null}
        </View>
        <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
          {t("mobile:accounts.sessions.lastSeen", { when: formatLastSeen(session.lastSeenAt, t) })}
        </Text>
      </View>
      <Button
        label={session.current ? t("mobile:accounts.sessions.signOutThis") : t("mobile:accounts.sessions.revoke")}
        variant="danger"
        size="sm"
        accessibilityLabel={`${session.current ? t("mobile:accounts.sessions.signOutThis") : t("mobile:accounts.sessions.revoke")}: ${deviceName}`}
        onPress={onRevoke}
        loading={revoking}
      />
    </Animated.View>
  );
}

type Pending = { kind: "one"; session: SessionSummary } | { kind: "others" } | null;

export default function ActiveSessionsScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => getApi().listSessions(),
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => getApi().revokeSession(sessionId),
    onSuccess: () => {
      setPending(null);
      return queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (err: unknown) => setError(localizeError(err, t)),
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => getApi().revokeOtherSessions(),
    onSuccess: () => {
      setPending(null);
      return queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (err: unknown) => setError(localizeError(err, t)),
  });

  // This device first, then most recently seen — the one you are holding is the
  // reference point for "which of these are not me?".
  const sessions = useMemo(() => {
    const list = [...(sessionsQuery.data?.sessions ?? [])];
    return list.sort((a, b) =>
      a.current === b.current ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.current ? -1 : 1,
    );
  }, [sessionsQuery.data]);
  const otherCount = sessions.filter((s) => !s.current).length;

  const ask = (next: Pending) => {
    setError(null);
    setPending(next);
  };

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === "others") {
      revokeOthersMutation.mutate();
      return;
    }
    if (pending.session.current) {
      setSigningOut(true);
      void logoutActiveAccount().finally(() => setSigningOut(false));
      return;
    }
    revokeMutation.mutate(pending.session.id);
  };

  const busy = revokeMutation.isPending || revokeOthersMutation.isPending || signingOut;
  const pendingName = pending?.kind === "one" ? deviceNameOf(pending.session, t) : "";

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom, gap: space.sm }}
        refreshControl={
          <RefreshControl
            refreshing={sessionsQuery.isRefetching}
            onRefresh={() => void sessionsQuery.refetch()}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
      >
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20, paddingBottom: space.sm }}>
          {t("mobile:accounts.sessions.description")}
        </Text>

        {sessionsQuery.isLoading ? (
          <SkeletonList count={3} lines={2} leadingSize={32} leadingRadius={radius.md} />
        ) : sessionsQuery.isError ? (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl }}>
            <EmptyState
              tone="error"
              compact
              icon={<CloudOff size={22} color={colors.danger} />}
              title={t("mobile:accounts.sessions.loadErrorTitle")}
              subtitle={localizeError(sessionsQuery.error, t)}
              action={
                <Button
                  label={t("common:buttons.retry")}
                  variant="secondary"
                  size="sm"
                  onPress={() => void sessionsQuery.refetch()}
                  loading={sessionsQuery.isFetching}
                />
              }
            />
          </View>
        ) : sessions.length === 0 ? (
          <EmptyState
            compact
            icon={<MonitorSmartphone size={22} color={colors.fgMuted} />}
            title={t("mobile:accounts.sessions.empty")}
          />
        ) : (
          <>
            <SectionEyebrow>{t("mobile:accounts.sessions.countLabel", { count: sessions.length })}</SectionEyebrow>
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                onRevoke={() => ask({ kind: "one", session })}
                revoking={revokeMutation.isPending && revokeMutation.variables === session.id}
              />
            ))}
          </>
        )}

        {error && pending === null ? (
          <Banner variant="danger" title={t("mobile:accounts.sessions.errorTitle")} description={error} onDismiss={() => setError(null)} />
        ) : null}

        {otherCount > 0 ? (
          <View style={{ paddingTop: space.md }}>
            <Button
              label={t("mobile:accounts.sessions.revokeOthers")}
              icon={LogOut}
              variant="danger"
              size="lg"
              block
              loading={revokeOthersMutation.isPending}
              onPress={() => ask({ kind: "others" })}
            />
          </View>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pending !== null}
        title={
          pending?.kind === "others"
            ? t("mobile:accounts.sessions.revokeOthers")
            : pending?.session.current
              ? t("mobile:accounts.sessions.signOutThisTitle")
              : t("mobile:accounts.sessions.revokeTitle", { name: pendingName })
        }
        body={
          pending?.kind === "others"
            ? t("mobile:accounts.sessions.revokeOthersConfirm")
            : pending?.session.current
              ? t("mobile:accounts.sessions.signOutThisBody")
              : t("mobile:accounts.sessions.revokeBody")
        }
        confirmLabel={
          pending?.kind === "others"
            ? t("mobile:accounts.sessions.revokeOthersConfirmCta")
            : pending?.session.current
              ? t("mobile:accounts.sessions.signOutThis")
              : t("mobile:accounts.sessions.revoke")
        }
        confirmIcon={LogOut}
        onConfirm={confirm}
        cancelLabel={t("mobile:accounts.cancel")}
        onCancel={() => setPending(null)}
        busy={busy}
        error={pending ? error : null}
        errorTitle={t("mobile:accounts.sessions.errorTitle")}
      />
    </Screen>
  );
}
