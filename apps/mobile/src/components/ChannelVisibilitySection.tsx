import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "./ui/Text";
import type { ChannelId, GroupId, RoleId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Check, Save } from "lucide-react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { RoleMultiSelect } from "@/components/RoleMultiSelect";
import { Segmented } from "@/components/Segmented";
import { localizeError } from "@/lib/errors";
import { useChannelRoles, useRoles, useSetChannelRoles } from "@/queries/chat-queries";
import { colors, motion, radius, space } from "@/theme/theme";

type Mode = "public" | "restricted";

/**
 * "Who can see this channel" — public (all members) or restricted to selected
 * roles (ADR 0007). The mobile mirror of the desktop ChannelVisibilitySection;
 * maps onto PUT /channels/:id/access (`[]` = public). Owner ∨ MANAGE_CHANNELS —
 * the parent only renders this for permitted viewers.
 */
export function ChannelVisibilitySection({
  groupId,
  channelId,
}: {
  groupId: GroupId;
  channelId: ChannelId;
}) {
  const { t } = useAppTranslation();
  const { data: roles } = useRoles(groupId);
  const { data: accessRoleIds, isLoading } = useChannelRoles(channelId);
  const setChannelRoles = useSetChannelRoles(groupId, channelId);

  const [mode, setMode] = useState<Mode>("public");
  const [selected, setSelected] = useState<Set<RoleId>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed per channel from the server's access list; re-seed when it changes
  // identity (initial load + after a successful save), not on every render.
  const serverKey = (accessRoleIds ?? []).join(",");
  useEffect(() => {
    if (!accessRoleIds) return;
    setMode(accessRoleIds.length > 0 ? "restricted" : "public");
    setSelected(new Set(accessRoleIds));
    setError(null);
    setSaved(false);
  }, [channelId, serverKey]);

  const toggle = (roleId: RoleId) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const onSave = () => {
    if (setChannelRoles.isPending) return;
    setError(null);
    const roleIds = mode === "public" ? [] : [...selected];
    setChannelRoles.mutate(roleIds, {
      onSuccess: () => setSaved(true),
      onError: (err) => setError(localizeError(err, t)),
    });
  };

  return (
    <View
      style={{
        gap: space.md,
        backgroundColor: colors.surface,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        padding: space.lg,
      }}
    >
      <View style={{ gap: space.xs }}>
        <Text
          accessibilityRole="header"
          variant="display"
          style={{ color: colors.fgDisplay, fontSize: 16, lineHeight: 22, fontWeight: "600" }}
        >
          {t("mobile:visibility.title")}
        </Text>
        <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16 }}>{t("mobile:visibility.note")}</Text>
      </View>

      {error ? <Banner variant="danger" title={t("mobile:visibility.saveErrorTitle")} description={error} /> : null}

      <Segmented<Mode>
        accessibilityLabel={t("mobile:visibility.title")}
        value={mode}
        onChange={(value) => {
          setMode(value);
          setSaved(false);
        }}
        options={[
          { value: "public", label: t("mobile:visibility.everyone") },
          { value: "restricted", label: t("mobile:visibility.selectedRoles") },
        ]}
      />
      <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
        {mode === "public" ? t("mobile:visibility.everyoneDesc") : t("mobile:visibility.selectedRolesDesc")}
      </Text>

      {mode === "restricted" ? (
        isLoading ? (
          <Text style={{ color: colors.fgFaint, fontSize: 13 }}>{t("mobile:serverSettings.loading")}</Text>
        ) : (roles ?? []).length === 0 ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13 }}>{t("mobile:visibility.noRoles")}</Text>
        ) : (
          <RoleMultiSelect roles={roles ?? []} selected={selected} onToggle={toggle} />
        )
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Button
          label={t("mobile:visibility.save")}
          icon={Save}
          variant="secondary"
          onPress={onSave}
          loading={setChannelRoles.isPending}
          style={{ flex: 1 }}
        />
        {saved && !setChannelRoles.isPending ? (
          <Animated.View
            entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
          >
            <Check size={14} color={colors.success} strokeWidth={2.5} />
            <Text style={{ color: colors.success, fontSize: 12, fontWeight: "500" }}>{t("mobile:visibility.saved")}</Text>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}
