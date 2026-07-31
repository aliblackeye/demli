import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Shield, Trash2 } from "lucide-react";
import { Button, Input, cn } from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { PERMISSIONS, type GroupId, type Role, type RoleId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import {
  useCreateRole,
  useDeleteRole,
  useRoles,
  useUpdateRole,
} from "../../queries/chat-queries";
import { PERMISSION_ROWS, ROLE_COLORS } from "./shared";

const ROLE_NAME_MAX = 32;

/** A single check-box style permission toggle row. */
function PermissionToggle({
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        "hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
          checked ? "border-accent bg-accent text-on-accent" : "border-stroke-strong bg-raised",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{label}</span>
        <span className="block text-2xs leading-snug text-fg-faint">{description}</span>
      </span>
    </button>
  );
}

/** Editor panel for the selected role. */
function RoleEditor({
  groupId,
  role,
  canManage,
  onDeleted,
}: {
  groupId: GroupId;
  role: Role;
  canManage: boolean;
  onDeleted: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(role.color);
  const [bits, setBits] = useState(role.permissions);
  const [error, setError] = useState<CommonErrorKey | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const updateRole = useUpdateRole(groupId);
  const deleteRole = useDeleteRole(groupId);
  const busy = updateRole.isPending || deleteRole.isPending;

  // Reseed the editor whenever a different role is selected.
  useEffect(() => {
    setName(role.name);
    setColor(role.color);
    setBits(role.permissions);
    setError(null);
    setConfirmingDelete(false);
    // Reseed only when a different role is selected, not on every refetch.
  }, [role.id]);

  const trimmed = name.trim();
  const dirty =
    trimmed !== role.name || color !== role.color || bits !== role.permissions;

  const onSave = (): void => {
    if (busy || !canManage || trimmed.length === 0) return;
    setError(null);
    updateRole.mutate(
      { roleId: role.id, name: trimmed, color, permissions: bits },
      { onError: (err) => setError(errorKey(err)) },
    );
  };

  const onDelete = (): void => {
    if (busy) return;
    setError(null);
    deleteRole.mutate(role.id, {
      onSuccess: () => onDeleted(),
      onError: (err) => setError(errorKey(err)),
    });
  };

  return (
    <div className="space-y-4">
      {error && (
        <FormErrorAlert>{t(error)}</FormErrorAlert>
      )}

      <div className="space-y-1.5">
        <label htmlFor="role-name" className="block text-xs font-semibold text-fg-muted">
          {t("desktop:serverSettings.roleName")}
        </label>
        <Input
          id="role-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={ROLE_NAME_MAX}
          disabled={!canManage}
          spellCheck={false}
          placeholder={t("desktop:serverSettings.rolePlaceholder")}
          aria-label={t("desktop:serverSettings.roleName")}
        />
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-semibold text-fg-muted">
          {t("desktop:serverSettings.color")}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label={t("desktop:serverSettings.noColor")}
            aria-pressed={color === null}
            disabled={!canManage}
            onClick={() => setColor(null)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full border text-[9px] font-semibold",
              "text-fg-faint transition-transform hover:scale-110 disabled:pointer-events-none disabled:opacity-50",
              color === null ? "border-accent ring-2 ring-accent/40" : "border-stroke-strong",
            )}
          >
            ✕
          </button>
          {ROLE_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={t("desktop:serverSettings.colorSwatch", { color: swatch })}
              aria-pressed={color === swatch}
              disabled={!canManage}
              onClick={() => setColor(swatch)}
              style={{ backgroundColor: swatch }}
              className={cn(
                "size-6 rounded-full transition-transform hover:scale-110",
                "disabled:pointer-events-none disabled:opacity-50",
                color === swatch
                  ? "ring-2 ring-offset-2 ring-offset-overlay ring-white/80"
                  : "ring-0",
              )}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <span className="block text-xs font-semibold text-fg-muted">
          {t("desktop:serverSettings.permissions")}
        </span>
        <div className="-mx-2">
          {PERMISSION_ROWS.map((row) => {
            const bit = PERMISSIONS[row.bit];
            return (
              <PermissionToggle
                key={row.bit}
                label={t(row.labelKey)}
                description={t(row.descriptionKey)}
                checked={(bits & bit) === bit}
                disabled={!canManage}
                onToggle={() => setBits((prev) => prev ^ bit)}
              />
            );
          })}
        </div>
      </div>

      {canManage && (
        <div className="flex items-center gap-2 border-t border-stroke pt-3">
          <Button size="sm" disabled={busy || !dirty || trimmed.length === 0} onClick={onSave}>
            {updateRole.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {t("desktop:serverSettings.saveRole")}
          </Button>
          {confirmingDelete ? (
            <>
              <span className="ml-auto text-2xs text-fg-muted">
                {t("desktop:serverSettings.deleteRoleConfirm")}
              </span>
              <Button variant="danger" size="sm" disabled={busy} onClick={onDelete}>
                {deleteRole.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {t("buttons.delete")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                {t("buttons.cancel")}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              className="ml-auto text-danger hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="size-3.5" />
              {t("buttons.delete")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Roles tab: role list (create/select) + the editor for the selected role. */
export function RolesTab({
  groupId,
  canManage,
}: {
  groupId: GroupId;
  canManage: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data: roles, isPending } = useRoles(groupId);
  const [selectedId, setSelectedId] = useState<RoleId | null>(null);
  const [createError, setCreateError] = useState<CommonErrorKey | null>(null);
  const createRole = useCreateRole(groupId);

  // Keep a valid selection as the list changes (create/delete/refetch).
  useEffect(() => {
    if (!roles) return;
    if (selectedId && roles.some((r) => r.id === selectedId)) return;
    setSelectedId(roles[0]?.id ?? null);
  }, [roles, selectedId]);

  const onCreate = (): void => {
    if (createRole.isPending) return;
    setCreateError(null);
    createRole.mutate(
      { name: t("desktop:serverSettings.newRoleName") },
      {
        onSuccess: ({ role }) => setSelectedId(role.id),
        onError: (err) => setCreateError(errorKey(err)),
      },
    );
  };

  const selected = roles?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex min-h-[20rem] gap-4">
      {/* Role list */}
      <div className="flex w-44 shrink-0 flex-col">
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onCreate}
            disabled={createRole.isPending}
            className="mb-2 w-full justify-start"
          >
            {createRole.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {t("desktop:serverSettings.newRole")}
          </Button>
        )}
        {createError && <p className="mb-2 text-2xs text-danger">{t(createError)}</p>}

        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto">
          {isPending && (
            <li className="px-2 py-1.5 text-xs text-fg-faint">
              {t("desktop:serverSettings.loading")}
            </li>
          )}
          {roles?.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-fg-faint">
              {t("desktop:serverSettings.noRoles")}
            </li>
          )}
          {roles?.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                aria-current={role.id === selectedId ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                  role.id === selectedId
                    ? "bg-white/[0.06] text-fg"
                    : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
                )}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: role.color ?? "#95a5a6" }}
                />
                <span className="min-w-0 truncate font-medium">{role.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Editor */}
      <div className="min-w-0 flex-1 border-l border-stroke pl-4">
        {selected ? (
          <RoleEditor
            key={selected.id}
            groupId={groupId}
            role={selected}
            canManage={canManage}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Shield className="size-8 text-fg-faint" />
            <p className="text-sm text-fg-muted">
              {canManage
                ? t("desktop:serverSettings.rolesEmptyManage")
                : t("desktop:serverSettings.rolesEmpty")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
