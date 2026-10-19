import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { router, Stack, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Camera, ImagePlus, LogOut, RotateCcw, Save, ShieldCheck, Trash2, Undo2 } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { BirthdateVerification } from "@/components/BirthdateVerification";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { TextField } from "@/components/TextField";
import { ImageCropEditor } from "@/components/profile/ImageCropEditor";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { DangerZone, SectionEyebrow, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { ActionDivider, ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Glass } from "@/components/ui/Glass";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { ApiClientError } from "@/lib/clients";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { logoutActiveAccount } from "@/lib/account-manager";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import {
  pickProfileSource,
  ProfileImageError,
  type PickedProfileImage,
  type ProfileImageKind,
  type ProfileImageSource,
} from "@/lib/profile-image";
import { useDeleteAccount, useUpdateMe, useUploadAvatar, useUploadBanner } from "@/queries/management-queries";
import { useMe } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, motion, radius, space } from "@/theme/theme";

const DISPLAY_NAME_MAX = 64;
const BIO_MAX = 280;
const AVATAR_SIZE = 88;

/** One request of the Save sequence — what the bar names while it runs. */
type SaveStep = "avatar" | "banner" | "profile";

/** What a field shows: a fresh draft, a pending removal, or the saved value. */
type ImageEdit = { kind: "draft"; image: PickedProfileImage } | { kind: "remove" } | null;

/**
 * Edit the signed-in user's profile: banner + avatar (each through the crop
 * editor), display name, bio, the SET-ONCE date of birth, and account deletion.
 *
 * ── The screen IS the card ───────────────────────────────────────────────────
 * The hero at the top is the profile card exactly as friends will see it once
 * saved — the 8:3 banner, the overlapping avatar, the name — and it redraws as
 * you type and crop. Tapping the banner or the avatar opens a small menu: a new
 * image (picker → crop editor), undo this change, or remove the current one.
 *
 * ── Nothing is saved until you press Save (founder rule, M15) ────────────────
 * A picked-and-cropped image is a local DRAFT (previewed from its own file, zero
 * bytes sent); a removal is a pending flag. The bar at the bottom appears with
 * the first change and runs ONE Save in order — avatar upload, banner upload,
 * then one PATCH for name/bio/removals — naming each step as it runs
 * ("Fotoğraf yükleniyor · 1/3") over a bar that fills step by step. Each step
 * reports on its own field: a step that landed clears its draft, a step that
 * failed keeps it, and "Tekrar dene" sends only what did not land (§26).
 *
 * Leaving with unsaved edits — header arrow, Android back, back gesture — opens
 * a sheet: save and leave, discard, or keep editing (`beforeRemove`). The date
 * of birth saves through its own confirming control (it can never be corrected)
 * and account deletion bypasses the guard on purpose.
 */
