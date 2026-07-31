import { useEffect, useState, type FormEvent } from "react";
import { Check, Hash, Loader2, Volume2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { CHANNEL_NAME_MAX_LENGTH } from "@demli/config";
import type { ChannelKind, RoleId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useCategories, useCreateChannel, useGroups, useRoles } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { NsfwToggle } from "./NsfwToggle";

type FormError = CommonErrorKey | "desktop:createChannel.nameRequired";
type Visibility = "public" | "restricted";

/** Owner-only channel creation for the active group. */
export function CreateChannelDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.createChannelDialogOpen);
  const setOpen = useUiStore((s) => s.setCreateChannelDialogOpen);
  // Which category the new channel lands in (M18) — set by the "+" on a category
  // header, null for the plain "create channel" entry.
  const createChannelCategoryId = useUiStore((s) => s.createChannelCategoryId);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: categories } = useCategories(activeGroupId);
  const targetCategory = categories?.find((c) => c.id === createChannelCategoryId) ?? null;
  const { data: groups } = useGroups();
  const group = groups?.find((g) => g.id === activeGroupId);
  // Roles only exist on servers; an empty list (the MVP default for a fresh
  // server) hides the whole visibility section — no non-functional UI (task #51).
  const { data: roles } = useRoles(activeGroupId);
  const hasRoles = (roles?.length ?? 0) > 0;

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("text");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [selectedRoles, setSelectedRoles] = useState<Set<RoleId>>(new Set());
  const [nsfw, setNsfw] = useState(false);
  const [error, setError] = useState<FormError | null>(null);

  const createChannel = useCreateChannel(activeGroupId);

  useEffect(() => {
    if (!open) {
      setName("");
      setKind("text");
      setVisibility("public");
      setSelectedRoles(new Set());
      setNsfw(false);
      setError(null);
    }
  }, [open]);

  const toggleRole = (roleId: RoleId): void => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (createChannel.isPending) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("desktop:createChannel.nameRequired");
      return;
    }
    setError(null);
    // Restricted with an empty selection stays public (mirrors ChannelVisibility-
    // Section); an unrestricted channel sends no roleIds at all.
    const roleIds =
      hasRoles && visibility === "restricted" ? [...selectedRoles] : [];
    createChannel.mutate(
      {
        name: trimmed,
        kind,
        roleIds,
        // NSFW is text-only; never send it for a voice channel (the API rejects it).
        ...(kind === "text" && nsfw ? { nsfw: true } : {}),
        // Only send a category when one was actually targeted, so the plain
        // "create channel" path stays byte-identical to its pre-M18 request.
        ...(createChannelCategoryId ? { categoryId: createChannelCategoryId } : {}),
      },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => setError(errorKey(err)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:createChannel.title")}</DialogTitle>
          <DialogDescription>
            {/* Naming the target category is the only signal that the "+" on a
                category header did anything different — without it the dialog
                would look identical and the placement would be a surprise. */}
            {targetCategory
              ? t("desktop:sidebar.createChannelInCategory", { name: targetCategory.name })
              : t("desktop:createChannel.description", {
                  group: group?.name ?? t("desktop:createChannel.thisGroup"),
                })}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form onSubmit={onSubmit}>
            {error && <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>}

            <div
              role="radiogroup"
              aria-label={t("desktop:createChannel.typeLabel")}
              className="mb-4 space-y-1"
            >
              {(
                [
                  {
                    value: "text",
                    label: t("desktop:createChannel.textLabel"),
                    hint: t("desktop:createChannel.textHint"),
                    icon: Hash,
                  },
                  {
                    value: "voice",
                    label: t("desktop:createChannel.voiceLabel"),
                    hint: t("desktop:createChannel.voiceHint"),
                    icon: Volume2,
                  },
                ] as const
              ).map((option) => {
                const selected = kind === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option.value)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left",
                      "transition-colors motion-instant",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                      selected
                        ? "border-accent/60 bg-accent/10 text-fg"
                        : "border-stroke bg-raised text-fg-muted hover:border-stroke-strong hover:text-fg",
                    )}
                  >
                    <option.icon className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-fg-faint">{option.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={CHANNEL_NAME_MAX_LENGTH}
              autoFocus
              spellCheck={false}
              placeholder={
                kind === "text"
                  ? t("desktop:createChannel.textPlaceholder")
                  : t("desktop:createChannel.voicePlaceholder")
              }
              aria-label={t("desktop:createChannel.nameLabel")}
            />

            {/* NSFW is a text-channel concept; hidden for voice. */}
            {kind === "text" && (
              <div className="mt-4">
                <NsfwToggle checked={nsfw} onChange={setNsfw} disabled={createChannel.isPending} />
              </div>
            )}

            {hasRoles && (
              <div className="mt-5 space-y-3 border-t border-stroke pt-4">
                <div>
                  <p className="text-sm font-semibold text-fg">
                    {t("desktop:createChannel.visibilityTitle")}
                  </p>
                  <p className="mt-0.5 text-2xs text-fg-faint">
                    {t("desktop:visibility.note")}
                  </p>
                </div>

                <div
                  role="radiogroup"
                  aria-label={t("desktop:createChannel.visibilityTitle")}
                  className="space-y-1.5"
                >
                  {(["public", "restricted"] as Visibility[]).map((value) => {
                    const on = visibility === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setVisibility(value)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
                          on
                            ? "border-accent/50 bg-accent/[0.06]"
                            : "border-stroke bg-raised/40 hover:bg-raised",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                            on ? "border-accent" : "border-stroke-strong",
                          )}
                        >
                          {on && <span className="size-2 rounded-full bg-accent" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-fg">
                            {value === "public"
                              ? t("desktop:visibility.everyone")
                              : t("desktop:visibility.selectedRoles")}
                          </span>
                          <span className="block text-2xs text-fg-faint">
                            {value === "public"
                              ? t("desktop:visibility.everyoneDesc")
                              : t("desktop:visibility.selectedRolesDesc")}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {visibility === "restricted" && (
                  <div className="space-y-px rounded-md border border-stroke p-1">
                    {roles?.map((role) => {
                      const on = selectedRoles.has(role.id);
                      return (
                        <button
                          key={role.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => toggleRole(role.id)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-white/[0.04]"
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded border",
                              on ? "border-accent bg-accent text-on-accent" : "border-stroke-strong",
                            )}
                          >
                            {on && <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: role.color ?? "#95a5a6" }}
                          />
                          <span className="min-w-0 truncate">{role.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <Button type="submit" disabled={createChannel.isPending} className="mt-4 w-full">
              {createChannel.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:sidebar.createChannel")}
            </Button>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
