/**
 * Name resolution — the ONE place the "what do I call this person" order lives
 * (ADR 0019 §2). Demli has two things called "nickname" and they have
 * different audiences, so which one wins is a product rule, not a formatting
 * detail:
 *
 *   private nickname → server nickname → displayName → username → id
 *
 * - **private nickname** (`user_nicknames`) — what *I* call you. Global across
 *   every surface, visible ONLY to me, and the target is never told.
 * - **server nickname** (`friend_group_members.nickname`) — what *this server*
 *   calls you. Visible to everyone in that server, scoped to it.
 *
 * The private one wins because it is the viewer's own explicit override; a
 * server may relabel someone, but it may not relabel them for me.
 *
 * Resolution is CLIENT-side on purpose: a private label must never travel
 * attached to a roster/message payload where it could be fanned out to the
 * wrong viewer, so the client fetches its whole private map once
 * (`GET /users/me/nicknames`) and applies it locally.
 *
 * Framework-free and dependency-free so desktop, web and (later) mobile all
 * resolve identically — the same reason `hasPermission` lives in
 * `@demli/types` rather than in each client.
 */

/** Every layer a displayed name can come from, most-specific first. */
export interface UserNameParts {
  /** The viewer's PRIVATE nickname for this user, or null/undefined. */
  privateNickname?: string | null;
  /** The user's per-server nickname in the CURRENT server, or null/undefined. */
  serverNickname?: string | null;
  /** The user's chosen display name. */
  displayName?: string | null;
  /** The `@handle`, used only when there is no display name at all. */
  username?: string | null;
  /**
   * Last-resort label (usually the user id) so a row never renders empty. A
   * caller that would rather show nothing can pass `""`.
   */
  fallback?: string;
}

/**
 * Trim, and treat a blank string as absent. A nickname of `"   "` is not a
 * nickname; without this, clearing a field in a text input by spacing it out
 * would rename someone to whitespace on every surface.
 */
function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The name to display for a user, applying the ADR 0019 §2 precedence.
 *
 * Every surface that renders a person's name — roster row, message author,
 * profile card, context-menu header, DM list, mention token — must go through
 * this. Ten local `nickname ?? displayName` expressions are ten places for the
 * order to drift, and the private/server split makes drift a privacy bug rather
 * than a cosmetic one.
 */
export function resolveUserName(parts: UserNameParts): string {
  return (
    present(parts.privateNickname) ??
    present(parts.serverNickname) ??
    present(parts.displayName) ??
    present(parts.username) ??
    parts.fallback ??
    ""
  );
}

/**
 * Which layer {@link resolveUserName} actually used. Drives the UI that has to
 * EXPLAIN a name rather than just print it — the profile card showing
 * "also known as <real name>" under a nickname, and the context menu offering
 * "Change nickname" vs "Remove nickname".
 */
export type UserNameSource = "privateNickname" | "serverNickname" | "displayName" | "username" | "fallback";

/** The layer {@link resolveUserName} resolved from, using the same precedence. */
export function resolveUserNameSource(parts: UserNameParts): UserNameSource {
  if (present(parts.privateNickname)) return "privateNickname";
  if (present(parts.serverNickname)) return "serverNickname";
  if (present(parts.displayName)) return "displayName";
  if (present(parts.username)) return "username";
  return "fallback";
}

/**
 * The user's REAL name (what they call themselves), ignoring both nickname
 * layers. Shown as a secondary line whenever a nickname is in force, so a
 * renamed person is still identifiable — rendered as "Takma ad (Gerçek ad)".
 * Returns null when no nickname is active, i.e. when there is nothing to
 * disambiguate.
 */
export function realNameBehindNickname(parts: UserNameParts): string | null {
  const source = resolveUserNameSource(parts);
  if (source !== "privateNickname" && source !== "serverNickname") return null;
  return present(parts.displayName) ?? present(parts.username);
}
