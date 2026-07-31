/**
 * The one-field editor behind the user menu's THREE text actions — private note,
 * private ("friend") nickname, and per-server nickname (ADR 0019 §1–2).
 *
 * They share a form because they share a shape (one field, a max length, a clear
 * affordance, a save) and, more importantly, because they must NOT share a
 * privacy line: two of them are visible only to the viewer and one is visible to
 * an entire server. Stating that where the text is typed — rather than in a
 * settings page — is the difference between a private label and an accidental
 * public rename, so `privacy` is a required prop, not an option.
 *
 * This is CONTENT, not a modal. It renders inside the menu's own sheet, because
 * on Android a second `Modal` mounted in the same commit that hides the first
 * one is attached but never presented — the editor opened its keyboard over an
 * invisible card (caught on the emulator). One sheet whose content swaps has no
 * such race, and it reads better too: the menu morphs into the editor in place.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { Text, TextInput } from "@/components/ui/Text";
import { colors, radius, space, typography } from "@/theme/theme";

export function MemberTextForm({
  title,
  description,
  /** The rule that governs WHO can see this value. Rendered under the field. */
  privacy,
  placeholder,
  maxLength,
  /** Server value to prefill; `null` means "not set yet". */
  initialValue,
  /** True while the current value is being fetched (note / nickname reads). */
  loading = false,
  /** Label for the "remove it" button; omitted when clearing makes no sense. */
  clearLabel,
  multiline = false,
  saving = false,
  onSave,
  onCancel,
}: {
  title: string;
  description: string;
  privacy: string;
  placeholder: string;
  maxLength: number;
  initialValue: string | null;
  loading?: boolean;
  clearLabel?: string;
  multiline?: boolean;
  saving?: boolean;
  /** `null` clears the value server-side; a string writes it. */
  onSave: (value: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useAppTranslation();
  const [value, setValue] = useState(initialValue ?? "");

  // Re-seed when the fetched value lands — the note read resolves AFTER the
  // editor is already on screen. Keyed by the value itself, so it only fires
  // when the server value genuinely changes (and while the editor is open the
  // only thing that changes it is our own save).
  useEffect(() => {
    setValue(initialValue ?? "");
  }, [initialValue]);

  const trimmed = value.trim();
  const hasStoredValue = (initialValue ?? "").trim().length > 0;

  return (
    <View style={{ gap: space.md, paddingHorizontal: space.sm, paddingBottom: space.sm }}>
      <View style={{ gap: space.xs }}>
        <Text
          variant="display"
          numberOfLines={2}
          style={{ color: colors.fg, fontSize: 17, fontWeight: "700" }}
        >
          {title}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>{description}</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.fgFaint} />
      ) : (
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={colors.fgFaint}
          maxLength={maxLength}
          multiline={multiline}
          autoFocus
          style={{
            backgroundColor: colors.surfaceRaised,
            borderColor: colors.stroke,
            borderWidth: 1,
            borderRadius: radius.md,
            borderCurve: "continuous",
            color: colors.fg,
            fontSize: 15,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            minHeight: multiline ? 96 : undefined,
            textAlignVertical: multiline ? "top" : "center",
          }}
        />
      )}

      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
        {/* The privacy rule, stated where the value is typed. */}
        <Text style={{ flex: 1, color: colors.fgFaint, fontSize: 12, lineHeight: 17 }}>
          {privacy}
        </Text>
        <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
          {value.length}/{maxLength}
        </Text>
      </View>

      <View style={{ gap: space.sm }}>
        <Button
          label={t("common:buttons.save")}
          onPress={() => onSave(trimmed.length > 0 ? trimmed : null)}
          loading={saving}
          disabled={saving || loading}
        />
        {/* Only offered when there IS something to remove (§35). */}
        {clearLabel && hasStoredValue ? (
          <Button
            label={clearLabel}
            variant="ghost"
            onPress={() => onSave(null)}
            disabled={saving || loading}
          />
        ) : null}
        <Button
          label={t("common:buttons.cancel")}
          variant="ghost"
          onPress={onCancel}
          disabled={saving}
        />
      </View>
    </View>
  );
}
