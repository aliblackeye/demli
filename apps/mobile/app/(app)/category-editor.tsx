import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderTree, Pencil, Plus } from "lucide-react-native";
import { CATEGORY_NAME_MAX_LENGTH } from "@demli/config";
import type { CategoryId, GroupId } from "@demli/types";
import { TextField } from "@/components/TextField";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useAppTranslation } from "@/lib/i18n";
import { useCreateCategory, useRenameCategory } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * Create or rename a channel category (M18) — mobile's parity of the desktop's
 * two category dialogs, collapsed into ONE modal because the only difference
 * between them is a title, a button label and whether an id is present.
 *
 * Deleting is deliberately NOT here: it is a confirm, not a form, so it stays an
 * `Alert` at the point of action in the channel list (the same shape the group
 * chat's delete uses). A modal that asks a yes/no question with a text field on
 * screen invites the wrong answer.
 *
 * Params: `groupId` always; `categoryId` + `name` only when renaming.
 *
 * The gate is COSMETIC (§28): this screen is only reachable from a menu that
 * `categoryMenuItems` already hid from anyone without owner ∨ MANAGE_CHANNELS,
 * and the API re-checks the permission on every write regardless.
 */
export default function CategoryEditor() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{
    groupId: string;
    categoryId?: string;
    name?: string;
  }>();
  const groupId = (params.groupId ?? null) as GroupId | null;
  const categoryId = (params.categoryId ?? null) as CategoryId | null;
  const isRename = categoryId !== null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const createCategory = useCreateCategory(groupId);
  const renameCategory = useRenameCategory(groupId);
  const pending = createCategory.isPending || renameCategory.isPending;

  const [name, setName] = useState(params.name ?? "");
  /** The request failed (shown as a banner titled with what failed). */
  const [error, setError] = useState<string | null>(null);
  /** The name itself is wrong (shown on the field). */
  const [validation, setValidation] = useState<string | null>(null);

  const onSubmit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > CATEGORY_NAME_MAX_LENGTH) {
      setValidation(t("mobile:category.nameRequired"));
      return;
    }
    setError(null);
    setValidation(null);

    const handlers = {
      onSuccess: () => router.back(),
      onError: (err: unknown) => setError(localizeError(err, t)),
    };

    if (isRename) renameCategory.mutate({ categoryId, name: trimmed }, handlers);
    else createCategory.mutate({ name: trimmed }, handlers);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom + keyboard,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen
          options={{
            title: isRename ? t("mobile:category.renameTitle") : t("mobile:category.createTitle"),
          }}
        />

        {/* Said once, up front: a category is organization, never permission.
            Without this line "category" reads like a place to hide channels. */}
        {isRename ? null : (
          <View
            style={{
              flexDirection: "row",
              gap: space.md,
              padding: space.lg,
              borderRadius: radius.xl,
              borderCurve: "continuous",
              backgroundColor: colors.surface,
            }}
          >
            <FolderTree size={20} color={colors.fgMuted} strokeWidth={2} style={{ marginTop: 1 }} />
            <Text type="ui" tone="muted" style={{ flex: 1, fontWeight: "400", lineHeight: 20 }}>
              {t("mobile:category.createDescription")}
            </Text>
          </View>
        )}

        {error ? (
          <Banner
            variant="danger"
            title={isRename ? t("mobile:category.renameFailed") : t("mobile:category.createFailed")}
            description={error}
          />
        ) : null}

        <TextField
          label={t("mobile:category.nameLabel")}
          value={name}
          onChangeText={(next) => {
            setName(next);
            if (validation) setValidation(null);
          }}
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          placeholder={t("mobile:category.namePlaceholder")}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onSubmit}
          error={validation}
          editable={!pending}
        />

        <Button
          label={isRename ? t("mobile:category.rename") : t("mobile:category.create")}
          icon={isRename ? Pencil : Plus}
          variant="accent"
          size="lg"
          block
          loading={pending}
          onPress={onSubmit}
        />
      </ScrollView>
    </View>
  );
}
