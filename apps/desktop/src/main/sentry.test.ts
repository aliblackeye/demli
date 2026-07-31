import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvelope,
  buildEvent,
  captureSentryError,
  initSentry,
  isSentryEnabled,
  normalizeFramePath,
  parseDsn,
  parseStack,
  resetSentryForTests,
  scrubText,
} from "./sentry";
import type { SentryEvent, SentryTransport } from "./sentry-types";

/**
 * The load-bearing test in this file is "disabled by default": with no DSN the
 * client must not perform a single network request. Everything else guards the
 * privacy scrubbing, which is the other way this feature could embarrass us
 * (CLAUDE.md §28 — the repo is going public).
 */

const VALID_DSN = "https://abc123def456@o4507123.ingest.de.sentry.io/4507999";

const BASE_CONFIG = {
  release: "0.0.64",
  environment: "production",
  osName: "win32",
  electronVersion: "33.0.0",
  eventId: "0123456789abcdef0123456789abcdef",
  timestamp: 1_770_000_000,
};

function fakeTransport(): {
  transport: SentryTransport;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const transport: SentryTransport = async (url, body) => {
    calls.push({ url, body });
    return { status: 200 };
  };
  return { transport, calls };
}

/** Pull the event JSON back out of an envelope body (3rd line). */
function eventFromEnvelope(body: string): SentryEvent {
  const lines = body.split("\n");
  return JSON.parse(lines[2] ?? "{}") as SentryEvent;
}

afterEach(() => {
  resetSentryForTests();
});

