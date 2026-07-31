import { describe, expect, it } from "vitest";
import { parseYouTubeVideoId, WATCH_VIDEO_REF_MAX_LENGTH } from "@demli/config";
import { clientEvent, CLIENT_EVENT, serverEvent, SERVER_EVENT } from "../factories.js";
import {
  clientToServerEventSchema,
  serverToClientEventSchema,
  watchControlPayloadSchema,
  watchSessionStatePayloadSchema,
  watchStartPayloadSchema,
  watchVideoIdSchema,
  watchVideoRefSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Watch Party contract (M20, ADR 0016).
//
// The bulk of this file is the VIDEO REFERENCE boundary, because that is the one
// client-controlled string that ends up inside an iframe URL on every other
// member's machine. The rule under test: a reference is accepted only if it
// normalizes to exactly 11 URL-safe characters, and only that normalized id ever
// appears on a server→client payload.
// ---------------------------------------------------------------------------

const CH = "11111111-1111-4111-8111-111111111111";
const UID = "33333333-3333-4333-8333-333333333333";
const VIDEO = "dQw4w9WgXcQ"; // 11 chars, the canonical shape

describe("YouTube video reference normalization", () => {
  it("accepts a bare id and the ordinary link shapes people paste", () => {
    const refs = [
      VIDEO,
      `  ${VIDEO}  `,
      `https://www.youtube.com/watch?v=${VIDEO}`,
      `https://www.youtube.com/watch?v=${VIDEO}&t=42s&list=PLabc`,
      `http://youtube.com/watch?v=${VIDEO}`,
      `https://m.youtube.com/watch?v=${VIDEO}`,
      `https://music.youtube.com/watch?v=${VIDEO}`,
      `https://youtu.be/${VIDEO}`,
      `https://youtu.be/${VIDEO}?t=90`,
      `youtu.be/${VIDEO}`,
      `www.youtube.com/watch?v=${VIDEO}`,
      `https://www.youtube-nocookie.com/embed/${VIDEO}`,
      `https://www.youtube.com/embed/${VIDEO}`,
      `https://www.youtube.com/shorts/${VIDEO}`,
      `https://www.youtube.com/live/${VIDEO}`,
      `https://www.youtube.com/v/${VIDEO}`,
    ];
    for (const ref of refs) {
      expect(parseYouTubeVideoId(ref), ref).toBe(VIDEO);
    }
  });

  it("refuses everything that is not a YouTube video reference", () => {
    const refs = [
      "",
      "   ",
      "not an id",
      // Wrong length — 10 and 12 chars must both fail, or the "exactly 11" claim
      // is not a claim at all.
      "dQw4w9WgXc",
      "dQw4w9WgXcQQ",
      // Characters that would escape the path segment an id is placed in.
      "dQw4w9WgXc/",
      "dQw4w9WgX.Q",
      "dQw4w9WgX?Q",
      "../../../etc",
      // Hosts we do not embed, including lookalikes that merely CONTAIN a
      // trusted name — the check is exact-hostname, never a substring.
      `https://evil.test/watch?v=${VIDEO}`,
      `https://youtube.com.evil.test/watch?v=${VIDEO}`,
      `https://notyoutube.com/watch?v=${VIDEO}`,
      `https://evil.test/?a=youtube.com/watch?v=${VIDEO}`,
      // Non-http(s) schemes: the payload must never carry an executable URL.
      `javascript:alert(1)//youtube.com/watch?v=${VIDEO}`,
      `data:text/html,<script>alert(1)</script>`,
      `file:///etc/passwd`,
      // Right host, but the id is somewhere we do not read from.
      "https://www.youtube.com/watch",
      `https://www.youtube.com/#v=${VIDEO}`,
      `https://www.youtube.com/results?search_query=${VIDEO}`,
      // Over the length bound.
      `https://www.youtube.com/watch?v=${VIDEO}&pad=${"x".repeat(WATCH_VIDEO_REF_MAX_LENGTH)}`,
    ];
    for (const ref of refs) {
      expect(parseYouTubeVideoId(ref), ref).toBeNull();
    }
  });

  it("never returns anything but 11 URL-safe characters", () => {
    // Property-ish sweep: whatever the input, the output is either null or a
    // string that cannot break out of a path segment.
    const inputs = [
      VIDEO,
      `https://youtu.be/${VIDEO}`,
      "https://youtu.be/../../admin",
      `https://www.youtube.com/embed/${VIDEO}/../../evil`,
      "https://www.youtube.com/watch?v=%2e%2e%2f%2e%2e",
      "javascript:void(0)",
    ];
    for (const input of inputs) {
      const parsed = parseYouTubeVideoId(input);
      if (parsed !== null) expect(parsed).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });
});

describe("watch payload schemas", () => {
  it("accepts a link as a videoRef and rejects an unparseable one at the boundary", () => {
    expect(watchVideoRefSchema.safeParse(`https://youtu.be/${VIDEO}`).success).toBe(true);
    expect(watchVideoRefSchema.safeParse(VIDEO).success).toBe(true);
    expect(watchVideoRefSchema.safeParse("https://evil.test/x").success).toBe(false);
    expect(watchVideoRefSchema.safeParse("").success).toBe(false);
    expect(watchVideoRefSchema.safeParse("x".repeat(WATCH_VIDEO_REF_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it("only lets a normalized id into a server→client payload", () => {
    expect(watchVideoIdSchema.safeParse(VIDEO).success).toBe(true);
    // A URL is a valid REF but never a valid id: the server stores the parse
    // result, so a payload carrying a raw link is a contract violation.
    expect(watchVideoIdSchema.safeParse(`https://youtu.be/${VIDEO}`).success).toBe(false);
    expect(
      serverToClientEventSchema.safeParse(
        serverEvent.watchStarted({
          channelId: CH,
          hostId: UID,
          source: "youtube",
          videoId: `https://youtu.be/${VIDEO}`,
          positionSec: 0,
          playing: true,
          serverTime: new Date().toISOString(),
        }),
      ).success,
    ).toBe(false);
  });

  it("bounds the playback position", () => {
    const base = { channelId: CH, action: "seek" as const };
    expect(watchControlPayloadSchema.safeParse({ ...base, positionSec: 0 }).success).toBe(true);
    expect(watchControlPayloadSchema.safeParse({ ...base, positionSec: 1234.5 }).success).toBe(
      true,
    );
    expect(watchControlPayloadSchema.safeParse({ ...base, positionSec: -1 }).success).toBe(false);
    expect(watchControlPayloadSchema.safeParse({ ...base, positionSec: 1e12 }).success).toBe(
      false,
    );
    expect(
      watchControlPayloadSchema.safeParse({ ...base, positionSec: Number.NaN }).success,
    ).toBe(false);
    expect(
      watchControlPayloadSchema.safeParse({ ...base, positionSec: Number.POSITIVE_INFINITY })
        .success,
    ).toBe(false);
  });

  it("closes the action and source enums", () => {
    expect(
      watchControlPayloadSchema.safeParse({ channelId: CH, action: "stop", positionSec: 0 })
        .success,
    ).toBe(false);
    expect(
      watchStartPayloadSchema.safeParse({ channelId: CH, source: "vimeo", videoRef: VIDEO })
        .success,
    ).toBe(false);
  });
});

describe("watch events on the wire", () => {
  it("round-trips every client→server watch frame through the union", () => {
    const frames = [
      clientEvent.watchStart({ channelId: CH, source: "youtube", videoRef: VIDEO }),
      clientEvent.watchControl({ channelId: CH, action: "play", positionSec: 12.5 }),
      clientEvent.watchSetVideo({ channelId: CH, videoRef: `https://youtu.be/${VIDEO}` }),
      clientEvent.watchTransferHost({ channelId: CH, toUserId: UID }),
      clientEvent.watchStop({ channelId: CH }),
    ];
    for (const frame of frames) {
      const parsed = clientToServerEventSchema.safeParse(frame);
      expect(parsed.success, frame.type).toBe(true);
    }
    expect(frames.map((f) => f.type)).toEqual([
      CLIENT_EVENT.watchStart,
      CLIENT_EVENT.watchControl,
      CLIENT_EVENT.watchSetVideo,
      CLIENT_EVENT.watchTransferHost,
      CLIENT_EVENT.watchStop,
    ]);
  });

  it("round-trips every server→client watch frame through the union", () => {
    const state = {
      channelId: CH,
      hostId: UID,
      source: "youtube" as const,
      videoId: VIDEO,
      positionSec: 42.25,
      playing: false,
      serverTime: new Date().toISOString(),
    };
    const frames = [
      serverEvent.watchStarted(state),
      serverEvent.watchState(state),
      serverEvent.watchHostChanged({ channelId: CH, hostId: UID }),
      serverEvent.watchStopped({ channelId: CH, reason: "channel_empty" }),
    ];
    for (const frame of frames) {
      expect(serverToClientEventSchema.safeParse(frame).success, frame.type).toBe(true);
    }
    expect(frames.map((f) => f.type)).toEqual([
      SERVER_EVENT.watchStarted,
      SERVER_EVENT.watchState,
      SERVER_EVENT.watchHostChanged,
      SERVER_EVENT.watchStopped,
    ]);
    // `watch.started` and `watch.state` share one payload shape on purpose, so a
    // client can fold either through the same upsert.
    expect(watchSessionStatePayloadSchema.safeParse(state).success).toBe(true);
  });

  it("closes the stop reason enum", () => {
    expect(
      serverToClientEventSchema.safeParse({
        type: SERVER_EVENT.watchStopped,
        payload: { channelId: CH, reason: "because" },
      }).success,
    ).toBe(false);
  });
});
