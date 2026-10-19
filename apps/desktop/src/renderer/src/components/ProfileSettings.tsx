import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, m } from "framer-motion";
import { Camera, Check, ImagePlus, Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  Button,
  Dialog,
  DialogPortal,
  DialogPrimitive,
  Field,
  Input,
  Textarea,
  UserAvatar,
  cn,
} from "@demli/ui";
import { FormErrorAlert, overlayFade, popIn, toastPop } from "@demli/app-ui";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { userBannerUrl } from "../lib/banner";
import { CROP_INPUT_ACCEPT, type ExportedImage } from "../lib/image-file";
import type { CropKind } from "../lib/image-crop";
import { useAppTranslation } from "../lib/i18n";
import {
  useDeleteAccount,
  useUpdateProfile,
  useUploadAvatar,
  useUploadBanner,
} from "../queries/chat-queries";
import { ApiClientError, type UpdateMeInput } from "../lib/api-client";
import { logoutActiveAccount } from "../lib/account-manager";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";
import { BirthdateVerification } from "./BirthdateVerification";
import { ImageCropDialog } from "./ImageCropDialog";
import { ProfileIdentityPreview } from "./ProfileCard";

const DISPLAY_NAME_MAX_LENGTH = 48;
/** Profile bio cap (ADR 0010 §3); the API is the authoritative validator. */
const BIO_MAX_LENGTH = 280;
const SAVED_RESET_MS = 1_800;

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
 * A picked-and-cropped image that is not uploaded yet. Held in memory ONLY until
 * the user presses Save (nothing reaches the server before then), so the bytes
 * live in React state for the life of the draft. That is a deliberate exception
 * to §27's "no large media blobs in state": the crop editor exports at a fixed
 * size (512² avatar / 1200×450 banner, typically tens of KB) and the server caps
 * still bound it (2 MB / 5 MB, an uncropped animated banner being the only case
 * near the top); the payload is exactly what the upload call needs.
 *
 * `"remove"` is the other kind of draft: clear the image on Save.
 */
type ImageDraft = Pick<ExportedImage, "mime" | "dataBase64" | "previewUrl"> | "remove";

/** One step of a Save, in the order it runs. */
type SaveStep = "avatar" | "banner" | "profile";

const SAVE_STEP_LABEL = {
  avatar: "desktop:profile.savingAvatar",
  banner: "desktop:profile.savingBanner",
  profile: "desktop:profile.savingProfile",
} as const satisfies Record<SaveStep, string>;

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
    <section className="rounded-card bg-danger-surface p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/15 text-danger">
          <TriangleAlert className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{t("desktop:profile.deleteHeading")}</h3>
          <p className="mt-1 text-label text-fg-muted">{t("desktop:profile.deleteDescription")}</p>
          <Button variant="danger" size="sm" className="mt-4" onClick={() => setOpen(true)}>
            <Trash2 className="size-4" aria-hidden />
            {t("desktop:profile.deleteAction")}
          </Button>
        </div>
      </div>

      <ConfirmLayer
        open={open}
        onDismiss={() => !deleteAccount.isPending && setOpen(false)}
        title={t("desktop:profile.deleteConfirmTitle")}
        body={t("desktop:profile.deleteConfirmBody")}
        error={error ? t(error) : null}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={deleteAccount.isPending}>
              {t("buttons.cancel")}
            </Button>
            <Button variant="danger" onClick={onConfirm} loading={deleteAccount.isPending}>
              {t("desktop:profile.deleteConfirmAction")}
            </Button>
          </>
        }
      />
    </section>
  );
}

/**
 * A confirmation card that layers ABOVE the settings modal (z-[58] > z-[55]),
 * framer-animated in both directions while keeping Radix's focus trap and Esc.
 * Used by the delete-account confirmation and the unsaved-changes guard.
 */
