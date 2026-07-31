import { randomInt } from "node:crypto";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import type { CreateUserInput, LinkGoogleInput } from "@demli/db";
import type { User } from "@demli/types";

/**
 * Google "Sign in with Google" groundwork (0010) — the pure find-or-create/link
 * logic, deliberately free of any Google SDK import so it unit-tests against a
 * mock store. Token verification (the part that needs `google-auth-library`)
 * lives in ./google-verifier.ts; this module only ever sees ALREADY-VERIFIED
 * claims.
 */

/** The subset of a verified Google ID token this app consumes. */
export interface GoogleIdTokenClaims {
  /** Stable, never-reused Google account id (the `sub` claim). Required. */
  sub: string;
  /** The account email; may be absent if the token lacked the `email` scope. */
  email?: string;
  /** Google's `email_verified` claim, normalized to a definite boolean. */
  emailVerified: boolean;
  /** Display name (`name` claim); not guaranteed present. */
  name?: string;
  /** Avatar URL (`picture` claim); not guaranteed present. */
  picture?: string;
}

/** Verifies a raw Google ID token into {@link GoogleIdTokenClaims}. */
export interface GoogleTokenVerifier {
  verifyIdToken(idToken: string): Promise<GoogleIdTokenClaims>;
}

/** Domain-level failure of the find-or-create/link step (not token verification). */
export class GoogleAuthError extends Error {
  constructor(
    readonly code: "EMAIL_UNVERIFIED",
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/**
 * The narrow slice of the users repository this logic needs. `@demli/db`'s
 * `usersRepo` satisfies it structurally, so production passes `repos.users`
 * directly; tests pass an in-memory fake.
 */
export interface GoogleUserStore {
  findByGoogleSub(googleSub: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByUsername(username: string): Promise<{ id: string } | null>;
  linkGoogleAccount(userId: string, input: LinkGoogleInput): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
}

export interface GoogleAuthResult {
  user: User;
  /** True only when path (c) minted a brand-new account. */
  created: boolean;
  /** True only when path (b) attached Google to a pre-existing account. */
  linked: boolean;
}

/** Postgres unique-violation SQLSTATE — a raced concurrent insert. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

const MIN_USERNAME_LENGTH = 3;
/** Ordinary numeric suffixes tried before falling back to random digits. */
const USERNAME_SEQUENTIAL_TRIES = 5;
const USERNAME_RANDOM_TRIES = 6;

/**
 * Collapse an arbitrary seed (email local-part or display name) into a legal
 * username stem: lowercase, `[a-z0-9_]` only, no leading/trailing/doubled `_`,
 * capped at {@link USERNAME_MAX_LENGTH}. Returns `"user"` when nothing usable
 * (or fewer than {@link MIN_USERNAME_LENGTH} chars) survives.
 */
export function sanitizeUsernameBase(seed: string): string {
  const cleaned = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, USERNAME_MAX_LENGTH);
  return cleaned.length >= MIN_USERNAME_LENGTH ? cleaned : "user";
}

/** `count` cryptographically-random decimal digits, as a string. */
function randomDigits(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += String(randomInt(0, 10));
  return out;
}

/** Append `suffix` to `base`, trimming `base` so the total stays within the cap. */
function withSuffix(base: string, suffix: string): string {
  return base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
}

/**
 * Derive a username unique against the store (0010). Mirrors the register path's
 * collision-retry, but auto-suffixes (there is no user-supplied name in the
 * Google flow): the bare stem first, then `stem2..stem6`, then random-digit
 * variants; a final long-random fallback makes an all-collision loop effectively
 * impossible. Every candidate is a legal username (see {@link sanitizeUsernameBase}).
 */
export async function deriveUniqueUsername(
  store: Pick<GoogleUserStore, "findByUsername">,
  seed: string,
): Promise<string> {
  const base = sanitizeUsernameBase(seed);
  const candidates = [base];
  for (let i = 0; i < USERNAME_SEQUENTIAL_TRIES; i++) {
    candidates.push(withSuffix(base, String(i + 2)));
  }
  for (let i = 0; i < USERNAME_RANDOM_TRIES; i++) {
    candidates.push(withSuffix(base, randomDigits(4)));
  }
  for (const candidate of candidates) {
    if (!(await store.findByUsername(candidate))) return candidate;
  }
  // Astronomically unlikely fallback: a 6-digit random tail.
  return withSuffix(base, randomDigits(6));
}

/** Prefer the email local-part as the username seed; fall back to the name. */
function usernameSeedFromClaims(claims: GoogleIdTokenClaims, email: string): string {
  const local = email.split("@")[0] ?? "";
  if (sanitizeUsernameBase(local) !== "user") return local;
  return claims.name ?? local;
}

/**
 * Find-or-create/link a Demli account from verified Google claims (0010):
 *
 *  (a) a known `google_sub` → log that account in;
 *  (b) else, for a VERIFIED email, an existing account with that email → attach
 *      the Google identity to it, then log in;
 *  (c) else → create a fresh password-less account (unique derived username,
 *      friend code minted by the repo).
 *
 * Requires a Google-verified email for (b)/(c): an unverified/absent email
 * throws {@link GoogleAuthError} `EMAIL_UNVERIFIED` (never silently links or
 * creates). Path (a) is exempt — the `sub` is the identity once already linked.
 */
export async function resolveGoogleUser(deps: {
  store: GoogleUserStore;
  claims: GoogleIdTokenClaims;
}): Promise<GoogleAuthResult> {
  const { store, claims } = deps;

  // (a) Known Google identity → straight login.
  const bySub = await store.findByGoogleSub(claims.sub);
  if (bySub) return { user: bySub, created: false, linked: false };

  // Beyond here identity rests on the email, so it MUST be Google-verified.
  const email = claims.email?.trim();
  if (!email || !claims.emailVerified) {
    throw new GoogleAuthError(
      "EMAIL_UNVERIFIED",
      "Your Google account has no verified email, so it can't be used to sign in yet.",
    );
  }

  // (b) Existing account with this verified email → link the Google identity.
  const byEmail = await store.findByEmail(email);
  if (byEmail) {
    const linked = await store.linkGoogleAccount(byEmail.id, {
      googleSub: claims.sub,
      email,
      avatarUrl: claims.picture ?? null,
    });
    return { user: linked ?? byEmail, created: false, linked: true };
  }

  // (c) Brand-new, password-less account.
  const username = await deriveUniqueUsername(store, usernameSeedFromClaims(claims, email));
  try {
    const user = await store.create({
      username,
      displayName: claims.name?.trim() || username,
      avatarUrl: claims.picture ?? null,
      passwordHash: null,
      email,
      googleSub: claims.sub,
    });
    return { user, created: true, linked: false };
  } catch (err) {
    // Lost a race with a concurrent first login for the same identity (the
    // unique index on google_sub/email fired): re-resolve and log that in.
    if (isUniqueViolation(err)) {
      const raced =
        (await store.findByGoogleSub(claims.sub)) ?? (await store.findByEmail(email));
      if (raced) return { user: raced, created: false, linked: false };
    }
    throw err;
  }
}
