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
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useCreateGroupChat } from "../queries/chat-queries";
import { useUiStore } from "../stores/ui-store";
import { HelpWithCount } from "./settings-kit";

type FormError = CommonErrorKey | "desktop:createGroupChat.nameRequired";

/**
 * Create a flat group chat (ADR 0005) — just a name. On success the mutation
 * opens the new chat and re-handshakes realtime; here we only close the dialog.
 */
export function CreateGroupChatDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.createGroupChatDialogOpen);
  const setOpen = useUiStore((s) => s.setCreateGroupChatDialogOpen);

  const [name, setName] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [touched, setTouched] = useState(false);

  const createGroupChat = useCreateGroupChat();
  const busy = createGroupChat.isPending;

  useEffect(() => {
    if (!open) {
      setName("");
      setError(null);
      setTouched(false);
    }
  }, [open]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setTouched(true);
      setError("desktop:createGroupChat.nameRequired");
      return;
    }
    setError(null);
    createGroupChat.mutate(
      { name: trimmed },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => setError(errorKey(err)),
      },
    );
  };

  const nameError =
    error === "desktop:createGroupChat.nameRequired" || (touched && name.trim().length === 0)
      ? t("desktop:createGroupChat.nameRequired")
      : undefined;
  const formError = error !== null && error !== "desktop:createGroupChat.nameRequired" ? t(error) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>{t("desktop:createGroupChat.title")}</DialogTitle>
          <DialogDescription>{t("desktop:createGroupChat.description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {formError && <FormErrorAlert>{formError}</FormErrorAlert>}
            <Field
              label={t("desktop:createGroupChat.nameLabel")}
              error={nameError}
              help={<HelpWithCount value={name} max={GROUP_NAME_MAX_LENGTH} />}
            >
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error === "desktop:createGroupChat.nameRequired") setError(null);
                }}
                onBlur={() => setTouched(true)}
                maxLength={GROUP_NAME_MAX_LENGTH}
                autoFocus
                placeholder={t("desktop:createGroupChat.namePlaceholder")}
              />
            </Field>
          </DialogBody>
          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t("buttons.cancel")}
            </Button>
            <Button type="submit" variant="accent" loading={busy}>
              {t("desktop:createGroupChat.submitCreate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