function ConfirmLayer({
  open,
  onDismiss,
  title,
  body,
  error,
  actions,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  body: string;
  error?: string | null;
  actions: JSX.Element;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <AnimatePresence>
        {open && (
          <DialogPortal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                variants={overlayFade}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed inset-0 z-[58] surface-scrim"
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <div className="fixed inset-0 z-[58] flex items-center justify-center p-6 focus:outline-none">
                <m.div
                  variants={popIn}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="w-full max-w-md overflow-hidden rounded-card bg-app p-6"
                >
                  <DialogPrimitive.Title className="font-display text-xl font-medium leading-tight text-fg-display">
                    {title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mt-2 text-sm leading-relaxed text-fg-muted">
                    {body}
                  </DialogPrimitive.Description>
                  {error && <FormErrorAlert className="mt-3">{error}</FormErrorAlert>}
                  <div className="mt-6 flex justify-end gap-2">{actions}</div>
                </m.div>
              </div>
            </DialogPrimitive.Content>
          </DialogPortal>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

/**
 * Unified "Account" settings panel (founder M15, re-laid for Koyu Masa in M16).
 *
 * Left: the editable fields — display name, avatar, banner, bio. Right (wide
 * windows; stacked above on narrow): a LIVE preview of the profile card drawn by
 * the card's own identity markup, fed with the unsaved draft, so "how it will
 * look" is never a guess. Picking an avatar or banner opens the crop editor
 * ({@link ImageCropDialog}); what it returns is a draft, never an upload.
 *
 * Every change is collected into ONE Save, driven from the sticky
 * unsaved-changes bar at the bottom of the panel (Ctrl/⌘+S works too). The bar
 * shows the save as its real steps — "Avatar yükleniyor… 1/3" — not an invented
 * percentage: each step is one request, and the step counter is the truthful
 * granularity. A step that fails keeps its draft and reports on its own field,
 * and "Try again" re-sends only what did not land (§26 honesty).
 *
 * The stand-alone "Log out" button was intentionally dropped — the app already
 * has one bottom-left (user footer) and one in the settings sidebar footer.
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

  // Image drafts: nothing is uploaded until the user presses Save (founder rule
  // — "kaydetmediğim sürece kaydedilmemeli").
  const [avatarDraft, setAvatarDraft] = useState<ImageDraft | null>(null);
  const [bannerDraft, setBannerDraft] = useState<ImageDraft | null>(null);
  const [avatarError, setAvatarError] = useState<CommonErrorKey | null>(null);
  const [bannerError, setBannerError] = useState<BannerError | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  /** The file the crop editor is open on (null = closed). */
  const [cropTarget, setCropTarget] = useState<{ kind: CropKind; file: File } | null>(null);

  /** True when the last Save applied some changes but not all (§26 honesty). */
  const [partialFailure, setPartialFailure] = useState(false);
  /** The step a running Save is on (null = not saving). */
  const [progress, setProgress] = useState<{ step: SaveStep; index: number; total: number } | null>(
    null,
  );
  const saving = progress !== null;

  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const uploadBanner = useUploadBanner();

  const setSettingsDirty = useUiStore((s) => s.setSettingsDirty);
  const pendingSettingsNav = useUiStore((s) => s.pendingSettingsNav);
  const confirmSettingsNav = useUiStore((s) => s.confirmSettingsNav);
  const cancelSettingsNav = useUiStore((s) => s.cancelSettingsNav);

  const persistedAvatarUrl = user?.avatarUrl ?? null;
  const persistedBannerUrl = userBannerUrl(user);
  const seed = user?.id ?? user?.username ?? "demli";

  // Drafts win over the persisted values so the preview shows exactly what Save
  // would apply — a local render, with no byte sent to the server.
  const avatarPreview =
    avatarDraft === "remove" ? null : (avatarDraft?.previewUrl ?? persistedAvatarUrl);
  const bannerPreview =
    bannerDraft === "remove" ? null : (bannerDraft?.previewUrl ?? persistedBannerUrl);

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const nameDirty = trimmedName !== (user?.displayName ?? "");
  const bioDirty = trimmedBio !== (user?.bio ?? "");
  const dirty = nameDirty || bioDirty || avatarDraft !== null || bannerDraft !== null;
  const shownName = trimmedName || user?.displayName || t("desktop:footer.you");
  const handle = user?.username ?? t("desktop:footer.youHandle");

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
   * Apply every pending change in one flow: image uploads first (their URLs must
   * exist before the row that points at them settles), then one PATCH for
   * name / bio / removals. The set-once birthdate is NOT part of this — it saves
   * itself from its own confirming form below.
   *
   * Each step is independent and its failure is reported on its own field, so a
   * partial success is visible rather than swallowed (§26). A step that succeeded
   * clears its draft; a step that failed KEEPS it, so Save again retries exactly
   * the parts that did not land.
   */
  const save = async (): Promise<void> => {
    if (saving || !dirty) return;
    if (trimmedName.length === 0) {
      setError("desktop:profile.nameRequired");
      return;
    }

    setError(null);
    setAvatarError(null);
    setBannerError(null);
    setPartialFailure(false);
    setSaved(false);

    const patch: UpdateMeInput = {};
    if (nameDirty) patch.displayName = trimmedName;
    if (bioDirty) patch.bio = trimmedBio.length > 0 ? trimmedBio : null;
    if (avatarDraft === "remove") patch.avatarUrl = null;
    if (bannerDraft === "remove") patch.bannerUrl = null;

    const steps: SaveStep[] = [];
    if (avatarDraft && avatarDraft !== "remove") steps.push("avatar");
    if (bannerDraft && bannerDraft !== "remove") steps.push("banner");
    if (Object.keys(patch).length > 0) steps.push("profile");

    let failed = false;
    for (const [index, step] of steps.entries()) {
      setProgress({ step, index, total: steps.length });
      if (step === "avatar" && avatarDraft && avatarDraft !== "remove") {
        try {
          await uploadAvatar.mutateAsync({ mime: avatarDraft.mime, dataBase64: avatarDraft.dataBase64 });
          setAvatarDraft(null);
        } catch (err) {
          setAvatarError(errorKey(err));
          failed = true;
        }
      } else if (step === "banner" && bannerDraft && bannerDraft !== "remove") {
        try {
          await uploadBanner.mutateAsync({ mime: bannerDraft.mime, dataBase64: bannerDraft.dataBase64 });
          setBannerDraft(null);
        } catch (err) {
          setBannerError(bannerErrorFrom(err));
          failed = true;
        }
      } else if (step === "profile") {
        try {
          await updateProfile.mutateAsync(patch);
          if (patch.avatarUrl === null) setAvatarDraft(null);
          if (patch.bannerUrl === null) setBannerDraft(null);
        } catch (err) {
          setError(errorKey(err));
          failed = true;
        }
      }
    }

    setProgress(null);
    setPartialFailure(failed);
    if (!failed) setSaved(true);
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void save();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const openPicker = (kind: CropKind): void => {
    if (saving) return;
    if (kind === "avatar") setAvatarError(null);
    else setBannerError(null);
    (kind === "avatar" ? avatarInputRef : bannerInputRef).current?.click();
  };

  const onPick = (kind: CropKind) => (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset the input so picking the SAME file again still fires onChange.
    event.target.value = "";
    // Type / size / pixel checks live in the editor, which explains a refusal
    // in place and offers "Choose another" instead of failing silently here.
    if (file) setCropTarget({ kind, file });
  };

  const onCropApplied = (image: ExportedImage): void => {
    if (!cropTarget) return;
    const draft = { mime: image.mime, dataBase64: image.dataBase64, previewUrl: image.previewUrl };
    if (cropTarget.kind === "avatar") {
      setAvatarDraft(draft);
      setAvatarError(null);
    } else {
      setBannerDraft(draft);
      setBannerError(null);
    }
    setSaved(false);
    setCropTarget(null);
  };

  const hasAvatar = avatarPreview !== null && avatarPreview !== undefined;
  const hasBanner = bannerPreview !== null && bannerPreview !== undefined;

  return (
    <div className="relative space-y-10" onKeyDown={onKeyDown}>
      <input
        ref={avatarInputRef}
        type="file"
        accept={CROP_INPUT_ACCEPT}
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={onPick("avatar")}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept={CROP_INPUT_ACCEPT}
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={onPick("banner")}
      />

      <div className="grid gap-8 wide:grid-cols-[minmax(0,1fr)_17.5rem]">
        {/* ── Live preview (first in DOM so it leads on narrow screens) ───── */}
        <aside
          aria-label={t("desktop:profile.previewHeading")}
          className="space-y-2 wide:order-2 wide:sticky wide:top-0 wide:self-start"
        >
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t("desktop:profile.previewHeading")}
          </p>
          <ProfileIdentityPreview
            name={shownName}
            username={handle}
            seed={seed}
            avatarUrl={avatarPreview}
            bannerUrl={bannerPreview}
            customStatus={user?.customStatus ?? null}
            bio={trimmedBio || null}
            avatarSlot={
              <ImageTarget
                shape="circle"
                label={t("desktop:profile.avatarUploadAria")}
                disabled={saving}
                onClick={() => openPicker("avatar")}
              >
                <AvatarFace name={shownName} seed={seed} src={avatarPreview} />
              </ImageTarget>
            }
            bannerSlot={
              <ImageTarget
                shape="banner"
                label={t("desktop:profile.bannerUploadAria")}
                disabled={saving}
                onClick={() => openPicker("banner")}
              />
            }
          />
          <p className="text-2xs text-fg-faint">{t("desktop:profile.previewNote")}</p>
        </aside>

        {/* ── Fields ─────────────────────────────────────────────────────── */}
        <form id="profile-form" onSubmit={onSubmit} className="min-w-0 space-y-7 wide:order-1">
          <Field
            label={t("desktop:profile.displayName")}
            error={error === "desktop:profile.nameRequired" ? t(error) : undefined}
            help={t("desktop:profile.charCount", {
              count: displayName.length,
              max: DISPLAY_NAME_MAX_LENGTH,
            })}
          >
            <Input
              id="profile-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              placeholder={t("desktop:profile.namePlaceholder")}
            />
          </Field>

          <ImageField
            heading={t("desktop:profile.avatarSection")}
            help={t("desktop:profile.avatarHelp")}
            changeLabel={t("desktop:profile.editAvatar")}
            removeLabel={t("desktop:profile.avatarRemove")}
            canRemove={hasAvatar}
            removing={avatarDraft === "remove"}
            undoRemoveLabel={t("desktop:profile.undoRemove")}
            onUndoRemove={() => setAvatarDraft(null)}
            pending={avatarDraft !== null}
            pendingLabel={
              avatarDraft === "remove" ? t("desktop:profile.removePending") : t("desktop:profile.imagePending")
            }
            busyLabel={progress?.step === "avatar" ? t("desktop:profile.savingAvatar") : null}
            error={avatarError ? t(avatarError) : null}
            disabled={saving}
            onChange={() => openPicker("avatar")}
            onRemove={() => setAvatarDraft(persistedAvatarUrl ? "remove" : null)}
          />

          <ImageField
            heading={t("desktop:profile.bannerSection")}
            help={t("desktop:profile.bannerHelp")}
            changeLabel={hasBanner ? t("desktop:profile.editBanner") : t("desktop:profile.bannerAdd")}
            removeLabel={t("desktop:profile.bannerRemove")}
            canRemove={hasBanner}
            removing={bannerDraft === "remove"}
            undoRemoveLabel={t("desktop:profile.undoRemove")}
            onUndoRemove={() => setBannerDraft(null)}
            pending={bannerDraft !== null}
            pendingLabel={
              bannerDraft === "remove" ? t("desktop:profile.removePending") : t("desktop:profile.imagePending")
            }
            busyLabel={progress?.step === "banner" ? t("desktop:profile.savingBanner") : null}
            error={bannerError ? t(bannerError) : null}
            disabled={saving}
            onChange={() => openPicker("banner")}
            onRemove={() => setBannerDraft(persistedBannerUrl ? "remove" : null)}
          />

          <Field
            label={
              <>
                {t("desktop:profile.bioLabel")}{" "}
                <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
              </>
            }
            help={`${t("desktop:profile.bioNote", { max: BIO_MAX_LENGTH })} · ${t("desktop:profile.charCount", {
              count: bio.length,
              max: BIO_MAX_LENGTH,
            })}`}
          >
            <Textarea
              id="profile-bio"
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={BIO_MAX_LENGTH}
              rows={4}
              placeholder={t("desktop:profile.bioPlaceholder")}
            />
          </Field>

          {error && error !== "desktop:profile.nameRequired" && <FormErrorAlert>{t(error)}</FormErrorAlert>}
        </form>
      </div>

      {/* ── Doğum tarihi (M15) — NSFW yaş kapısı, set-once ───────────────────
          Deliberately OUTSIDE the profile form: it saves itself through the same
          confirming <BirthdateVerification> the NSFW gate uses, because this
          value can never be corrected afterwards. Once set, the section is
          read-only and states the 18+ outcome. */}
      <section className="max-w-sm space-y-1.5">
        {user?.birthdate ? (
          <>
            <p className="text-label font-medium text-fg-muted">{t("desktop:profile.birthdateLabel")}</p>
            <p className="text-sm text-fg">{user.birthdate}</p>
            <p className="text-2xs text-fg-faint">
              {user.isAdult ? t("desktop:profile.birthdateAdult") : t("desktop:profile.birthdateMinor")}
              {" · "}
              {t("desktop:profile.birthdateLocked")}
            </p>
          </>
        ) : (
          <>
            <p className="text-2xs text-fg-faint">{t("desktop:profile.birthdateHint")}</p>
            <BirthdateVerification />
          </>
        )}
      </section>

      <p className="text-2xs text-fg-faint">
        {t("desktop:profile.usernameNote", { username: handle, max: USERNAME_MAX_LENGTH })}
      </p>

      {/* ── Danger zone: permanent account deletion ────────────────────────── */}
      <DangerZone />

      {/* ── Unsaved-changes bar ───────────────────────────────────────────────
          Sticky to the bottom of the settings scroll area; enters on the
          position spring when the first edit lands, leaves when the draft is
          saved or discarded. */}
      <div className="pointer-events-none sticky bottom-4 z-10 -mt-6 flex justify-center">
        <AnimatePresence>
          {(dirty || saving || saved) && (
            <SaveBar
              key="save-bar"
              state={saving ? "saving" : partialFailure ? "failed" : dirty ? "dirty" : "saved"}
              progress={progress}
              onDiscard={discardDraft}
              onSave={() => void save()}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ── Unsaved-changes guard ──────────────────────────────────────────────
          Raised when the user tries to close settings (Esc, backdrop, X) or
          switch section with a draft open. Discarding here is the ONLY way an
          edit is silently dropped, and the user asked for it explicitly. */}
      <ConfirmLayer
        open={pendingSettingsNav !== null}
        onDismiss={cancelSettingsNav}
        title={t("desktop:profile.unsavedTitle")}
        body={t("desktop:profile.unsavedBody")}
        actions={
          <>
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
          </>
        }
      />

      <ImageCropDialog
        kind={cropTarget?.kind ?? "avatar"}
        file={cropTarget?.file ?? null}
        onCancel={() => setCropTarget(null)}
        onApply={onCropApplied}
        identity={{
          name: shownName,
          username: handle,
          seed,
          avatarUrl: avatarPreview,
          bannerUrl: bannerPreview,
        }}
      />
    </div>
  );
}

/** The avatar inside the preview's change-avatar button (the card's own `lg`). */
function AvatarFace({
  name,
  seed,
  src,
}: {
  name: string;
  seed: string;
  src: string | null | undefined;
}): JSX.Element {
  return <UserAvatar name={name} colorSeed={seed} src={src} size="lg" />;
}

/**
 * A click target laid over the preview's avatar or banner: hover / focus reveals
 * a camera affordance on a scrim (tone change, 200ms — nothing moves), click
 * opens the picker. A real button with a spoken label, so the preview is also
 * the fastest way to change either image.
 */
function ImageTarget({
  shape,
  label,
  disabled,
  onClick,
  children,
}: {
  shape: "circle" | "banner";
  label: string;
  disabled: boolean;
  onClick: () => void;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group/target cursor-pointer focus-visible:outline-none disabled:cursor-wait",
        shape === "circle"
          ? "relative block rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          : "absolute inset-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 flex items-center justify-center bg-scrim text-fg-display",
          "opacity-0 transition-opacity motion-hover group-hover/target:opacity-100 group-focus-visible/target:opacity-100",
          shape === "circle" ? "rounded-full" : "",
        )}
      >
        <Camera className={shape === "circle" ? "size-6" : "size-5"} />
      </span>
    </button>
  );
}

/** Avatar / banner row in the form: heading, help, Change + Remove, draft state, error. */
function ImageField({
  heading,
  help,
  changeLabel,
  removeLabel,
  canRemove,
  removing,
  undoRemoveLabel,
  onUndoRemove,
  pending,
  pendingLabel,
  busyLabel,
  error,
  disabled,
  onChange,
  onRemove,
}: {
  heading: string;
  help: string;
  changeLabel: string;
  removeLabel: string;
  canRemove: boolean;
  /** A removal is pending: the same button becomes "undo", so focus never drops. */
  removing: boolean;
  undoRemoveLabel: string;
  onUndoRemove: () => void;
  pending: boolean;
  pendingLabel: string;
  busyLabel: string | null;
  error: string | null;
  disabled: boolean;
  onChange: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-label font-medium text-fg-muted">{heading}</h3>
        <p className="text-label text-fg-faint">{help}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onChange}>
          <ImagePlus className="size-4" aria-hidden />
          {changeLabel}
        </Button>
        {(canRemove || removing) && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={removing ? onUndoRemove : onRemove}>
            {removing ? undoRemoveLabel : removeLabel}
          </Button>
        )}
        {busyLabel ? (
          <span className="inline-flex items-center gap-1.5 text-2xs text-fg-faint" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {busyLabel}
          </span>
        ) : (
          pending && (
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-surface px-2 py-0.5 text-2xs font-medium text-accent-hover">
              {pendingLabel}
            </span>
          )
        )}
      </div>
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The sticky glass pill at the bottom of the panel. Four faces:
 *   dirty   "You have unsaved changes."   Discard · Save changes
 *   saving  the current step + "1/3"      a thin coral step bar
 *   failed  what happened + how retry works   Discard · Try again
 *   saved   a quiet tick, then it leaves on its own
 */
function SaveBar({
  state,
  progress,
  onDiscard,
  onSave,
}: {
  state: "dirty" | "saving" | "failed" | "saved";
  progress: { step: SaveStep; index: number; total: number } | null;
  onDiscard: () => void;
  onSave: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const done = progress ? progress.index / progress.total : 0;
  return (
    <m.div
      variants={toastPop}
      initial="initial"
      animate="animate"
      exit="exit"
      role="region"
      aria-label={t("desktop:profile.unsavedBar")}
      className={cn(
        // Wraps on a phone-width web window: the message keeps a full line and
        // the two buttons drop under it, right-aligned, instead of crushing it.
        "pointer-events-auto relative flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2 overflow-hidden rounded-cta py-2.5 pl-4 pr-2.5 surface-glass-strong",
      )}
    >
      {/* Failed: a pink wash under the content, so the pill reads as a problem
          before a word of it is read (never a solid fill — §1.5). */}
      {state === "failed" && <span aria-hidden className="pointer-events-none absolute inset-0 bg-danger/12" />}
      <div className="flex min-w-[12rem] flex-1 items-center gap-2.5" aria-live="polite">
        {state === "saving" && progress ? (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
            <span className="truncate text-sm font-medium text-fg">{t(SAVE_STEP_LABEL[progress.step])}</span>
            <span className="shrink-0 text-2xs tabular-nums text-fg-faint">
              {t("desktop:profile.saveStep", { current: progress.index + 1, total: progress.total })}
            </span>
          </>
        ) : state === "failed" ? (
          <>
            <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{t("desktop:profile.saveFailed")}</span>
              <span className="block truncate text-2xs text-fg-muted">{t("desktop:profile.saveFailedHint")}</span>
            </span>
          </>
        ) : state === "saved" ? (
          <>
            <Check className="size-4 shrink-0 text-success" aria-hidden />
            <span className="truncate text-sm font-medium text-fg">{t("desktop:profile.saved")}</span>
          </>
        ) : (
          <span className="truncate text-sm font-medium text-fg">{t("desktop:profile.unsavedBar")}</span>
        )}
      </div>
      {state !== "saved" && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" disabled={state === "saving"} onClick={onDiscard}>
            {t("desktop:profile.discard")}
          </Button>
          <Button
            type="submit"
            form="profile-form"
            variant="primary"
            size="sm"
            disabled={state === "saving"}
            onClick={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            {state === "failed" ? t("buttons.retry") : t("desktop:profile.saveChanges")}
          </Button>
        </div>
      )}
      {state === "saving" && progress && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-wash">
          <span
            className="block h-full origin-left bg-accent transition-transform motion-standard"
            style={{ transform: `scaleX(${Math.max(0.04, done)})` }}
          />
        </span>
      )}
    </m.div>
  );
}
