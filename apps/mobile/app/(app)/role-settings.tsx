import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Lock, Save, ShieldQuestion, Trash2 } from "lucide-react-native";
import { PERMISSIONS, type PermissionBitfield } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { EmptyState } from "@/components/EmptyState";
import { RoleColorPicker } from "@/components/RoleColorPicker";
import { Skeleton } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ToggleRow } from "@/components/ToggleRow";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { DangerZone, SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { PERMISSION_ROWS, ROLE_DOT_FALLBACK, ROLE_NAME_MAX } from "@/lib/roles";
import { useDeleteRole, useRoles, useServerPermissions, useUpdateRole } from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * Role editor (ADR 0007): name, color, and the 5 MVP permission bits. Reached
 * from the server-settings Roles section (create then edit, mirroring desktop).
 * Owner ∨ MANAGE_ROLES; inputs disable for viewers without the permission — the
 * API is authoritative regardless.
 *
 * Koyu Masa: a live preview at the top (the role's pill and your name in its
 * colour, exactly as a member list shows them), name + colour, permissions as a
 * checklist card with what each bit allows, deletion in the danger zone behind
 * a sheet. A viewer without the permission sees the role read-only, and is told.
 */
export default function RoleSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; roleId: string }>();
  const groupId = params.groupId ?? null;
  const roleId = params.roleId ?? null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const me = useAuthStore((s) => s.user);

  const { data: roles, isLoading } = useRoles(groupId);
  const role = roles?.find((r) => r.id === roleId) ?? null;
  const { isOwner, can } = useServerPermissions(groupId);
  const canManage = isOwner || can(PERMISSIONS.MANAGE_ROLES);

  const updateRole = useUpdateRole(groupId);
  const deleteRole = useDeleteRole(groupId);

  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [bits, setBits] = useState<PermissionBitfield>(0);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Seed once from the fetched role.
  useEffect(() => {
    if (role && !hydrated) {
      setName(role.name);
      setColor(role.color);
      setBits(role.permissions);
      setHydrated(true);
    }
  }, [role, hydrated]);

  const trimmed = name.trim();
  const dirty = !!role && (trimmed !== role.name || color !== role.color || bits !== role.permissions);
  const nameInvalid = hydrated && (trimmed.length === 0 || trimmed.length > ROLE_NAME_MAX);

  const onSave = () => {
    if (!roleId) return;
    if (trimmed.length === 0 || trimmed.length > ROLE_NAME_MAX) {
      setError(t("mobile:roleEditor.validationName", { max: ROLE_NAME_MAX }));
      return;
    }
    setError(null);
    updateRole.mutate(
      { roleId, name: trimmed, color, permissions: bits },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onDelete = () => {
    if (!roleId) return;
    setDeleteError(null);
    deleteRole.mutate(roleId, {
      onSuccess: () => {
        setConfirmDelete(false);
        router.back();
      },
      onError: (err) => setDeleteError(localizeError(err, t)),
    });
  };

  const tint = color ?? ROLE_DOT_FALLBACK;
  const previewName = me?.displayName || me?.username || t("mobile:common.you");

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen options={{ title: t("mobile:roleEditor.title") }} />

        {isLoading && !role ? (
          <View style={{ gap: space.lg }}>
            <Skeleton width="100%" height={72} radius={radius.xl} />
            <Skeleton width="100%" height={44} radius={radius.lg} />
            <Skeleton width="100%" height={220} radius={radius.xl} />
          </View>
        ) : null}

        {!isLoading && !role ? (
          <EmptyState
            icon={<ShieldQuestion size={22} color={colors.fgMuted} />}
            title={t("mobile:roleEditor.notFound")}
            action={<Button label={t("common:buttons.back")} variant="secondary" size="sm" onPress={() => router.back()} />}
          />
        ) : null}

        {role ? (
          <>
            {/* Live preview: the pill and a name in the role's colour. */}
            <View
              accessible
              accessibilityLabel={`${t("mobile:roleEditor.previewHeading")}: ${trimmed || role.name}`}
              style={{ gap: space.md, padding: space.lg, borderRadius: radius.xl, borderCurve: "continuous", backgroundColor: colors.surface }}
            >
              <SectionEyebrow style={{ paddingHorizontal: 0, paddingBottom: 0 }}>{t("mobile:roleEditor.previewHeading")}</SectionEyebrow>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
                <Text type="body" numberOfLines={1} style={{ fontWeight: "600", color: color ?? colors.fg, flexShrink: 1 }}>
                  {previewName}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs + 2,
                    paddingHorizontal: space.md,
                    paddingVertical: space.xs + 1,
                    borderRadius: radius.pill,
                    backgroundColor: colors.surfaceRaised,
                  }}
                >
                  <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: tint }} />
                  <Text type="meta" tone="default" numberOfLines={1} style={{ fontWeight: "500" }}>
                    {trimmed || role.name}
                  </Text>
                </View>
              </View>
            </View>

            {!canManage ? (
              <Banner variant="info" icon={Lock} title={t("mobile:roleEditor.readOnlyTitle")} description={t("mobile:roleEditor.readOnlyBody")} />
            ) : null}

            {error ? <Banner variant="danger" title={t("mobile:roleEditor.saveErrorTitle")} description={error} /> : null}

            <TextField
              label={t("mobile:roleEditor.nameLabel")}
              value={name}
              onChangeText={setName}
              maxLength={ROLE_NAME_MAX}
              editable={canManage}
              placeholder={t("mobile:roleEditor.namePlaceholder")}
              error={nameInvalid ? t("mobile:roleEditor.validationName", { max: ROLE_NAME_MAX }) : null}
            />

            <View style={{ gap: space.sm }}>
              <SectionEyebrow style={{ paddingBottom: 0 }}>{t("mobile:roleEditor.color")}</SectionEyebrow>
              <RoleColorPicker value={color} disabled={!canManage} onChange={setColor} noColorLabel={t("mobile:roleEditor.noColor")} />
            </View>

            <View>
              <SectionEyebrow>{t("mobile:roleEditor.permissions")}</SectionEyebrow>
              <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", padding: space.xs }}>
                {PERMISSION_ROWS.map((row) => {
                  const bit = PERMISSIONS[row.bit];
                  return (
                    <ToggleRow
                      key={row.bit}
                      label={t(row.labelKey)}
                      description={t(row.descriptionKey)}
                      checked={(bits & bit) === bit}
                      disabled={!canManage}
                      onToggle={() => setBits((prev) => prev ^ bit)}
                    />
                  );
                })}
              </View>
            </View>

            {canManage ? (
              <>
                <Button
                  label={t("mobile:roleEditor.save")}
                  icon={Save}
                  variant="accent"
                  size="lg"
                  block
                  onPress={onSave}
                  loading={updateRole.isPending}
                  disabled={!dirty || trimmed.length === 0}
                />

                <DangerZone title={t("mobile:common.dangerZone")} description={t("mobile:roleEditor.dangerDescription")}>
                  <Button
                    label={t("mobile:roleEditor.delete")}
                    icon={Trash2}
                    variant="danger"
                    onPress={() => {
                      setDeleteError(null);
                      setConfirmDelete(true);
                    }}
                  />
                </DangerZone>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={confirmDelete}
        title={t("mobile:roleEditor.deleteConfirmTitle")}
        body={t("mobile:roleEditor.deleteConfirmBody", {
          name: role?.name ?? t("mobile:roleEditor.deleteConfirmFallbackName"),
        })}
        confirmLabel={t("buttons.delete")}
        confirmIcon={Trash2}
        onConfirm={onDelete}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmDelete(false)}
        busy={deleteRole.isPending}
        error={deleteError}
        errorTitle={t("mobile:roleEditor.deleteError")}
      />
    </View>
  );
}
