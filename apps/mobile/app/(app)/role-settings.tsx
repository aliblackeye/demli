import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PERMISSIONS, type PermissionBitfield } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { RoleColorPicker } from "@/components/RoleColorPicker";
import { TextField } from "@/components/TextField";
import { ToggleRow } from "@/components/ToggleRow";
import { localizeError } from "@/lib/errors";
import { PERMISSION_ROWS, ROLE_NAME_MAX } from "@/lib/roles";
import {
  useDeleteRole,
  useRoles,
  useServerPermissions,
  useUpdateRole,
} from "@/queries/chat-queries";
import { colors, radius, space, typography } from "@/theme/theme";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Role editor (ADR 0007): name, color, and the 5 MVP permission bits. Reached
 * from the server-settings Roles section (create then edit, mirroring desktop).
 * Owner ∨ MANAGE_ROLES; inputs disable for viewers without the permission — the
 * API is authoritative regardless.
 */
export default function RoleSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; roleId: string }>();
  const groupId = params.groupId ?? null;
  const roleId = params.roleId ?? null;
  const insets = useSafeAreaInsets();

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
  const dirty =
    !!role && (trimmed !== role.name || color !== role.color || bits !== role.permissions);

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
    Alert.alert(
      t("mobile:roleEditor.deleteConfirmTitle"),
      t("mobile:roleEditor.deleteConfirmBody", {
        name: role?.name ?? t("mobile:roleEditor.deleteConfirmFallbackName"),
      }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.delete"),
          style: "destructive",
          onPress: () =>
            deleteRole.mutate(roleId, {
              onSuccess: () => router.back(),
              onError: (err) =>
                Alert.alert(t("mobile:roleEditor.deleteError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen options={{ title: t("mobile:roleEditor.title") }} />

        {isLoading && !role ? (
          <View style={{ paddingTop: space.xl, alignItems: "center" }}>
            <ActivityIndicator color={colors.fgFaint} />
          </View>
        ) : null}

        {!isLoading && !role ? (
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", paddingTop: space.xl }}>
            {t("mobile:roleEditor.notFound")}
          </Text>
        ) : null}

        {role ? (
          <>
            {error ? (
              <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
                <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
                  {error}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: space.md }}>
              <TextField
                label={t("mobile:roleEditor.nameLabel")}
                value={name}
                onChangeText={setName}
                maxLength={ROLE_NAME_MAX}
                editable={canManage}
                placeholder={t("mobile:roleEditor.namePlaceholder")}
              />

              <View style={{ gap: space.sm }}>
                <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                  {t("mobile:roleEditor.color")}
                </Text>
                <RoleColorPicker
                  value={color}
                  disabled={!canManage}
                  onChange={setColor}
                  noColorLabel={t("mobile:roleEditor.noColor")}
                />
              </View>
            </View>

            <View style={{ gap: space.sm }}>
              <SectionLabel>{t("mobile:roleEditor.permissions")}</SectionLabel>
              <View style={{ marginHorizontal: -space.md }}>
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
                  onPress={onSave}
                  loading={updateRole.isPending}
                  disabled={!dirty || trimmed.length === 0}
                />

                <View style={{ height: 1, backgroundColor: colors.stroke }} />

                <View style={{ gap: space.md }}>
                  <SectionLabel>{t("mobile:common.dangerZone")}</SectionLabel>
                  <Button
                    label={t("mobile:roleEditor.delete")}
                    variant="danger"
                    onPress={onDelete}
                    loading={deleteRole.isPending}
                    style={{ borderRadius: radius.md }}
                  />
                </View>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
