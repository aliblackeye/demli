/**
 * Google OAuth (0010) — find-or-create/link unit tests. No network / no DB: the
 * token verifier is out of scope here (resolveGoogleUser consumes already-verified
 * claims), and the users repo is an in-memory fake. We assert the three account
 * paths (known sub, link-by-email, create), the verified-email guard, username
 * collision handling, and the create-race fallback deterministically.
 */

import { describe, expect, it } from "vitest";
import type { CreateUserInput, LinkGoogleInput } from "@demli/db";
import type { User } from "@demli/types";
import {
  GoogleAuthError,
  deriveUniqueUsername,
  resolveGoogleUser,
  sanitizeUsernameBase,
  type GoogleIdTokenClaims,
  type GoogleUserStore,
} from "../lib/google-auth.js";

interface Row {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  googleSub: string | null;
}

function toUser(row: Row): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    bio: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeStore(initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  let seq = rows.length;
  const createInputs: CreateUserInput[] = [];
  const linkCalls: Array<{ userId: string; input: LinkGoogleInput }> = [];
  const store: GoogleUserStore = {
    async findByGoogleSub(sub) {
      const r = rows.find((x) => x.googleSub === sub);
      return r ? toUser(r) : null;
    },
    async findByEmail(email) {
      const n = email.trim().toLowerCase();
      const r = rows.find((x) => x.email?.toLowerCase() === n);
      return r ? toUser(r) : null;
    },
    async findByUsername(username) {
      const r = rows.find((x) => x.username === username);
      return r ? { id: r.id } : null;
    },
    async linkGoogleAccount(userId, input) {
      const r = rows.find((x) => x.id === userId);
      if (!r) return null;
      linkCalls.push({ userId, input });
      r.googleSub = input.googleSub;
      if (input.email != null) r.email = input.email;
      if (input.avatarUrl && !r.avatarUrl) r.avatarUrl = input.avatarUrl;
      return toUser(r);
    },
    async create(input) {
      createInputs.push(input);
      const row: Row = {
        id: `new-${++seq}`,
        username: input.username,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        email: input.email ?? null,
        googleSub: input.googleSub ?? null,
      };
      rows.push(row);
      return toUser(row);
    },
  };
  return { store, rows, createInputs, linkCalls };
}

const claims = (over: Partial<GoogleIdTokenClaims> = {}): GoogleIdTokenClaims => ({
  sub: "google-sub-1",
  email: "ada@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  picture: "https://pic/ada.png",
  ...over,
});

