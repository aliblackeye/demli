# ADR 0007 — Roles & Permissions (M9)

**Status:** accepted — shipped; roles and permissions are live on desktop, web and mobile
**Date:** 2026-07-07

## Context

Founder asks for M9: custom roles per server, channel visibility restricted to
roles ("only mods can see #staff"), delegable powers (e.g. a moderator who can
delete messages and kick), and richer server settings (General / Members /
Roles / Channels tabs). Today authorization is a single enum on
`friend_group_members.role` (`owner | member | guest`): owners manage
channels/settings, members chat and create invites, guests are read-only.
CLAUDE.md §5/§35 forbid a full permission hierarchy in the MVP, so the
model must be minimal but able to grow into `Role`/`Permission`/
`ChannelOverride` later.

Constraints from the current system:

- The WS gateway subscribes a connection to **every** channel of every group
  the user belongs to at handshake (`apps/realtime/src/gateway.ts`), and
  routes broadcasts per channel via `SubscriptionRegistry`. Channel
  visibility must therefore be enforced at subscription time, not per frame.
- `friend_groups.kind = 'group'` (flat chats, ADR 0005) must stay
  role-free — a two-person film-night chat has no business with a role editor.
- Migration 0004 (system channel + slowmode) is in flight on a parallel
  branch; this work starts at migration 0005.

## Decision

Additive role layer on top of the existing enum. The enum stays and keeps its
current meaning; roles only **grant more** than the member baseline.

### Data model (server-scoped, `kind = 'server'` only)

```txt
roles                 id, group_id → friend_groups (cascade), name, color (hex|null),
                      position (int, display order), permissions (bigint bitfield),
                      created_at. UNIQUE (id, group_id) as composite-FK target.

member_roles          (role_id, user_id) PK, group_id, assigned_at.
                      FK (group_id, user_id) → friend_group_members  ON DELETE CASCADE
                      FK (role_id, group_id) → roles(id, group_id)   ON DELETE CASCADE
                      → leaving a server or deleting a role cleans assignments in the DB,
                        and a role can never be assigned across servers.

channel_role_access   (channel_id, role_id) PK, group_id.
                      Composite FKs to channels(id, group_id) and roles(id, group_id).
                      No rows for a channel  = public to all members (today's behavior).
                      ≥1 row                 = restricted: visible only to the owner and
                                               members holding at least one listed role.
```

### Permission bits (minimal, `packages/types` named constants — no magic numbers)

```ts
export const PERMISSIONS = {
  MANAGE_CHANNELS: 1 << 0, // create/edit/delete/reorder channels, slowmode, visibility
  MANAGE_MESSAGES: 1 << 1, // delete/edit-moderate others' messages
  KICK_MEMBERS:    1 << 2, // remove members (never the owner)
  CREATE_INVITE:   1 << 3, // see invite policy below
  MANAGE_ROLES:    1 << 4, // role CRUD + assignment, with escalation guard
} as const;
```

Semantics:

- **Effective permissions = bitwise OR of all held roles.** One query, one OR.
- **Owner bypasses everything.** The bitfield is never consulted for the owner.
- **Guests stay read-only.** Roles cannot be assigned to guests (API rejects).
- **Member baseline is unchanged:** read, send, join voice, create invites.
  Bits only add capabilities on top.
- **Escalation guard:** a non-owner editor may only create/edit roles whose
  bits are a subset of their own effective bits (`newBits & ~actorBits === 0`),
  and may only assign roles satisfying the same rule. Only the owner can hand
  out `MANAGE_ROLES`. No position-based hierarchy in MVP — `position` is
  display order only.
- **Position/hierarchy, per-channel allow/deny overrides, role mentions** are
  explicitly out of scope; the schema leaves room (`position`, join tables)
  without implementing them.

### CREATE_INVITE and invite policy

Members can already create invites; a bit that "grants" this would be dead on
arrival. To make it real without breaking back-compat, `friend_groups` gains
`invite_policy enum('members','roles') NOT NULL DEFAULT 'members'`:

- `members` (default, today's behavior): owner + members create invites,
  guests never.
- `roles`: only owner + holders of `CREATE_INVITE` create invites.

The join flow itself is untouched: redeeming an invite still creates a
`member` row with no roles — a new joiner sees only unrestricted channels
until someone assigns them a role.

### Channel visibility × WS gateway

The invariant: **events of an invisible channel must never reach the client —
filtered at subscription, not at render.**

- At handshake the gateway builds the connection's channel set already; it now
  builds it **visibility-filtered** (public channels + restricted channels
  matching the user's roles + everything if owner). A non-subscribed
  connection never receives that channel's `message.*`, `typing.*`, `voice.*`
  frames — this falls out of the existing `SubscriptionRegistry` routing.
- Sends to an invisible channel answer `CHANNEL_NOT_FOUND` (not a new
  "forbidden" code) so restricted channels do not leak their existence.
- Role/access mutations happen over HTTP; the API publishes them on the
  mutation bus (extended with a group-scoped variant). The gateway then
  **resyncs** subscriptions for affected connected members and forwards thin
  typed events (`role.*`, `member.roles_updated`, `channel.access_changed`);
  clients refetch via HTTP, which applies the same visibility filter.
- If a user loses access to a voice channel they are connected to, the
  gateway force-leaves them (same path as `voice.leave`).
- The same visibility check is enforced on every HTTP read/write that takes a
  `channelId` (`GET/POST /channels/:id/messages`, `PATCH /channels/:id`,
  `POST /media/token`) — the socket filter is necessary, not sufficient.

### Back-compatibility

A server with zero roles and zero `channel_role_access` rows behaves exactly
as today, verbatim: owner manages, members chat and invite, guests read. No
existing row changes shape; migration 0005 only adds tables and one defaulted
column. Flat group chats (`kind='group'`) reject all role endpoints.

## Consequences

- Three new tables + one column; three new domain types (`Role`,
  `MemberRoleAssignment`, `ChannelRoleAccess`) and `PERMISSIONS` in
  `packages/types`; five new server→client events in `packages/protocol`.
- The gateway gains a group-scoped bus channel and a per-user resync path —
  the one genuinely new moving part; it needs dedicated tests.
- Every channel-scoped endpoint gains a visibility check — one shared
  `canSeeChannel`/`effectivePermissions` service in `apps/api`, not scattered
  conditionals.
- UI grows the four server-settings tabs and a visibility section in channel
  settings; member colors come from the highest-positioned colored role.
- Future growth (channel overrides, hierarchy, role mentions) extends these
  tables instead of replacing them.

## Alternatives considered

1. **Extend the member enum (add `moderator`, `admin`…).** Rejected: not
   composable, no custom names/colors, a migration per new role, and it
   cannot express channel visibility at all.
2. **A full permission hierarchy (per-channel allow/deny overrides, role
   ordering, role mentions).** Rejected: CLAUDE.md §5/§35 non-negotiable; friend-group
   scale does not need it, and it roughly triples the auth surface.
3. **Per-channel member whitelist (`channel_members`) instead of roles.**
   Rejected: solves visibility but not delegation (moderator story), and
   membership management would be duplicated per channel. A whitelist is
   trivially emulated with a single role.
4. **`jsonb` permission array instead of a bitfield.** Rejected: bitfields
   compose with a single OR, check with a single AND, and stay compact;
   named constants in `packages/types` remove the magic-number risk. JS
   numbers are safe to 53 bits — decades of headroom for our 5.
5. **Filtering restricted-channel events per frame at broadcast time instead
   of at subscription.** Rejected: a permission lookup on the hot broadcast
   path; the registry already gives us set-membership routing for free.
