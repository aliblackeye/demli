import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Camera, Check, ImageIcon, Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  Button,
  Dialog,
  DialogPortal,
  DialogPrimitive,
  Input,
  Textarea,
  UserAvatar,
  cn,
} from "@demli/ui";
import { FormErrorAlert, overlayFade, popIn } from "@demli/app-ui";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { bannerGradient, userBannerUrl } from "../lib/banner";
import { useAppTranslation } from "../lib/i18n";
import {
  useDeleteAccount,
  useUpdateProfile,
  useUploadAvatar,
  useUploadBanner,
} from "../queries/chat-queries";
import { ApiClientError } from "../lib/api-client";
import { logoutActiveAccount } from "../lib/account-manager";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";
import { BirthdateVerification } from "./BirthdateVerification";

const DISPLAY_NAME_MAX_LENGTH = 48;
/** Profile bio cap (ADR 0010 §3); the API is the authoritative validator. */
const BIO_MAX_LENGTH = 280;
const SAVED_RESET_MS = 1_800;

/** Client-side pre-checks — the API is authoritative (magic-byte sniff + cap). */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const AVATAR_ACCEPT_ATTR = AVATAR_ACCEPT_TYPES.join(",");

/** Banners are larger and additionally allow an animated GIF (founder request). */
const BANNER_MAX_BYTES = 5 * 1024 * 1024;
const BANNER_ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const BANNER_ACCEPT_ATTR = BANNER_ACCEPT_TYPES.join(",");

type FormError = CommonErrorKey | "desktop:profile.nameRequired";

/**
 * A banner upload failure. Banner endpoints can answer bespoke codes the shared
 * `ApiClientErrorCode` union does not model, so this is mapped locally (never
 * through `errorKey`, which would return `undefined` for an unknown code).
 */
type BannerError =
  | "desktop:profile.bannerTooLarge"
  | "desktop:profile.bannerInvalid"
  | "desktop:profile.bannerDisabled"
  | "desktop:profile.bannerRejected"
  | CommonErrorKey;

function bannerErrorFrom(err: unknown): BannerError {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case "AVATAR_TOO_LARGE":
        return "desktop:profile.bannerTooLarge";
      case "INVALID_AVATAR":
        return "desktop:profile.bannerInvalid";
      case "AVATAR_UPLOADS_DISABLED":
        return "desktop:profile.bannerDisabled";
      case "AVATAR_REJECTED":
        return "desktop:profile.bannerRejected";
      case "NETWORK":
        return "errors.network";
    }
    // Recognise banner-specific server codes by their string form (not in the
    // typed union) so a bespoke banner error still gets bespoke copy.
    switch (err.code as string) {
      case "BANNER_TOO_LARGE":
        return "desktop:profile.bannerTooLarge";
      case "INVALID_BANNER":
        return "desktop:profile.bannerInvalid";
      case "BANNER_UPLOADS_DISABLED":
        return "desktop:profile.bannerDisabled";
      case "BANNER_REJECTED":
        return "desktop:profile.bannerRejected";
    }
  }
  return "errors.generic";
}

/**
 * A picked-but-not-yet-uploaded image. Held in memory ONLY until the user presses
 * Save (nothing reaches the server before then), so the bytes live in React state
 * for the life of the draft. That is a deliberate exception to §27's "no large
 * media blobs in state": the size is hard-capped by the pre-checks below (2 MB
 * avatar / 5 MB banner) and the payload is exactly what the upload call needs, so
 * keeping it costs one copy and saves a re-read.
 */
interface ImageDraft {
  mime: string;
  dataBase64: string;
}

/** Local preview source for a draft — no network, no object-URL lifecycle. */
function draftPreviewUrl(draft: ImageDraft | null): string | null {
  return draft ? `data:${draft.mime};base64,${draft.dataBase64}` : null;
}