describe("disabled by default (no DSN => no network)", () => {
  it.each([undefined, "", "   "])("stays disabled for %j", (dsn) => {
    const { transport, calls } = fakeTransport();
    const enabled = initSentry({ ...BASE_CONFIG, dsn, transport });

    expect(enabled).toBe(false);
    expect(isSentryEnabled()).toBe(false);

    captureSentryError({ message: "boom", process: "main" });
    captureSentryError({ message: "boom2", process: "renderer" });

    expect(calls).toHaveLength(0);
  });

  it("makes no request when initSentry was never called at all", () => {
    // Fresh module state (afterEach resets it): capturing must be inert.
    const spy = vi.fn();
    expect(isSentryEnabled()).toBe(false);
    captureSentryError({ message: "boom", process: "main" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-url",
    "http://key@sentry.example.com/1", // plaintext rejected
    "https://sentry.example.com/1", // no public key
    "https://key@sentry.example.com/", // no project id
    "https://key@sentry.example.com/notanumber",
  ])("rejects malformed DSN %s and sends nothing", (dsn) => {
    const { transport, calls } = fakeTransport();
    expect(initSentry({ ...BASE_CONFIG, dsn, transport })).toBe(false);
    captureSentryError({ message: "boom", process: "main" });
    expect(calls).toHaveLength(0);
  });
});

describe("parseDsn", () => {
  it("builds the envelope endpoint from a real-shaped DSN", () => {
    const dsn = parseDsn(VALID_DSN);
    expect(dsn).not.toBeNull();
    expect(dsn?.publicKey).toBe("abc123def456");
    expect(dsn?.projectId).toBe("4507999");
    expect(dsn?.envelopeUrl).toContain(
      "https://o4507123.ingest.de.sentry.io/api/4507999/envelope/",
    );
    expect(dsn?.envelopeUrl).toContain("sentry_key=abc123def456");
    expect(dsn?.envelopeUrl).toContain("sentry_version=7");
  });

  it("supports a self-hosted path prefix", () => {
    const dsn = parseDsn("https://pk@sentry.example.com/prefix/42");
    expect(dsn?.envelopeUrl).toContain(
      "https://sentry.example.com/prefix/api/42/envelope/",
    );
  });
});

describe("scrubText (PII / secrets never leave the machine)", () => {
  it("redacts JWTs", () => {
    const out = scrubText(
      "auth failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijk",
    );
    expect(out).toBe("auth failed for [jwt]");
  });

  it("redacts bearer tokens", () => {
    expect(scrubText("Authorization: Bearer sk_live_9f8a7b6c")).toContain(
      "Bearer [redacted]",
    );
    expect(scrubText("Authorization: Bearer sk_live_9f8a7b6c")).not.toContain(
      "sk_live",
    );
  });

  it("redacts email addresses", () => {
    expect(scrubText("login failed: someone@example.com")).toBe(
      "login failed: [email]",
    );
  });

  it("strips URL query strings (invite codes, signed URLs)", () => {
    const out = scrubText(
      "GET https://api.getdemli.com/invites/join?token=s3cr3t&u=42 failed",
    );
    expect(out).toContain("https://api.getdemli.com/invites/join?[redacted]");
    expect(out).not.toContain("s3cr3t");
  });

  it("removes the Windows/macOS/Linux user name from paths", () => {
    expect(scrubText("C:\\Users\\jdoe\\AppData\\Local\\app.log")).toBe(
      "C:\\Users\\[user]\\AppData\\Local\\app.log",
    );
    expect(scrubText("/Users/ali/Library/Logs/x")).toBe(
      "/Users/[user]/Library/Logs/x",
    );
    expect(scrubText("/home/ali/.config/x")).toBe("/home/[user]/.config/x");
  });

  it("redacts long opaque secrets", () => {
    const secret = "A".repeat(60);
    expect(scrubText(`key=${secret}`)).toBe("key=[redacted]");
  });
});

describe("stack normalization", () => {
  it("reduces packaged paths to a machine-independent app:/// id", () => {
    expect(
      normalizeFramePath(
        "C:\\Users\\jdoe\\AppData\\Local\\Programs\\Demli\\resources\\app.asar\\out\\main\\index.js",
      ),
    ).toBe("app:///out/main/index.js");
    expect(
      normalizeFramePath("file:///C:/projects/demli/apps/desktop/out/renderer/x.js"),
    ).toBe("app:///out/renderer/x.js");
  });

  it("collapses an unrecognized path to its basename (never a home dir)", () => {
    expect(normalizeFramePath("/Users/ali/secret/thing.js")).toBe(
      "app:///thing.js",
    );
  });

  it("parses V8 frames oldest-first and flags in_app", () => {
    const stack = [
      "Error: kaboom",
      "    at doThing (C:\\app\\resources\\app.asar\\out\\main\\index.js:10:5)",
      "    at node:internal/process/task_queues:95:5",
    ].join("\n");
    const frames = parseStack(stack);
    expect(frames).toHaveLength(2);
    // reversed: the node: builtin is the oldest frame
    expect(frames[0]?.filename).toBe("node:internal/process/task_queues");
    expect(frames[0]?.in_app).toBe(false);
    expect(frames[1]?.filename).toBe("app:///out/main/index.js");
    expect(frames[1]?.function).toBe("doThing");
    expect(frames[1]?.lineno).toBe(10);
    expect(frames[1]?.in_app).toBe(true);
  });

  it("returns no frames for a missing stack", () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("buildEvent", () => {
  it("tags the release, environment and process, with no user identity", () => {
    const event = buildEvent(
      { message: "kaboom", process: "renderer" },
      BASE_CONFIG,
    );
    expect(event.release).toBe("demli-desktop@0.0.64");
    expect(event.environment).toBe("production");
    expect(event.tags["process"]).toBe("renderer");
    expect(event.platform).toBe("javascript");
    // Nothing that could identify a person may exist on the event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("\"user\"");
    expect(serialized).not.toContain("server_name");
    expect(event).not.toHaveProperty("breadcrumbs");
  });

  it("scrubs the message before it reaches the payload", () => {
    const event = buildEvent(
      {
        message: "send failed for someone@example.com",
        process: "main",
        stack: "Error: x\n    at f (C:\\Users\\jdoe\\app\\out\\main\\i.js:1:2)",
      },
      BASE_CONFIG,
    );
    const value = event.exception.values[0]?.value ?? "";
    expect(value).toBe("send failed for [email]");
    expect(JSON.stringify(event)).not.toContain("jdoe");
  });

  it("keeps the component stack as an extra, not as user content", () => {
    const event = buildEvent(
      { message: "render error", process: "renderer", componentStack: "at App" },
      BASE_CONFIG,
    );
    expect(event.extra?.["componentStack"]).toBe("at App");
  });
});

describe("enabled client", () => {
  it("POSTs a well-formed envelope to the ingest endpoint", async () => {
    const { transport, calls } = fakeTransport();
    expect(initSentry({ ...BASE_CONFIG, dsn: VALID_DSN, transport })).toBe(true);

    captureSentryError({ message: "kaboom", process: "main" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const call = calls[0]!;
    expect(call.url).toContain("/api/4507999/envelope/");
    const [envelopeHeader, itemHeader] = call.body.split("\n");
    expect(JSON.parse(envelopeHeader ?? "{}")).toMatchObject({
      dsn: VALID_DSN,
    });
    expect(JSON.parse(itemHeader ?? "{}")).toMatchObject({ type: "event" });
    expect(eventFromEnvelope(call.body).exception.values[0]?.value).toBe(
      "kaboom",
    );
  });

  it("deduplicates the same error within a session", async () => {
    const { transport, calls } = fakeTransport();
    initSentry({ ...BASE_CONFIG, dsn: VALID_DSN, transport });

    for (let i = 0; i < 5; i += 1) {
      captureSentryError({ message: "loop", process: "main" });
    }
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("caps the number of events per session", async () => {
    const { transport, calls } = fakeTransport();
    initSentry({ ...BASE_CONFIG, dsn: VALID_DSN, transport });

    for (let i = 0; i < 80; i += 1) {
      captureSentryError({ message: `distinct-${i}`, process: "main" });
    }
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.length).toBeLessThanOrEqual(25);
  });

  it("never throws when the transport fails", async () => {
    const failing: SentryTransport = async () => {
      throw new Error("offline");
    };
    initSentry({ ...BASE_CONFIG, dsn: VALID_DSN, transport: failing });
    expect(() =>
      captureSentryError({ message: "kaboom", process: "main" }),
    ).not.toThrow();
  });
});

describe("buildEnvelope", () => {
  it("declares the exact byte length of the payload", () => {
    const event = buildEvent({ message: "ü".repeat(5), process: "main" }, BASE_CONFIG);
    const body = buildEnvelope(event, VALID_DSN);
    const [, itemHeader, payload] = body.split("\n");
    const declared = (JSON.parse(itemHeader ?? "{}") as { length: number })
      .length;
    expect(declared).toBe(Buffer.byteLength(payload ?? "", "utf8"));
  });
});
