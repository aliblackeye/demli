/**
 * Platform bridge surface — the typed contract plus the desktop/web adapters and
 * the React provider/hook that make it available to the shared product UI.
 *
 * Phase 0 wires nobody to this yet; Phase 1's ported components consume it.
 */
export type * from "./bridge-types";

export {
  PlatformProvider,
  usePlatform,
  usePlatformOptional,
  type PlatformProviderProps,
} from "./platform-context";

export {
  createDesktopBridge,
  getDesktopNativeBridge,
  hasDesktopBridge,
} from "./desktop-bridge";

export { createWebBridge, type WebBridgeOptions } from "./web-bridge";

export { createWebImagesBridge, webCopyImageSupported } from "./web-image-actions";

export { isExternalHttpUrl, openExternalUrl } from "./external-link";
