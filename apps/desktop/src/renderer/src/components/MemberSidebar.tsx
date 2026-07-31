import { MemberSidebar as MemberSidebarView, type RenderMemberMenu } from "@demli/app-ui";
import { useChatStore } from "../stores/chat-store";
import { ProfileCard } from "./ProfileCard";
import { MemberContextMenu } from "./MemberContextMenu";

/**
 * Desktop MemberSidebar: the shared @demli/app-ui roster (data via
 * useShellData) with the desktop's ProfileCard popover wrapping each member row,
 * plus the full user context menu (ADR 0019) on right-click / long-press.
 *
 * The menu is attached to EVERY row including the viewer's own — your own menu
 * is a real, different menu (profile, mention, edit your server profile, roles,
 * copy id), not an empty one. Which entries appear is decided entirely inside
 * `lib/member-menu`, so this component holds no permission logic at all: it
 * passes the target and the server, and the menu drops anything the viewer
 * cannot do (§35).
 */
export function MemberSidebar(): JSX.Element {
  const activeGroupId = useChatStore((s) => s.activeGroupId);

  const renderMemberMenu: RenderMemberMenu = (member, children) => (
    <MemberContextMenu
      target={{
        userId: member.id,
        displayName: member.displayName,
        isOwner: member.isOwner,
        isGuest: member.isGuest,
      }}
      groupId={activeGroupId}
    >
      {children}
    </MemberContextMenu>
  );

  return (
    <MemberSidebarView
      renderMemberProfile={(userId, groupId, children) => (
        <ProfileCard userId={userId} groupId={groupId ?? undefined}>
          {children}
        </ProfileCard>
      )}
      renderMemberMenu={renderMemberMenu}
    />
  );
}
