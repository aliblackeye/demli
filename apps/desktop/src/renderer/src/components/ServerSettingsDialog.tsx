import { useEffect, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@demli/ui";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useGroups, useServerPermissions } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { GeneralTab } from "./server-settings/GeneralTab";
import { RolesTab } from "./server-settings/RolesTab";
import { MembersTab } from "./server-settings/MembersTab";
import { EmojiTab } from "./server-settings/EmojiTab";
import { ModerationLogTab } from "./server-settings/ModerationLogTab";

type Tab = "general" | "roles" | "members" | "emoji" | "moderationLog";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-white/[0.06] text-fg"
          : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Server settings, tabbed (ADR 0007): General (name/icon/system channel/invite
 * policy), Roles (role editor), Members (role assignment + kick). Tabs are gated
 * by the viewer's effective permissions — cosmetic only, the API re-checks.
 */
export function ServerSettingsDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.serverSettingsOpen);
  const setOpen = useUiStore((s) => s.setServerSettingsOpen);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: groups } = useGroups();
  const group = groups?.find((g) => g.id === activeGroupId);

  const { isOwner, can } = useServerPermissions(activeGroupId);
  const canManageRoles = can(PERMISSIONS.MANAGE_ROLES);
  const canKick = can(PERMISSIONS.KICK_MEMBERS);

  const showRoles = isOwner || canManageRoles;
  const showMembers = isOwner || canManageRoles || canKick;
  // Audit log (M18): the SAME gate the endpoint enforces — owner ∨ KICK_MEMBERS,
  // i.e. whoever may moderate may see what has been moderated. Anyone else never
  // sees the tab at all rather than a tab that 403s on open (§35).
  const showModerationLog = isOwner || canKick;

  const [tab, setTab] = useState<Tab>("general");
  useEffect(() => {
    if (open) setTab("general");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("desktop:sidebar.serverSettings")}</DialogTitle>
          <DialogDescription>
            {group?.name ?? t("desktop:leaveServer.thisServer")}
          </DialogDescription>
        </DialogHeader>

        {group && activeGroupId ? (
          <>
            <div className="flex shrink-0 gap-1 border-b border-stroke px-5 pb-3">
              <TabButton active={tab === "general"} onClick={() => setTab("general")}>
                {t("desktop:serverSettings.tabGeneral")}
              </TabButton>
              {showRoles && (
                <TabButton active={tab === "roles"} onClick={() => setTab("roles")}>
                  {t("desktop:serverSettings.roles")}
                </TabButton>
              )}
              {showMembers && (
                <TabButton active={tab === "members"} onClick={() => setTab("members")}>
                  {t("desktop:members.membersNav")}
                </TabButton>
              )}
              {/* Emoji is open to every member: the API lets any member upload,
                  and deletion is gated per-row (uploader ∨ owner). */}
              <TabButton active={tab === "emoji"} onClick={() => setTab("emoji")}>
                {t("desktop:emoji.tab")}
              </TabButton>
              {showModerationLog && (
                <TabButton
                  active={tab === "moderationLog"}
                  onClick={() => setTab("moderationLog")}
                >
                  {t("desktop:moderationLog.tab")}
                </TabButton>
              )}
            </div>

            <DialogBody className="pt-4">
              {tab === "general" && <GeneralTab group={group} isOwner={isOwner} />}
              {tab === "roles" && showRoles && (
                <RolesTab groupId={activeGroupId} canManage={isOwner || canManageRoles} />
              )}
              {tab === "members" && showMembers && (
                <MembersTab
                  groupId={activeGroupId}
                  canManageRoles={isOwner || canManageRoles}
                  canKick={isOwner || canKick}
                />
              )}
              {tab === "emoji" && <EmojiTab groupId={activeGroupId} isOwner={isOwner} />}
              {tab === "moderationLog" && showModerationLog && (
                <ModerationLogTab groupId={activeGroupId} />
              )}
            </DialogBody>
          </>
        ) : (
          <DialogBody>
            <p className="text-sm text-fg-muted">{t("desktop:serverSettings.selectFirst")}</p>
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}
