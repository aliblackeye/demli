import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { Button, Field, Input, RadioGroup, RadioItem, Select, cn } from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import {
  GROUP_NAME_MAX_LENGTH,
  IMAGE_HEADER_BYTES,
  isWithinPixelBudget,
} from "@demli/config";
import { ApiClientError } from "@demli/client-core";
import type { FriendGroup, InvitePolicy } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import {
  useDeleteGroup,
  useGroupDetails,
  useUpdateGroup,
  useUploadGroupBanner,
} from "../../queries/chat-queries";
import { useChatStore } from "../../stores/chat-store";
import { useUiStore } from "../../stores/ui-store";
import { DangerZone, HelpWithCount, UnsavedChangesBar } from "../settings-kit";
import { useReportDirty, type DraftGuard } from "./shared";

const INVITE_POLICIES = [
  {
    value: "members",
    labelKey: "desktop:serverSettings.inviteMembers",
    descriptionKey: "desktop:serverSettings.inviteMembersDesc",
  },
  {
    value: "roles",
    labelKey: "desktop:serverSettings.inviteRoles",
    descriptionKey: "desktop:serverSettings.inviteRolesDesc",
  },
] as const satisfies readonly { value: InvitePolicy; labelKey: string; descriptionKey: string }[];

type FormError = CommonErrorKey | "desktop:serverSettings.nameRequired";

/**
 * Server banner rules, mirroring the profile banner exactly (5 MB, GIF allowed,
 * no SVG). These are a fast local rejection so a user learns what is wrong
 * WITHOUT a 5 MB round trip — the API re-checks every one of them on the real
 * bytes, which is where the actual decision is made (§28).
 */
const BANNER_MAX_BYTES = 5 * 1024 * 1024;
const BANNER_ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const BANNER_ACCEPT_ATTR = BANNER_ACCEPT_TYPES.join(",");

/** A server-banner upload failure, mapped to its own copy. */
type BannerError =
  | "desktop:serverSettings.bannerInvalid"
  | "desktop:serverSettings.bannerTooLarge"
  | "desktop:serverSettings.bannerTooManyPixels"
  | "desktop:serverSettings.bannerDisabled"
  | "desktop:serverSettings.bannerRejected"
  | CommonErrorKey;

/**
 * Map a server-banner API failure to its message. The group-banner codes are not
 * in the shared `ApiClientErrorCode` union, so they are matched by their string
 * form — `errorKey` would return undefined for every one of them.
 */
