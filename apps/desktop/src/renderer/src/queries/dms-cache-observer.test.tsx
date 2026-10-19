// @vitest-environment jsdom
/**
 * The DM composer reads the DM list from the cache to know whether the open
 * stream is a DM with someone the viewer blocked. It used to do that with an
 * observer registered as `queryFn: skipToken` on the SAME key the shell fetches.
 * An observer's options overwrite the shared Query's on every render, so after a
 * composer render the next `invalidateQueries(dms)` found `skipToken` and
 * rejected ("Missing queryFn") instead of refetching — a hidden DM that received
 * a message never came back, and block/unblock never refreshed the list.
 *
 * These renders are real (real QueryClient, real hooks); only the network is
 * stubbed. The control case proves the failure mode is real, so the passing
 * case is not green by accident.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  skipToken,
  useQuery,
} from "@tanstack/react-query";
import type { Dm } from "@demli/types";
import type * as SocialQueriesModule from "./social-queries";
import type { queryKeys as QueryKeysValue } from "../lib/query-client";

const listDms = vi.fn(async () => ({ dms: [] as Dm[] }));

vi.mock("../lib/api-client", () => ({ api: { listDms: () => listDms() } }));
vi.mock("../realtime/connection", () => ({
  resubscribeRealtime: () => undefined,
  sendChatMessage: () => undefined,
}));
vi.mock("../stores/chat-store", () => ({
  useChatStore: { getState: () => ({ upsertUsers: () => undefined }) },
}));
vi.mock("../stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type SocialQueries = typeof SocialQueriesModule;
let social: SocialQueries;
let queryKeys: typeof QueryKeysValue;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  social = await import("./social-queries");
  ({ queryKeys } = await import("../lib/query-client"));
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  listDms.mockClear();
});

function Shell(): null {
  social.useDms();
  return null;
}

function CachedReader({ tick }: { tick: number }): JSX.Element {
  const { data } = social.useCachedDms();
  return <span data-tick={tick}>{data?.length ?? -1}</span>;
}

function SkipTokenReader({ tick }: { tick: number }): JSX.Element {
  const { data } = useQuery<Dm[]>({ queryKey: queryKeys.dms, queryFn: skipToken });
  return <span data-tick={tick}>{data?.length ?? -1}</span>;
}

async function mountAndInvalidate(Reader: (props: { tick: number }) => JSX.Element) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (tick: number): void =>
    root?.render(
      <QueryClientProvider client={client}>
        <Shell />
        <Reader tick={tick} />
      </QueryClientProvider>,
    );
  await act(async () => render(0));
  await act(async () => {
    await client.getQueryCache().find({ queryKey: queryKeys.dms })?.promise;
  });
  // The composer re-renders (typing, a channel switch) — its observer re-applies its options.
  await act(async () => render(1));
  await act(async () => render(2));
  const callsBefore = listDms.mock.calls.length;
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.dms }).catch(() => undefined);
  });
  return {
    refetched: listDms.mock.calls.length - callsBefore,
    state: client.getQueryState(queryKeys.dms),
  };
}

describe("composer's cached DM-list observer", () => {
  it("leaves the shared query refetchable after the composer re-renders", async () => {
    const { refetched, state } = await mountAndInvalidate(CachedReader);
    expect(refetched).toBe(1);
    expect(state?.status).toBe("success");
  });

  it("never fetches on its own", async () => {
    const client = new QueryClient();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <CachedReader tick={0} />
        </QueryClientProvider>,
      ),
    );
    expect(listDms).not.toHaveBeenCalled();
  });

  it("control: a skipToken observer on the same key breaks the invalidation", async () => {
    // react-query logs the misconfiguration this test provokes on purpose.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { refetched, state } = await mountAndInvalidate(SkipTokenReader);
    quiet.mockRestore();
    expect(refetched).toBe(0);
    expect(state?.status).toBe("error");
  });
});