describe("resolveGoogleUser", () => {
  it("(a) logs in a known google_sub without creating or linking", async () => {
    const { store, createInputs, linkCalls } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: null,
        email: "ada@example.com",
        googleSub: "google-sub-1",
      },
    ]);

    const result = await resolveGoogleUser({ store, claims: claims() });

    expect(result).toMatchObject({ created: false, linked: false });
    expect(result.user.id).toBe("u1");
    expect(createInputs).toEqual([]);
    expect(linkCalls).toEqual([]);
  });

  it("(a) known google_sub logs in even when the email is now unverified", async () => {
    const { store } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: null,
        email: "ada@example.com",
        googleSub: "google-sub-1",
      },
    ]);

    const result = await resolveGoogleUser({
      store,
      claims: claims({ emailVerified: false }),
    });

    expect(result.user.id).toBe("u1");
    expect(result.created).toBe(false);
  });

  it("(b) links google_sub onto an existing account matched by verified email", async () => {
    const { store, createInputs, linkCalls } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: "https://pic/existing.png",
        email: "ADA@example.com", // different case → still matches
        googleSub: null,
      },
    ]);

    const result = await resolveGoogleUser({ store, claims: claims() });

    expect(result).toMatchObject({ created: false, linked: true });
    expect(result.user.id).toBe("u1");
    expect(createInputs).toEqual([]);
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0]).toMatchObject({
      userId: "u1",
      input: { googleSub: "google-sub-1", email: "ada@example.com" },
    });
    // Existing avatar is NOT overwritten by the Google picture.
    expect(result.user.avatarUrl).toBe("https://pic/existing.png");
  });

  it("(c) creates a new password-less account with google_sub + email", async () => {
    const { store, createInputs } = makeStore([]);

    const result = await resolveGoogleUser({ store, claims: claims() });

    expect(result).toMatchObject({ created: true, linked: false });
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      passwordHash: null,
      email: "ada@example.com",
      googleSub: "google-sub-1",
      displayName: "Ada Lovelace",
      avatarUrl: "https://pic/ada.png",
    });
    // Username derived from the email local-part.
    expect(createInputs[0]!.username).toBe("ada");
  });

  it("(c) derives a collision-free username when the derived one is taken", async () => {
    const { store, createInputs } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: null,
        email: "someone@else.com",
        googleSub: "other-sub",
      },
    ]);

    const result = await resolveGoogleUser({ store, claims: claims() });

    expect(result.created).toBe(true);
    expect(createInputs[0]!.username).toBe("ada2");
  });

  it("rejects an unverified email (no create, no link)", async () => {
    const { store, createInputs, linkCalls } = makeStore([]);

    await expect(
      resolveGoogleUser({ store, claims: claims({ emailVerified: false }) }),
    ).rejects.toBeInstanceOf(GoogleAuthError);
    expect(createInputs).toEqual([]);
    expect(linkCalls).toEqual([]);
  });

  it("rejects a token with no email at all", async () => {
    const { store } = makeStore([]);

    await expect(
      resolveGoogleUser({ store, claims: claims({ email: undefined }) }),
    ).rejects.toMatchObject({ code: "EMAIL_UNVERIFIED" });
  });

  it("does NOT auto-link an unverified email to an existing account", async () => {
    // Guards the account-takeover case: even though an account with this email
    // exists, an unverified Google email must not seize it.
    const { store, linkCalls } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: null,
        email: "ada@example.com",
        googleSub: null,
      },
    ]);

    await expect(
      resolveGoogleUser({ store, claims: claims({ emailVerified: false }) }),
    ).rejects.toMatchObject({ code: "EMAIL_UNVERIFIED" });
    expect(linkCalls).toEqual([]);
  });

  it("falls back to the raced account when create hits a unique violation", async () => {
    // Simulate two concurrent first logins: our create loses the unique index
    // race (SQLSTATE 23505), then re-resolving by sub finds the winner.
    const base = makeStore([]);
    let created = false;
    const store: GoogleUserStore = {
      ...base.store,
      async findByGoogleSub(sub) {
        return created
          ? {
              id: "winner",
              username: "ada",
              displayName: "Ada",
              avatarUrl: null,
              bio: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            }
          : base.store.findByGoogleSub(sub);
      },
      async create() {
        created = true;
        throw Object.assign(new Error("dup"), { code: "23505" });
      },
    };

    const result = await resolveGoogleUser({ store, claims: claims() });

    expect(result).toMatchObject({ created: false, linked: false });
    expect(result.user.id).toBe("winner");
  });
});

describe("sanitizeUsernameBase", () => {
  it("lowercases, strips illegal chars, and trims underscores", () => {
    expect(sanitizeUsernameBase("Ada.Lovelace")).toBe("ada_lovelace");
    expect(sanitizeUsernameBase("  a+b@c  ")).toBe("a_b_c");
    expect(sanitizeUsernameBase("__weird--name__")).toBe("weird_name");
  });

  it("falls back to 'user' when nothing usable (or too short) survives", () => {
    expect(sanitizeUsernameBase("!!")).toBe("user");
    expect(sanitizeUsernameBase("ab")).toBe("user");
    expect(sanitizeUsernameBase("")).toBe("user");
  });

  it("caps length at the configured maximum", () => {
    const long = "a".repeat(100);
    expect(sanitizeUsernameBase(long).length).toBe(32);
  });
});

describe("deriveUniqueUsername", () => {
  it("returns the bare stem when free", async () => {
    const { store } = makeStore([]);
    expect(await deriveUniqueUsername(store, "ada.lovelace")).toBe("ada_lovelace");
  });

  it("suffixes sequentially past taken names", async () => {
    const { store } = makeStore([
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarUrl: null,
        email: null,
        googleSub: null,
      },
      {
        id: "u2",
        username: "ada2",
        displayName: "Ada2",
        avatarUrl: null,
        email: null,
        googleSub: null,
      },
    ]);
    expect(await deriveUniqueUsername(store, "ada")).toBe("ada3");
  });
});
