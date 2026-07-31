import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "./ui/Text";
import type { ChannelId, GroupId, RoleId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { RoleMultiSelect } from "@/components/RoleMultiSelect";
import { Segmented } from "@/components/Segmented";
import { localizeError } from "@/lib/errors";
import { useChannelRoles, useRoles, useSetChannelRoles } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

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
    <View style={{ gap: space.md }}>
      <View style={{ height: 1, backgroundColor: colors.stroke }} />

      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
          {t("mobile:visibility.title")}
        </Text>
        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>{t("mobile:visibility.note")}</Text>
      </View>

      {error ? (
        <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
          <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
            {error}
          </Text>
        </View>
      ) : null}

      <Segmented<Mode>
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
      <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
        {mode === "public"
          ? t("mobile:visibility.everyoneDesc")
          : t("mobile:visibility.selectedRolesDesc")}
      </Text>

      {mode === "restricted" ? (
        isLoading ? (
          <Text style={{ color: colors.fgFaint, fontSize: 13 }}>
            {t("mobile:serverSettings.loading")}
          </Text>
        ) : (roles ?? []).length === 0 ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
            {t("mobile:visibility.noRoles")}
          </Text>
        ) : (
          <RoleMultiSelect roles={roles ?? []} selected={selected} onToggle={toggle} />
        )
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Button
          label={t("mobile:visibility.save")}
          onPress={onSave}
          loading={setChannelRoles.isPending}
          style={{ flex: 1 }}
        />
        {saved && !setChannelRoles.isPending ? (
          <Text style={{ color: colors.online, fontSize: 12 }}>{t("mobile:visibility.saved")}</Text>
        ) : null}
      </View>
    </View>
  );
}
