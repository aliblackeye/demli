import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient, friendlyErrorMessage } from "../api-client.js";

const BASE = "http://api.test:4000";
/** A well-formed client mark; the factories reject a malformed one. */
const TEST_SIGNATURE = "demli-test/1";

/** Build a Response-like object for a stubbed fetch. */
function jsonResponse(
  body: unknown,
  init: { status?: number; ok?: boolean } = {},
): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Install a typed fetch mock. Declaring the params keeps `mock.calls` typed as
 * `[string, RequestInit?][]` so the assertions below can read url/init safely.
 */
function stubFetch(respond: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(
    (input: string, init?: RequestInit): Promise<Response> => Promise.resolve(respond(input, init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Headers set by the request under test (always a plain record at runtime). */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient — URL building", () => {
  it("builds the messages URL with encoded channel id and query params", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ messages: [], nextCursor: null }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.listMessages("chan/1", { cursor: "cur:2", limit: 25 });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${BASE}/channels/chan%2F1/messages?cursor=cur%3A2&limit=25`,
    );
  });

  it("omits the query string when no pagination options are given", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ messages: [], nextCursor: null }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.listMessages("general");

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/channels/general/messages`);
  });

  it("PATCHes updateGroup with a systemChannelId body (incl. null to disable)", async () => {
    const group = { id: "g1", systemChannelId: "c1" };
    const fetchMock = stubFetch(() => jsonResponse({ group }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.updateGroup("g/1", { systemChannelId: "c1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g%2F1`);
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ systemChannelId: "c1" });

    await api.updateGroup("g1", { systemChannelId: null });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      systemChannelId: null,
    });
  });

  it("PATCHes updateChannel with slowmodeSeconds and audioBitrateKbps", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ channel: { id: "c1" } }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.updateChannel("c1", { slowmodeSeconds: 10 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      slowmodeSeconds: 10,
    });

    await api.updateChannel("c2", { audioBitrateKbps: 96 });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      audioBitrateKbps: 96,
    });
  });

  it("POSTs sendFriendRequestByUsername to /friends/requests/by-username with a { username } body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    // Client sends the raw value verbatim (leading "@"/case are normalized
    // server-side); the endpoint answers a uniform opaque result.
    const res = await api.sendFriendRequestByUsername("Ali");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/friends/requests/by-username`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ username: "Ali" });
    expect(res).toEqual({ ok: true });
  });

  it("DELETEs the leaveGroup member URL with encoded ids", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.leaveGroup("g/1", "u/2");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g%2F1/members/u%2F2`);
    expect(init!.method).toBe("DELETE");
  });

  it("DELETEs the deleteGroupChat URL with an encoded group id", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.deleteGroupChat("gc/9");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/group-chats/gc%2F9`);
    expect(init!.method).toBe("DELETE");
  });

  it("POSTs the media token request with a JSON channelId body", async () => {
    const grant = {
      url: "ws://lk:7880",
      token: "jwt",
      roomName: "chan",
      identity: "u1",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const fetchMock = stubFetch(() => jsonResponse(grant));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.getMediaToken("chan");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/media/token`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ channelId: "chan" });
    expect(res).toEqual(grant);
  });
});

