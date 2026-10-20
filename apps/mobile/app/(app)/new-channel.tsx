import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Hash, Plus, Volume2, type LucideIcon } from "lucide-react-native";
import { CHANNEL_NAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import type { CategoryId, ChannelKind, RoleId } from "@demli/types";
import { NsfwToggle } from "@/components/NsfwToggle";
import { RoleMultiSelect } from "@/components/RoleMultiSelect";
import { Segmented } from "@/components/Segmented";
import { TextField } from "@/components/TextField";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useCreateChannel, useRoles } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

type Visibility = "public" | "restricted";

/** The two channel kinds as choice tiles: what each one is FOR, not just its name. */
const KINDS = [
  {
    value: "text",
    icon: Hash,
    label: "mobile:newChannel.kindText",
    description: "mobile:newChannel.kindTextDesc",
  },
  {
    value: "voice",
    icon: Volume2,
    label: "mobile:newChannel.kindVoice",
    description: "mobile:newChannel.kindVoiceDesc",
  },
] as const satisfies readonly { value: ChannelKind; icon: LucideIcon; label: string; description: string }[];

/**
 * Owner-only: add a text or voice channel to a server. Modal from the server screen.
 *
 * Koyu Masa: the kind as two choice tiles (coral wash on the chosen one, each
 * saying what the kind is for), the name field led by the kind's glyph, NSFW as
 * a switch card, role visibility as its own card. Errors land in a banner above.
 */
export default function NewChannel() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; categoryId?: string }>();
  const groupId = params.groupId ?? null;
  /**
   * Set when the screen was opened from a category header's "+" (M18) — the new
   * channel is filed there instead of landing in the uncategorized list, which is
   * the whole point of that button.
   */
  const categoryId = (params.categoryId ?? null) as CategoryId | null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const createChannel = useCreateChannel(groupId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("text");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [selectedRoles, setSelectedRoles] = useState<Set<RoleId>>(new Set());
  const [nsfw, setNsfw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Roles only exist on servers; an empty list (the MVP default) hides the whole
  // visibility section — no non-functional UI (task #51).
  const { data: roles } = useRoles(groupId);
  const hasRoles = (roles?.length ?? 0) > 0;

  const toggleRole = (roleId: RoleId) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const roleList = useMemo(() => roles ?? [], [roles]);

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > CHANNEL_NAME_MAX_LENGTH) {
      setError(t("mobile:channelSettings.validationName", { max: CHANNEL_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    // Restricted with no roles selected stays public; an unrestricted channel
    // sends no roleIds at all.
    const roleIds =
      hasRoles && visibility === "restricted" ? [...selectedRoles] : [];
    // NSFW is a text-channel-only flag (the API rejects it on voice); only send
    // it when set so voice channels never carry it.
    createChannel.mutate(
      {
        name: trimmed,
        kind,
        roleIds,
        ...(kind === "text" && nsfw ? { nsfw: true } : {}),
        // Only sent when the screen was opened from a category header, so a
        // plain "new channel" keeps landing in the uncategorized list.
        ...(categoryId ? { categoryId } : {}),
      },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
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
        <Stack.Screen options={{ title: t("mobile:newChannel.title") }} />

        {error ? <Banner variant="danger" title={t("mobile:newChannel.errorTitle")} description={error} /> : null}

        {/* Kind: two choice tiles, the chosen one on the coral wash. */}
        <View accessibilityRole="radiogroup" accessibilityLabel={t("mobile:newChannel.kindLabel")} style={{ flexDirection: "row", gap: space.sm }}>
          {KINDS.map((option) => {
            const selected = kind === option.value;
            const Icon = option.icon;
            return (
              <Touchable
                key={option.value}
                onPress={() => {
                  if (selected) return;
                  haptics.selection();
                  setKind(option.value);
                }}
                accessibilityRole="radio"
                accessibilityLabel={t(option.label)}
                accessibilityHint={t(option.description)}
                accessibilityState={{ checked: selected }}
                tone={selected ? colors.accentSurface : colors.surface}
                pressedTone={selected ? colors.accentSurfaceStrong : colors.surfaceRaised}
                style={{ flex: 1, gap: space.sm, padding: space.lg, borderRadius: radius.xl, borderCurve: "continuous" }}
              >
                <Icon size={22} color={selected ? colors.accent : colors.fgMuted} strokeWidth={2} />
                <View style={{ gap: 2 }}>
                  <Text type="body" style={{ fontWeight: "600", color: selected ? colors.accent : colors.fg }}>
                    {t(option.label)}
                  </Text>
                  <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                    {t(option.description)}
                  </Text>
                </View>
              </Touchable>
            );
          })}
        </View>

        <TextField
          label={t("mobile:newChannel.nameLabel")}
          value={name}
          onChangeText={setName}
          maxLength={CHANNEL_NAME_MAX_LENGTH}
          leading={
            kind === "voice" ? (
              <Volume2 size={18} color={colors.fgFaint} />
            ) : (
              <Hash size={18} color={colors.fgFaint} />
            )
          }
          placeholder={
            kind === "voice" ? t("mobile:newChannel.placeholderVoice") : t("mobile:newChannel.placeholderText")
          }
          autoCapitalize="none"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onCreate}
          editable={!createChannel.isPending}
        />

        {kind === "text" ? <NsfwToggle value={nsfw} onChange={setNsfw} /> : null}

        {hasRoles ? (
          <View style={{ gap: space.md, backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", padding: space.lg }}>
            <Text accessibilityRole="header" variant="display" style={{ color: colors.fgDisplay, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>
              {t("mobile:newChannel.visibilityLabel")}
            </Text>
            <Segmented<Visibility>
              accessibilityLabel={t("mobile:newChannel.visibilityLabel")}
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "public", label: t("mobile:newChannel.visibilityEveryone") },
                { value: "restricted", label: t("mobile:newChannel.visibilityRoles") },
              ]}
            />
            <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16 }}>{t("mobile:newChannel.visibilityNote")}</Text>

            {visibility === "restricted" ? (
              <RoleMultiSelect roles={roleList} selected={selectedRoles} onToggle={toggleRole} />
            ) : null}
          </View>
        ) : null}

        <Button
          label={t("mobile:newChannel.create")}
          icon={Plus}
          variant="accent"
          size="lg"
          block
          onPress={onCreate}
          loading={createChannel.isPending}
          disabled={name.trim().length === 0}
        />
      </ScrollView>
    </View>
  );
}
