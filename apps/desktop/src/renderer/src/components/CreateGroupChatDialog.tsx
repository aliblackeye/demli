import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useCreateGroupChat } from "../queries/chat-queries";
import { useUiStore } from "../stores/ui-store";

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

  const createGroupChat = useCreateGroupChat();
  const busy = createGroupChat.isPending;

  useEffect(() => {
    if (!open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:createGroupChat.title")}</DialogTitle>
          <DialogDescription>{t("desktop:createGroupChat.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form onSubmit={onSubmit}>
            {error && <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>}

            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={GROUP_NAME_MAX_LENGTH}
              autoFocus
              placeholder={t("desktop:createGroupChat.namePlaceholder")}
              aria-label={t("desktop:createGroupChat.nameLabel")}
            />

            <Button type="submit" disabled={busy} className="mt-4 w-full">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:createGroupChat.submitCreate")}
            </Button>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
