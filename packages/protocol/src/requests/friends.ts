/**
 * Friendship request bodies.
 *
 * There is exactly ONE username rule in this product and it lives in
 * `@demli/config`; this file is where the add-a-friend form and the
 * add-a-friend route both read it from, so the client can never show a rule the
 * server does not run (and vice versa). Before this existed the API capped the
 * by-username field at a hand-written 64 while a username can only ever be 32,
 * so a user could type 40 characters that could not possibly match an account
 * and be told nothing useful about why it failed.
 */

import { z } from "zod";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from "@demli/config";
import { customIssue } from "./codes.js";
import type { TextField } from "./text.js";

/**
 * Canonicalize a hand-typed handle the way storage holds it: drop the leading
 * `@` people naturally type, trim, lowercase (auth lowercases on register and
 * login, so a lookup must too).
 *
 * Exported because the same normalization has to run on both sides of the wire —
 * the form normalizes so what it validates is what it sends, the route
 * normalizes so it never trusts that the client did.
 */
export function normalizeUsernameInput(value: string): string {
  return value.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * A username as typed into a LOOKUP field (add a friend, add a member).
 *
 * Same bounds and same grammar as {@link usernameField} in `auth.ts`, but built
 * separately on purpose: this one strips the leading `@` first, because a lookup
 * field is where a user pastes `@ali` from a mention, while registration is
 * where they choose a name and an `@` there is a mistake to reject, not a
 * decoration to ignore.
 *
 * The grammar IS enforced here, unlike the group-chat member field: a value that
 * breaks it cannot match any stored account (register, rename and the
 * Google-derived path all produce `[a-z0-9_]` names), so checking it costs
 * nothing and buys the user a message that names the actual mistake instead of a
 * flat "not found".
 */
export const friendUsernameField: TextField = z
  .string()
  .transform(normalizeUsernameInput)
  .pipe(
    z
      .string()
      .min(USERNAME_MIN_LENGTH)
      .max(USERNAME_MAX_LENGTH)
      .superRefine((value, ctx) => {
        if (!USERNAME_PATTERN.test(value)) ctx.addIssue(customIssue("usernamePattern"));
      }),
  );

/** `POST /friends/requests/by-username` (#111 — the friend-code replacement). */
export const sendFriendRequestByUsernameBodySchema = z.object({
  username: friendUsernameField,
});

export type SendFriendRequestByUsernameBody = z.infer<
  typeof sendFriendRequestByUsernameBodySchema
>;
