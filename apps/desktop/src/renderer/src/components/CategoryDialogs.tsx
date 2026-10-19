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
import { CATEGORY_NAME_MAX_LENGTH, FormErrorAlert } from "@demli/app-ui";
import { Trans } from "@demli/i18n";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import {
  useCreateCategory,
  useDeleteCategory,
  useRenameCategory,
} from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { ConfirmDialog, HelpWithCount } from "./settings-kit";

type FormError = CommonErrorKey | "desktop:category.nameRequired";

/**
 * The three channel-category dialogs (M18), driven by the single
 * `ui-store.categoryDialog` slot: create, rename and the delete confirmation.
 *
 * They share one file because they share one state slot and one mutation family;
 * splitting them would mean three modules each holding a third of the same form.
 * Mounted once from the AppShell overlay stack, like every other server dialog.
 *
 * The delete confirmation is the important one: category deletion is `ON DELETE
 * SET NULL` server-side, so the channels SURVIVE and fall back to the
 * uncategorized list. The copy says exactly that — a "this cannot be undone"
 * boilerplate warning here would be a lie about what the button does.
 */
export function CategoryDialogs(): JSX.Element {
  const { t } = useAppTranslation();
  const dialog = useUiStore((s) => s.categoryDialog);
  const setDialog = useUiStore((s) => s.setCategoryDialog);
  const activeGroupId = useChatStore((s) => s.activeGroupId);

  const createCategory = useCreateCategory(activeGroupId);
  const renameCategory = useRenameCategory(activeGroupId);
  const deleteCategory = useDeleteCategory(activeGroupId);

  const [name, setName] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [touched, setTouched] = useState(false);

  // Destructured so the effect below depends on STABLE reset identities rather
  // than the whole mutation objects (which change on every state transition and
  // would re-run the seeding mid-edit).
  const { reset: resetCreate } = createCategory;
  const { reset: resetRename } = renameCategory;
  const { reset: resetDelete } = deleteCategory;

  // Seed the field from whichever dialog opened, and clear the error/mutation
  // state on close so reopening never shows the previous attempt's failure.
  useEffect(() => {
    setTouched(false);
    if (!dialog) {
      setName("");
      setError(null);
      resetCreate();
      resetRename();
      resetDelete();
      return;
    }
    setName(dialog.mode === "rename" ? dialog.name : "");
    setError(null);
  }, [dialog, resetCreate, resetRename, resetDelete]);

  const close = (): void => setDialog(null);
  const busy =
    createCategory.isPending || renameCategory.isPending || deleteCategory.isPending;

  const onSubmitName = (event: FormEvent): void => {
    event.preventDefault();
    if (!dialog || busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setTouched(true);
      setError("desktop:category.nameRequired");
      return;
    }
    setError(null);

    if (dialog.mode === "create") {
      createCategory.mutate(
        { name: trimmed },
        { onSuccess: close, onError: (err) => setError(errorKey(err)) },
      );
      return;
    }
    if (dialog.mode === "rename") {
      renameCategory.mutate(
        { categoryId: dialog.categoryId, name: trimmed },
        { onSuccess: close, onError: (err) => setError(errorKey(err)) },
      );
    }
  };

  const onDelete = (): void => {
    if (dialog?.mode !== "delete" || busy) return;
    deleteCategory.mutate(dialog.categoryId, {
      onSuccess: close,
      onError: (err) => setError(errorKey(err)),
    });
  };

  const isNameForm = dialog?.mode === "create" || dialog?.mode === "rename";
  const nameError =
    error === "desktop:category.nameRequired" || (touched && name.trim().length === 0)
      ? t("desktop:category.nameRequired")
      : undefined;
  const formError = error !== null && error !== "desktop:category.nameRequired" ? t(error) : null;
  // Renaming to the same name is not a change worth a request.
  const unchanged = dialog?.mode === "rename" && name.trim() === dialog.name;

  return (
    <>
      <Dialog open={isNameForm} onOpenChange={(next) => !next && close()}>
        <DialogContent closeLabel={t("buttons.close")}>
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "rename" ? t("desktop:category.renameTitle") : t("desktop:category.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === "rename" ? dialog.name : t("desktop:category.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmitName} noValidate className="flex min-h-0 flex-1 flex-col">
            <DialogBody className="space-y-4">
              {formError && <FormErrorAlert>{formError}</FormErrorAlert>}
              <Field
                label={t("desktop:category.nameLabel")}
                error={nameError}
                help={<HelpWithCount value={name} max={CATEGORY_NAME_MAX_LENGTH} />}
              >
                <Input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (error === "desktop:category.nameRequired") setError(null);
                  }}
                  onBlur={() => setTouched(true)}
                  maxLength={CATEGORY_NAME_MAX_LENGTH}
                  autoFocus
                  spellCheck={false}
                  placeholder={t("desktop:category.namePlaceholder")}
                />
              </Field>
            </DialogBody>
            <DialogFooter className="pt-4">
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                {t("buttons.cancel")}
              </Button>
              <Button type="submit" variant="accent" loading={busy} disabled={unchanged}>
                {dialog?.mode === "rename" ? t("desktop:category.rename") : t("desktop:category.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={dialog?.mode === "delete"}
        onOpenChange={(next) => !next && close()}
        title={t("desktop:category.deleteTitle", { name: dialog?.mode === "delete" ? dialog.name : "" })}
        confirmLabel={t("desktop:category.deleteConfirm")}
        cancelLabel={t("buttons.cancel")}
        closeLabel={t("buttons.close")}
        onConfirm={onDelete}
        pending={deleteCategory.isPending}
        error={error ? <FormErrorAlert>{t(error)}</FormErrorAlert> : undefined}
      >
        <p className="text-sm leading-relaxed text-fg-muted">
          <Trans
            t={t}
            i18nKey="desktop:category.deleteBody"
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        </p>
      </ConfirmDialog>
    </>
  );
}