describe("createApiClient — voice occupancy (state-resync)", () => {
  it("GETs /voice/occupancy with the Bearer token and returns the snapshot", async () => {
    const snapshot = {
      channels: [
        {
          channelId: "voice-1",
          occupants: [
            { userId: "u1", muted: false, screenSharing: true, camera: false },
            { userId: "u2", muted: true },
          ],
        },
      ],
    };
    const fetchMock = stubFetch(() => jsonResponse(snapshot));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    setAuthToken("sess-9");
    const res = await api.getVoiceOccupancy();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/voice/occupancy`);
    expect(init!.method ?? "GET").toBe("GET");
    expect(headersOf(init).Authorization).toBe("Bearer sess-9");
    // Optional screenSharing/camera media-plane fields round-trip verbatim.
    expect(res).toEqual(snapshot);
  });

  it("surfaces a 503 as a typed VOICE_OCCUPANCY_UNAVAILABLE error (caller keeps its view)", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "VOICE_OCCUPANCY_UNAVAILABLE",
            message: "Voice occupancy is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.getVoiceOccupancy().catch((e: unknown) => e);

    // A throwable the focus-pull caller catches → it never resyncs → view kept.
    // VOICE_OCCUPANCY_UNAVAILABLE round-trips as the runtime code even though it
    // is intentionally not a typed member (never user-surfaced) — String() sidesteps
    // the no-overlap comparison, matching the INVALID_REACTION precedent above.
    expect(err).toBeInstanceOf(ApiClientError);
    expect(String((err as ApiClientError).code)).toBe("VOICE_OCCUPANCY_UNAVAILABLE");
    expect((err as ApiClientError).status).toBe(503);
  });
});

describe("createApiClient — roles & permissions (ADR 0007)", () => {
  it("GETs the roles list URL with an encoded group id", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ roles: [] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.listRoles("g/1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g%2F1/roles`);
    expect(init!.method ?? "GET").toBe("GET");
  });

  it("POSTs createRole with a name/color/permissions body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ role: { id: "r1" } }, { status: 201 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.createRole("g1", { name: "Mod", color: "#ff8800", permissions: 6 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g1/roles`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      name: "Mod",
      color: "#ff8800",
      permissions: 6,
    });
  });

  it("PATCHes updateRole at the encoded role URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ role: { id: "r1" } }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.updateRole("g/1", "r/2", { permissions: 0, color: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g%2F1/roles/r%2F2`);
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ permissions: 0, color: null });
  });

  it("DELETEs a role at the encoded role URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.deleteRole("g1", "r1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g1/roles/r1`);
    expect(init!.method).toBe("DELETE");
  });

  it("PUTs setMemberRoles with the full desired role-id set", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ roleIds: ["r1", "r2"] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.setMemberRoles("g1", "u1", ["r1", "r2"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/groups/g1/members/u1/roles`);
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ roleIds: ["r1", "r2"] });
    expect(res).toEqual({ roleIds: ["r1", "r2"] });
  });

  it("GET/PUTs channel visibility roles at the access URL ([] = public)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ roleIds: [] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.listChannelRoles("c/1");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/channels/c%2F1/access`);

    await api.setChannelRoles("c1", []);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${BASE}/channels/c1/access`);
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ roleIds: [] });
  });

  it("PATCHes updateGroup with an invitePolicy body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ group: { id: "g1" } }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.updateGroup("g1", { invitePolicy: "roles" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      invitePolicy: "roles",
    });
  });
});

describe("createApiClient — message reactions (ADR 0011)", () => {
  it("PUTs addReaction at the encoded message + emoji URL and returns the summary", async () => {
    const reactions = [{ emoji: "👍", count: 1, reactedByMe: true }];
    const fetchMock = stubFetch(() => jsonResponse({ reactions }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.addReaction("m/1", "👍");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/messages/m%2F1/reactions/${encodeURIComponent("👍")}`);
    expect(init!.method).toBe("PUT");
    expect(res).toEqual({ reactions });
  });

  it("DELETEs removeReaction at the encoded message + emoji URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ reactions: [] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.removeReaction("m1", "🔥");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/messages/m1/reactions/${encodeURIComponent("🔥")}`);
    expect(init!.method).toBe("DELETE");
  });

  it("URL-encodes a multi-codepoint emoji so it round-trips (❤️ = U+2764 U+FE0F)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ reactions: [] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.addReaction("m1", "❤️");

    // %E2%9D%A4%EF%B8%8F — never a raw multi-byte emoji in the path segment.
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/messages/m1/reactions/%E2%9D%A4%EF%B8%8F`);
  });

  it("surfaces an out-of-palette emoji rejection as a 400 ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "INVALID_REACTION", message: "That reaction isn't allowed." } },
        { status: 400 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.addReaction("m1", "🥑").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    // The server's INVALID_REACTION string round-trips as the runtime code even
    // though it is not in the ApiClientErrorCode union (kept purely additive).
    expect(String((err as ApiClientError).code)).toBe("INVALID_REACTION");
    expect((err as ApiClientError).status).toBe(400);
  });
});

describe("createApiClient — push devices (task #46)", () => {
  it("POSTs registerDevice with the token + platform body", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(
      api.registerDevice({ token: "ExponentPushToken[abc]", platform: "android" }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/devices/token`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      token: "ExponentPushToken[abc]",
      platform: "android",
    });
  });

  it("DELETEs unregisterDevice with the token in the body", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(
      api.unregisterDevice({ token: "ExponentPushToken[abc]" }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/devices/token`);
    expect(init!.method).toBe("DELETE");
    expect(JSON.parse(init!.body as string)).toEqual({ token: "ExponentPushToken[abc]" });
  });

  it("attaches the Bearer token to device registration when signed in", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    setAuthToken("sess-9");
    await api.registerDevice({ token: "ExponentPushToken[abc]", platform: "ios" });

    expect(headersOf(fetchMock.mock.calls[0]![1]).Authorization).toBe("Bearer sess-9");
  });
});

describe("createApiClient — auth header", () => {
  it("attaches the Bearer token once setAuthToken is called, and drops it on null", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ user: {} }));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });

    await api.getMe();
    expect(headersOf(fetchMock.mock.calls[0]![1]).Authorization).toBeUndefined();

    setAuthToken("sess-123");
    await api.getMe();
    expect(headersOf(fetchMock.mock.calls[1]![1]).Authorization).toBe("Bearer sess-123");

    setAuthToken(null);
    await api.getMe();
    expect(headersOf(fetchMock.mock.calls[2]![1]).Authorization).toBeUndefined();
  });

  it("never attaches a token to auth endpoints (auth:false)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ token: "t", user: {} }));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    setAuthToken("sess-123");
    await api.login({ username: "ali", password: "pw" });

    expect(headersOf(fetchMock.mock.calls[0]![1]).Authorization).toBeUndefined();
  });
});

describe("createApiClient — error mapping", () => {
  it("maps a structured error body to a typed ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "INVITE_EXPIRED", message: "This invite has expired." } },
        { status: 410 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.redeemInvite("code").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("INVITE_EXPIRED");
    expect((err as ApiClientError).status).toBe(410);
    expect(friendlyErrorMessage(err)).toBe("This invite has expired.");
  });

  it("maps a 429 SLOWMODE body to a typed error carrying retryAfterSeconds", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "SLOWMODE",
            message: "Slow mode is on. Try again in 8s.",
            retryAfterSeconds: 8,
          },
        },
        { status: 429 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api
      .updateChannel("c1", { name: "x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("SLOWMODE");
    expect((err as ApiClientError).status).toBe(429);
    expect((err as ApiClientError).retryAfterSeconds).toBe(8);
  });

  it("leaves retryAfterSeconds null for non-slowmode errors", async () => {
    stubFetch(() =>
      jsonResponse({ error: { code: "FORBIDDEN", message: "Nope." } }, { status: 403 }),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.leaveGroup("g1", "u1").catch((e: unknown) => e);

    expect((err as ApiClientError).code).toBe("FORBIDDEN");
    expect((err as ApiClientError).retryAfterSeconds).toBeNull();
  });

  it("falls back to INTERNAL when the error body has no code", async () => {
    stubFetch(() => jsonResponse({}, { status: 500 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.listGroups().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("INTERNAL");
  });

  it("maps a fetch rejection to a NETWORK error with a friendly message", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.getMe().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("NETWORK");
    expect(friendlyErrorMessage(err)).toMatch(/Check your connection/);
  });

  it("returns undefined for a 204 No Content response (logout)", async () => {
    stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.logout()).resolves.toBeUndefined();
  });
});

describe("createApiClient — media attachments (ADR 0008)", () => {
  it("POSTs upload-url with mime/sizeBytes and returns the ticket", async () => {
    const ticket = {
      attachmentId: "a1",
      uploadUrl: "https://store.test/signed",
      expiresAt: "2026-07-08T00:00:00.000Z",
    };
    const fetchMock = stubFetch(() => jsonResponse(ticket, { status: 201 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const result = await api.createAttachmentUploadUrl("chan/1", {
      filename: "cat.png",
      mime: "image/png",
      sizeBytes: 1234,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/chan%2F1/attachments/upload-url`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      filename: "cat.png",
      mime: "image/png",
      sizeBytes: 1234,
    });
    expect(result).toEqual(ticket);
  });

  it("POSTs complete with measured dimensions and returns the attachment", async () => {
    const attachment = { id: "a1", kind: "image", width: 800, height: 600 };
    const fetchMock = stubFetch(() => jsonResponse({ attachment }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.completeAttachment("a/1", { width: 800, height: 600 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/attachments/a%2F1/complete`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ width: 800, height: 600 });
  });

  it("sends an empty body object when complete has no measurements", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ attachment: { id: "a1" } }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.completeAttachment("a1");

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({});
  });

  it("POSTs the batch URLs endpoint with attachmentIds", async () => {
    const urls = [
      { attachmentId: "a1", url: "https://store.test/r1", urlExpiresAt: "x" },
    ];
    const fetchMock = stubFetch(() => jsonResponse({ urls }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const result = await api.getAttachmentUrls("c1", ["a1", "a2"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/c1/attachments/urls`);
    expect(JSON.parse(init!.body as string)).toEqual({ attachmentIds: ["a1", "a2"] });
    expect(result.urls).toEqual(urls);
  });

  it("DELETEs cancelAttachment and resolves on 204", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.cancelAttachment("a1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/attachments/a1`);
    expect(init!.method).toBe("DELETE");
  });

  it("surfaces ATTACHMENTS_DISABLED as a typed ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "ATTACHMENTS_DISABLED",
            message: "Attachments are not available on this server.",
          },
        },
        { status: 503 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api
      .createAttachmentUploadUrl("c1", { mime: "image/png", sizeBytes: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("ATTACHMENTS_DISABLED");
  });
});

describe("createApiClient — message reactions (ADR 0011)", () => {
  it("PUTs addReaction at the encoded message + URL-encoded emoji path", async () => {
    const reactions = [{ emoji: "👍", count: 1, reactedByMe: true }];
    const fetchMock = stubFetch(() => jsonResponse({ reactions }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.addReaction("m/1", "👍");

    const [url, init] = fetchMock.mock.calls[0]!;
    // 👍 = U+1F44D → %F0%9F%91%8D ; the '/' in the id is encoded too.
    expect(url).toBe(`${BASE}/messages/m%2F1/reactions/%F0%9F%91%8D`);
    expect(init!.method).toBe("PUT");
    expect(res.reactions).toEqual(reactions);
  });

  it("DELETEs removeReaction and round-trips a multi-codepoint emoji", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ reactions: [] }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.removeReaction("m1", "❤️");

    const [url, init] = fetchMock.mock.calls[0]!;
    // ❤️ = U+2764 U+FE0F → %E2%9D%A4%EF%B8%8F (variation selector preserved).
    expect(url).toBe(`${BASE}/messages/m1/reactions/%E2%9D%A4%EF%B8%8F`);
    expect(init!.method).toBe("DELETE");
    expect(res.reactions).toEqual([]);
  });

  it("surfaces INVALID_REACTION as a typed ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "INVALID_REACTION", message: "That reaction is not allowed." } },
        { status: 400 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.addReaction("m1", "🦄").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("INVALID_REACTION");
  });
});

describe("createApiClient — native version (mobile update prompt)", () => {
  it("GETs /mobile/version WITHOUT a Bearer token even when signed in", async () => {
    const info = {
      latestRuntimeVersion: "1.3.0",
      apkUrl: "https://dl.example.com/demli.apk",
    };
    const fetchMock = stubFetch(() => jsonResponse(info));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    setAuthToken("sess-9");
    const res = await api.getMobileVersion();

    const [url, init] = fetchMock.mock.calls[0]!;
    // v2, not the frozen `/mobile/version` — see the endpoint's own module doc.
    expect(url).toBe(`${BASE}/mobile/version`);
    expect(init!.method ?? "GET").toBe("GET");
    // Public endpoint — the token must NOT ride along (auth: false).
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(res).toEqual(info);
  });

  it("passes through an optional minSupportedRuntimeVersion", async () => {
    const info = {
      latestRuntimeVersion: "1.3.0",
      apkUrl: "https://dl.example.com/demli.apk",
      minSupportedRuntimeVersion: "1.1.0",
    };
    stubFetch(() => jsonResponse(info));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.getMobileVersion()).resolves.toEqual(info);
  });
});