/** Read a File into `{ mime, dataBase64 }` (strips the `data:...;base64,` prefix). */
async function fileToUpload(file: File): Promise<{ mime: string; dataBase64: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  return { mime: file.type, dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
}

/**
 * "Danger zone" — permanently delete the account. Deletion FREEZES the account for
 * 14 days (signing in again within that window reactivates it); after that it is
 * removed for good. A confirmation dialog spells this out; on success we sign the
 * user out. Rendered ABOVE the settings modal (z-[58] > settings z-[55]).
 */
function DangerZone(): JSX.Element {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<CommonErrorKey | null>(null);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const deleteAccount = useDeleteAccount();

  const onConfirm = (): void => {
    if (deleteAccount.isPending) return;
    setError(null);
    deleteAccount.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        // The account is gone — bypass the unsaved-changes guard, or the settings
        // modal would stay open behind a prompt for a profile that no longer exists.
        useUiStore.getState().setSettingsDirty(false);
        closeSettings();
        void logoutActiveAccount();
      },
      onError: (err) => setError(errorKey(err)),
    });
  };

  return (
    <section className="rounded-xl border border-danger/30 bg-danger-surface/40 p-5">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{t("desktop:profile.deleteHeading")}</h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t("desktop:profile.deleteDescription")}
          </p>
        </div>
      </div>
      <Button variant="danger" size="sm" className="mt-4" onClick={() => setOpen(true)}>
        <Trash2 className="size-4" />
        {t("desktop:profile.deleteAction")}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !next && !deleteAccount.isPending && setOpen(false)}>
        <AnimatePresence>
          {open && (
            <DialogPortal forceMount>
              <DialogPrimitive.Overlay asChild forceMount>
                <m.div
                  variants={overlayFade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed inset-0 z-[58] bg-black/70 backdrop-blur-sm"
                />
              </DialogPrimitive.Overlay>
              <DialogPrimitive.Content asChild forceMount>
                <div className="fixed inset-0 z-[58] flex items-center justify-center p-6">
                  <m.div
                    variants={popIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className={cn(
                      "w-full max-w-md overflow-hidden rounded-xl border border-stroke-strong bg-overlay p-5 shadow-elevated",
                    )}
                  >
                    <DialogPrimitive.Title className="text-base font-semibold text-fg">
                      {t("desktop:profile.deleteConfirmTitle")}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-2 text-sm leading-relaxed text-fg-muted">
                      {t("desktop:profile.deleteConfirmBody")}
                    </DialogPrimitive.Description>
                    {error && <FormErrorAlert className="mt-3">{t(error)}</FormErrorAlert>}
                    <div className="mt-5 flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setOpen(false)}
                        disabled={deleteAccount.isPending}
                      >
                        {t("buttons.cancel")}
                      </Button>
                      <Button variant="danger" onClick={onConfirm} disabled={deleteAccount.isPending}>
                        {deleteAccount.isPending && <Loader2 className="size-4 animate-spin" />}
                        {t("desktop:profile.deleteConfirmAction")}
                      </Button>
                    </div>
                  </m.div>
                </div>
              </DialogPrimitive.Content>
            </DialogPortal>
          )}
        </AnimatePresence>
      </Dialog>
    </section>
  );
}

/**
 * Unified "Account" settings panel (founder M15): the former separate "My Account"
 * and "Profile" sections merged into one. It carries the identity header (uploadable
 * BANNER + overhanging uploadable AVATAR), the display-name + bio form, and the
 * account "Danger zone" (permanent deletion). The stand-alone "Log out" button was
 * intentionally dropped — the app already has one bottom-left (user footer) and one
 * in the settings sidebar footer.
 *
 * Avatar and banner each upload independently (a failure in one never blocks the
 * other); failures render inline (never a window.alert). Banner uploads add GIF to
 * the image whitelist and a larger size cap.
 */
