import { GroupRail as GroupRailView } from "@demli/app-ui";
import demliLogo from "../assets/demli-logo.svg";
import { NotificationMuteSubmenu } from "./NotificationMuteSubmenu";
import { useAuthStore } from "../stores/auth-store";
import { useAppTranslation } from "../lib/i18n";
import { railDownloadAction } from "../lib/download-surface";

/**
 * Desktop GroupRail: the shared @demli/app-ui rail (data via useShellData,
 * fed by DesktopShellDataProvider) with the desktop's mutation-coupled
 * notification-mute submenu supplied as the per-server context-menu slot, and the
 * Demli brand mark supplied as the box-less top home tile.
 *
 * The signed-in user id scopes the server-folder layout (per-account
 * localStorage), so each account on this machine keeps its own folders/order.
 *
 * The rail's bottom "download the app" button is WEB-ONLY (founder): inside the
 * installed desktop app it offers the user the thing they are already running,
 * and the app's own updates are surfaced by the top-right UpdateBadge instead —
 * so on Electron it is not rendered at all rather than shown as a dead control
 * (CLAUDE.md §35). The surface is read from the platform bridge, never the UA.
 *
 * On the web it narrows further by DEVICE (lib/download-surface.ts): a phone
 * gets a button that downloads the one artifact it can install (and none at all
 * on iOS, where we have no build), a desktop browser gets the full picker. The
 * label follows the same decision so the button never says something broader
 * than what it does.
 */
export function GroupRail(): JSX.Element {
  const { t } = useAppTranslation();
  const accountId = useAuthStore((s) => s.user?.id ?? null);
  const download = railDownloadAction();

  return (
    <GroupRailView
      homeLogoSrc={demliLogo}
      accountId={accountId}
      showDownloadButton={download.kind !== "hidden"}
      downloadLabel={
        download.kind === "direct" && download.platform === "android"
          ? t("desktop:download.androidCta")
          : undefined
      }
      renderGroupMuteMenu={(groupId, isMuted) => (
        <NotificationMuteSubmenu scope="group" targetId={groupId} isMuted={isMuted} />
      )}
    />
  );
}