export default function Profile() {
  const { t } = useAppTranslation();
  const navigation = useNavigation();
  /** The navigation a guarded exit carried (what `beforeRemove` hands over). */
  type NavigationAction = Parameters<typeof navigation.dispatch>[0];
  const reduced = useReducedMotion();
  const meQuery = useMe();
  const storeUser = useAuthStore((s) => s.user);
  const user = meQuery.data ?? storeUser ?? null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const updateMe = useUpdateMe();
  const uploadAvatar = useUploadAvatar();
  const uploadBanner = useUploadBanner();
  const deleteAccount = useDeleteAccount();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");

  // Picked-but-unsaved images. The base64 is held in memory only until Save — a
  // deliberate, hard-capped exception to §27's "no large media blobs in state"
  // (512² avatar / ≤5 MB banner, already the exact payload the upload wants).
  // The PREVIEW renders from the accompanying local file uri, never the base64.
  const [avatarEdit, setAvatarEdit] = useState<ImageEdit>(null);
  const [bannerEdit, setBannerEdit] = useState<ImageEdit>(null);
  const [opening, setOpening] = useState<ProfileImageKind | null>(null);
  const [editorSource, setEditorSource] = useState<ProfileImageSource | null>(null);
  const [menu, setMenu] = useState<ProfileImageKind | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  /** The last Save applied some changes but not all (§26 honesty). */
  const [partialFailure, setPartialFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<{ id: SaveStep; index: number; total: number } | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The navigation a dirty screen held back — replayed after save/discard. */
  const [pendingLeave, setPendingLeave] = useState<NavigationAction | null>(null);

  const usernameLabel = user?.username ? `@${user.username}` : null;
  const previewName = displayName.trim() || user?.username || t("mobile:common.you");
  const birthdateSet = !!user?.birthdate;

  // What the hero shows = what Save would apply (a local render, no byte sent).
  const avatarPreview =
    avatarEdit?.kind === "draft" ? avatarEdit.image.previewUri : avatarEdit?.kind === "remove" ? null : (user?.avatarUrl ?? null);
  const bannerPreview =
    bannerEdit?.kind === "draft" ? bannerEdit.image.previewUri : bannerEdit?.kind === "remove" ? null : (user?.bannerUrl ?? null);

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const nameDirty = trimmedName !== (user?.displayName ?? "");
  const bioDirty = trimmedBio !== (user?.bio ?? "");
  const dirty = nameDirty || bioDirty || avatarEdit !== null || bannerEdit !== null;
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > DISPLAY_NAME_MAX;
  const nameError =
    nameInvalid && (nameTouched || nameDirty) ? t("mobile:profile.validationDisplayName", { max: DISPLAY_NAME_MAX }) : null;
  const bioError = trimmedBio.length > BIO_MAX ? t("mobile:profile.validationBio", { max: BIO_MAX }) : null;

  // Re-seed the text fields from the server user — but NEVER over unsaved edits.
  // `user.updated` lands here whenever this account changes anywhere (another
  // device, our own save); clobbering a half-typed bio would be data loss.
  useEffect(() => {
    if (nameDirty || bioDirty) return;
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    // Driven by the SERVER values only; the dirty flags are a guard and stay out
    // of the deps (the first keystroke would otherwise re-run and fight typing).
  }, [user?.displayName, user?.bio]);

  /** Throw away every unsaved edit and return to the persisted profile. */
  const discardDraft = useCallback(() => {
    setAvatarEdit(null);
    setBannerEdit(null);
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
    setNameTouched(false);
  }, [user?.displayName, user?.bio]);

  // ── Unsaved-changes guard ────────────────────────────────────────────────
  // Read through refs so the listener registers ONCE and still sees current
  // state: re-subscribing on every keystroke would drop an in-flight event.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** Set before an intentional exit (successful save, discard, account deletion). */
  const bypassGuardRef = useRef(false);

  useEffect(() => {
    // Covers the header arrow, the Android hardware back button and the back
    // gesture — all of them remove this screen, so all of them come through here.
    const unsubscribe = navigation.addListener("beforeRemove", (event) => {
      if (!dirtyRef.current || bypassGuardRef.current) return;
      event.preventDefault();
      haptics.light();
      setPendingLeave(event.data.action);
    });
    return unsubscribe;
  }, [navigation]);

  const leave = (action: NavigationAction | null) => {
    bypassGuardRef.current = true;
    if (action) navigation.dispatch(action);
    else router.back();
  };

  /** Localize an image pick/upload failure (own keys + avatar/banner API codes). */
  const imageErrorText = (err: unknown): string => {
    if (err instanceof ProfileImageError) return t(err.key);
    if (err instanceof ApiClientError) {
      const code = err.code as string;
      if (code === "INVALID_AVATAR" || code === "INVALID_BANNER") return t("mobile:profile.imageInvalidType");
      if (code === "AVATAR_TOO_LARGE") return t("mobile:profile.imageTooLargeAvatar");
      if (code === "BANNER_TOO_LARGE") return t("mobile:profile.imageTooLargeBanner");
      if (code === "AVATAR_UPLOADS_DISABLED" || code === "BANNER_UPLOADS_DISABLED")
        return t("mobile:profile.imageUploadsDisabled");
      if (code === "AVATAR_REJECTED" || code === "BANNER_REJECTED") return t("mobile:profile.imageRejected");
    }
    return localizeError(err, t);
  };

  // ── Images: pick → crop → draft ──────────────────────────────────────────
  const setKindError = (kind: ProfileImageKind, message: string | null) =>
    kind === "avatar" ? setAvatarError(message) : setBannerError(message);

  /** Open the picker, decode the pick, and hand it to the crop editor. Nothing is uploaded. */
  const pickInto = async (kind: ProfileImageKind) => {
    if (saving || opening) return;
    setKindError(kind, null);
    setOpening(kind);
    try {
      const source = await pickProfileSource(kind);
      if (source) setEditorSource(source);
    } catch (err) {
      setKindError(kind, imageErrorText(err));
      // A failed pick from INSIDE the editor ("choose another") closes it: the
      // error belongs next to the field, where the next attempt starts.
      setEditorSource(null);
    } finally {
      setOpening(null);
    }
  };

  const onImagePress = (kind: ProfileImageKind) => {
    if (saving) return;
    const edit = kind === "avatar" ? avatarEdit : bannerEdit;
    const current = kind === "avatar" ? avatarPreview : bannerPreview;
    // Nothing to undo and nothing to remove: go straight to the picker.
    if (edit === null && !current) {
      void pickInto(kind);
      return;
    }
    setMenu(kind);
  };

  const onCropApplied = (image: PickedProfileImage) => {
    const kind = editorSource?.kind ?? "avatar";
    if (kind === "avatar") setAvatarEdit({ kind: "draft", image });
    else setBannerEdit({ kind: "draft", image });
    setKindError(kind, null);
    setPartialFailure(false);
    setEditorSource(null);
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const progress = useSharedValue(0);
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  const onSave = async (after: NavigationAction | null = null) => {
    if (saving) return;
    setNameTouched(true);
    if (nameInvalid || bioError) {
      setPendingLeave(null);
      haptics.error();
      return;
    }

    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
    setSaving(true);

    const profilePatch = {
      ...(nameDirty ? { displayName: trimmedName } : {}),
      ...(bioDirty ? { bio: trimmedBio.length > 0 ? trimmedBio : null } : {}),
      ...(avatarEdit?.kind === "remove" ? { avatarUrl: null } : {}),
      ...(bannerEdit?.kind === "remove" ? { bannerUrl: null } : {}),
    };
    const steps: SaveStep[] = [
      ...(avatarEdit?.kind === "draft" ? (["avatar"] as const) : []),
      ...(bannerEdit?.kind === "draft" ? (["banner"] as const) : []),
      ...(Object.keys(profilePatch).length > 0 ? (["profile"] as const) : []),
    ];
    progress.value = 0;

    let failed = false;
    for (const [index, id] of steps.entries()) {
      setStep({ id, index, total: steps.length });
      // The bar moves to the middle of the running step, then to its end: real
      // per-request progress, not a timer pretending to be one.
      progress.value = motionTo((index + 0.5) / steps.length, "position", { reduced });
      try {
        if (id === "avatar" && avatarEdit?.kind === "draft") {
          await uploadAvatar.mutateAsync(avatarEdit.image.upload);
          setAvatarEdit(null);
        } else if (id === "banner" && bannerEdit?.kind === "draft") {
          await uploadBanner.mutateAsync(bannerEdit.image.upload);
          setBannerEdit(null);
        } else if (id === "profile") {
          await updateMe.mutateAsync(profilePatch);
          if (avatarEdit?.kind === "remove") setAvatarEdit(null);
          if (bannerEdit?.kind === "remove") setBannerEdit(null);
        }
      } catch (err) {
        failed = true;
        if (id === "avatar") setAvatarError(imageErrorText(err));
        else if (id === "banner") setBannerError(imageErrorText(err));
        else setError(localizeError(err, t));
      }
      progress.value = motionTo((index + 1) / steps.length, "position", { reduced });
    }

    setSaving(false);
    setStep(null);
    setPendingLeave(null);
    setPartialFailure(failed);
    if (failed) {
      haptics.error();
      return;
    }
    haptics.success();
    // Everything landed — leave without asking. Closing the screen IS the
    // confirmation: the surface behind it already repaints with the new photo
    // and name, which reads stronger than a chip flashing for one frame (§35).
    leave(after);
  };

  const onDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    deleteAccount.mutate(undefined, {
      onSuccess: () => {
        // The account is gone — never prompt about edits to a profile that no
        // longer exists.
        bypassGuardRef.current = true;
        void logoutActiveAccount();
      },
      onError: (err) => {
        setDeleting(false);
        setDeleteError(localizeError(err, t));
      },
    });
  };

  const stepLabel = useMemo(() => {
    if (!step) return null;
    const key =
      step.id === "avatar"
        ? "mobile:profile.savingAvatar"
        : step.id === "banner"
          ? "mobile:profile.savingBanner"
          : "mobile:profile.savingProfile";
    return `${t(key)} · ${t("mobile:profile.saveStep", { current: step.index + 1, total: step.total })}`;
  }, [step, t]);

  const barVisible = dirty || saving || partialFailure;
  const barHeight = 120;
  const menuEdit = menu === "avatar" ? avatarEdit : bannerEdit;
  const menuHasImage = menu === "avatar" ? !!avatarPreview : !!bannerPreview;

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <Stack.Screen options={{ title: t("mobile:profile.title") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          paddingBottom: (barVisible ? barHeight : space.xl) + insets.bottom + keyboard,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Hero: the card as it will look ─────────────────────────────── */}
        <View>
          <Touchable
            onPress={() => onImagePress("banner")}
            disabled={saving}
            dimmed={false}
            accessibilityRole="button"
            accessibilityLabel={bannerPreview ? t("mobile:profile.bannerChange") : t("mobile:profile.bannerAdd")}
            accessibilityHint={t("mobile:profile.bannerHelp")}
          >
            <ProfileBannerImage bannerUrl={bannerPreview} seedId={user?.id ?? "self"} />
            <View style={{ position: "absolute", right: space.md, top: space.md, flexDirection: "row", gap: space.xs }}>
              {bannerEdit ? (
                <Badge
                  variant="accent"
                  label={bannerEdit.kind === "remove" ? t("mobile:profile.removePending") : t("mobile:profile.draftBadge")}
                />
              ) : null}
            </View>
            <Glass
              strong
              style={{
                position: "absolute",
                right: space.md,
                bottom: space.md,
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                paddingHorizontal: space.md,
                paddingVertical: space.xs + 2,
                borderRadius: radius.pill,
              }}
            >
              {opening === "banner" ? (
                <ActivityIndicator size="small" color={colors.fg} />
              ) : (
                <ImagePlus size={15} color={colors.fg} strokeWidth={2} />
              )}
              <Text type="meta" tone="default" style={{ fontWeight: "600" }}>
                {opening === "banner"
                  ? t("mobile:profile.opening")
                  : bannerPreview
                    ? t("mobile:profile.bannerChange")
                    : t("mobile:profile.bannerAdd")}
              </Text>
            </Glass>
          </Touchable>

          <View style={{ paddingHorizontal: space.lg, marginTop: -(AVATAR_SIZE / 2) - 4 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
              <Touchable
                onPress={() => onImagePress("avatar")}
                disabled={saving}
                dimmed={false}
                pressScale={0.96}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:profile.avatarChange")}
                accessibilityHint={t("mobile:profile.avatarHelp")}
                style={{ borderRadius: radius.pill, backgroundColor: colors.app, padding: 4 }}
              >
                <Avatar name={previewName} size={AVATAR_SIZE} uri={avatarPreview} />
                <View
                  style={{
                    position: "absolute",
                    right: 2,
                    bottom: 2,
                    width: 30,
                    height: 30,
                    borderRadius: radius.pill,
                    backgroundColor: colors.accent,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 3,
                    borderColor: colors.app,
                  }}
                >
                  {opening === "avatar" ? (
                    <ActivityIndicator size="small" color={colors.onAccent} />
                  ) : (
                    <Camera size={14} color={colors.onAccent} strokeWidth={2.25} />
                  )}
                </View>
              </Touchable>
              {avatarEdit ? (
                <Animated.View
                  entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                  exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
                  style={{ paddingBottom: space.sm }}
                >
                  <Badge
                    variant="accent"
                    label={avatarEdit.kind === "remove" ? t("mobile:profile.removePending") : t("mobile:profile.draftBadge")}
                  />
                </Animated.View>
              ) : null}
            </View>
            <View style={{ marginTop: space.sm, gap: 2 }}>
              <Text type="title" tone="display" numberOfLines={1}>
                {previewName}
              </Text>
              {usernameLabel ? (
                <Text type="ui" tone="muted" style={{ fontWeight: "400" }}>
                  {usernameLabel}
                </Text>
              ) : null}
              {trimmedBio ? (
                <Text type="ui" tone="default" numberOfLines={3} style={{ fontWeight: "400", marginTop: space.xs }}>
                  {trimmedBio}
                </Text>
              ) : null}
            </View>
            {dirty ? (
              <Animated.View entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}>
                <Text type="meta" tone="faint" style={{ marginTop: space.sm, fontWeight: "400" }}>
                  {t("mobile:profile.previewNote")}
                </Text>
              </Animated.View>
            ) : null}
          </View>
        </View>

        {avatarError || bannerError ? (
          <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
            {avatarError ? (
              <Banner
                variant="danger"
                title={t("mobile:profile.avatarErrorTitle")}
                description={avatarError}
                action={{ label: t("mobile:imageEditor.chooseAnother"), onPress: () => void pickInto("avatar") }}
                onDismiss={() => setAvatarError(null)}
              />
            ) : null}
            {bannerError ? (
              <Banner
                variant="danger"
                title={t("mobile:profile.bannerErrorTitle")}
                description={bannerError}
                action={{ label: t("mobile:imageEditor.chooseAnother"), onPress: () => void pickInto("banner") }}
                onDismiss={() => setBannerError(null)}
              />
            ) : null}
          </View>
        ) : null}

        {/* ── Fields ──────────────────────────────────────────────────────── */}
        <View style={{ paddingHorizontal: space.lg, gap: space.lg }}>
          {error ? <Banner variant="danger" title={t("mobile:profile.profileErrorTitle")} description={error} /> : null}
          <TextField
            label={t("mobile:profile.displayNameLabel")}
            value={displayName}
            onChangeText={setDisplayName}
            onBlur={() => setNameTouched(true)}
            maxLength={DISPLAY_NAME_MAX}
            placeholder={t("mobile:profile.displayNamePlaceholder")}
            error={nameError}
            hint={t("mobile:profile.bioCount", { count: trimmedName.length, max: DISPLAY_NAME_MAX })}
            editable={!saving}
          />
          <TextField
            label={t("mobile:profile.bioLabel")}
            value={bio}
            onChangeText={setBio}
            maxLength={BIO_MAX}
            multiline
            placeholder={t("mobile:profile.bioPlaceholder")}
            hint={t("mobile:profile.bioHint", { count: trimmedBio.length, max: BIO_MAX })}
            error={bioError}
            editable={!saving}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
        </View>

        {/* ── Date of birth — SET-ONCE, saved by its own confirming control,
            NOT by the profile Save: it can never be corrected afterwards. ── */}
        <View style={{ paddingHorizontal: space.lg }}>
          {birthdateSet ? (
            <SettingsSection title={t("mobile:profile.birthdateSection")} footer={t("mobile:profile.birthdateLockedNote")}>
              <SettingsRow
                icon={ShieldCheck}
                title={user?.birthdate ?? ""}
                subtitle={user?.isAdult ? t("mobile:profile.birthdateAdult") : t("mobile:profile.birthdateMinor")}
                value={t("mobile:profile.birthdateLocked")}
              />
            </SettingsSection>
          ) : (
            <View>
              <SectionEyebrow>{t("mobile:profile.birthdateSection")}</SectionEyebrow>
              <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, paddingBottom: space.sm, fontWeight: "400" }}>
                {t("mobile:profile.birthdateHint")}
              </Text>
              <BirthdateVerification />
            </View>
          )}
        </View>

        {/* ── Danger zone — delete account (14-day freeze). ───────────────── */}
        <View style={{ paddingHorizontal: space.lg }}>
          <DangerZone title={t("mobile:common.dangerZone")} description={t("mobile:profile.deleteDescription")}>
            <Button
              label={t("mobile:profile.deleteAction")}
              icon={Trash2}
              variant="danger"
              onPress={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
              disabled={saving}
            />
          </DangerZone>
        </View>
      </ScrollView>

      {/* ── Save bar — appears with the first change; names each request. ── */}
      {barVisible ? (
        <Animated.View
          entering={FadeInDown.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutDown.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          style={{
            position: "absolute",
            left: space.md,
            right: space.md,
            bottom: space.md + (keyboard > 0 ? keyboard : insets.bottom),
          }}
        >
          <Glass strong style={{ borderRadius: radius.card, padding: space.md, gap: space.md }}>
            <View accessibilityLiveRegion="polite" style={{ gap: 2 }}>
              <Text type="ui" tone={partialFailure && !saving ? "danger" : "default"} style={{ fontWeight: "600" }}>
                {saving
                  ? (stepLabel ?? t("mobile:profile.savingProfile"))
                  : partialFailure
                    ? t("mobile:profile.saveFailed")
                    : t("mobile:profile.unsavedBar")}
              </Text>
              {partialFailure && !saving ? (
                <Text type="meta" tone="muted" style={{ fontWeight: "400" }}>
                  {t("mobile:profile.saveFailedHint")}
                </Text>
              ) : null}
            </View>
            {saving ? (
              <View
                accessibilityRole="progressbar"
                accessibilityValue={step ? { min: 0, max: step.total, now: step.index } : undefined}
                style={{ height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, overflow: "hidden" }}
              >
                <Animated.View style={[{ height: 4, backgroundColor: colors.accent, borderRadius: radius.pill }, progressStyle]} />
              </View>
            ) : null}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button
                label={t("mobile:profile.discard")}
                icon={Undo2}
                variant="ghost"
                onPress={discardDraft}
                disabled={saving || !dirty}
                style={{ flex: 1 }}
              />
              <Button
                label={partialFailure && !saving ? t("common:buttons.retry") : t("mobile:profile.save")}
                icon={partialFailure && !saving ? RotateCcw : Save}
                variant="accent"
                onPress={() => void onSave()}
                loading={saving}
                disabled={!dirty || nameInvalid || !!bioError}
                style={{ flex: 1.4 }}
              />
            </View>
          </Glass>
        </Animated.View>
      ) : null}

      {/* Avatar / banner menu: new image · undo · remove. */}
      <ActionSheet
        visible={menu !== null}
        title={menu === "banner" ? t("mobile:profile.bannerSheetTitle") : t("mobile:profile.avatarSheetTitle")}
        onClose={() => setMenu(null)}
      >
        <ActionRow
          icon={<ImagePlus size={20} color={colors.fgMuted} />}
          label={t("mobile:profile.chooseImage")}
          hint={menu === "banner" ? t("mobile:profile.bannerHelp") : t("mobile:profile.avatarHelp")}
          onPress={() => {
            const kind = menu;
            setMenu(null);
            if (kind) void pickInto(kind);
          }}
        />
        {menuEdit !== null ? (
          <ActionRow
            icon={<Undo2 size={20} color={colors.fgMuted} />}
            label={t("mobile:profile.undoDraft")}
            onPress={() => {
              if (menu === "avatar") setAvatarEdit(null);
              else setBannerEdit(null);
              setMenu(null);
            }}
          />
        ) : null}
        {menuHasImage && menuEdit?.kind !== "remove" && (menu === "avatar" ? !!user?.avatarUrl : !!user?.bannerUrl) ? (
          <>
            <ActionDivider />
            <ActionRow
              icon={<Trash2 size={20} color={colors.danger} />}
              label={menu === "banner" ? t("mobile:profile.bannerRemove") : t("mobile:profile.avatarRemove")}
              hint={t("mobile:profile.removeHint")}
              labelColor={colors.danger}
              onPress={() => {
                if (menu === "avatar") setAvatarEdit({ kind: "remove" });
                else setBannerEdit({ kind: "remove" });
                setMenu(null);
              }}
            />
          </>
        ) : null}
      </ActionSheet>

      <ImageCropEditor
        source={editorSource}
        onCancel={() => setEditorSource(null)}
        onApply={onCropApplied}
        onChooseAnother={() => {
          if (editorSource) void pickInto(editorSource.kind);
        }}
        displayName={previewName}
        seedId={user?.id ?? "self"}
        avatarUri={avatarPreview}
        bannerUri={bannerPreview}
      />

      <ConfirmSheet
        visible={pendingLeave !== null}
        title={t("mobile:profile.unsavedTitle")}
        body={t("mobile:profile.unsavedBody")}
        alternative={{
          label: t("mobile:profile.unsavedSaveAndLeave"),
          icon: Save,
          loading: true,
          onPress: () => void onSave(pendingLeave),
        }}
        confirmLabel={t("mobile:profile.unsavedDiscard")}
        confirmIcon={LogOut}
        onConfirm={() => {
          const action = pendingLeave;
          discardDraft();
          setPendingLeave(null);
          leave(action);
        }}
        cancelLabel={t("mobile:profile.unsavedKeepEditing")}
        onCancel={() => setPendingLeave(null)}
        busy={saving}
      />

      <ConfirmSheet
        visible={confirmDelete}
        title={t("mobile:profile.deleteConfirmTitle")}
        body={t("mobile:profile.deleteConfirmBody")}
        confirmLabel={t("mobile:profile.deleteConfirmAction")}
        confirmIcon={Trash2}
        onConfirm={onDelete}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmDelete(false)}
        busy={deleting}
        error={deleteError}
        errorTitle={t("mobile:profile.deleteErrorTitle")}
      />
    </View>
  );
}
