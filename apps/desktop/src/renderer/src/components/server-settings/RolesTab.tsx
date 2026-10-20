import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Pipette, Plus, Shield, ShieldCheck } from "lucide-react";
import { Button, Field, Input, Skeleton, cn } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { PERMISSIONS, type GroupId, type Role, type RoleId } from "@demli/types";
import { errorKey, localizeError, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import {
  useCreateRole,
  useDeleteRole,
  useGroupDetails,
  useRoles,
  useUpdateRole,
} from "../../queries/chat-queries";
import {
  ChangedElsewhereNotice,
  DangerZone,
  HelpWithCount,
  InlineError,
  SettingRow,
  SettingsGroup,
  UnsavedChangesBar,
} from "../settings-kit";
import { Toggle } from "../Toggle";
import {
  HEX_COLOR,
  PERMISSION_ROWS,
  ROLE_COLORS,
  ROLE_COLOR_FALLBACK,
  useReportDirty,
  type DraftGuard,
} from "./shared";

const ROLE_NAME_MAX = 32;

/**
 * Role colour picker: "no colour", the curated swatches, and a custom colour
 * (native colour well + a hex field validated live). One radiogroup, so the
 * whole picker is a single tab stop with arrow-key selection.
 */
function RoleColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const labelId = useId();
  const nativeRef = useRef<HTMLInputElement>(null);
  const isCustom = value !== null && !ROLE_COLORS.some((c) => c.toLowerCase() === value.toLowerCase());
  const [hexDraft, setHexDraft] = useState(value ?? "");
  useEffect(() => setHexDraft(value ?? ""), [value]);
  const hexInvalid = hexDraft.length > 0 && !HEX_COLOR.test(hexDraft);

  const options: (string | null)[] = [null, ...ROLE_COLORS];
  const selectedIndex = Math.max(
    0,
    options.findIndex((c) => (c ?? "").toLowerCase() === (value ?? "").toLowerCase()),
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next] ?? null);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className="space-y-3">
      <p id={labelId} className="text-label font-medium text-fg-muted">
        {t("desktop:settingsUi.colorLabel")}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
        {options.map((swatch, index) => {
          const selected = !isCustom && (swatch ?? "") === (value ?? "") && (swatch === null) === (value === null);
          return (
            <button
              key={swatch ?? "none"}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={swatch ? t("desktop:serverSettings.colorSwatch", { color: swatch }) : t("desktop:serverSettings.noColor")}
              tabIndex={(isCustom ? 0 : selectedIndex) === index ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(swatch)}
              onKeyDown={(event) => onKeyDown(event, index)}
              style={swatch ? { backgroundColor: swatch } : undefined}
              className={cn(
                "relative flex size-7 cursor-pointer items-center justify-center rounded-full",
                "transition-shadow motion-hover disabled:pointer-events-none disabled:opacity-40",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
                swatch === null && "bg-raised text-fg-faint",
                selected
                  ? "shadow-[0_0_0_2px_var(--color-app),0_0_0_4px_var(--color-fg-display)]"
                  : "hover:shadow-[0_0_0_2px_var(--color-app),0_0_0_4px_var(--color-stroke-strong)]",
              )}
            >
              {swatch === null ? (
                <span aria-hidden className="h-0.5 w-4 rotate-45 rounded-full bg-fg-faint" />
              ) : (
                selected && <Check aria-hidden className="size-3.5 text-fg-display drop-shadow" strokeWidth={3} />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-start gap-2">
        <button
          type="button"
          disabled={disabled}
          aria-label={t("desktop:settingsUi.customColor")}
          aria-pressed={isCustom}
          onClick={() => nativeRef.current?.click()}
          style={isCustom && value ? { backgroundColor: value } : undefined}
          className={cn(
            "relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg",
            "transition-[box-shadow,background-color] motion-hover disabled:pointer-events-none disabled:opacity-40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
            isCustom
              ? "shadow-[0_0_0_2px_var(--color-app),0_0_0_4px_var(--color-fg-display)]"
              : "bg-surface text-fg-muted hover:bg-raised",
          )}
        >
          <Pipette aria-hidden className={cn("size-4", isCustom && "text-fg-display drop-shadow")} />
          <input
            ref={nativeRef}
            type="color"
            tabIndex={-1}
            aria-hidden
            value={value && HEX_COLOR.test(value) ? value : ROLE_COLOR_FALLBACK}
            onChange={(event) => onChange(event.target.value)}
            className="pointer-events-none absolute inset-0 size-full opacity-0"
          />
        </button>
        <Field
          label={t("desktop:settingsUi.customColor")}
          hideLabel
          error={hexInvalid ? t("validation.pattern.hexColor") : undefined}
          className="w-36"
        >
          <Input
            value={hexDraft}
            disabled={disabled}
            spellCheck={false}
            maxLength={7}
            placeholder="#ff8464"
            onChange={(event) => {
              const raw = event.target.value.trim();
              const next = raw.length > 0 && !raw.startsWith("#") ? `#${raw}` : raw;
              setHexDraft(next);
              if (HEX_COLOR.test(next)) onChange(next.toLowerCase());
              if (next.length === 0) onChange(null);
            }}
            className="font-mono text-label"
          />
        </Field>
      </div>
    </div>
  );
}

/** The editable fields of a role, as the draft and the server see them. */
type RoleSnapshot = { name: string; color: string | null; permissions: number };

const snapshotOf = (role: Role): RoleSnapshot => ({
  name: role.name,
  color: role.color,
  permissions: role.permissions,
});

const sameRole = (a: RoleSnapshot, b: RoleSnapshot): boolean =>
  a.name === b.name &&
  (a.color ?? "").toLowerCase() === (b.color ?? "").toLowerCase() &&
  a.permissions === b.permissions;

/** Editor panel for the selected role. */
function RoleEditor({
  groupId,
  role,
  canManage,
  memberCount,
  onDeleted,
  guard,
  onDirtyChange,
}: {
  groupId: GroupId;
  role: Role;
  canManage: boolean;
  memberCount: number;
  onDeleted: () => void;
  guard?: DraftGuard;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  // `baseline` is the server value the draft was seeded from. The draft is
  // compared against IT, never against the live prop: a refetch carrying
  // someone else's edit must not make an untouched editor look dirty (which
  // would lock the dialog and invite saving stale values over theirs).
  const [baseline, setBaseline] = useState<RoleSnapshot>(() => snapshotOf(role));
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(role.color);
  const [bits, setBits] = useState(role.permissions);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [error, setError] = useState<CommonErrorKey | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const updateRole = useUpdateRole(groupId);
  const deleteRole = useDeleteRole(groupId);
  const busy = updateRole.isPending || deleteRole.isPending;

  const trimmed = name.trim();
  const draft: RoleSnapshot = { name: trimmed, color, permissions: bits };
  const dirty = canManage && !sameRole(draft, baseline);
  const server = snapshotOf(role);

  /** Seed the draft (and its baseline) from a server value. */
  const adopt = (next: RoleSnapshot): void => {
    setBaseline(next);
    setName(next.name);
    setColor(next.color);
    setBits(next.permissions);
    setChangedElsewhere(false);
    setError(null);
  };

  // The server value moved (a refetch after someone else's edit). A clean
  // editor simply follows it; a dirty one keeps the user's draft and says the
  // role changed underneath it. While our own save is in flight its result is
  // adopted by onSave's onSuccess instead, so it is never mistaken for a
  // remote edit (and a server-normalized name never leaves a phantom draft).
  useEffect(() => {
    if (updateRole.isPending || sameRole(server, baseline)) return;
    if (!dirty || sameRole(server, draft)) adopt(server);
    else setChangedElsewhere(true);
    // Keyed on the server fields; draft/baseline are read at that moment.
  }, [server.name, server.color, server.permissions, updateRole.isPending]);

  useReportDirty(guard, dirty);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const onSave = (): void => {
    if (busy || !canManage || trimmed.length === 0) return;
    setError(null);
    updateRole.mutate(
      { roleId: role.id, name: trimmed, color, permissions: bits },
      {
        onSuccess: ({ role: saved }) => adopt(snapshotOf(saved)),
        onError: (err) => setError(errorKey(err)),
      },
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

  const previewColor = color ?? undefined;

  return (
    <div className="space-y-6">
      {error && <FormErrorAlert>{t(error)}</FormErrorAlert>}
      {changedElsewhere && (
        <ChangedElsewhereNotice
          message={t("desktop:settingsUi.changedElsewhereRole")}
          actionLabel={t("desktop:settingsUi.changedElsewhereLoad")}
          onAction={() => adopt(server)}
        />
      )}

      {/* Live preview: exactly how a member with this role reads in a list. */}
      <div className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3">
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-full bg-raised text-label font-semibold text-fg-muted"
        >
          {(trimmed || role.name).charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" style={{ color: previewColor }}>
            {trimmed || role.name}
          </p>
          <p className="text-label text-fg-faint">{t("desktop:settingsUi.rolePreview")}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-white/12 px-2.5 py-1 text-xs font-medium text-fg">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color ?? ROLE_COLOR_FALLBACK }} />
          {trimmed || role.name}
        </span>
      </div>

      <Field
        label={t("desktop:serverSettings.roleName")}
        error={trimmed.length === 0 ? t("desktop:settingsUi.roleNameRequired") : undefined}
        help={<HelpWithCount value={name} max={ROLE_NAME_MAX} />}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={ROLE_NAME_MAX}
          disabled={!canManage}
          spellCheck={false}
          placeholder={t("desktop:serverSettings.rolePlaceholder")}
        />
      </Field>

      <RoleColorPicker value={color} onChange={setColor} disabled={!canManage} />

      <SettingsGroup title={t("desktop:serverSettings.permissions")}>
        {PERMISSION_ROWS.map((row) => {
          const bit = PERMISSIONS[row.bit];
          return (
            <SettingRow key={row.bit} title={t(row.labelKey)} description={t(row.descriptionKey)}>
              <Toggle
                checked={(bits & bit) === bit}
                disabled={!canManage}
                onChange={() => setBits((prev) => prev ^ bit)}
                label={t(row.labelKey)}
              />
            </SettingRow>
          );
        })}
      </SettingsGroup>

      {canManage && (
        <DangerZone
          title={t("desktop:settingsUi.roleDeleteTitle")}
          body={t("desktop:settingsUi.roleDeleteBody", { count: memberCount })}
          actionLabel={t("desktop:settingsUi.roleDeleteTitle")}
          confirmLabel={t("desktop:channelSettings.confirmDelete")}
          cancelLabel={t("buttons.cancel")}
          onConfirm={onDelete}
          pending={deleteRole.isPending}
          disabled={updateRole.isPending}
          confirming={confirmingDelete}
          onConfirmingChange={setConfirmingDelete}
        />
      )}

      <UnsavedChangesBar
        open={dirty}
        saving={updateRole.isPending}
        nudge={guard?.nudge ?? 0}
        message={t("desktop:settingsUi.unsavedMessage")}
        nudgeMessage={t("desktop:settingsUi.unsavedNudge")}
        resetLabel={t("desktop:settingsUi.unsavedReset")}
        saveLabel={t("desktop:serverSettings.saveRole")}
        onReset={() => adopt(server)}
        onSave={onSave}
        saveDisabled={trimmed.length === 0}
        className="sticky bottom-0 z-10 -mx-1 pb-1 pt-2"
      />
    </div>
  );
}

/** Roles tab: role list (create/select) + the editor for the selected role. */
export function RolesTab({
  groupId,
  canManage,
  guard,
}: {
  groupId: GroupId;
  canManage: boolean;
  guard?: DraftGuard;
}): JSX.Element {
  const { t } = useAppTranslation();
  const rolesQuery = useRoles(groupId);
  const { data: roles, isPending } = rolesQuery;
  const { data: details } = useGroupDetails(groupId);
  const [selectedId, setSelectedId] = useState<RoleId | null>(null);
  const [createError, setCreateError] = useState<CommonErrorKey | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [localNudge, setLocalNudge] = useState(0);
  const createRole = useCreateRole(groupId);

  // Keep a valid selection as the list changes (create/delete/refetch).
  useEffect(() => {
    if (!roles) return;
    if (selectedId && roles.some((r) => r.id === selectedId)) return;
    setSelectedId(roles[0]?.id ?? null);
  }, [roles, selectedId]);

  const memberCounts = useMemo(() => {
    const counts = new Map<RoleId, number>();
    for (const member of details?.members ?? []) {
      for (const id of member.roleIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [details]);

  /** Switching role over an unsaved edit is refused (and the bar nudged). */
  const select = (id: RoleId): void => {
    if (id === selectedId) return;
    if (editorDirty) {
      setLocalNudge((n) => n + 1);
      return;
    }
    setSelectedId(id);
  };

  const onCreate = (): void => {
    if (createRole.isPending) return;
    if (editorDirty) {
      setLocalNudge((n) => n + 1);
      return;
    }
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
  const editorGuard: DraftGuard | undefined = guard
    ? { onDirtyChange: guard.onDirtyChange, nudge: guard.nudge + localNudge }
    : undefined;

  // A failed load is said as a failure — never as "no roles yet, create one",
  // which would invite duplicates of roles that really exist.
  if (rolesQuery.isError && !roles) {
    return (
      <InlineError
        message={localizeError(rolesQuery.error, t)}
        retryLabel={t("buttons.retry")}
        onRetry={() => void rolesQuery.refetch()}
        retrying={rolesQuery.isFetching}
      />
    );
  }

  return (
    // Container query, not a viewport breakpoint: the tab lives in a dialog
    // whose width is what matters. Narrow (phone web) stacks the role list
    // above the editor as a wrapping row of role pills; wide is master/detail.
    <div className="@container">
      <div className="flex min-h-[22rem] flex-col gap-4 @xl:flex-row @xl:gap-5">
        {/* Role list */}
        <div className="flex min-w-0 flex-col gap-2 @xl:w-48 @xl:shrink-0">
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onCreate}
              loading={createRole.isPending}
              className="justify-start self-start @xl:w-full"
            >
              <Plus className="size-3.5" />
              {t("desktop:serverSettings.newRole")}
            </Button>
          )}
          {createError && <p className="text-label text-danger">{t(createError)}</p>}

          <ul
            aria-label={t("desktop:serverSettings.roles")}
            className="flex min-h-0 flex-wrap gap-1 @xl:block @xl:flex-1 @xl:space-y-0.5 @xl:overflow-y-auto"
          >
            {isPending &&
              [0, 1, 2].map((i) => (
                <li key={i} className="flex h-9 items-center gap-2 px-2.5" aria-hidden>
                  <Skeleton shape="circle" width={10} />
                  <Skeleton shape="line" height={12} className={i === 1 ? "w-16" : "w-24"} />
                </li>
              ))}
            {roles?.map((role) => {
              const active = role.id === selectedId;
              return (
                <li key={role.id} className="min-w-0 max-w-full">
                  <button
                    type="button"
                    onClick={() => select(role.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors motion-hover",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      active
                        ? "bg-accent-surface text-fg"
                        : // Narrow: a surface pill in a wrapping row (hover one
                          // step up); wide: a bare list row (hover = surface).
                          "bg-surface text-fg-muted hover:bg-raised hover:text-fg active:bg-raised-pressed @xl:bg-transparent @xl:hover:bg-hover @xl:active:bg-raised",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: role.color ?? ROLE_COLOR_FALLBACK }}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{role.name}</span>
                    <span className="shrink-0 text-2xs tabular-nums text-fg-faint">{memberCounts.get(role.id) ?? 0}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Editor */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <RoleEditor
              key={selected.id}
              groupId={groupId}
              role={selected}
              canManage={canManage}
              memberCount={memberCounts.get(selected.id) ?? 0}
              onDeleted={() => setSelectedId(null)}
              guard={editorGuard}
              onDirtyChange={setEditorDirty}
            />
          ) : roles && roles.length === 0 ? (
            <EmptyState
              icon={canManage ? <ShieldCheck className="size-6" /> : <Shield className="size-6" />}
              title={canManage ? t("desktop:serverSettings.rolesEmptyManage") : t("desktop:serverSettings.rolesEmpty")}
              action={
                canManage ? (
                  <Button size="sm" variant="accent" onClick={onCreate} loading={createRole.isPending}>
                    <Plus className="size-3.5" />
                    {t("desktop:serverSettings.newRole")}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
