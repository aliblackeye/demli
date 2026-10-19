import { useDeferredValue, useMemo, useState } from "react";
import { m } from "framer-motion";
import { ChevronDown, Crown, Search, UserMinus, Users } from "lucide-react";
import {
  Button,
  Chip,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
} from "@demli/ui";
import { EmptyState, FormErrorAlert, springs } from "@demli/app-ui";
import type { GroupId, Role, RoleId, UserId } from "@demli/types";
import type { GroupMemberWithUser } from "../../lib/api-client";
import { errorKey, localizeError, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import {
  useGroupDetails,
  useKickMember,
  useRoles,
  useSetMemberRoles,
} from "../../queries/chat-queries";
import { indexRoles, memberColor } from "../../lib/permissions";
import { useAuthStore } from "../../stores/auth-store";
import { SettingsLabel } from "../settings-kit";
import { ROLE_COLOR_FALLBACK } from "./shared";

/** Multi-select role assignment for one member. Keeps the menu open per toggle. */
function RoleAssignMenu({
  roles,
  assigned,
  disabled,
  pending,
  onToggle,
}: {
  roles: Role[];
  assigned: Set<RoleId>;
  disabled: boolean;
  pending: boolean;
  onToggle: (roleId: RoleId, next: boolean) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled} loading={pending}>
          {t("desktop:serverSettings.roles")}
          <ChevronDown className="size-3.5 text-fg-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {roles.length === 0 ? (
          <p className="px-2 py-1.5 text-label text-fg-faint">{t("desktop:serverSettings.noRolesToAssign")}</p>
        ) : (
          roles.map((role) => {
            const on = assigned.has(role.id);
            return (
              <DropdownMenuCheckboxItem
                key={role.id}
                checked={on}
                // Keep the menu open: assigning several roles is one trip.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(next) => onToggle(role.id, next === true)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color ?? ROLE_COLOR_FALLBACK }}
                  />
                  <span className="min-w-0 truncate">{role.name}</span>
                </span>
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemberRow({
  member,
  ownerId,
  currentUserId,
  roles,
  rolesById,
  canManageRoles,
  canKick,
  assignPending,
  onAssign,
}: {
  member: GroupMemberWithUser;
  ownerId: UserId | undefined;
  currentUserId: UserId | undefined;
  roles: Role[];
  rolesById: Map<RoleId, Role>;
  canManageRoles: boolean;
  canKick: boolean;
  assignPending: boolean;
  onAssign: (userId: UserId, roleIds: RoleId[]) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [confirmKick, setConfirmKick] = useState(false);
  const kick = useKickMember(member.groupId);

  const isOwnerMember = member.userId === ownerId;
  const isSelf = member.userId === currentUserId;
  const isGuest = member.role === "guest";
  const assigned = new Set(member.roleIds ?? []);
  const color = memberColor(member.roleIds, rolesById);
  const memberRoles = (member.roleIds ?? [])
    .map((id) => rolesById.get(id))
    .filter((r): r is Role => r !== undefined);

  const toggleRole = (roleId: RoleId, next: boolean): void => {
    const nextSet = new Set(assigned);
    if (next) nextSet.add(roleId);
    else nextSet.delete(roleId);
    onAssign(member.userId, [...nextSet]);
  };

  return (
    <li className="rounded-lg px-3 py-2.5 transition-colors motion-hover content-visibility-row hover:bg-hover">
      <div className="flex items-center gap-3">
        <UserAvatar name={member.user.displayName} colorSeed={member.user.id} src={member.user.avatarUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-fg" style={{ color: color ?? undefined }}>
              {member.user.displayName}
            </span>
            {isOwnerMember && (
              <Crown aria-label={t("desktop:serverSettings.owner")} className="size-3.5 shrink-0 text-warning" />
            )}
            <span className="truncate text-label text-fg-faint">@{member.user.username}</span>
          </div>
          {memberRoles.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {memberRoles.map((role) => (
                <Chip key={role.id} variant="role" dotColor={role.color ?? ROLE_COLOR_FALLBACK} className="py-0.5 text-2xs">
                  {role.name}
                </Chip>
              ))}
            </div>
          )}
        </div>

        {canManageRoles &&
          (isGuest ? (
            // Guests can't hold roles — explain the disabled control rather than
            // leaving a dead, unexplained button (task #17).
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex" tabIndex={0}>
                  <Button variant="secondary" size="sm" disabled>
                    {t("desktop:serverSettings.roles")}
                    <ChevronDown className="size-3.5 text-fg-muted" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{t("desktop:serverSettings.guestNoRoles")}</TooltipContent>
            </Tooltip>
          ) : (
            <RoleAssignMenu
              roles={roles}
              assigned={assigned}
              disabled={assignPending}
              pending={assignPending}
              onToggle={toggleRole}
            />
          ))}

        {canKick && !isOwnerMember && !isSelf && !confirmKick && (
          <IconButton
            variant="ghost"
            size="sm"
            label={t("desktop:serverSettings.kickName", { name: member.user.displayName })}
            onClick={() => {
              kick.reset();
              setConfirmKick(true);
            }}
            className="hover:bg-danger-surface hover:text-danger"
          >
            <UserMinus />
          </IconButton>
        )}
      </div>

      {confirmKick && (
        <m.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: springs.position }}
          className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-danger-surface px-3 py-2 pl-11"
        >
          <p className="min-w-0 flex-1 text-label text-fg">
            {t("desktop:serverSettings.kickName", { name: member.user.displayName })}
          </p>
          <Button variant="ghost" size="sm" disabled={kick.isPending} onClick={() => setConfirmKick(false)}>
            {t("buttons.cancel")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={kick.isPending}
            onClick={() => kick.mutate(member.userId, { onSuccess: () => setConfirmKick(false) })}
          >
            {t("desktop:serverSettings.kick")}
          </Button>
          {/* A failed kick is said on the row it failed on (§26). */}
          {kick.isError && (
            <p role="alert" className="w-full text-label text-danger">
              {t("desktop:settingsUi.kickFailed", { name: member.user.displayName })}{" "}
              {localizeError(kick.error, t)}
            </p>
          )}
        </m.div>
      )}
    </li>
  );
}

/** Members tab: searchable member list with role chips, role assignment, and kick. */
export function MembersTab({
  groupId,
  canManageRoles,
  canKick,
}: {
  groupId: GroupId;
  canManageRoles: boolean;
  canKick: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data: details, isPending } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const setMemberRoles = useSetMemberRoles(groupId);
  const [error, setError] = useState<CommonErrorKey | null>(null);
  const [query, setQuery] = useState("");
  // Filtering 100+ rows on every keystroke stays smooth: the list renders the
  // deferred term while the field itself never waits.
  const deferredQuery = useDeferredValue(query);

  const ownerId = details?.group.ownerId;
  const rolesById = useMemo(() => indexRoles(roles), [roles]);
  const members = useMemo(
    () => [...(details?.members ?? [])].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName)),
    [details],
  );
  const filtered = useMemo(() => {
    const term = deferredQuery.trim().toLocaleLowerCase();
    if (term.length === 0) return members;
    return members.filter(
      (m) =>
        m.user.displayName.toLocaleLowerCase().includes(term) ||
        m.user.username.toLocaleLowerCase().includes(term),
    );
  }, [members, deferredQuery]);

  const onAssign = (userId: UserId, roleIds: RoleId[]): void => {
    setError(null);
    setMemberRoles.mutate({ userId, roleIds }, { onError: (err) => setError(errorKey(err)) });
  };

  return (
    <div className="space-y-3">
      {error && <FormErrorAlert>{t(error)}</FormErrorAlert>}
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("desktop:settingsUi.memberSearch")}
          aria-label={t("desktop:settingsUi.memberSearch")}
          className="pl-10"
        />
      </div>
      <SettingsLabel>
        {canManageRoles
          ? t("desktop:serverSettings.memberCountAssign", { count: members.length })
          : t("desktop:serverSettings.memberCount", { count: members.length })}
      </SettingsLabel>

      {isPending ? (
        <ul aria-hidden className="space-y-1">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton shape="circle" width={32} />
              <Skeleton shape="line" height={13} className={i % 2 ? "w-28" : "w-40"} />
            </li>
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title={t("desktop:settingsUi.memberNoMatch", { query: deferredQuery.trim() })}
          className="py-10"
        />
      ) : (
        <ul className="space-y-px">
          {filtered.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              ownerId={ownerId}
              currentUserId={currentUserId}
              roles={roles ?? []}
              rolesById={rolesById}
              canManageRoles={canManageRoles}
              canKick={canKick}
              assignPending={setMemberRoles.isPending && setMemberRoles.variables?.userId === member.userId}
              onAssign={onAssign}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
