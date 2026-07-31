/**
 * Boundary cases for the remaining REST bodies: users, groups, channels,
 * categories, roles, invites, emojis, messages.
 *
 * Each schema gets the same four questions — does the minimum hold, does the
 * maximum hold one character either side of the line, is invisible input
 * refused, and does the sanitized value come back out.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AUDIO_BITRATE_PRESETS_KBPS,
  BIO_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_MAX_PARTICIPANTS,
  CHANNEL_NAME_MAX_LENGTH,
  CUSTOM_STATUS_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  INVITE_EXPIRES_HOURS_MAX,
  INVITE_MAX_USES_MAX,
  isAudioBitratePreset,
  MESSAGE_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from "@demli/config";
import { validationCodeOf, type ValidationCode } from "../requests/codes.js";
import {
  setCustomStatusBodySchema,
  updateProfileBodySchema,
} from "../requests/users.js";
import {
  addGroupChatMemberBodySchema,
  banBodySchema,
  createGroupBodySchema,
  updateGroupBodySchema,
} from "../requests/groups.js";
import {
  createChannelBodySchema,
  updateChannelBodySchema,
} from "../requests/channels.js";
import {
  createCategoryBodySchema,
  reorderChannelsBodySchema,
} from "../requests/categories.js";
import { createRoleBodySchema, updateRoleBodySchema } from "../requests/roles.js";
import {
  INVITE_LINK_PREFIX,
  buildInviteLink,
  createInviteBodySchema,
  findInviteCodesInText,
  inviteCodeField,
  isInviteLinkUrl,
  parseInviteCode,
} from "../requests/invites.js";
import { createEmojiBodySchema } from "../requests/emojis.js";
import {
  createMessageBodySchema,
  editMessageBodySchema,
  messageListQuerySchema,
} from "../requests/messages.js";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "a1b2c3d4-4f89-11d3-9a0c-0305e82c3301";

const ZWSP = "\u200B";

function codes(result: z.SafeParseReturnType<unknown, unknown>): ValidationCode[] {
  if (result.success) return [];
  return result.error.issues
    .map((issue) => validationCodeOf(issue))
    .filter((code): code is ValidationCode => code !== null);
}

describe("updateProfileBodySchema", () => {
  it("rejects an empty body", () => {
    expect(codes(updateProfileBodySchema.safeParse({}))).toContain("emptyUpdate");
  });

  it("sanitizes and caps the bio", () => {
    expect(updateProfileBodySchema.parse({ bio: `  merhaba${ZWSP}  ` }).bio).toBe("merhaba");
    expect(
      updateProfileBodySchema.safeParse({ bio: "a".repeat(BIO_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      updateProfileBodySchema.safeParse({ bio: "a".repeat(BIO_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("keeps line breaks in the bio", () => {
    expect(updateProfileBodySchema.parse({ bio: "bir\r\niki" }).bio).toBe("bir\niki");
  });

  it("accepts null to clear the bio and the banner", () => {
    expect(updateProfileBodySchema.parse({ bio: null }).bio).toBeNull();
    expect(updateProfileBodySchema.parse({ bannerUrl: null }).bannerUrl).toBeNull();
  });

  it("refuses a javascript: avatar URL", () => {
    expect(codes(updateProfileBodySchema.safeParse({ avatarUrl: "javascript:alert(1)" })))
      .toContain("invalidUrl");
  });

  it("accepts a real https avatar URL", () => {
    const url = "https://cdn.karagozali.com/a/1.png";
    expect(updateProfileBodySchema.parse({ avatarUrl: url }).avatarUrl).toBe(url);
  });
});

describe("setCustomStatusBodySchema", () => {
  it("accepts an empty string as a clear", () => {
    expect(setCustomStatusBodySchema.parse({ text: "   " }).text).toBe("");
  });

  it("accepts null as a clear", () => {
    expect(setCustomStatusBodySchema.parse({ text: null }).text).toBeNull();
  });

  it("caps at 128", () => {
    const at = "a".repeat(CUSTOM_STATUS_MAX_LENGTH);
    expect(setCustomStatusBodySchema.safeParse({ text: at }).success).toBe(true);
    expect(setCustomStatusBodySchema.safeParse({ text: `${at}a` }).success).toBe(false);
  });

  it("bounds the expiry window", () => {
    expect(setCustomStatusBodySchema.safeParse({ text: "x", expiresInMinutes: 0 }).success)
      .toBe(false);
    expect(
      setCustomStatusBodySchema.safeParse({ text: "x", expiresInMinutes: 7 * 24 * 60 }).success,
    ).toBe(true);
    expect(
      setCustomStatusBodySchema.safeParse({ text: "x", expiresInMinutes: 7 * 24 * 60 + 1 })
        .success,
    ).toBe(false);
  });
});

describe("group bodies", () => {
  it("trims and bounds the server name", () => {
    expect(createGroupBodySchema.parse({ name: "  Demli  " }).name).toBe("Demli");
    expect(createGroupBodySchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      createGroupBodySchema.safeParse({ name: "a".repeat(GROUP_NAME_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      createGroupBodySchema.safeParse({ name: "a".repeat(GROUP_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("rejects an all-invisible server name", () => {
    // Zero-width space + zero-width joiner: passes `min(1)` on the raw string,
    // survives sanitizing (the joiner is kept), and renders as a blank rail icon.
    const invisible = `${ZWSP}\u200D`;
    expect(codes(createGroupBodySchema.safeParse({ name: invisible }))).toContain(
      "noVisibleCharacter",
    );
  });

  it("rejects an empty group update", () => {
    expect(codes(updateGroupBodySchema.safeParse({}))).toContain("emptyUpdate");
  });

  it("only allows the two invite policies", () => {
    expect(updateGroupBodySchema.safeParse({ invitePolicy: "members" }).success).toBe(true);
    expect(updateGroupBodySchema.safeParse({ invitePolicy: "anyone" }).success).toBe(false);
  });

  it("strips a leading @ from an add-by-username body", () => {
    expect(addGroupChatMemberBodySchema.parse({ username: " @AliKaragoz " }).username).toBe(
      "alikaragoz",
    );
  });

  it("rejects a username longer than a username can be", () => {
    expect(addGroupChatMemberBodySchema.safeParse({ username: "a".repeat(33) }).success).toBe(
      false,
    );
  });

  it("does NOT enforce the username grammar (no existence oracle)", () => {
    // A legal-looking unknown name and an illegal one must both reach the
    // handler and get the same uniform answer.
    expect(addGroupChatMemberBodySchema.safeParse({ username: "ali.karagoz" }).success).toBe(
      true,
    );
  });

  it("sanitizes a ban reason and allows omitting it", () => {
    expect(banBodySchema.parse({ userId: UUID }).reason).toBeUndefined();
    expect(banBodySchema.parse({ userId: UUID, reason: "  spam  " }).reason).toBe("spam");
  });

  it("rejects a non-uuid target", () => {
    expect(banBodySchema.safeParse({ userId: "nope" }).success).toBe(false);
  });
});

describe("channel bodies", () => {
  const valid = { name: "genel", kind: "text" } as const;

  it("bounds the channel name", () => {
    expect(
      createChannelBodySchema.safeParse({ ...valid, name: "a".repeat(CHANNEL_NAME_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      createChannelBodySchema.safeParse({
        ...valid,
        name: "a".repeat(CHANNEL_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("only allows text and voice", () => {
    expect(createChannelBodySchema.safeParse({ ...valid, kind: "stage" }).success).toBe(false);
  });

  it("allows a 512-character description — the API's real limit", () => {
    // The desktop dialog capped this at 280 while the API accepted 512, so the
    // client refused text the server would happily have stored.
    const at = "a".repeat(CHANNEL_DESCRIPTION_MAX_LENGTH);
    expect(updateChannelBodySchema.safeParse({ description: at }).success).toBe(true);
    expect(updateChannelBodySchema.safeParse({ description: `${at}a` }).success).toBe(false);
  });

  it("bounds maxParticipants to 1..99 integers", () => {
    expect(updateChannelBodySchema.safeParse({ maxParticipants: 0 }).success).toBe(false);
    expect(updateChannelBodySchema.safeParse({ maxParticipants: 1 }).success).toBe(true);
    expect(
      updateChannelBodySchema.safeParse({ maxParticipants: CHANNEL_MAX_PARTICIPANTS }).success,
    ).toBe(true);
    expect(
      updateChannelBodySchema.safeParse({ maxParticipants: CHANNEL_MAX_PARTICIPANTS + 1 })
        .success,
    ).toBe(false);
    expect(updateChannelBodySchema.safeParse({ maxParticipants: 4.5 }).success).toBe(false);
  });

  it("bounds the audio bitrate to the Opus window", () => {
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 7 }).success).toBe(false);
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 8 }).success).toBe(true);
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 510 }).success).toBe(true);
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 511 }).success).toBe(false);
  });

  it("accepts every offered bitrate preset", () => {
    // The UI's three steps must be legal values — if a preset ever fell outside the
    // schema window the picker would offer a choice the server rejects.
    for (const kbps of AUDIO_BITRATE_PRESETS_KBPS) {
      expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: kbps }).success).toBe(true);
      expect(isAudioBitratePreset(kbps)).toBe(true);
    }
    expect(AUDIO_BITRATE_PRESETS_KBPS).toEqual([8, 64, 128]);
  });

  it("still accepts values ABOVE the offered presets, so existing channels keep working", () => {
    // The presets narrowed the UI, NOT the contract. A channel configured at 256 kbps
    // before the picker landed must remain saveable and must not be reported as a
    // preset (the UI shows it as a custom value instead of snapping it to 128).
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 256 }).success).toBe(true);
    expect(updateChannelBodySchema.safeParse({ audioBitrateKbps: 96 }).success).toBe(true);
    expect(isAudioBitratePreset(256)).toBe(false);
    expect(isAudioBitratePreset(96)).toBe(false);
  });

  it("rejects an empty channel update", () => {
    expect(codes(updateChannelBodySchema.safeParse({}))).toContain("emptyUpdate");
  });
});

describe("category bodies", () => {
  it("bounds the category name", () => {
    expect(createCategoryBodySchema.parse({ name: " Sesli " }).name).toBe("Sesli");
    expect(
      createCategoryBodySchema.safeParse({ name: "a".repeat(CATEGORY_NAME_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it("rejects a reorder that moves nothing", () => {
    expect(codes(reorderChannelsBodySchema.safeParse({}))).toContain("emptyUpdate");
    expect(codes(reorderChannelsBodySchema.safeParse({ categoryIds: [] }))).toContain(
      "emptyUpdate",
    );
  });

  it("accepts a reorder that moves a channel out of every category", () => {
    const body = { channels: [{ channelId: UUID, categoryId: null }] };
    expect(reorderChannelsBodySchema.safeParse(body).success).toBe(true);
  });
});

describe("role bodies", () => {
  it("bounds the role name", () => {
    expect(
      createRoleBodySchema.safeParse({ name: "a".repeat(ROLE_NAME_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      createRoleBodySchema.safeParse({ name: "a".repeat(ROLE_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("accepts a #rrggbb colour and null", () => {
    expect(createRoleBodySchema.parse({ name: "Admin", color: "#7c3aed" }).color).toBe("#7c3aed");
    expect(createRoleBodySchema.parse({ name: "Admin", color: null }).color).toBeNull();
  });

  it("rejects any other colour notation", () => {
    for (const bad of ["7c3aed", "#7c3ae", "#7c3aedd", "rgb(1,2,3)", "red"]) {
      expect(codes(createRoleBodySchema.safeParse({ name: "Admin", color: bad }))).toContain(
        "hexColorPattern",
      );
    }
  });

  it("rejects negative or fractional permission bits", () => {
    expect(createRoleBodySchema.safeParse({ name: "A", permissions: -1 }).success).toBe(false);
    expect(createRoleBodySchema.safeParse({ name: "A", permissions: 1.5 }).success).toBe(false);
    expect(createRoleBodySchema.safeParse({ name: "A", permissions: 0 }).success).toBe(true);
  });

  it("rejects an empty role update", () => {
    expect(codes(updateRoleBodySchema.safeParse({}))).toContain("emptyUpdate");
  });
});

describe("invite bodies", () => {
  it("builds the branded ENGLISH https link (no /kat/)", () => {
    expect(buildInviteLink("ab12cd34")).toBe("https://app.getdemli.com/invite/ab12cd34");
    expect(INVITE_LINK_PREFIX).not.toContain("/kat/");
  });

  it("parses a bare code unchanged", () => {
    expect(parseInviteCode("  ab12cd34  ")).toBe("ab12cd34");
  });

  it("parses the canonical link, the short link, and a link with a tail", () => {
    expect(parseInviteCode(buildInviteLink("ab12cd34"))).toBe("ab12cd34");
    expect(parseInviteCode("https://app.getdemli.com/invite/ab12cd34")).toBe("ab12cd34");
    expect(parseInviteCode("https://app.getdemli.com/kat/ab12cd34")).toBe("ab12cd34");
    expect(parseInviteCode("https://karagozali.com/kat/ab12cd34")).toBe("ab12cd34");
    expect(parseInviteCode("demli://join/ab12cd34?ref=x#y")).toBe("ab12cd34");
  });

  it("accepts a pasted link even though the raw text exceeds the code cap", () => {
    const long = `https://karagozali.com/kat/ab12cd34?utm_source=${"x".repeat(100)}`;
    expect(inviteCodeField.parse(long)).toBe("ab12cd34");
  });

  it("rejects input that yields nothing usable", () => {
    for (const bad of ["", "   ", "abc", "https://karagozali.com/kat/", "///"]) {
      expect(codes(inviteCodeField.safeParse(bad))).toContain("invalidInviteCode");
    }
  });

  it("bounds the invite options", () => {
    expect(createInviteBodySchema.safeParse({}).success).toBe(true);
    expect(createInviteBodySchema.safeParse({ expiresInHours: 0 }).success).toBe(false);
    expect(createInviteBodySchema.safeParse({ expiresInHours: 1 }).success).toBe(true);
    expect(
      createInviteBodySchema.safeParse({ expiresInHours: INVITE_EXPIRES_HOURS_MAX }).success,
    ).toBe(true);
    expect(
      createInviteBodySchema.safeParse({ expiresInHours: INVITE_EXPIRES_HOURS_MAX + 1 }).success,
    ).toBe(false);
    expect(createInviteBodySchema.safeParse({ maxUses: INVITE_MAX_USES_MAX }).success).toBe(true);
    expect(createInviteBodySchema.safeParse({ maxUses: INVITE_MAX_USES_MAX + 1 }).success).toBe(
      false,
    );
  });
});

describe("in-chat invite detection (davet embed kartı)", () => {
  it("finds the canonical link, the short link, and codes inside prose", () => {
    expect(
      findInviteCodesInText("gel: https://app.getdemli.com/invite/AB12CD34XY bekliyoruz"),
    ).toEqual(["AB12CD34XY"]);
    expect(findInviteCodesInText("https://app.getdemli.com/kat/AB12CD34XY")).toEqual([
      "AB12CD34XY",
    ]);
    expect(findInviteCodesInText("demli://join/AB12CD34XY")).toEqual(["AB12CD34XY"]);
  });

  it("drops a query/hash tail and trailing punctuation", () => {
    expect(findInviteCodesInText("https://app.getdemli.com/invite/AB12CD34XY?ref=x#y")).toEqual([
      "AB12CD34XY",
    ]);
    expect(
      findInviteCodesInText("Katıl! https://app.getdemli.com/invite/AB12CD34XY, tamam mı?"),
    ).toEqual(["AB12CD34XY"]);
  });

  it("dedupes and preserves first-seen order across several links", () => {
    const text = [
      buildInviteLink("AAAA2222"),
      buildInviteLink("BBBB3333"),
      "demli://join/AAAA2222",
      "https://app.getdemli.com/kat/AAAA2222",
    ].join(" ");
    expect(findInviteCodesInText(text)).toEqual(["AAAA2222", "BBBB3333"]);
  });

  it("never treats a normal URL or a bare code as an invite (no false positives)", () => {
    for (const text of [
      "https://example.com/invite/AB12CD34XY",
      "https://example.com/kat/AB12CD34XY",
      "https://app.getdemli.com/other/AB12CD34XY",
      "https://karagozali.com/katalog/AB12CD34XY",
      "AB12CD34XY",
      "bak şu kata çık: 3. kat/4. daire",
      "https://app.getdemli.com/invite/",
      "https://app.getdemli.com/kat/",
    ]) {
      expect(findInviteCodesInText(text)).toEqual([]);
    }
  });

  it("isInviteLinkUrl matches whole invite URLs only (both paths)", () => {
    expect(isInviteLinkUrl(buildInviteLink("AB12CD34XY"))).toBe(true);
    expect(isInviteLinkUrl("https://app.getdemli.com/kat/AB12CD34XY")).toBe(true);
    expect(isInviteLinkUrl("demli://join/AB12CD34XY")).toBe(true);
    expect(isInviteLinkUrl("https://example.com/invite/AB12CD34XY")).toBe(false);
    expect(isInviteLinkUrl("https://example.com/kat/AB12CD34XY")).toBe(false);
    expect(isInviteLinkUrl("https://app.getdemli.com/")).toBe(false);
  });
});

describe("createEmojiBodySchema", () => {
  const base = { mime: "image/png", dataBase64: "AAAA" };

  it("lowercases the name before checking the grammar", () => {
    expect(createEmojiBodySchema.parse({ ...base, name: " CatJam " }).name).toBe("catjam");
  });

  it("rejects a name outside the grammar", () => {
    for (const bad of ["cat jam", "cat-jam", "cat:jam", "kedi̇"]) {
      expect(codes(createEmojiBodySchema.safeParse({ ...base, name: bad }))).toContain(
        "emojiNamePattern",
      );
    }
  });

  it("enforces the 2..32 name window", () => {
    expect(createEmojiBodySchema.safeParse({ ...base, name: "a" }).success).toBe(false);
    expect(createEmojiBodySchema.safeParse({ ...base, name: "ab" }).success).toBe(true);
    expect(createEmojiBodySchema.safeParse({ ...base, name: "a".repeat(33) }).success).toBe(false);
  });
});

describe("message bodies", () => {
  it("accepts text with no attachment", () => {
    expect(createMessageBodySchema.safeParse({ content: "selam" }).success).toBe(true);
  });

  it("accepts an attachment with no text", () => {
    expect(createMessageBodySchema.safeParse({ attachmentIds: [UUID] }).success).toBe(true);
  });

  it("rejects a send with neither, pointing at the content field", () => {
    const result = createMessageBodySchema.safeParse({ content: "   " });
    expect(codes(result)).toContain("emptyMessage");
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["content"]);
  });

  it("does NOT sanitize message content — it is stored raw and escaped at render", () => {
    // A ZWJ emoji family, an RTL paragraph and meaningful tabs must survive.
    const raw = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\tkod\t\u202Bعربي\u202C";
    expect(createMessageBodySchema.parse({ content: raw }).content).toBe(raw);
  });

  it("caps content at the message limit", () => {
    const at = "a".repeat(MESSAGE_MAX_LENGTH);
    expect(createMessageBodySchema.safeParse({ content: at }).success).toBe(true);
    expect(createMessageBodySchema.safeParse({ content: `${at}a` }).success).toBe(false);
  });

  it("caps the attachment count", () => {
    const ten = Array.from({ length: 10 }, () => UUID);
    expect(createMessageBodySchema.safeParse({ attachmentIds: ten }).success).toBe(true);
    expect(createMessageBodySchema.safeParse({ attachmentIds: [...ten, UUID_B] }).success).toBe(
      false,
    );
  });

  it("refuses to blank a message by editing it", () => {
    expect(codes(editMessageBodySchema.safeParse({ content: "   " }))).toContain("emptyMessage");
    expect(editMessageBodySchema.safeParse({ content: "" }).success).toBe(false);
  });

  it("coerces a query-string limit and bounds it", () => {
    expect(messageListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(messageListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(messageListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(messageListQuerySchema.parse({}).limit).toBeUndefined();
  });
});
