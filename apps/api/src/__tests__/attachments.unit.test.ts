/**
 * M10-3 attachment unit tests — pure logic (no DB) plus route guards driven with
 * mocked repos (the media.token.test pattern). Covers the security-critical
 * magic-byte sniff, the DTO projection that strips `storagePath`/`status`, size/
 * mime validation, and the guest-deny / feature-disabled / auth guards.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Channel, User } from "@demli/types";
import type { AttachmentRecord, Repositories } from "@demli/db";
import { hashSessionToken } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import {
  assertWithinSizeCap,
  resolveKindOrReject,
  sniffAttachmentKind,
  toAttachmentDTO,
} from "../lib/attachments.js";
import type { AttachmentStorage, ObjectProbe, SignedRead, SignedUpload } from "../lib/storage.js";

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

const sig = (...bytes: number[]) => new Uint8Array(bytes);
const ascii = (text: string, ...trailing: number[]) =>
  new Uint8Array([...[...text].map((c) => c.charCodeAt(0)), ...trailing]);

describe("sniffAttachmentKind", () => {
  it("classifies whitelisted image signatures", () => {
    expect(sniffAttachmentKind(sig(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image"); // PNG
    expect(sniffAttachmentKind(sig(0xff, 0xd8, 0xff, 0xe0))).toBe("image"); // JPEG
    expect(sniffAttachmentKind(ascii("GIF89a"))).toBe("image"); // GIF
    expect(sniffAttachmentKind(riff("WEBP"))).toBe("image"); // WEBP
  });

  it("classifies whitelisted audio signatures", () => {
    expect(sniffAttachmentKind(riff("WAVE"))).toBe("audio"); // WAV
    expect(sniffAttachmentKind(ascii("OggS"))).toBe("audio"); // OGG
    expect(sniffAttachmentKind(ascii("ID3", 0x03))).toBe("audio"); // MP3 (ID3)
    expect(sniffAttachmentKind(sig(0xff, 0xfb))).toBe("audio"); // MP3 frame sync
  });

  it("classifies whitelisted video signatures", () => {
    expect(sniffAttachmentKind(sig(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toBe("video"); // ftyp @4 (MP4)
    expect(sniffAttachmentKind(sig(0x1a, 0x45, 0xdf, 0xa3))).toBe("video"); // WEBM/EBML
  });

  it("returns null for unknown / disguised bytes (e.g. an .exe renamed .png)", () => {
    expect(sniffAttachmentKind(sig(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // MZ (PE executable)
    expect(sniffAttachmentKind(sig(1, 2, 3, 4))).toBeNull();
    expect(sniffAttachmentKind(new Uint8Array(0))).toBeNull();
  });
});

/** Build a RIFF container header whose form-type at offset 8 is `form`. */
function riff(form: string): Uint8Array {
  return new Uint8Array([
    ...[..."RIFF"].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,
    ...[...form].map((c) => c.charCodeAt(0)),
  ]);
}

describe("resolveKindOrReject / assertWithinSizeCap", () => {
  it("maps whitelisted mimes to kinds", () => {
    expect(resolveKindOrReject("image/png")).toBe("image");
    expect(resolveKindOrReject("audio/mpeg")).toBe("audio");
    expect(resolveKindOrReject("video/mp4")).toBe("video");
  });

  it("rejects a non-whitelisted mime (incl. SVG)", () => {
    expect(() => resolveKindOrReject("image/svg+xml")).toThrow();
    expect(() => resolveKindOrReject("application/octet-stream")).toThrow();
  });

  it("rejects sizes over the per-kind cap and accepts sizes at the cap", () => {
    expect(() => assertWithinSizeCap("image", 10 * 1024 * 1024 + 1)).toThrow();
    expect(() => assertWithinSizeCap("image", 10 * 1024 * 1024)).not.toThrow();
    expect(() => assertWithinSizeCap("video", 100 * 1024 * 1024)).not.toThrow();
  });
});

describe("toAttachmentDTO", () => {
  it("projects metadata and strips storagePath + status", () => {
    const record: AttachmentRecord = {
      id: "a1",
      messageId: "m1",
      channelId: "c1",
      uploaderId: "u1",
      kind: "image",
      mime: "image/png",
      sizeBytes: 1234,
      width: 10,
      height: 20,
      durationMs: null,
      isVoiceMessage: false,
      storagePath: "c1/secret-object-key.png",
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    const dto = toAttachmentDTO(record);
    expect(dto).not.toHaveProperty("storagePath");
    expect(dto).not.toHaveProperty("status");
    expect(dto.id).toBe("a1");
    expect(dto.mime).toBe("image/png");
    expect(JSON.stringify(dto)).not.toContain("secret-object-key");
  });
});

// ---------------------------------------------------------------------------
// Route guards with mocked repos
// ---------------------------------------------------------------------------

const SESSION_TOKEN = "attach-unit-session-token";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "attach_tester",
  displayName: "Attach Tester",
  avatarUrl: null,
  createdAt: new Date().toISOString(),
};

const guestChannelId = "22222222-2222-4222-8222-222222222222";

function makeChannel(id: string, kind: Channel["kind"]): Channel {
  return {
    id,
    groupId: "55555555-5555-4555-8555-555555555555",
    kind,
    name: "general",
    position: 0,
    createdAt: new Date().toISOString(),
  };
}

const guestRepos = {
  sessions: {
    findActiveByTokenHash: async (tokenHash: string) =>
      tokenHash === hashSessionToken(SESSION_TOKEN) ? { session: {}, user } : null,
  },
  channels: {
    findWithMembership: async (channelId: string, userId: string) =>
      userId === user.id && channelId === guestChannelId
        ? { channel: makeChannel(channelId, "text"), role: "guest" as const }
        : null,
  },
  channelAccess: { canUserSeeChannel: async () => true },
} as unknown as Repositories;

class NoopStorage implements AttachmentStorage {
  async createSignedUploadUrl(): Promise<SignedUpload> {
    return { uploadUrl: "https://noop/upload", expiresAt: new Date().toISOString() };
  }
  async createSignedReadUrl(): Promise<SignedRead> {
    return { url: "https://noop/read", expiresAt: new Date().toISOString() };
  }
  async probeObject(): Promise<ObjectProbe> {
    return { exists: true, sizeBytes: 0, head: new Uint8Array(0) };
  }
  async upload(): Promise<void> {}
  async remove(): Promise<void> {}
}

const env = loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" });

describe("upload-url guards (mocked repos)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ repos: guestRepos, env, storage: new NoopStorage(), logger: false });
  });
  afterAll(async () => {
    await app?.close();
  });

  const upload = (token: string | null) =>
    app.inject({
      method: "POST",
      url: `/channels/${guestChannelId}/attachments/upload-url`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { mime: "image/png", sizeBytes: 1024 },
    });

  it("requires authentication", async () => {
    const res = await upload(null);
    expect(res.statusCode).toBe(401);
  });

  it("forbids guests from uploading (403)", async () => {
    const res = await upload(SESSION_TOKEN);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});

describe("attachments disabled (storage null)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ repos: guestRepos, env, storage: null, logger: false });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("answers ATTACHMENTS_DISABLED (503) on upload-url", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/channels/${guestChannelId}/attachments/upload-url`,
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: { mime: "image/png", sizeBytes: 1024 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ATTACHMENTS_DISABLED");
  });
});
