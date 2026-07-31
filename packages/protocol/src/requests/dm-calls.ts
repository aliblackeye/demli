/**
 * DM-call HTTP contract — the STATE-RESYNC read (call-UX plan 2026-07-30, K2.2).
 *
 *   GET /dm-calls/active  →  {@link DmCallActiveResponse}
 *
 * ## Why this endpoint exists
 *
 * A DM call's control plane is HTTP + user-scoped `call.*` events (ADR 0012 §4).
 * That is enough only while both sides observe every event in order, and they do
 * not: the callee is rung over its socket (and by push), so it can ACCEPT before
 * the caller's own `POST /dm-calls` response has even landed. The caller's FSM
 * then sees `call.accepted` for a call it does not know it has, drops it as
 * out-of-phase, and the row sits `active` with nobody joining it — the founder's
 * "kabul etti ama bağlanmadı", unescapable until the periodic sweeper reaps it
 * minutes later.
 *
 * This is the `voice.resync` idea applied to the call plane: instead of trying to
 * make two independent transports totally ordered (a WS replay queue was
 * considered and REJECTED as far more machinery than the problem), the client can
 * always ask the server "what call am I actually in right now?" and re-seat on
 * the answer. It is pulled on WS (re)connect and whenever an out-of-phase
 * `call.accepted` / `call.invite` arrives.
 *
 * ## Deliberately a PULL, not a push
 *
 * `voice.resync` is pushed because occupancy changes constantly and the client
 * cannot ask cheaply. A call is the opposite: at most ONE live row per user, and
 * the client knows the exact moments its own state might be stale. A pull keeps
 * the socket contract untouched (no new server event) and gives the answer the
 * authority of a fresh database read.
 */

import type { DmCall, User } from "@demli/types";

/** Which side of the call the requesting user is on. */
export type DmCallSide = "caller" | "callee";

/**
 * LiveKit credentials for a call room, WITHOUT the call itself.
 *
 * Field-for-field the media half of `DmCallTokenResponse` (see `events.ts`) —
 * same names, same meaning — so a client hands it to the media engine through
 * the identical `{ url, token }` path it already uses for start/accept. Kept as
 * its own type rather than reusing that interface because the resync response
 * carries the call ONCE, at the top level, where `call: null` is a legal answer.
 */
export interface DmCallMediaCredential {
  /** LiveKit websocket URL the client should connect to. */
  url: string;
  /** LiveKit access token (JWT), scoped to `roomName`. */
  token: string;
  /** LiveKit room name — always `call.roomName` (`dmcall:<id>`). */
  roomName: string;
  /** Token identity — always the authenticated user id. */
  identity: string;
  /** ISO timestamp after which the token is no longer valid. */
  expiresAt: string;
}

/**
 * The authenticated user's single LIVE (`ringing` | `active`) DM call, or an
 * all-null body when they have none. Never 404s and never errors on "no call" —
 * "you are in nothing" is a normal, actionable answer, and a client that has to
 * distinguish an error from an empty state gets that distinction wrong.
 *
 * `media` is present ONLY when the user is already entitled to be in the room:
 * they are the CALLER (who joined it at start), or the call is `active` (they
 * accepted). A ringing CALLEE gets `media: null` — accepting is the one path
 * allowed to flip the row and mint their token, and a resync must not become a
 * back door around it.
 *
 * The credential is freshly minted, so a client whose token expired during a
 * long disconnect can rejoin from this response alone with no second request.
 */
export interface DmCallActiveResponse {
  /** The live call, or null when the user is in none. */
  call: DmCall | null;
  /** The OTHER participant (public {@link User}, no friendCode); null with `call`. */
  peer: User | null;
  /** The requester's side of `call`; null with `call`. */
  side: DmCallSide | null;
  /** Join credentials, or null — see the type doc for exactly when. */
  media: DmCallMediaCredential | null;
  /**
   * Is THIS user's LiveKit identity currently sitting in the call's room? Read
   * from the media plane (ADR 0023 §3), which is the only honest source for it.
   *
   *   `true`  — yes, on SOME device of this account (LiveKit identities are per
   *             USER, not per device, so this cannot say which one — the client
   *             distinguishes "this device" by asking its own media engine).
   *   `false` — definitely not: the room holds nobody with this identity.
   *   `null`  — UNKNOWN, because the media plane could not be probed.
   *
   * ## Why the third value exists, and why it is not `false`
   *
   * The client uses this as the AUTO-JOIN GATE: a resync may bring media up only
   * on `false`. LiveKit enforces one connection per identity, so a device that
   * joins while another device of the same account is in the room DISCONNECTS
   * that device — a phone dropped out of a live conversation by a desktop that
   * was merely re-syncing. That is the failure this field exists to prevent, so
   * "I don't know" must never be spelled `false`.
   *
   * The two ways of being wrong are not symmetric:
   *   - wrong `false` → the other device is kicked out of a call in progress,
   *     mid-sentence, with no user action behind it. Unrecoverable in the moment.
   *   - wrong `true`/`null` → this device shows "you're in this call on another
   *     device" and waits for the user to press Join. One click, no data lost.
   * The cheap error is the cautious one, so an unreachable media plane answers
   * `null` and the client stays out of the room. Mirrors the sweeper's rule that
   * an unreachable SFU is not evidence that rooms are empty.
   *
   * Always `null` when `call` is null — there is no room to be in.
   */
  inRoom: boolean | null;
}
