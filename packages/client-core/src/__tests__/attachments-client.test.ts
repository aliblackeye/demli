import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient } from "../api-client.js";

const BASE = "http://api.test:4000";
/** A well-formed client mark; the factories reject a malformed one. */
const TEST_SIGNATURE = "demli-test/1";

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

function stubFetch(respond: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(
    (input: string, init?: RequestInit): Promise<Response> => Promise.resolve(respond(input, init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient — attachment endpoints (ADR 0008)", () => {
  it("POSTs upload-url with the encoded channel id and mime/size/filename body", async () => {
    const grant = {
      attachmentId: "att1",
      uploadUrl: "https://storage.test/signed?token=abc",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const fetchMock = stubFetch(() => jsonResponse(grant, { status: 201 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.createAttachmentUploadUrl("chan/1", {
      mime: "image/png",
      sizeBytes: 2048,
      filename: "cat.png",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/chan%2F1/attachments/upload-url`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      mime: "image/png",
      sizeBytes: 2048,
      filename: "cat.png",
    });
    expect(res).toEqual(grant);
  });

  it("POSTs complete at the encoded attachment id with a dims body", async () => {
    const attachment = { id: "att1", kind: "image", width: 800, height: 600 };
    const fetchMock = stubFetch(() => jsonResponse({ attachment }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.completeAttachment("att/1", { width: 800, height: 600 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/attachments/att%2F1/complete`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ width: 800, height: 600 });
    expect(res).toEqual({ attachment });
  });

  it("POSTs complete with an empty body when no dims are given", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ attachment: { id: "att1" } }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await api.completeAttachment("att1");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({});
  });

  it("DELETEs cancelAttachment at the encoded id and resolves on 204", async () => {
    const fetchMock = stubFetch(() => jsonResponse(null, { status: 204 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    await expect(api.cancelAttachment("att/1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/attachments/att%2F1`);
    expect(init!.method).toBe("DELETE");
  });

  it("POSTs getAttachmentUrls with the id array and returns the urls", async () => {
    const urls = [
      { attachmentId: "att1", url: "https://cdn/att1?sig=x", urlExpiresAt: "2026-01-01T01:00:00.000Z" },
    ];
    const fetchMock = stubFetch(() => jsonResponse({ urls }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.getAttachmentUrls("chan1", ["att1", "att2"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/chan1/attachments/urls`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ attachmentIds: ["att1", "att2"] });
    expect(res).toEqual({ urls });
  });

  it("POSTs sendMessage with content + attachmentIds to the channel messages URL", async () => {
    const message = { id: "m1", content: "hi", attachments: [] };
    const fetchMock = stubFetch(() => jsonResponse({ message }, { status: 201 }));

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const res = await api.sendMessage("chan1", { content: "hi", attachmentIds: ["att1"] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/chan1/messages`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ content: "hi", attachmentIds: ["att1"] });
    expect(res).toEqual({ message });
  });

  it("maps a 503 ATTACHMENTS_DISABLED body to a typed error", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "ATTACHMENTS_DISABLED", message: "Media uploads are disabled." } },
        { status: 503 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api
      .createAttachmentUploadUrl("chan1", { mime: "image/png", sizeBytes: 10 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe("ATTACHMENTS_DISABLED");
    expect((err as ApiClientError).status).toBe(503);
  });

  it("maps a 400 INVALID_ATTACHMENT body to a typed error", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: "INVALID_ATTACHMENT", message: "That file type is not allowed." } },
        { status: 400 },
      ),
    );

    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE });
    const err = await api.completeAttachment("att1").catch((e: unknown) => e);

    expect((err as ApiClientError).code).toBe("INVALID_ATTACHMENT");
    expect((err as ApiClientError).status).toBe(400);
  });
});
