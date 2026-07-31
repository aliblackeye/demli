import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Camera, ImagePlus, Trash2, TriangleAlert } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { BirthdateVerification } from "@/components/BirthdateVerification";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { TextField } from "@/components/TextField";
import { ApiClientError } from "@/lib/clients";
import { localizeError } from "@/lib/errors";
import { logoutActiveAccount } from "@/lib/account-manager";
import {
  pickProfileImage,
  ProfileImageError,
  type PickedProfileImage,
  type ProfileImageKind,
} from "@/lib/profile-image";
import {
  useDeleteAccount,
  useUpdateMe,
  useUploadAvatar,
  useUploadBanner,
} from "@/queries/management-queries";
import { useMe } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space, typography } from "@/theme/theme";

const DISPLAY_NAME_MAX = 64;
const BIO_MAX = 280;
const BANNER_HEIGHT = 140;
const AVATAR_SIZE = 88;

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

function ErrorNote({ children }: { children: string }) {
  return (
    <View
      style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}
    >
      <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
        {children}
      </Text>
    </View>
  );
}

/** Local preview source for a picked-but-unsaved image — no request, no upload. */
function draftPreviewUri(draft: PickedProfileImage | null): string | null {
  return draft?.previewUri ?? null;
}

/**
 * Edit the signed-in user's profile (M15): tap-to-change banner + avatar, display
 * name, bio, a SET-ONCE date of birth (drives the 18+ gate), and a danger zone to
 * delete the account. The me-only fields (birthdate / isAdult / bannerUrl) are
 * read from {@link useMe} (the `/users/me` record), falling back to the auth-store
 * user.
 *
 * ── Nothing is saved until you press Save ───────────────────────────────────
 * Founder rule, mirrored from the desktop panel: picking a photo or a banner
 * produces a local DRAFT (previewed from its own base64, zero bytes sent). One
 * "Save profile" then applies everything in order — images first (their URLs must
 * exist before the row that points at them settles), then name/bio, then the
 * set-once birthdate as its OWN request so a 409 BIRTHDATE_LOCKED cannot take the
 * name/bio save down with it.
 *
 * Each step is independent and reports on its own field, so a partial success is
 * visible rather than swallowed (§26): a step that succeeded clears its draft, a
 * step that failed KEEPS it, and pressing Save again retries exactly the parts
 * that did not land. Leaving the screen with unsaved edits — back button, back
 * gesture or the header arrow — raises a confirm first (`beforeRemove`).
 */
