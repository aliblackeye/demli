import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { Button, Input, cn } from "@demli/ui";
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

/** Native <select> styled to match the Input primitive (dark-first). */
const selectClass = [
  "h-9 w-full rounded-md border border-stroke bg-raised px-2.5 text-sm text-fg",
  "transition-colors motion-instant",
  "focus:outline-none focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30",
  "disabled:pointer-events-none disabled:opacity-50",
].join(" ");

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
 */
export function GeneralTab({
  group,
  isOwner,
}: {
  group: FriendGroup;
  isOwner: boolean;
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
  const [invitePolicy, setInvitePolicy] = useState<InvitePolicy>(
    group.invitePolicy ?? "members",
  );
  const [error, setError] = useState<FormError | null>(null);
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

  // Reseed if the underlying server changes (dialog reused across servers).
  useEffect(() => {
    setName(group.name);
    setIconUrl(group.iconUrl ?? "");
    setSystemChannelId(group.systemChannelId ?? "");
    setInvitePolicy(group.invitePolicy ?? "members");
    setError(null);
    setBannerError(null);
    setConfirmingDelete(false);
    // Reseed only when the underlying server changes, not on every refetch.
  }, [group.id]);

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
    updateGroup.mutate(
      { bannerUrl: null },
      { onError: (err) => setBannerError(bannerErrorFrom(err)) },
    );
  };

  const onSave = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !isOwner) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
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
      {
        onSuccess: () => setOpen(false),
        onError: (err) => setError(errorKey(err)),
      },
    );
  };

  const onDelete = (): void => {
    if (busy || !activeGroupId) return;
    setError(null);
    deleteGroup.mutate(activeGroupId, {
      onSuccess: () => setOpen(false),
      onError: (err) => setError(errorKey(err)),
    });
  };

  return (
    <>
      {error && <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>}

      {/* ── Server banner ─────────────────────────────────────────────────── */}
      {/* Its own action, above the form: it POSTs bytes to its own endpoint
          rather than riding the Save button, which patches name/icon/policy. */}
      <div className="mb-5 space-y-1.5">
        <span className="block text-xs font-semibold text-fg-muted">
          {t("desktop:serverSettings.bannerLabel")}{" "}
          <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
        </span>

        {bannerError && <FormErrorAlert className="mb-2">{t(bannerError)}</FormErrorAlert>}

        <div className="overflow-hidden rounded-xl border border-stroke bg-surface">
          <button
            type="button"
            onClick={openBannerPicker}
            disabled={bannerBusy || !isOwner}
            aria-label={t("desktop:serverSettings.bannerUploadAria")}
            className={cn(
              "group relative block h-28 w-full overflow-hidden",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
              !isOwner && "cursor-default",
              isOwner && (bannerBusy ? "cursor-wait" : "cursor-pointer"),
            )}
          >
            {bannerUrl ? (
              <img
                src={bannerUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              // No banner: a plain surface with a short line, never a broken
              // <img> and never an empty box pretending something failed.
              <span className="absolute inset-0 flex items-center justify-center bg-raised/50 text-2xs text-fg-faint">
                {t("desktop:serverSettings.bannerEmpty")}
              </span>
            )}

            {bannerBusy ? (
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center bg-black/40"
              >
                <Loader2 className="size-5 animate-spin text-white" />
              </span>
            ) : (
              isOwner && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full",
                    "bg-black/55 px-3 py-1.5 text-2xs font-medium text-white backdrop-blur-sm",
                    "opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100",
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
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-2xs text-fg-faint">{t("desktop:serverSettings.bannerNote")}</p>
          {/* Remove exists only when there is something to remove (§35). */}
          {isOwner && bannerUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bannerBusy}
              onClick={onRemoveBanner}
              className="shrink-0 border-danger/40 text-danger hover:bg-danger/10"
            >
              <Trash2 className="size-3.5" />
              {t("desktop:serverSettings.bannerRemove")}
            </Button>
          )}
        </div>
      </div>

      <form onSubmit={onSave} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="server-name" className="block text-xs font-semibold text-fg-muted">
            {t("desktop:serverSettings.name")}
          </label>
          <Input
            id="server-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={GROUP_NAME_MAX_LENGTH}
            disabled={!isOwner}
            placeholder={t("desktop:serverSettings.namePlaceholder")}
            aria-label={t("desktop:serverSettings.namePlaceholder")}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="server-icon" className="block text-xs font-semibold text-fg-muted">
            {t("desktop:serverSettings.iconLabel")}{" "}
            <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
          </label>
          <Input
            id="server-icon"
            value={iconUrl}
            onChange={(event) => setIconUrl(event.target.value)}
            disabled={!isOwner}
            spellCheck={false}
            placeholder="https://…"
            aria-label={t("desktop:serverSettings.iconLabel")}
            className="font-mono text-[13px]"
          />
          <p className="text-2xs text-fg-faint">{t("desktop:serverSettings.iconNote")}</p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="server-system-channel"
            className="block text-xs font-semibold text-fg-muted"
          >
            {t("desktop:serverSettings.systemChannel")}
          </label>
          <select
            id="server-system-channel"
            value={systemChannelId}
            onChange={(event) => setSystemChannelId(event.target.value)}
            disabled={!isOwner}
            aria-label={t("desktop:serverSettings.systemChannel")}
            className={selectClass}
          >
            <option value="">{t("desktop:serverSettings.systemChannelOff")}</option>
            {textChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                # {channel.name}
              </option>
            ))}
          </select>
          <p className="text-2xs text-fg-faint">
            {t("desktop:serverSettings.systemChannelNote")}
          </p>
        </div>

        <fieldset className="space-y-2" disabled={!isOwner}>
          <legend className="text-xs font-semibold text-fg-muted">
            {t("desktop:serverSettings.whoCanInvite")}
          </legend>
          <div className="space-y-1.5">
            {INVITE_POLICIES.map((policy) => (
              <label
                key={policy.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-stroke bg-raised/40 p-2.5 transition-colors hover:bg-raised has-[:checked]:border-accent/50 has-[:checked]:bg-accent/[0.06]"
              >
                <input
                  type="radio"
                  name="invite-policy"
                  value={policy.value}
                  checked={invitePolicy === policy.value}
                  onChange={() => setInvitePolicy(policy.value)}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">
                    {t(policy.labelKey)}
                  </span>
                  <span className="block text-2xs text-fg-faint">
                    {t(policy.descriptionKey)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {isOwner && (
          <Button type="submit" disabled={busy} className="w-full">
            {updateGroup.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("desktop:channelSettings.save")}
          </Button>
        )}
      </form>

      {isOwner && (
        <div className="mt-6 rounded-lg border border-danger/30 bg-danger/[0.06] p-4">
          <p className="text-sm font-semibold text-fg">
            {t("desktop:serverSettings.deleteServer")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t("desktop:serverSettings.deleteNote")}
          </p>
          {confirmingDelete ? (
            <div className="mt-3 flex gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={onDelete}
                className="flex-1"
              >
                {deleteGroup.isPending && <Loader2 className="size-4 animate-spin" />}
                {t("desktop:channelSettings.confirmDelete")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
                className="flex-1"
              >
                {t("buttons.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              className="mt-3 border-danger/40 text-danger hover:bg-danger/10"
            >
              {t("desktop:serverSettings.deleteServer")}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
