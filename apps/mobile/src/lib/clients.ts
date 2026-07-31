/**
 * Mobile HTTP-client wrapper around the shared `@demli/client-core`
 * (ADR 0002 — one wire implementation for desktop + mobile).
 *
 * The base URL is fixed at build time from `EXPO_PUBLIC_API_URL` (baked into the
 * APK via eas.json — see lib/server-config.ts). There is no in-app server config,
 * so the client is built once here; `getApi()` returns that singleton and
 * `setAuthToken()` re-applies the session token as it changes.
 */
import { createApiClient, type Api } from "@demli/client-core";
import { API_URL } from "./server-config";
import { CLIENT_SIGNATURE } from "./client-signature";

const client = createApiClient({
  baseUrl: API_URL,
  // The mark the server's client gate reads to tell a current build from a
  // retired one. Required by the factory on purpose — forgetting it is a compile
  // error, not a build that looks healthy until the gate is armed.
  clientSignature: CLIENT_SIGNATURE,
});

/** The typed API surface, bound to the baked server URL. */
export function getApi(): Api {
  return client.api;
}

/** Called by the auth store whenever the session token changes. */
export function setAuthToken(token: string | null): void {
  client.setAuthToken(token);
}

// Re-export the shared transport surface so screens/stores import errors and
// DTO types from one place, matching the desktop's `lib/api-client` ergonomics.
export {
  ApiClientError,
  friendlyErrorMessage,
  type Api,
  type ApiClientErrorCode,
  type AuthResponse,
  type DevicePlatform,
  type RegisterDeviceInput,
  type FriendRequestDirection,
  type FriendWithUser,
  type GroupChatDetails,
  type GroupDetails,
  type GroupMemberWithUser,
  type MessagesPage,
  type MobileVersionInfo,
  type ModerationLogPage,
  type RecentCall,
  type RecentCallDirection,
  type RecentCallsPage,
  type SetNotificationMuteInput,
  type SendFriendRequestInput,
  type SendFriendRequestOutcome,
  type SendFriendRequestResult,
  type UpdateChannelInput,
  type UpdateGroupInput,
  type UpdateMeInput,
} from "@demli/client-core";
