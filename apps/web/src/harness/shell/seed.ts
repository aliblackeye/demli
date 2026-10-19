/**
 * Puts the REAL stores and the REAL query cache into the state a scene needs.
 * Nothing here re-implements a component; it only writes the data those
 * components read, the same way the realtime gateway and the API would.
 */
import type { VoiceParticipant } from "@demli/media";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { queryClient, queryKeys } from "../../../../desktop/src/renderer/src/lib/query-client";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useAccountsStore } from "../../../../desktop/src/renderer/src/stores/accounts-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import { useVoiceStore } from "../../../../desktop/src/renderer/src/stores/voice-store";
import { useSelfPresenceStore } from "../../../../desktop/src/renderer/src/stores/self-presence-store";
import {
  CH_AKSAM,
  CH_SOHBET,
  DETAILS,
  DMS,
  GROUPS,
  GROUP_CHATS,
  G_MASA,
  MASA_CATEGORIES,
  ME,
  MUTES,
  PRESENCE,
  ROLES,
  UNREAD,
  USERS,
} from "./fixtures";

/**
 * Network: the harness must never reach the live API (the web build defaults
 * VITE_API_URL to production). Every cross-origin request is held PENDING
 * forever — which is also exactly what a slow first fetch looks like, so an
 * unseeded query renders its genuine loading state instead of an error.
 */
export function holdNetwork(routes: FailingRoute[] = []): void {
  const original = window.fetch.bind(window);
  const calls = new Map<FailingRoute, number>();
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      window.location.href,
    );
    if (url.origin === window.location.origin) return original(input, init);
    const route = routes.find((r) => r.path.test(url.pathname));
    if (route) {
      const n = (calls.get(route) ?? 0) + 1;
      calls.set(route, n);
      // First request: the server is unreachable — the same TypeError a real
      // offline / DNS / refused connection gives fetch. Every later one (the
      // user's retry) succeeds with the route's body.
      if (n === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(
        new Response(JSON.stringify(route.healedBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return new Promise<Response>(() => undefined);
  };
}

/**
 * A request the fetch-failed scenes refuse ONCE, then serve: proves both the
 * error state and that its retry really refetches (no faked state flip).
 */
export interface FailingRoute {
  path: RegExp;
  healedBody: unknown;
}

export function seedSignedIn({ withDms = true }: { withDms?: boolean } = {}): void {
  queryClient.setDefaultOptions({
    queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnMount: false },
  });
  useAuthStore.setState({ status: "authenticated", user: ME, token: "harness" });
  useAccountsStore.setState({
    accounts: [
      { accountId: ME.id, token: "harness", username: ME.username, displayName: ME.displayName, avatarUrl: ME.avatarUrl, lastUsedAt: 2 },
      { accountId: "u-alt", token: "harness-2", username: "ali.is", displayName: "Ali (iş)", avatarUrl: null, lastUsedAt: 1 },
    ],
    activeAccountId: ME.id,
  });
  useSelfPresenceStore.setState({ statusByUser: { [ME.id]: "online" } } as never);

  queryClient.setQueryData(queryKeys.me, ME);
  queryClient.setQueryData(queryKeys.groups, GROUPS);
  for (const [groupId, details] of Object.entries(DETAILS)) {
    queryClient.setQueryData(queryKeys.groupDetails(groupId as GroupId), details);
    queryClient.setQueryData(queryKeys.categories(groupId as GroupId), groupId === G_MASA ? MASA_CATEGORIES : []);
    queryClient.setQueryData(queryKeys.roles(groupId as GroupId), groupId === G_MASA ? ROLES : []);
  }
  // Left unseeded by the DM load-state scenes, so the real query runs.
  if (withDms) queryClient.setQueryData(queryKeys.dms, DMS);
  queryClient.setQueryData(queryKeys.groupChats, GROUP_CHATS);
  queryClient.setQueryData(queryKeys.notificationMutes, MUTES);
  queryClient.setQueryData(queryKeys.userNicknames, {});
  // An empty, fully-loaded conversation for the channel on screen.
  queryClient.setQueryData(queryKeys.messages(CH_SOHBET), {
    pages: [{ messages: [], nextCursor: null }],
    pageParams: [null],
  });

  const chat = useChatStore.getState();
  chat.upsertUsers(USERS);
  chat.replaceNotificationMutes(MUTES);
  useChatStore.setState({
    activeView: "server",
    activeGroupId: G_MASA,
    activeChannelId: CH_SOHBET,
    memberSidebarOpen: true,
    presence: PRESENCE as never,
    customStatuses: { "u-kaan": "Çay demleniyor" } as never,
    connectionStatus: "online",
    ...UNREAD,
  });
}

/** In the voice room "akşam odası" with three people, one of them talking. */
export function seedVoice(): void {
  const participant = (id: string, speaking: boolean, isLocal = false): VoiceParticipant => ({
    userId: id as UserId,
    identity: id,
    micEnabled: id !== "u-baran",
    speaking,
    screenSharing: false,
    cameraEnabled: false,
    volume: 1,
    deafened: false,
    isLocal,
  });
  useVoiceStore.setState({
    status: "connected",
    roomId: CH_AKSAM,
    roomLabel: { channelName: "akşam odası", groupName: "bizim masa" },
    micEnabled: true,
    deafened: false,
    participants: [participant(ME.id, false, true), participant("u-ece", true), participant("u-baran", false)],
  });
}

export function openHomeDm(): void {
  const dm = DMS[0]!;
  useChatStore.setState({
    activeView: "home",
    homeView: "dm",
    activeDmId: dm.id,
    activeChannelId: dm.streamId,
  });
  queryClient.setQueryData(queryKeys.messages(dm.streamId as ChannelId), {
    pages: [{ messages: [], nextCursor: null }],
    pageParams: [null],
  });
}
