import { useState } from "react";
import { Check, ChevronDown, Crown, Loader2, UserMinus } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import type { GroupId, Role, RoleId, UserId } from "@demli/types";
import type { GroupMemberWithUser } from "../../lib/api-client";
import { errorKey, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import {
  useGroupDetails,
  useKickMember,
  useRoles,
  useSetMemberRoles,
} from "../../queries/chat-queries";
import { indexRoles, memberColor } from "../../lib/permissions";
import { useAuthStore } from "../../stores/auth-store";

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
        <Button variant="secondary" size="sm" disabled={disabled}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("desktop:serverSettings.roles")}
          <ChevronDown className="size-3.5 text-fg-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {roles.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-fg-faint">
            {t("desktop:serverSettings.noRolesToAssign")}
          </p>
        ) : (
          roles.map((role) => {
            const on = assigned.has(role.id);
            return (
              <DropdownMenuItem
                key={role.id}
                onSelect={(event) => {
                  event.preventDefault();
                  onToggle(role.id, !on);
                }}
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
              </DropdownMenuItem>
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
    <li className="flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-white/[0.03]">
      <UserAvatar
        name={member.user.displayName}
        colorSeed={member.user.id}
        src={member.user.avatarUrl}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className="truncate text-sm font-medium"
            style={{ color: color ?? undefined }}
          >
            {member.user.displayName}
          </span>
          {isOwnerMember && (
            <Crown
              aria-label={t("desktop:serverSettings.owner")}
              className="size-3 shrink-0 text-idle"
            />
          )}
        </div>
        {memberRoles.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {memberRoles.map((role) => (
              <span
                key={role.id}
                className="inline-flex items-center gap-1 rounded-full border border-stroke bg-raised/60 px-1.5 py-px text-badge text-fg-muted"
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: role.color ?? "#95a5a6" }}
                />
                {role.name}
              </span>
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
              <span className="inline-flex">
                <Button variant="secondary" size="sm" disabled>
                  {t("desktop:serverSettings.roles")}
                  <ChevronDown className="size-3.5 text-fg-muted" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("desktop:serverSettings.guestNoRoles")}
            </TooltipContent>
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

      {canKick && !isOwnerMember && !isSelf ? (
        confirmKick ? (
          <div className="flex items-center gap-1">
            <Button
              variant="danger"
              size="sm"
              disabled={kick.isPending}
              onClick={() =>
                kick.mutate(member.userId, { onSettled: () => setConfirmKick(false) })
              }
            >
              {kick.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t("desktop:serverSettings.kick")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmKick(false)}>
              {t("buttons.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("desktop:serverSettings.kickName", {
              name: member.user.displayName,
            })}
            onClick={() => setConfirmKick(true)}
            className="text-fg-faint hover:bg-danger/10 hover:text-danger"
          >
            <UserMinus className="size-4" />
          </Button>
        )
      ) : null}
    </li>
  );
}

/** Members tab: member list with role chips, role assignment, and kick. */
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
  const { data: details } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const setMemberRoles = useSetMemberRoles(groupId);
  const [error, setError] = useState<CommonErrorKey | null>(null);

  const ownerId = details?.group.ownerId;
  const rolesById = indexRoles(roles);
  const members = [...(details?.members ?? [])].sort((a, b) =>
    a.user.displayName.localeCompare(b.user.displayName),
  );

  const onAssign = (userId: UserId, roleIds: RoleId[]): void => {
    setError(null);
    setMemberRoles.mutate(
      { userId, roleIds },
      { onError: (err) => setError(errorKey(err)) },
    );
  };

  return (
    <div className="space-y-2">
      {error && (
        <FormErrorAlert>{t(error)}</FormErrorAlert>
      )}
      <p className="text-2xs text-fg-faint">
        {canManageRoles
          ? t("desktop:serverSettings.memberCountAssign", { count: members.length })
          : t("desktop:serverSettings.memberCount", { count: members.length })}
      </p>
      <ul className="space-y-px">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            ownerId={ownerId}
            currentUserId={currentUserId}
            roles={roles ?? []}
            rolesById={rolesById}
            canManageRoles={canManageRoles}
            canKick={canKick}
            assignPending={
              setMemberRoles.isPending && setMemberRoles.variables?.userId === member.userId
            }
            onAssign={onAssign}
          />
        ))}
      </ul>
    </div>
  );
}
