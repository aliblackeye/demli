import { useEffect, useState, type FormEvent } from "react";
import { m } from "framer-motion";
import { Hash, Volume2 } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioCard,
  RadioGroup,
  RadioItem,
} from "@demli/ui";
import { FormErrorAlert, springs } from "@demli/app-ui";
import { CHANNEL_NAME_MAX_LENGTH } from "@demli/config";
import type { ChannelKind, RoleId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useCategories, useCreateChannel, useGroups, useRoles } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { NsfwToggle } from "./NsfwToggle";
import { HelpWithCount } from "./settings-kit";
import { ROLE_COLOR_FALLBACK } from "./server-settings/shared";

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
  const [touched, setTouched] = useState(false);

  const createChannel = useCreateChannel(activeGroupId);

  useEffect(() => {
    if (!open) {
      setName("");
      setKind("text");
      setVisibility("public");
      setSelectedRoles(new Set());
      setNsfw(false);
      setError(null);
      setTouched(false);
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
      setTouched(true);
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

  const nameError =
    error === "desktop:createChannel.nameRequired" || (touched && name.trim().length === 0)
      ? t("desktop:createChannel.nameRequired")
      : undefined;
  const formError = error !== null && error !== "desktop:createChannel.nameRequired" ? t(error) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t("buttons.close")}>
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

        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-5">
            {formError && <FormErrorAlert>{formError}</FormErrorAlert>}

            <div className="space-y-2">
              <p id="create-channel-type" className="text-label font-medium text-fg-muted">
                {t("desktop:createChannel.typeLabel")}
              </p>
              <RadioGroup
                value={kind}
                onValueChange={(next) => setKind(next as ChannelKind)}
                aria-labelledby="create-channel-type"
                className="grid grid-cols-2 gap-2"
              >
                <RadioCard
                  value="text"
                  align="start"
                  icon={<Hash />}
                  label={t("desktop:createChannel.textLabel")}
                  detail={t("desktop:createChannel.textHint")}
                />
                <RadioCard
                  value="voice"
                  align="start"
                  icon={<Volume2 />}
                  label={t("desktop:createChannel.voiceLabel")}
                  detail={t("desktop:createChannel.voiceHint")}
                />
              </RadioGroup>
            </div>

            <Field
              label={t("desktop:createChannel.nameLabel")}
              error={nameError}
              help={<HelpWithCount value={name} max={CHANNEL_NAME_MAX_LENGTH} />}
            >
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error === "desktop:createChannel.nameRequired") setError(null);
                }}
                onBlur={() => setTouched(true)}
                maxLength={CHANNEL_NAME_MAX_LENGTH}
                autoFocus
                spellCheck={false}
                placeholder={
                  kind === "text"
                    ? t("desktop:createChannel.textPlaceholder")
                    : t("desktop:createChannel.voicePlaceholder")
                }
              />
            </Field>

            {/* NSFW is a text-channel concept; hidden for voice. */}
            {kind === "text" && (
              <NsfwToggle checked={nsfw} onChange={setNsfw} disabled={createChannel.isPending} />
            )}

            {hasRoles && (
              <section aria-labelledby="create-channel-visibility" className="space-y-3">
                <header className="space-y-1">
                  <p id="create-channel-visibility" className="text-sm font-semibold text-fg">
                    {t("desktop:createChannel.visibilityTitle")}
                  </p>
                  <p className="text-label text-fg-faint">{t("desktop:visibility.note")}</p>
                </header>

                <RadioGroup
                  value={visibility}
                  onValueChange={(next) => setVisibility(next as Visibility)}
                  aria-labelledby="create-channel-visibility"
                  className="rounded-xl bg-surface p-1"
                >
                  <RadioItem
                    value="public"
                    label={t("desktop:visibility.everyone")}
                    description={t("desktop:visibility.everyoneDesc")}
                  />
                  <RadioItem
                    value="restricted"
                    label={t("desktop:visibility.selectedRoles")}
                    description={t("desktop:visibility.selectedRolesDesc")}
                  />
                </RadioGroup>

                {visibility === "restricted" && (
                  <m.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0, transition: springs.position }}
                    className="space-y-2.5 rounded-xl bg-surface px-4 py-3"
                  >
                    {roles?.map((role) => (
                      <Checkbox
                        key={role.id}
                        checked={selectedRoles.has(role.id)}
                        onCheckedChange={() => toggleRole(role.id)}
                        label={
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: role.color ?? ROLE_COLOR_FALLBACK }}
                            />
                            {role.name}
                          </span>
                        }
                        className="flex"
                      />
                    ))}
                  </m.div>
                )}
              </section>
            )}
          </DialogBody>

          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={createChannel.isPending}>
              {t("buttons.cancel")}
            </Button>
            <Button type="submit" variant="accent" loading={createChannel.isPending}>
              {t("desktop:sidebar.createChannel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