describe("friendlyErrorMessage", () => {
  it("returns a generic message for non-ApiClientError values", () => {
    expect(friendlyErrorMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
    expect(friendlyErrorMessage("nope")).toBe("Something went wrong. Please try again.");
  });
});

describe("createApiClient — message edit & delete (Feature A)", () => {
  it("PATCHes editMessage at the encoded message URL with a { content } body", async () => {
    const message = {
      id: "m/1",
      channelId: "c1",
      authorId: "u1",
      content: "fixed text",
      createdAt: "t0",
      updatedAt: "t1",
      deletedAt: null,
    };
    const fetchMock = stubFetch(() => jsonResponse({ message }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.editMessage("m/1", "fixed text");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/messages/m%2F1`);
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ content: "fixed text" });
    expect(res).toEqual({ message });
  });

  it("DELETEs deleteMessage at the encoded message URL and resolves on 204", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.deleteMessage("m/1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/messages/m%2F1`);
    expect(init!.method).toBe("DELETE");
  });

  it("surfaces a non-author edit rejection as a 403 FORBIDDEN ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "FORBIDDEN", message: "You can only edit your own messages." } },
        { status: 403 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.editMessage("m1", "hax").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("FORBIDDEN");
  });
});

describe("createApiClient — active sessions (M15)", () => {
  it("GETs /sessions with the Bearer token and returns the summaries", async () => {
    const sessions = [
      {
        id: "s1",
        deviceName: "Windows · Demli",
        platform: "desktop",
        lastSeenAt: "2026-07-19T00:00:00.000Z",
        createdAt: "2026-07-18T00:00:00.000Z",
        current: true,
      },
    ];
    const fetchMock = stubFetch(() => jsonResponse({ sessions }));

    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    setAuthToken("sess-9");
    const res = await api.listSessions();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/sessions`);
    expect(init!.method ?? "GET").toBe("GET");
    expect(headersOf(init).Authorization).toBe("Bearer sess-9");
    expect(res).toEqual({ sessions });
  });

  it("DELETEs revokeSession at the encoded session URL and resolves on 204", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.revokeSession("s/2")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/sessions/s%2F2`);
    expect(init!.method).toBe("DELETE");
  });

  it("DELETEs revokeOtherSessions and returns the revoked count", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ revoked: 3 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.revokeOtherSessions();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/sessions/others`);
    expect(init!.method).toBe("DELETE");
    expect(res).toEqual({ revoked: 3 });
  });

  it("forwards optional device metadata on login (deviceName + platform)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ token: "t", user: {} }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.login({
      username: "ali",
      password: "pw",
      deviceName: "Windows · Demli",
      platform: "desktop",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      username: "ali",
      password: "pw",
      deviceName: "Windows · Demli",
      platform: "desktop",
    });
  });

  it("forwards optional device metadata on register", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ token: "t", user: {} }, { status: 201 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.register({
      username: "ali",
      password: "password123",
      platform: "mobile",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      username: "ali",
      password: "password123",
      platform: "mobile",
    });
  });
});
