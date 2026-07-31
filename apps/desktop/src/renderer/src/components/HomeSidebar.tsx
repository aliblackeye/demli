import { HomeSidebar as HomeSidebarView } from "@demli/app-ui";
import { UserFooter } from "./UserFooter";
import { CallDock } from "./CallDock";

/**
 * Desktop HomeSidebar: the shared @demli/app-ui home column (data via
 * useShellData) with the desktop's DM-call dock and user footer as slots.
 */
export function HomeSidebar(): JSX.Element {
  return <HomeSidebarView callDock={<CallDock />} userFooter={<UserFooter />} />;
}
