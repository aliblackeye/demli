import { useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Trash2 } from "lucide-react-native";
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_PER_GROUP,
  CUSTOM_EMOJI_NAME_MAX_LENGTH,
  isCustomEmojiMime,
  isCustomEmojiName,
} from "@demli/config";
import { ApiClientError } from "@demli/client-core";
import type { CustomEmoji, GroupId } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { Screen } from "@/components/Screen";
import { TextField } from "@/components/TextField";
import {
  useCreateCustomEmoji,
  useCustomEmojiMap,
  useCustomEmojis,
  useDeleteCustomEmoji,
  useServerPermissions,
} from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, radius, space, typography } from "@/theme/theme";

/** Human-readable byte cap for the copy ("256 KB"). */
const MAX_KB = Math.round(CUSTOM_EMOJI_MAX_BYTES / 1024);

/**
 * Localize an emoji upload/delete failure.
 *
 * The emoji codes stay additive server-side (deliberately NOT in
 * `ApiClientErrorCode`), so the runtime `code` string is compared here. Every
 * branch gets its own catalog key because the user CAN act on each difference —
 * rename, shrink, convert, or delete something first.
 */
function emojiErrorText(err: unknown, t: AppTFunction): string {
  const code = err instanceof ApiClientError ? (err.code as string) : null;
  switch (code) {
    case "INVALID_EMOJI":
      return t("mobile:emoji.invalid");
    case "EMOJI_TOO_LARGE":
      return t("mobile:emoji.tooLarge", { max: MAX_KB });
    case "EMOJI_NAME_TAKEN":
      return t("mobile:emoji.nameTaken");
    case "EMOJI_LIMIT":
      return t("mobile:emoji.limit", { max: CUSTOM_EMOJI_MAX_PER_GROUP });
    case "EMOJI_DISABLED":
      return t("mobile:emoji.disabled");
    default:
      return t("mobile:emoji.error");
  }
}

/**
 * Server settings → Emoji (M17), the mobile twin of the desktop renderer's
 * server-settings/EmojiTab. Upload, list and remove a server's custom emoji,
 * which members then use as `:name:` in any message of that server.
 *
 * Limits and the name grammar are IMPORTED from @demli/config, never
 * re-typed, so the copy can never drift from what the API enforces (§23). The
 * client pre-validates name / MIME / size purely for a fast, friendly reject —
 * the server re-validates the real bytes (magic-byte sniff) and is authoritative.
 */
