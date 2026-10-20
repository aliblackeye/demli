import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudOff, ImagePlus, Smile, Trash2, Upload } from "lucide-react-native";
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
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { Skeleton, SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { toast } from "@/components/ui/toast-store";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import {
  useCreateCustomEmoji,
  useCustomEmojiMap,
  useCustomEmojis,
  useDeleteCustomEmoji,
  useServerPermissions,
} from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, radius, space } from "@/theme/theme";

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
 *
 * Koyu Masa: an upload card (picked preview, `:name:` field validated inline,
 * pick + upload), a quiet usage meter, the list as cards, removal confirmed in a
 * sheet. A full server shows the limit as a banner and dims the form — never an
 * inert control without a reason (§35).
 */
export default function ServerEmojiScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const params = useLocalSearchParams<{ groupId?: string }>();
  const groupId = (params.groupId ?? null) as GroupId | null;

  const { data, isPending, isError, error: loadError, refetch, isFetching } = useCustomEmojis(groupId);
  const urls = useCustomEmojiMap(groupId);
  const create = useCreateCustomEmoji(groupId);
  const remove = useDeleteCustomEmoji(groupId);
  const { isOwner } = useServerPermissions(groupId);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [name, setName] = useState("");
  const [picked, setPicked] = useState<{ base64: string; mime: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CustomEmoji | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const emojis = data?.emojis ?? [];
  const maxPerGroup = data?.maxPerGroup ?? CUSTOM_EMOJI_MAX_PER_GROUP;
  const full = emojis.length >= maxPerGroup;
  const normalizedName = name.trim().toLowerCase();
  const nameValid = isCustomEmojiName(normalizedName);
  const canSubmit = !full && picked !== null && nameValid && !create.isPending;
  const used = Math.min(1, maxPerGroup > 0 ? emojis.length / maxPerGroup : 0);

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
          haptics.success();
          toast({ key: "emoji-added", variant: "success", title: t("mobile:emoji.added", { name: normalizedName }) });
          setName("");
          setPicked(null);
        },
        onError: (err) => setError(emojiErrorText(err, t)),
      },
    );
  };

  const confirmRemove = (): void => {
    if (!removing) return;
    setRemoveError(null);
    remove.mutate(removing.id, {
      onSuccess: () => setRemoving(null),
      onError: (err) => setRemoveError(emojiErrorText(err, t)),
    });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t("mobile:emoji.title") }} />
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom + keyboard, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
          {t("mobile:emoji.hint")}
        </Text>

        {/* Usage meter — how much room is left, at a glance. */}
        <View style={{ gap: space.xs }}>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={t("mobile:emoji.count", { used: emojis.length, max: maxPerGroup })}
            accessibilityValue={{ min: 0, max: maxPerGroup, now: emojis.length }}
            style={{ height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, overflow: "hidden" }}
          >
            <View style={{ width: `${used * 100}%`, height: 4, borderRadius: radius.pill, backgroundColor: full ? colors.warning : colors.accent }} />
          </View>
          <Text type="caption" tone="faint">
            {t("mobile:emoji.count", { used: emojis.length, max: maxPerGroup })}
          </Text>
        </View>

        {full ? <Banner variant="warning" title={t("mobile:emoji.limit", { max: maxPerGroup })} /> : null}

        {/* Upload form. Dimmed — not hidden — when the server is full, with the
            reason in the banner above, so the affordance is never silently inert. */}
        <View
          pointerEvents={full ? "none" : "auto"}
          style={{ gap: space.md, padding: space.lg, borderRadius: radius.xl, borderCurve: "continuous", backgroundColor: colors.surface, opacity: full ? 0.4 : 1 }}
        >
          <SectionEyebrow style={{ paddingHorizontal: 0, paddingBottom: 0 }}>{t("mobile:emoji.add")}</SectionEyebrow>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Touchable
              onPress={() => void pickImage()}
              disabled={full}
              accessibilityRole="button"
              accessibilityLabel={t("mobile:emoji.pickFile")}
              tone={colors.surfaceRaised}
              pressedTone={colors.raisedHover}
              style={{ width: 64, height: 64, borderRadius: radius.lg, borderCurve: "continuous", alignItems: "center", justifyContent: "center" }}
            >
              {picked ? (
                <Image source={{ uri: picked.uri }} accessibilityIgnoresInvertColors style={{ width: 44, height: 44 }} contentFit="contain" />
              ) : (
                <ImagePlus size={22} color={colors.fgMuted} strokeWidth={2} />
              )}
            </Touchable>
            <View style={{ flex: 1 }}>
              <TextField
                label={t("mobile:emoji.name")}
                value={name}
                onChangeText={setName}
                editable={!full && !create.isPending}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={CUSTOM_EMOJI_NAME_MAX_LENGTH}
                placeholder={t("mobile:emoji.namePlaceholder")}
                error={normalizedName.length > 0 && !nameValid ? t("mobile:emoji.nameHint") : null}
                hint={t("mobile:emoji.nameHint")}
              />
            </View>
          </View>
          <Text type="caption" tone="faint">
            {t("mobile:emoji.tooLarge", { max: MAX_KB })} · PNG / WebP
          </Text>
          {error ? <Banner variant="danger" title={t("mobile:emoji.error")} description={error} /> : null}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button
              label={t("mobile:emoji.pickFile")}
              icon={ImagePlus}
              variant="secondary"
              disabled={full || create.isPending}
              onPress={() => void pickImage()}
              style={{ flex: 1 }}
            />
            <Button
              label={t("mobile:emoji.upload")}
              icon={Upload}
              variant="accent"
              disabled={!canSubmit}
              loading={create.isPending}
              onPress={submit}
              style={{ flex: 1 }}
            />
          </View>
        </View>

        {isPending ? (
          <SkeletonList count={4} lines={2} leadingSize={32} leadingRadius={radius.md} />
        ) : isError ? (
          <EmptyState
            tone="error"
            compact
            icon={<CloudOff size={22} color={colors.danger} />}
            title={t("mobile:emoji.loadErrorTitle")}
            subtitle={localizeError(loadError, t)}
            action={<Button label={t("common:buttons.retry")} variant="secondary" size="sm" onPress={() => void refetch()} loading={isFetching} />}
          />
        ) : emojis.length === 0 ? (
          <EmptyState compact icon={<Smile size={22} color={colors.fgMuted} />} title={t("mobile:emoji.empty")} subtitle={t("mobile:emoji.hint")} />
        ) : (
          <View style={{ gap: space.sm }}>
            {emojis.map((emoji) => (
              <EmojiRow
                key={emoji.id}
                emoji={emoji}
                url={urls.get(emoji.name)}
                // Server rule: the uploader may remove their own; anyone else
                // needs owner. §35 — someone who cannot delete never sees it.
                canDelete={isOwner || (currentUserId !== undefined && emoji.createdBy === currentUserId)}
                onRemove={() => {
                  setRemoveError(null);
                  setRemoving(emoji);
                }}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <ConfirmSheet
        visible={removing !== null}
        title={t("mobile:emoji.deleteConfirmTitle")}
        body={t("mobile:emoji.deleteConfirmBody", { name: removing?.name ?? "" })}
        confirmLabel={t("mobile:emoji.delete")}
        confirmIcon={Trash2}
        onConfirm={confirmRemove}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setRemoving(null)}
        busy={remove.isPending}
        error={removeError}
        errorTitle={t("mobile:emoji.error")}
      />
    </Screen>
  );
}

/** One emoji row: preview, shortcode, uploader + size, and a gated remove. */
function EmojiRow({
  emoji,
  url,
  canDelete,
  onRemove,
}: {
  emoji: CustomEmoji;
  url: string | undefined;
  canDelete: boolean;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const uploader = useChatStore((s) => s.users[emoji.createdBy]);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.sm,
        paddingLeft: space.md,
        paddingRight: space.xs,
        minHeight: 56,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surfaceRaised }}>
        {url ? (
          <Image source={{ uri: url }} accessibilityIgnoresInvertColors style={{ width: 28, height: 28 }} contentFit="contain" />
        ) : (
          <Skeleton width={24} height={24} radius={radius.sm} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text type="ui" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
          :{emoji.name}:
        </Text>
        <Text type="caption" tone="faint" numberOfLines={1}>
          {uploader?.displayName ?? uploader?.username ?? t("mobile:chat.unknownAuthor")} · {Math.max(1, Math.round(emoji.sizeBytes / 1024))} KB
        </Text>
      </View>
      {canDelete ? (
        <IconButton icon={Trash2} variant="ghost" label={`${t("mobile:emoji.delete")}: :${emoji.name}:`} onPress={onRemove} />
      ) : null}
    </View>
  );
}
