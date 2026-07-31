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

  const addMember = useAddGroupChatMember(activeGroupChatId);
  const busy = addMember.isPending;

  useEffect(() => {
    if (!open) {
      setUsername("");
      setError(null);
    }
  }, [open]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = username.trim().replace(/^@/, "");
    if (trimmed.length === 0) {
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:addMember.title")}</DialogTitle>
          <DialogDescription>{t("desktop:addMember.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form onSubmit={onSubmit}>
            {error && <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>}

            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={USERNAME_MAX_LENGTH + 1}
              autoFocus
              spellCheck={false}
              placeholder={t("desktop:addMember.placeholder")}
              aria-label={t("desktop:addMember.usernameLabel")}
              className="font-mono"
            />

            <Button type="submit" disabled={busy} className="mt-4 w-full">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:addMember.submit")}
            </Button>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