export default function ServerEmojiScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId?: string }>();
  const groupId = (params.groupId ?? null) as GroupId | null;

  const { data, isPending } = useCustomEmojis(groupId);
  const urls = useCustomEmojiMap(groupId);
  const create = useCreateCustomEmoji(groupId);
  const { isOwner } = useServerPermissions(groupId);

  const [name, setName] = useState("");
  const [picked, setPicked] = useState<{ base64: string; mime: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const emojis = data?.emojis ?? [];
  const maxPerGroup = data?.maxPerGroup ?? CUSTOM_EMOJI_MAX_PER_GROUP;
  const full = emojis.length >= maxPerGroup;
  const normalizedName = name.trim().toLowerCase();
  const nameValid = isCustomEmojiName(normalizedName);
  const canSubmit = !full && picked !== null && nameValid && !create.isPending;

  const pickImage = async (): Promise<void> => {
    setError(null);
    // `base64: true` because the API takes the bytes INLINE (they are capped at
    // 256 KB), so there is no pending-upload dance to drive here.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      base64: true,
      allowsMultipleSelection: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) {
      setError(t("mobile:emoji.error"));
      return;
    }
    // Local pre-checks mirroring the server's gates, so an obviously bad file
    // never costs a round trip. `mimeType` can be absent on some Android
    // providers — fall back to PNG, which the server re-verifies anyway.
    const mime = asset.mimeType ?? "image/png";
    if (!isCustomEmojiMime(mime)) {
      setError(t("mobile:emoji.invalid"));
      return;
    }
    // base64 inflates ~4/3; compare the DECODED size against the real cap.
    const decodedBytes = Math.floor((asset.base64.length * 3) / 4);
    if (decodedBytes > CUSTOM_EMOJI_MAX_BYTES) {
      setError(t("mobile:emoji.tooLarge", { max: MAX_KB }));
      return;
    }
    setPicked({ base64: asset.base64, mime, uri: asset.uri });
    if (name.trim().length === 0 && asset.fileName) {
      const stem = asset.fileName.replace(/\.[^.]+$/, "").toLowerCase();
      const cleaned = stem.replace(/[^a-z0-9_]/g, "_").slice(0, CUSTOM_EMOJI_NAME_MAX_LENGTH);
      if (isCustomEmojiName(cleaned)) setName(cleaned);
    }
  };

  const submit = (): void => {
    if (!picked || !nameValid) return;
    setError(null);
    create.mutate(
      { name: normalizedName, mime: picked.mime, dataBase64: picked.base64 },
      {
        onSuccess: () => {
          setName("");
          setPicked(null);
        },
        onError: (err) => setError(emojiErrorText(err, t)),
      },
    );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t("mobile:emoji.title") }} />
      <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ flex: 1, color: colors.fgMuted, fontSize: 13 }}>
            {t("mobile:emoji.hint")}
          </Text>
          <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
            {t("mobile:emoji.count", { used: emojis.length, max: maxPerGroup })}
          </Text>
        </View>

        {/* Upload form. Disabled — not hidden — when the group is full, with the
            reason spelled out, so the affordance is never silently inert (§35). */}
        <View
          style={{
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.stroke,
            backgroundColor: colors.surface,
          }}
        >
          <TextField
            label={t("mobile:emoji.name")}
            value={name}
            onChangeText={setName}
            editable={!full}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={CUSTOM_EMOJI_NAME_MAX_LENGTH}
            placeholder={t("mobile:emoji.namePlaceholder")}
          />
          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
            {t("mobile:emoji.nameHint")}
          </Text>

          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            {picked ? (
              <Image
                source={{ uri: picked.uri }}
                accessibilityIgnoresInvertColors
                style={{ width: 36, height: 36, borderRadius: radius.sm }}
                resizeMode="contain"
              />
            ) : null}
            <Button
              label={t("mobile:emoji.pickFile")}
              variant="ghost"
              disabled={full}
              onPress={() => void pickImage()}
              style={{ flex: 1 }}
            />
            <Button
              label={t("mobile:emoji.upload")}
              disabled={!canSubmit}
              onPress={submit}
              style={{ flex: 1 }}
            />
          </View>

          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
            {t("mobile:emoji.tooLarge", { max: MAX_KB })} · PNG / WebP
          </Text>
          {full ? (
            <Text style={{ color: colors.idle, fontSize: 12 }}>
              {t("mobile:emoji.limit", { max: maxPerGroup })}
            </Text>
          ) : null}
          {error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
        </View>

        {isPending ? (
          <ActivityIndicator color={colors.fgFaint} />
        ) : emojis.length === 0 ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13, textAlign: "center" }}>
            {t("mobile:emoji.empty")}
          </Text>
        ) : (
          <View style={{ gap: space.xs }}>
            {emojis.map((emoji) => (
              <EmojiRow
                key={emoji.id}
                groupId={groupId}
                emoji={emoji}
                url={urls.get(emoji.name)}
                isOwner={isOwner}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

/** One emoji row: preview, shortcode, uploader, and a gated remove. */
function EmojiRow({
  groupId,
  emoji,
  url,
  isOwner,
}: {
  groupId: GroupId | null;
  emoji: CustomEmoji;
  url: string | undefined;
  isOwner: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const uploader = useChatStore((s) => s.users[emoji.createdBy]);
  const remove = useDeleteCustomEmoji(groupId);

  // Server rule: the uploader may remove their own; anyone else needs owner.
  // §35 — someone who cannot delete never sees the button.
  const canDelete = isOwner || (currentUserId !== undefined && emoji.createdBy === currentUserId);

  const confirmDelete = (): void => {
    Alert.alert(
      t("mobile:emoji.deleteConfirmTitle"),
      t("mobile:emoji.deleteConfirmBody", { name: emoji.name }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.delete"),
          style: "destructive",
          onPress: () =>
            remove.mutate(emoji.id, {
              onError: (err) => Alert.alert(t("mobile:emoji.error"), emojiErrorText(err, t)),
            }),
        },
      ],
    );
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.sm,
          backgroundColor: colors.surfaceRaised,
        }}
      >
        {url ? (
          <Image
            source={{ uri: url }}
            accessibilityIgnoresInvertColors
            style={{ width: 24, height: 24 }}
            resizeMode="contain"
          />
        ) : (
          <ActivityIndicator size="small" color={colors.fgFaint} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>:{emoji.name}:</Text>
        <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
          {uploader?.displayName ?? uploader?.username ?? t("mobile:chat.unknownAuthor")} ·{" "}
          {Math.max(1, Math.round(emoji.sizeBytes / 1024))} KB
        </Text>
      </View>
      {canDelete ? (
        <Pressable
          onPress={confirmDelete}
          disabled={remove.isPending}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:emoji.delete")}
          style={{ padding: space.xs, opacity: remove.isPending ? 0.5 : 1 }}
        >
          <Trash2 size={18} color={colors.danger} />
        </Pressable>
      ) : null}
    </View>
  );
}