export function ProfileSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const user = useAuthStore((s) => s.user);

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [error, setError] = useState<FormError | null>(null);
  const [saved, setSaved] = useState(false);

  // Birthdate is SET-ONCE (M15 age gate) and therefore does NOT ride the profile
  // Save: it lives in its own <BirthdateVerification>, which makes the user
  // confirm the date + the age it implies before writing it. A permanent value
  // must not be one careless click away, and the same form is used at the NSFW
  // gate and in the reminder, so the promise is identical everywhere. On success
  // the store user gains `birthdate`/`isAdult` and this section re-renders to the
  // read-only view (and the NSFW gate unlocks with no reload).

  // Avatar picker state. The picked image is a DRAFT: nothing is uploaded until
  // the user presses Save (founder rule — "kaydetmediğim sürece kaydedilmemeli").
  const [avatarError, setAvatarError] = useState<CommonErrorKey | null>(null);
  const [avatarReading, setAvatarReading] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState<ImageDraft | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Banner picker state — same shape, independent of the avatar.
  const [bannerError, setBannerError] = useState<BannerError | null>(null);
  const [bannerReading, setBannerReading] = useState(false);
  const [bannerDraft, setBannerDraft] = useState<ImageDraft | null>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  /** True when the last Save applied some changes but not all (§26 honesty). */
  const [partialFailure, setPartialFailure] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const uploadBanner = useUploadBanner();
  const avatarBusy = avatarReading || (saving && avatarDraft !== null);
  const bannerBusy = bannerReading || (saving && bannerDraft !== null);

  const setSettingsDirty = useUiStore((s) => s.setSettingsDirty);
  const pendingSettingsNav = useUiStore((s) => s.pendingSettingsNav);
  const confirmSettingsNav = useUiStore((s) => s.confirmSettingsNav);
  const cancelSettingsNav = useUiStore((s) => s.cancelSettingsNav);

  const persistedBannerUrl = userBannerUrl(user);
  const seed = user?.id ?? user?.username ?? "demli";

  // Drafts win over the persisted values so the panel previews exactly what Save
  // would apply — a local render, with no byte sent to the server.
  const avatarPreview = draftPreviewUrl(avatarDraft) ?? user?.avatarUrl ?? undefined;
  const bannerPreview = draftPreviewUrl(bannerDraft) ?? persistedBannerUrl;

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const nameDirty = trimmedName !== (user?.displayName ?? "");
  const bioDirty = trimmedBio !== (user?.bio ?? "");
  const dirty = nameDirty || bioDirty || avatarDraft !== null || bannerDraft !== null;

  // Re-seed the text fields from the server user — but NEVER over unsaved edits.
  // `user.updated` now lands here whenever this account changes anywhere (another
  // window, our own save), and clobbering a half-typed bio with it would be the
  // same class of data loss this whole screen is meant to prevent.
  useEffect(() => {
    if (nameDirty || bioDirty) return;
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    // Re-seeding is driven by the SERVER values only; the dirty flags are read as
    // a guard and deliberately excluded from the deps (including them would make
    // the first keystroke re-run the effect and fight the user's own typing).
  }, [user?.displayName, user?.bio]);

  // Publish the draft state so the settings shell can guard Esc / backdrop /
  // section switches. Clearing on unmount matters: a section switch that IS
  // allowed through must not leave a stale "dirty" latch behind.
  useEffect(() => {
    setSettingsDirty(dirty);
  }, [dirty, setSettingsDirty]);
  useEffect(() => {
    return () => setSettingsDirty(false);
  }, [setSettingsDirty]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** Throw away every unsaved edit and return to the persisted profile. */
  const discardDraft = (): void => {
    setAvatarDraft(null);
    setBannerDraft(null);
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
  };

  /**
   * Apply every pending change in one flow: images first (their URLs must exist
   * before the row that points at them settles), then name/bio. The set-once
   * birthdate is NOT part of this — it saves itself from its own confirming form
   * below, so a permanent write can never ride a routine profile save.
   *
   * Each step is independent and its failure is reported on its own field, so a
   * partial success is visible rather than swallowed (§26). A step that succeeded
   * clears its draft; a step that failed KEEPS it, so pressing Save again retries
   * exactly the parts that did not land.
   */
  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    if (trimmedName.length === 0) {
      setError("desktop:profile.nameRequired");
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
        await uploadAvatar.mutateAsync(avatarDraft);
        setAvatarDraft(null);
      } catch (err) {
        setAvatarError(errorKey(err));
        failed = true;
      }
    }

    if (bannerDraft) {
      try {
        await uploadBanner.mutateAsync(bannerDraft);
        setBannerDraft(null);
      } catch (err) {
        setBannerError(bannerErrorFrom(err));
        failed = true;
      }
    }

    if (nameDirty || bioDirty) {
      try {
        await updateProfile.mutateAsync({
          displayName: trimmedName,
          bio: trimmedBio.length > 0 ? trimmedBio : null,
        });
      } catch (err) {
        setError(errorKey(err));
        failed = true;
      }
    }

    setSaving(false);
    setPartialFailure(failed);
    if (!failed) setSaved(true);
  };

  const openAvatarPicker = (): void => {
    if (avatarBusy || saving) return;
    setAvatarError(null);
    avatarInputRef.current?.click();
  };

  const onAvatarChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Reset the input so picking the SAME file again still fires onChange.
    event.target.value = "";
    if (!file) return;

    setAvatarError(null);
    if (!AVATAR_ACCEPT_TYPES.includes(file.type as (typeof AVATAR_ACCEPT_TYPES)[number])) {
      setAvatarError("errors.invalidAvatar");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("errors.avatarTooLarge");
      return;
    }

    setAvatarReading(true);
    let payload: ImageDraft;
    try {
      payload = await fileToUpload(file);
    } catch {
      setAvatarReading(false);
      setAvatarError("errors.invalidAvatar");
      return;
    }
    setAvatarReading(false);
    // DRAFT ONLY — no request. It ships when the user presses Save.
    setAvatarDraft(payload);
  };

  const openBannerPicker = (): void => {
    if (bannerBusy || saving) return;
    setBannerError(null);
    bannerInputRef.current?.click();
  };

  const onBannerChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBannerError(null);
    if (!BANNER_ACCEPT_TYPES.includes(file.type as (typeof BANNER_ACCEPT_TYPES)[number])) {
      setBannerError("desktop:profile.bannerInvalid");
      return;
    }
    if (file.size > BANNER_MAX_BYTES) {
      setBannerError("desktop:profile.bannerTooLarge");
      return;
    }

    setBannerReading(true);
    let payload: ImageDraft;
    try {
      payload = await fileToUpload(file);
    } catch {
      setBannerReading(false);
      setBannerError("desktop:profile.bannerInvalid");
      return;
    }
    setBannerReading(false);
    setBannerDraft(payload);
  };

  return (
    <div className="space-y-6">
      {/* ── Identity: uploadable banner + overhanging uploadable avatar ────── */}
      <div className="overflow-hidden rounded-xl border border-stroke bg-surface">
        {/* Banner — click anywhere to change (hover reveals the affordance). */}
        <button
          type="button"
          onClick={openBannerPicker}
          disabled={bannerBusy}
          aria-label={t("desktop:profile.bannerUploadAria")}
          className={cn(
            "group relative block h-36 w-full overflow-hidden wide:h-44",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
            bannerBusy ? "cursor-wait" : "cursor-pointer",
          )}
        >
          {bannerPreview ? (
            <img
              src={bannerPreview}
              alt=""
              className="size-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="absolute inset-0" style={bannerGradient(seed)} aria-hidden />
          )}
          {/* Sheen + grounding fade so the overhanging avatar reads clearly. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/40 to-transparent"
          />
          {/* Hover affordance / busy spinner. */}
          {bannerBusy ? (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center bg-black/40"
            >
              <Loader2 className="size-6 animate-spin text-white" />
            </span>
          ) : (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full",
                "bg-black/55 px-3 py-1.5 text-2xs font-medium text-white backdrop-blur-sm",
                "opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100",
              )}
            >
              <Camera className="size-3.5" />
              {t("desktop:profile.bannerChange")}
            </span>
          )}
        </button>
        <input
          ref={bannerInputRef}
          type="file"
          accept={BANNER_ACCEPT_ATTR}
          className="sr-only"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => void onBannerChange(event)}
        />

        {/* Avatar row — the avatar overhangs the banner. */}
        <div className="flex items-end gap-4 px-5 pb-5">
          <button
            type="button"
            onClick={openAvatarPicker}
            disabled={avatarBusy}
            aria-label={t("desktop:profile.avatarUploadAria")}
            className={cn(
              "group relative -mt-12 shrink-0 rounded-full ring-[5px] ring-surface",
              "focus-visible:outline-none focus-visible:ring-offset-0 focus-visible:ring-accent/70",
              avatarBusy ? "cursor-wait" : "cursor-pointer",
            )}
          >
            <UserAvatar
              name={trimmedName || user?.displayName || t("desktop:footer.you")}
              colorSeed={user?.id}
              src={avatarPreview}
              size="lg"
            />
            {!avatarBusy && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                <Camera className="size-6 text-white" />
              </span>
            )}
            {avatarBusy && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/60"
              >
                <Loader2 className="size-6 animate-spin text-white" />
              </span>
            )}
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept={AVATAR_ACCEPT_ATTR}
            className="sr-only"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => void onAvatarChange(event)}
          />

          <div className="min-w-0 pb-1">
            <p className="truncate text-lg font-semibold text-fg">
              {trimmedName || user?.displayName || t("desktop:footer.you")}
            </p>
            <p className="truncate text-sm text-fg-muted">
              @{user?.username ?? t("desktop:footer.youHandle")}
            </p>
          </div>
        </div>

        {/* Change actions + status/errors, inset to align under the avatar. */}
        <div className="space-y-1.5 px-5 pb-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {avatarBusy ? (
              <span className="flex items-center gap-1.5 text-2xs text-fg-faint">
                <Loader2 className="size-3 animate-spin" />
                {avatarReading
                  ? t("desktop:profile.avatarChecking")
                  : t("desktop:profile.avatarUploading")}
              </span>
            ) : (
              <button
                type="button"
                onClick={openAvatarPicker}
                className="flex items-center gap-1.5 text-2xs font-medium text-accent hover:underline"
              >
                <Camera className="size-3" />
                {t("desktop:profile.avatarChange")}
              </button>
            )}
            {avatarDraft && !avatarBusy && (
              <span className="text-2xs text-fg-faint">
                {t("desktop:profile.imagePending")}
              </span>
            )}
            {bannerBusy ? (
              <span className="flex items-center gap-1.5 text-2xs text-fg-faint">
                <Loader2 className="size-3 animate-spin" />
                {bannerReading
                  ? t("desktop:profile.bannerChecking")
                  : t("desktop:profile.bannerUploading")}
              </span>
            ) : (
              <button
                type="button"
                onClick={openBannerPicker}
                className="flex items-center gap-1.5 text-2xs font-medium text-accent hover:underline"
              >
                <ImageIcon className="size-3" />
                {bannerPreview
                  ? t("desktop:profile.bannerChange")
                  : t("desktop:profile.bannerAdd")}
              </button>
            )}
            {bannerDraft && !bannerBusy && (
              <span className="text-2xs text-fg-faint">
                {t("desktop:profile.imagePending")}
              </span>
            )}
          </div>
          {avatarError && (
            <p role="alert" className="text-2xs text-danger">
              {t(avatarError)}
            </p>
          )}
          {bannerError && (
            <p role="alert" className="text-2xs text-danger">
              {t(bannerError)}
            </p>
          )}
          <p className="text-2xs text-fg-faint">{t("desktop:profile.imagesNote")}</p>
        </div>
      </div>

      {/* ── Display name + bio ─────────────────────────────────────────────── */}
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
        {error && <FormErrorAlert>{t(error)}</FormErrorAlert>}

        <div className="space-y-1.5">
          <label htmlFor="profile-name" className="block text-xs font-semibold text-fg-muted">
            {t("desktop:profile.displayName")}
          </label>
          <Input
            id="profile-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            placeholder={t("desktop:profile.namePlaceholder")}
            aria-label={t("desktop:profile.displayName")}
            className="max-w-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="profile-bio" className="block text-xs font-semibold text-fg-muted">
            {t("desktop:profile.bioLabel")}{" "}
            <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
          </label>
          <Textarea
            id="profile-bio"
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            maxLength={BIO_MAX_LENGTH}
            rows={3}
            placeholder={t("desktop:profile.bioPlaceholder")}
            aria-label={t("desktop:profile.bioLabel")}
            className="max-w-sm"
          />
          <p className="text-2xs text-fg-faint">
            {t("desktop:profile.bioNote", { max: BIO_MAX_LENGTH })}
          </p>
        </div>

        {partialFailure && (
          <FormErrorAlert>{t("desktop:profile.savePartial")}</FormErrorAlert>
        )}

        <div className="flex items-center gap-3">
          {/* One Save for the WHOLE profile — images, name, bio and the set-once
              birthdate all ship from here, and only from here. */}
          <Button type="submit" disabled={saving || !dirty}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("desktop:profile.save")}
          </Button>
          {/* A real Discard, so "close without saving" is never the only way out. */}
          <Button
            type="button"
            variant="ghost"
            onClick={discardDraft}
            disabled={saving || !dirty}
          >
            {t("desktop:profile.discard")}
          </Button>
          {saved && !saving && (
            <span className={cn("flex items-center gap-1 text-xs font-medium text-online")}>
              <Check className="size-3.5" />
              {t("desktop:profile.saved")}
            </span>
          )}
        </div>
      </form>

      {/* ── Doğum tarihi (M15) — NSFW yaş kapısı, set-once ───────────────────
          Deliberately OUTSIDE the profile form: it saves itself through the same
          confirming <BirthdateVerification> the NSFW gate uses, because this
          value can never be corrected afterwards. Once set, the section is
          read-only and states the 18+ outcome. */}
      <div className="max-w-sm space-y-1.5">
        {user?.birthdate ? (
          <>
            <p className="block text-xs font-semibold text-fg-muted">
              {t("desktop:profile.birthdateLabel")}
            </p>
            <div className="space-y-1">
              <p className="text-sm text-fg">{user.birthdate}</p>
              <p className="text-2xs text-fg-faint">
                {user.isAdult
                  ? t("desktop:profile.birthdateAdult")
                  : t("desktop:profile.birthdateMinor")}
                {" · "}
                {t("desktop:profile.birthdateLocked")}
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="text-2xs text-fg-faint">{t("desktop:profile.birthdateHint")}</p>
            <BirthdateVerification />
          </>
        )}
      </div>

      <p className="text-2xs text-fg-faint">
        {t("desktop:profile.usernameNote", {
          username: user?.username ?? t("desktop:footer.youHandle"),
          max: USERNAME_MAX_LENGTH,
        })}
      </p>

      {/* ── Danger zone: permanent account deletion ────────────────────────── */}
      <DangerZone />

      {/* ── Unsaved-changes guard ──────────────────────────────────────────────
          Raised when the user tries to close settings (Esc, backdrop, X) or
          switch section with a draft open. Discarding here is the ONLY way an
          edit is silently dropped, and the user asked for it explicitly. */}
      <Dialog
        open={pendingSettingsNav !== null}
        onOpenChange={(next) => !next && cancelSettingsNav()}
      >
        <AnimatePresence>
          {pendingSettingsNav !== null && (
            <DialogPortal forceMount>
              <DialogPrimitive.Overlay asChild forceMount>
                <m.div
                  variants={overlayFade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed inset-0 z-[58] bg-black/70 backdrop-blur-sm"
                />
              </DialogPrimitive.Overlay>
              <DialogPrimitive.Content asChild forceMount>
                <div className="fixed inset-0 z-[58] flex items-center justify-center p-6">
                  <m.div
                    variants={popIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="w-full max-w-md overflow-hidden rounded-xl border border-stroke-strong bg-overlay p-5 shadow-elevated"
                  >
                    <DialogPrimitive.Title className="text-base font-semibold text-fg">
                      {t("desktop:profile.unsavedTitle")}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-2 text-sm leading-relaxed text-fg-muted">
                      {t("desktop:profile.unsavedBody")}
                    </DialogPrimitive.Description>
                    <div className="mt-5 flex justify-end gap-2">
                      <Button variant="secondary" onClick={cancelSettingsNav}>
                        {t("desktop:profile.unsavedKeepEditing")}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          discardDraft();
                          confirmSettingsNav();
                        }}
                      >
                        {t("desktop:profile.unsavedDiscard")}
                      </Button>
                    </div>
                  </m.div>
                </div>
              </DialogPrimitive.Content>
            </DialogPortal>
          )}
        </AnimatePresence>
      </Dialog>
    </div>
  );
}
