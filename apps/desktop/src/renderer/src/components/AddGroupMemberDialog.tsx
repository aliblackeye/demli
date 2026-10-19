import { useEffect, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import { blockedErrorKey, errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useAddGroupChatMember } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";

type FormError = CommonErrorKey | "desktop:addMember.usernameRequired";

/** Owner-only: add someone to the active flat group chat by username. */
export function AddGroupMemberDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.addGroupMemberDialogOpen);
  const setOpen = useUiStore((s) => s.setAddGroupMemberDialogOpen);
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);

  const [username, setUsername] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [touched, setTouched] = useState(false);

  const addMember = useAddGroupChatMember(activeGroupChatId);
  const busy = addMember.isPending;

  useEffect(() => {
    if (!open) {
      setUsername("");
      setError(null);
      setTouched(false);
    }
  }, [open]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = username.trim().replace(/^@/, "");
    if (trimmed.length === 0) {
      setTouched(true);
      setError("desktop:addMember.usernameRequired");
      return;
    }
    setError(null);
    addMember.mutate(
      { username: trimmed },
      {
        onSuccess: () => setOpen(false),
        // A block between the adder (or ANY existing member) and the target
        // refuses this with BLOCKED. The copy stays neutral — it never says which
        // pair is blocked, let alone in which direction (§28, ADR 0017).
        onError: (err) => setError(blockedErrorKey(err, "addMember") ?? errorKey(err)),
      },
    );
  };

  const usernameError =
    error === "desktop:addMember.usernameRequired" ||
    (touched && username.trim().replace(/^@/, "").length === 0)
      ? t("desktop:addMember.usernameRequired")
      : undefined;
  const formError = error !== null && error !== "desktop:addMember.usernameRequired" ? t(error) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>{t("desktop:addMember.title")}</DialogTitle>
          <DialogDescription>{t("desktop:addMember.description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {formError && <FormErrorAlert>{formError}</FormErrorAlert>}
            <Field label={t("desktop:addMember.usernameLabel")} error={usernameError}>
              <Input
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (error !== null) setError(null);
                }}
                onBlur={() => setTouched(true)}
                maxLength={USERNAME_MAX_LENGTH + 1}
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder={t("desktop:addMember.placeholder")}
                className="font-mono"
              />
            </Field>
          </DialogBody>
          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t("buttons.cancel")}
            </Button>
            <Button type="submit" variant="accent" loading={busy}>
              {t("desktop:addMember.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
