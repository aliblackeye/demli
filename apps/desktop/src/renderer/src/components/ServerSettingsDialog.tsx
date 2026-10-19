import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@demli/ui";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useGroupDetails, useGroups, useServerPermissions } from "../queries/chat-queries";
import { localizeError } from "../lib/errors";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { GeneralTab } from "./server-settings/GeneralTab";
import { RolesTab } from "./server-settings/RolesTab";
import { MembersTab } from "./server-settings/MembersTab";
import { EmojiTab } from "./server-settings/EmojiTab";
import { ModerationLogTab } from "./server-settings/ModerationLogTab";
import type { DraftGuard } from "./server-settings/shared";
import { InlineError, SegmentedTabs, TabPanel, type SegmentedTab } from "./settings-kit";

type Tab = "general" | "roles" | "members" | "emoji" | "moderationLog";

const TABS_ID = "server-settings";

/**
 * Server settings, tabbed (ADR 0007): General (name/icon/system channel/invite
 * policy), Roles (role editor), Members (role assignment + kick), Emoji, Audit
 * log. Tabs are gated by the viewer's effective permissions — cosmetic only, the
 * API re-checks.
 *
 * Unsaved drafts (General form, the role editor) are guarded HERE: while a tab
 * reports a dirty draft, closing the dialog (Esc, scrim, ×) and switching tabs
 * are refused and the tab's unsaved-changes bar is nudged instead — the draft is
 * never dropped silently, and the bar says exactly what to do.
 */
export function ServerSettingsDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.serverSettingsOpen);
  const setOpen = useUiStore((s) => s.setServerSettingsOpen);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: groups } = useGroups();
  const group = groups?.find((g) => g.id === activeGroupId);

  const { isOwner, can } = useServerPermissions(activeGroupId);
  // Every tab gate (owner, MANAGE_ROLES, KICK_MEMBERS) is read from the server
  // details. If they fail to load, the gates are UNKNOWN — rendering the tabs
  // anyway would silently demote an owner to a read-only General tab with no
  // Roles/Members, so the failure is said instead.
  const detailsQuery = useGroupDetails(activeGroupId);
  const detailsFailed = detailsQuery.isError && !detailsQuery.data;
  const canManageRoles = can(PERMISSIONS.MANAGE_ROLES);
  const canKick = can(PERMISSIONS.KICK_MEMBERS);

  const showRoles = isOwner || canManageRoles;
  const showMembers = isOwner || canManageRoles || canKick;
  // Audit log (M18): the SAME gate the endpoint enforces — owner ∨ KICK_MEMBERS,
  // i.e. whoever may moderate may see what has been moderated. Anyone else never
  // sees the tab at all rather than a tab that 403s on open (§35).
  const showModerationLog = isOwner || canKick;

  const [tab, setTab] = useState<Tab>("general");
  const [dirty, setDirty] = useState(false);
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (open) setTab("general");
    else setDirty(false);
  }, [open]);

  const guard: DraftGuard = {
    onDirtyChange: useCallback((next: boolean) => setDirty(next), []),
    nudge,
  };

  const tabs: SegmentedTab<Tab>[] = [
    { id: "general", label: t("desktop:serverSettings.tabGeneral") },
    ...(showRoles ? [{ id: "roles" as const, label: t("desktop:serverSettings.roles") }] : []),
    ...(showMembers ? [{ id: "members" as const, label: t("desktop:members.membersNav") }] : []),
    // Emoji is open to every member: the API lets any member upload, and
    // deletion is gated per-row (uploader ∨ owner).
    { id: "emoji", label: t("desktop:emoji.tab") },
    ...(showModerationLog ? [{ id: "moderationLog" as const, label: t("desktop:moderationLog.tab") }] : []),
  ];

  const selectTab = (next: Tab): void => {
    if (next === tab) return;
    if (dirty) {
      setNudge((n) => n + 1);
      return;
    }
    setTab(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dirty) {
          setNudge((n) => n + 1);
          return;
        }
        setOpen(next);
      }}
    >
      <DialogContent
        closeLabel={t("buttons.close")}
        className="h-[min(46rem,calc(100vh-4rem))] max-w-3xl"
      >
        <DialogHeader className="pb-3">
          <DialogTitle>{t("desktop:sidebar.serverSettings")}</DialogTitle>
          <DialogDescription>{group?.name ?? t("desktop:leaveServer.thisServer")}</DialogDescription>
        </DialogHeader>

        {group && activeGroupId && detailsFailed ? (
          <DialogBody>
            <InlineError
              title={t("desktop:settingsUi.serverSettingsLoadFailed")}
              message={localizeError(detailsQuery.error, t)}
              retryLabel={t("buttons.retry")}
              onRetry={() => void detailsQuery.refetch()}
              retrying={detailsQuery.isFetching}
            />
          </DialogBody>
        ) : group && activeGroupId ? (
          <>
            <div className="shrink-0 overflow-x-auto px-6 pb-3 shadow-[inset_0_-1px_0_var(--color-stroke)]">
              <SegmentedTabs
                tabs={tabs}
                value={tab}
                onChange={selectTab}
                label={t("desktop:sidebar.serverSettings")}
                idPrefix={TABS_ID}
              />
            </div>

            <DialogBody className="relative pt-5">
              <TabPanel idPrefix={TABS_ID} id={tab} key={tab}>
                {tab === "general" && <GeneralTab group={group} isOwner={isOwner} guard={guard} />}
                {tab === "roles" && showRoles && (
                  <RolesTab groupId={activeGroupId} canManage={isOwner || canManageRoles} guard={guard} />
                )}
                {tab === "members" && showMembers && (
                  <MembersTab
                    groupId={activeGroupId}
                    canManageRoles={isOwner || canManageRoles}
                    canKick={isOwner || canKick}
                  />
                )}
                {tab === "emoji" && <EmojiTab groupId={activeGroupId} isOwner={isOwner} />}
                {tab === "moderationLog" && showModerationLog && <ModerationLogTab groupId={activeGroupId} />}
              </TabPanel>
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