export default function Profile() {
  const { t } = useAppTranslation();
  const navigation = useNavigation();
  const meQuery = useMe();
  const storeUser = useAuthStore((s) => s.user);
  const user = meQuery.data ?? storeUser ?? null;
  const insets = useSafeAreaInsets();

  const updateMe = useUpdateMe();
  const uploadAvatar = useUploadAvatar();
  const uploadBanner = useUploadBanner();
  const deleteAccount = useDeleteAccount();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");

  // Picked-but-unsaved images. The base64 is held in memory only until Save — a
  // deliberate, hard-capped exception to §27's "no large media blobs in state"
  // (2 MB avatar / 5 MB banner, already the exact payload the upload call wants).
  // The PREVIEW renders from the accompanying local file uri, never from the
  // base64, so no huge string crosses the bridge on render.
  const [avatarDraft, setAvatarDraft] = useState<PickedProfileImage | null>(null);
  const [bannerDraft, setBannerDraft] = useState<PickedProfileImage | null>(null);
  const [avatarPicking, setAvatarPicking] = useState(false);
  const [bannerPicking, setBannerPicking] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  /** True when the last Save applied some changes but not all (§26 honesty). */
  const [partialFailure, setPartialFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const previewName = displayName.trim() || user?.username || t("mobile:common.you");
  const birthdateSet = !!user?.birthdate;

  // Drafts win over the persisted values so the screen previews exactly what Save
  // would apply — a local render, with no byte sent to the server.
  const avatarPreview = draftPreviewUri(avatarDraft) ?? user?.avatarUrl ?? null;
  const bannerPreview = draftPreviewUri(bannerDraft) ?? user?.bannerUrl ?? null;

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const nameDirty = trimmedName !== (user?.displayName ?? "");
  const bioDirty = trimmedBio !== (user?.bio ?? "");
  const dirty = nameDirty || bioDirty || avatarDraft !== null || bannerDraft !== null;

  const avatarBusy = avatarPicking || (saving && avatarDraft !== null);
  const bannerBusy = bannerPicking || (saving && bannerDraft !== null);

  // Re-seed the text fields from the server user — but NEVER over unsaved edits.
  // `user.updated` now lands here whenever this account changes anywhere (another
  // device, our own save), and clobbering a half-typed bio with it would be the
  // same class of data loss this whole screen is meant to prevent.
  useEffect(() => {
    if (nameDirty || bioDirty) return;
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    // Re-seeding is driven by the SERVER values only; the dirty flags are read as
    // a guard and deliberately excluded from the deps (including them would make
    // the first keystroke re-run the effect and fight the user's own typing).
  }, [user?.displayName, user?.bio]);

  /** Throw away every unsaved edit and return to the persisted profile. */
  const discardDraft = useCallback(() => {
    setAvatarDraft(null);
    setBannerDraft(null);
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
  }, [user?.displayName, user?.bio]);

  // ── Unsaved-changes guard ────────────────────────────────────────────────
  // Read through refs so the listener registers ONCE and still sees current
  // state: re-subscribing on every keystroke would drop an in-flight event.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** Set before an intentional exit (successful save, account deletion). */
  const bypassGuardRef = useRef(false);
  const discardRef = useRef(discardDraft);
  discardRef.current = discardDraft;

  useEffect(() => {
    // Covers the header arrow, the Android hardware back button and the back
    // gesture — all of them remove this screen, so all of them come through here.
    const unsubscribe = navigation.addListener("beforeRemove", (event) => {
      if (!dirtyRef.current || bypassGuardRef.current) return;
      event.preventDefault();
      Alert.alert(t("mobile:profile.unsavedTitle"), t("mobile:profile.unsavedBody"), [
        { text: t("mobile:profile.unsavedKeepEditing"), style: "cancel" },
        {
          text: t("mobile:profile.unsavedDiscard"),
          style: "destructive",
          onPress: () => {
            discardRef.current();
            bypassGuardRef.current = true;
            navigation.dispatch(event.data.action);
          },
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, t]);

  /** Localize an image pick/upload failure (own keys + avatar/banner API codes). */
  const imageErrorText = (err: unknown): string => {
    if (err instanceof ProfileImageError) return t(err.key);
    if (err instanceof ApiClientError) {
      const code = err.code as string;
      if (code === "INVALID_AVATAR" || code === "INVALID_BANNER")
        return t("mobile:profile.imageInvalidType");
      if (code === "AVATAR_TOO_LARGE") return t("mobile:profile.imageTooLargeAvatar");
      if (code === "BANNER_TOO_LARGE") return t("mobile:profile.imageTooLargeBanner");
      if (code === "AVATAR_UPLOADS_DISABLED" || code === "BANNER_UPLOADS_DISABLED")
        return t("mobile:profile.imageUploadsDisabled");
      if (code === "AVATAR_REJECTED" || code === "BANNER_REJECTED")
        return t("mobile:profile.imageRejected");
    }
    return localizeError(err, t);
  };

  /**
   * Pick + prepare an image and hold it as a DRAFT. No request is made here —
   * the bytes ship from {@link onSave} and nowhere else.
   */
  const onPickImage = async (kind: ProfileImageKind) => {
    if (saving) return;
    const setPicking = kind === "avatar" ? setAvatarPicking : setBannerPicking;
    const setKindError = kind === "avatar" ? setAvatarError : setBannerError;
    const setDraft = kind === "avatar" ? setAvatarDraft : setBannerDraft;
    setKindError(null);
    setPicking(true);
    try {
      const prepared = await pickProfileImage(kind);
      if (prepared) setDraft(prepared);
    } catch (err) {
      setKindError(imageErrorText(err));
    } finally {
      setPicking(false);
    }
  };

  const onSave = async () => {
    if (saving) return;
    if (trimmedName.length === 0 || trimmedName.length > DISPLAY_NAME_MAX) {
      setError(t("mobile:profile.validationDisplayName", { max: DISPLAY_NAME_MAX }));
      return;
    }
    if (trimmedBio.length > BIO_MAX) {
      setError(t("mobile:profile.validationBio", { max: BIO_MAX }));
      return;
    }

    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
    setSaving(true);

    let failed = false;

    if (avatarDraft) {
      try {
        await uploadAvatar.mutateAsync(avatarDraft.upload);
        setAvatarDraft(null);
      } catch (err) {
        setAvatarError(imageErrorText(err));
        failed = true;
      }
    }

    if (bannerDraft) {
      try {
        await uploadBanner.mutateAsync(bannerDraft.upload);
        setBannerDraft(null);
      } catch (err) {
        setBannerError(imageErrorText(err));
        failed = true;
      }
    }

    if (nameDirty || bioDirty) {
      try {
        await updateMe.mutateAsync({
          displayName: trimmedName,
          bio: trimmedBio.length > 0 ? trimmedBio : null,
        });
      } catch (err) {
        setError(localizeError(err, t));
        failed = true;
      }
    }

    setSaving(false);
    setPartialFailure(failed);
    if (failed) return;

    // Everything landed and there is nothing left to lose — leave without asking.
    // Closing the screen IS the confirmation: the surface behind it (You tab /
    // Settings row) already repaints with the new photo and name, which reads
    // stronger than a "Saved" chip that would flash for one frame before the
    // navigation transition (§35 — no dead UI).
    bypassGuardRef.current = true;
    router.back();
  };

  const onDelete = () => {
    Alert.alert(t("mobile:profile.deleteConfirmTitle"), t("mobile:profile.deleteConfirmBody"), [
      { text: t("buttons.cancel"), style: "cancel" },
      {
        text: t("mobile:profile.deleteConfirmAction"),
        style: "destructive",
        onPress: () => {
          setDeleting(true);
          deleteAccount.mutate(undefined, {
            onSuccess: () => {
              // The account is gone — never prompt about unsaved edits to a
              // profile that no longer exists.
              bypassGuardRef.current = true;
              void logoutActiveAccount();
            },
            onError: (err) => {
              setDeleting(false);
              Alert.alert(t("mobile:profile.deleteHeading"), localizeError(err, t));
            },
          });
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ paddingBottom: space.xl + insets.bottom, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen options={{ title: t("mobile:profile.title") }} />

        {/* Banner (tap to change) with the avatar overhanging it (tap to change).
            Both are DRAFTS until Save — the preview below is rendered from the
            picked bytes, not from anything the server has seen. */}
        <View>
          <Pressable
            onPress={() => void onPickImage("banner")}
            disabled={bannerBusy || saving}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:profile.bannerChange")}
          >
            <ProfileBannerImage
              bannerUrl={bannerPreview}
              seedId={user?.id ?? "self"}
              height={BANNER_HEIGHT}
            />
            <View
              style={{
                position: "absolute",
                right: space.md,
                top: space.md,
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                paddingHorizontal: space.sm,
                paddingVertical: space.xs,
                borderRadius: radius.pill,
                backgroundColor: "rgba(0,0,0,0.45)",
              }}
            >
              {bannerBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <ImagePlus size={14} color="#fff" />
              )}
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>
                {bannerPreview ? t("mobile:profile.bannerChange") : t("mobile:profile.bannerAdd")}
              </Text>
            </View>
          </Pressable>

          <View style={{ paddingHorizontal: space.lg, marginTop: -(AVATAR_SIZE / 2) }}>
            <Pressable
              onPress={() => void onPickImage("avatar")}
              disabled={avatarBusy || saving}
              accessibilityRole="button"
              accessibilityLabel={t("mobile:profile.avatarChange")}
              style={{
                alignSelf: "flex-start",
                borderRadius: radius.pill,
                backgroundColor: colors.app,
                padding: 4,
              }}
            >
              <Avatar name={previewName} size={AVATAR_SIZE} uri={avatarPreview} />
              <View
                style={{
                  position: "absolute",
                  right: 2,
                  bottom: 2,
                  width: 28,
                  height: 28,
                  borderRadius: radius.pill,
                  backgroundColor: colors.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 2,
                  borderColor: colors.app,
                }}
              >
                {avatarBusy ? (
                  <ActivityIndicator size="small" color={colors.onAccent} />
                ) : (
                  <Camera size={15} color={colors.onAccent} />
                )}
              </View>
            </Pressable>
            {user?.username ? (
              <Text style={{ color: colors.fgMuted, fontSize: 13, marginTop: space.xs }}>
                @{user.username}
              </Text>
            ) : null}
            {/* "Not saved yet" — the whole point of the draft model, said out loud. */}
            {avatarDraft || bannerDraft ? (
              <Text style={{ color: colors.fgFaint, fontSize: 12, marginTop: space.xs }}>
                {t("mobile:profile.imagePending")}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          {avatarError ? <ErrorNote>{avatarError}</ErrorNote> : null}
          {bannerError ? <ErrorNote>{bannerError}</ErrorNote> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <TextField
            label={t("mobile:profile.displayNameLabel")}
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={DISPLAY_NAME_MAX}
            placeholder={t("mobile:profile.displayNamePlaceholder")}
          />
          <TextField
            label={t("mobile:profile.bioLabel")}
            value={bio}
            onChangeText={setBio}
            maxLength={BIO_MAX}
            multiline
            placeholder={t("mobile:profile.bioPlaceholder")}
            hint={t("mobile:profile.bioHint", { count: bio.trim().length, max: BIO_MAX })}
            style={{ minHeight: 88, textAlignVertical: "top" }}
          />

          {partialFailure ? <ErrorNote>{t("mobile:profile.savePartial")}</ErrorNote> : null}

          {/* One Save for the WHOLE profile — images, name, bio and the set-once
              birthdate all ship from here, and only from here. */}
          <Button
            label={t("mobile:profile.save")}
            onPress={() => void onSave()}
            loading={saving}
            disabled={!dirty}
          />
          {/* A real Discard, so "leave without saving" is never the only way out. */}
          <Button
            label={t("mobile:profile.discard")}
            variant="ghost"
            onPress={discardDraft}
            disabled={saving || !dirty}
          />
        </View>

        {/* Date of birth — SET-ONCE, and therefore NOT part of the profile Save:
            it saves itself through the same confirming <BirthdateVerification>
            the NSFW gate uses, because this value can never be corrected
            afterwards. Read-only + 18+ status once set. */}
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <SectionLabel>{t("mobile:profile.birthdateSection")}</SectionLabel>
          {birthdateSet ? (
            <View
              style={{
                gap: space.xs,
                padding: space.lg,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.stroke,
              }}
            >
              <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
                {user?.birthdate}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
                {(user?.isAdult
                  ? t("mobile:profile.birthdateAdult")
                  : t("mobile:profile.birthdateMinor")) +
                  " · " +
                  t("mobile:profile.birthdateLocked")}
              </Text>
            </View>
          ) : (
            <>
              <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                {t("mobile:profile.birthdateHint")}
              </Text>
              <BirthdateVerification />
            </>
          )}
        </View>

        {/* Danger zone — delete account (14-day freeze). */}
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <SectionLabel>{t("mobile:common.dangerZone")}</SectionLabel>
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: colors.dangerSurface,
            }}
          >
            <TriangleAlert size={18} color={colors.danger} style={{ marginTop: 1 }} />
            <Text style={{ flex: 1, color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
              {t("mobile:profile.deleteDescription")}
            </Text>
          </View>
          <Button
            label={t("mobile:profile.deleteAction")}
            variant="danger"
            onPress={onDelete}
            loading={deleting}
            style={{ borderRadius: radius.md }}
          >
            <Trash2 size={16} color={colors.danger} />
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