function bannerErrorFrom(err: unknown): BannerError {
  if (err instanceof ApiClientError) {
    switch (err.code as string) {
      case "INVALID_GROUP_BANNER":
        return "desktop:serverSettings.bannerInvalid";
      case "GROUP_BANNER_TOO_LARGE":
        return "desktop:serverSettings.bannerTooLarge";
      case "GROUP_BANNER_UPLOADS_DISABLED":
        return "desktop:serverSettings.bannerDisabled";
      case "GROUP_BANNER_REJECTED":
        return "desktop:serverSettings.bannerRejected";
      case "NETWORK":
        return "errors.network";
    }
  }
  return "errors.generic";
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
 * General server settings: name, icon, system channel, invite policy, delete.
 * Every field here is owner-only (the API rejects non-owners); the tab still
 * renders read-only for managers who reach settings via other permissions.
 *
 * The form is a DRAFT: edits collect locally, the unsaved-changes bar rises
 * the moment the draft differs from the server, and Save / Reset are the only
 * ways out (the dialog refuses to close over it — see ServerSettingsDialog).
 */
export function GeneralTab({
  group,
  isOwner,
  guard,
}: {
  group: FriendGroup;
  isOwner: boolean;
  guard?: DraftGuard;
}): JSX.Element {
  const { t } = useAppTranslation();
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: details } = useGroupDetails(activeGroupId);
  const setOpen = useUiStore((s) => s.setServerSettingsOpen);

  const textChannels = (details?.channels ?? [])
    .filter((c) => c.kind === "text")
    .sort((a, b) => a.position - b.position);

  const [name, setName] = useState(group.name);
  const [iconUrl, setIconUrl] = useState(group.iconUrl ?? "");
  const [systemChannelId, setSystemChannelId] = useState(group.systemChannelId ?? "");
  const [invitePolicy, setInvitePolicy] = useState<InvitePolicy>(group.invitePolicy ?? "members");
  const [error, setError] = useState<FormError | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [bannerError, setBannerError] = useState<BannerError | null>(null);
  const [bannerReading, setBannerReading] = useState(false);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const updateGroup = useUpdateGroup(activeGroupId);
  const uploadGroupBanner = useUploadGroupBanner(activeGroupId);
  const deleteGroup = useDeleteGroup();
  const busy = updateGroup.isPending || deleteGroup.isPending;
  const bannerBusy = bannerReading || uploadGroupBanner.isPending || updateGroup.isPending;

  const bannerUrl = group.bannerUrl ?? null;

  const reseed = (): void => {
    setName(group.name);
    setIconUrl(group.iconUrl ?? "");
    setSystemChannelId(group.systemChannelId ?? "");
    setInvitePolicy(group.invitePolicy ?? "members");
    setError(null);
    setNameTouched(false);
  };

  // Reseed if the underlying server changes (dialog reused across servers).
  useEffect(() => {
    reseed();
    setBannerError(null);
    setConfirmingDelete(false);
    // Reseed only when the underlying server changes, not on every refetch.
  }, [group.id]);

  const trimmedName = name.trim();
  const dirty =
    isOwner &&
    (trimmedName !== group.name ||
      iconUrl.trim() !== (group.iconUrl ?? "") ||
      systemChannelId !== (group.systemChannelId ?? "") ||
      invitePolicy !== (group.invitePolicy ?? "members"));
  useReportDirty(guard, dirty);

  const nameError =
    error === "desktop:serverSettings.nameRequired" || (nameTouched && trimmedName.length === 0)
      ? t("desktop:serverSettings.nameRequired")
      : undefined;

  const openBannerPicker = (): void => {
    if (bannerBusy || !isOwner) return;
    setBannerError(null);
    bannerInputRef.current?.click();
  };

  /**
   * Validate then upload immediately. The banner is its own endpoint (bytes, not
   * a form field), so it is its own action rather than a draft riding on Save —
   * a draft would have to survive a submit that talks to a different route, which
   * is exactly the kind of half-wired affordance §35 forbids.
   */
  const onBannerChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !isOwner) return;

    setBannerError(null);
    if (!BANNER_ACCEPT_TYPES.includes(file.type as (typeof BANNER_ACCEPT_TYPES)[number])) {
      setBannerError("desktop:serverSettings.bannerInvalid");
      return;
    }
    if (file.size > BANNER_MAX_BYTES) {
      setBannerError("desktop:serverSettings.bannerTooLarge");
      return;
    }

    setBannerReading(true);
    let payload: { mime: string; dataBase64: string };
    try {
      // Decompression-bomb pre-check on the HEADER only: a 300 KB PNG can claim
      // 40000×40000 and pass every size rule above while being gigabytes once
      // decoded. Reading 64 KB answers it without loading the file twice. The
      // API runs the identical guard on the real bytes — this one exists so the
      // user gets told immediately instead of after a 5 MB upload.
      const header = new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
      if (!isWithinPixelBudget(header)) {
        setBannerReading(false);
        setBannerError("desktop:serverSettings.bannerTooManyPixels");
        return;
      }
      payload = await fileToUpload(file);
    } catch {
      setBannerReading(false);
      setBannerError("desktop:serverSettings.bannerInvalid");
      return;
    }
    setBannerReading(false);

    uploadGroupBanner.mutate(payload, {
      onError: (err) => setBannerError(bannerErrorFrom(err)),
    });
  };

  const onRemoveBanner = (): void => {
    if (bannerBusy || !isOwner || !bannerUrl) return;
    setBannerError(null);
    updateGroup.mutate({ bannerUrl: null }, { onError: (err) => setBannerError(bannerErrorFrom(err)) });
  };

  const onSave = (event?: FormEvent): void => {
    event?.preventDefault();
    if (busy || !isOwner) return;
    if (trimmedName.length === 0) {
      setNameTouched(true);
      setError("desktop:serverSettings.nameRequired");
      return;
    }
    setError(null);
    const trimmedIcon = iconUrl.trim();
    updateGroup.mutate(
      {
        name: trimmedName,
        iconUrl: trimmedIcon.length > 0 ? trimmedIcon : null,
        systemChannelId: systemChannelId.length > 0 ? systemChannelId : null,
        invitePolicy,
      },
      { onError: (err) => setError(errorKey(err)) },
    );
  };

  const onDelete = (): void => {
    if (busy || !activeGroupId) return;
    setError(null);
    deleteGroup.mutate(activeGroupId, {
      onSuccess: () => {
        // The server is gone: drop the draft latch so the dialog may close.
        guard?.onDirtyChange(false);
        setOpen(false);
      },
      onError: (err) => setError(errorKey(err)),
    });
  };

  const channelOptions = [
    { value: "", label: t("desktop:serverSettings.systemChannelOff") },
    ...textChannels.map((channel) => ({ value: channel.id, label: `# ${channel.name}` })),
  ];

  return (
    <div className="space-y-7">
      {error && error !== "desktop:serverSettings.nameRequired" && <FormErrorAlert>{t(error)}</FormErrorAlert>}

      {/* ── Server banner ─────────────────────────────────────────────────── */}
      {/* Its own action, above the form: it POSTs bytes to its own endpoint
          rather than riding the Save button, which patches name/icon/policy. */}
      <section className="space-y-2">
        <p className="text-label font-medium text-fg-muted">
          {t("desktop:serverSettings.bannerLabel")}{" "}
          <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
        </p>

        <button
          type="button"
          onClick={openBannerPicker}
          disabled={bannerBusy || !isOwner}
          aria-label={t("desktop:serverSettings.bannerUploadAria")}
          className={cn(
            "group relative block h-32 w-full overflow-hidden rounded-xl bg-surface",
            "transition-[box-shadow] motion-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
            !isOwner && "cursor-default",
            isOwner && (bannerBusy ? "cursor-wait" : "cursor-pointer hover:shadow-[inset_0_0_0_1px_var(--color-stroke-strong)]"),
          )}
        >
          {bannerUrl ? (
            <img src={bannerUrl} alt="" className="size-full object-cover" draggable={false} />
          ) : (
            // No banner: a plain surface with a short line, never a broken
            // <img> and never an empty box pretending something failed.
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-label text-fg-faint">
              <ImagePlus aria-hidden className="size-5 text-fg-subtle" />
              {t("desktop:serverSettings.bannerEmpty")}
            </span>
          )}

          {bannerBusy ? (
            <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-scrim">
              <Loader2 className="size-5 animate-spin text-fg-display" />
            </span>
          ) : (
            isOwner && (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5",
                  "bg-veil text-2xs font-medium text-fg-display backdrop-blur-[8px] shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]",
                  "opacity-0 transition-opacity motion-hover group-hover:opacity-100 group-focus-visible:opacity-100",
                )}
              >
                <Camera className="size-3.5" />
                {t("desktop:serverSettings.bannerChange")}
              </span>
            )
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

        {bannerError && <FormErrorAlert>{t(bannerError)}</FormErrorAlert>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-label text-fg-faint">{t("desktop:serverSettings.bannerNote")}</p>
          {/* Remove exists only when there is something to remove (§35). */}
          {isOwner && bannerUrl && (
            <Button type="button" variant="danger" size="sm" disabled={bannerBusy} onClick={onRemoveBanner}>
              <Trash2 className="size-3.5" />
              {t("desktop:serverSettings.bannerRemove")}
            </Button>
          )}
        </div>
      </section>

      <form id="server-general-form" onSubmit={onSave} className="space-y-5" noValidate>
        <Field
          label={t("desktop:serverSettings.name")}
          error={nameError}
          help={<HelpWithCount value={name} max={GROUP_NAME_MAX_LENGTH} />}
        >
          <Input
            id="server-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error === "desktop:serverSettings.nameRequired") setError(null);
            }}
            onBlur={() => setNameTouched(true)}
            maxLength={GROUP_NAME_MAX_LENGTH}
            disabled={!isOwner}
            placeholder={t("desktop:serverSettings.namePlaceholder")}
          />
        </Field>

        <Field
          label={
            <>
              {t("desktop:serverSettings.iconLabel")}{" "}
              <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
            </>
          }
          help={t("desktop:serverSettings.iconNote")}
        >
          <Input
            id="server-icon"
            value={iconUrl}
            onChange={(event) => setIconUrl(event.target.value)}
            disabled={!isOwner}
            spellCheck={false}
            placeholder="https://…"
            className="font-mono text-label"
          />
        </Field>

        <Field label={t("desktop:serverSettings.systemChannel")} help={t("desktop:serverSettings.systemChannelNote")}>
          <Select
            id="server-system-channel"
            options={channelOptions}
            value={systemChannelId}
            onValueChange={setSystemChannelId}
            disabled={!isOwner}
            placeholder={t("desktop:serverSettings.systemChannelOff")}
          />
        </Field>

        <div className="space-y-2">
          <p id="invite-policy-label" className="text-label font-medium text-fg-muted">
            {t("desktop:serverSettings.whoCanInvite")}
          </p>
          <RadioGroup
            value={invitePolicy}
            onValueChange={(next) => setInvitePolicy(next as InvitePolicy)}
            disabled={!isOwner}
            aria-labelledby="invite-policy-label"
            className="rounded-xl bg-surface p-1"
          >
            {INVITE_POLICIES.map((policy) => (
              <RadioItem
                key={policy.value}
                value={policy.value}
                label={t(policy.labelKey)}
                description={t(policy.descriptionKey)}
              />
            ))}
          </RadioGroup>
        </div>
      </form>

      {isOwner && (
        <DangerZone
          title={t("desktop:serverSettings.deleteServer")}
          body={t("desktop:serverSettings.deleteNote")}
          actionLabel={t("desktop:serverSettings.deleteServer")}
          confirmLabel={t("desktop:channelSettings.confirmDelete")}
          cancelLabel={t("buttons.cancel")}
          onConfirm={onDelete}
          pending={deleteGroup.isPending}
          disabled={updateGroup.isPending}
          confirming={confirmingDelete}
          onConfirmingChange={setConfirmingDelete}
        />
      )}

      <UnsavedChangesBar
        open={dirty}
        saving={updateGroup.isPending}
        nudge={guard?.nudge ?? 0}
        message={t("desktop:settingsUi.unsavedMessage")}
        nudgeMessage={t("desktop:settingsUi.unsavedNudge")}
        resetLabel={t("desktop:settingsUi.unsavedReset")}
        saveLabel={t("desktop:settingsUi.unsavedSave")}
        onReset={reseed}
        onSave={() => onSave()}
        saveDisabled={trimmedName.length === 0}
        className="sticky bottom-0 z-10 -mx-1 pb-1 pt-2"
      />
    </div>
  );
}
