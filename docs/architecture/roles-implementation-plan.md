# M9 Roles & Permissions — Implementation Plan

> **Shipped — this is the plan as written, kept as a record.** Roles and permissions (ADR 0007) are live in production on desktop, web and mobile. It reads as
> forward-looking work orders because that is what it was; it is not a list of pending
> work. Current per-platform status lives in `docs/product/feature-parity.md`.

Design: ADR 0007. Order is strict: DB → types/protocol → API → gateway → UI → QA.
Assumes migration 0004 (system channel + slowmode) has landed first.

## 1. Migration 0005 (`packages/db`)

```sql
CREATE TYPE invite_policy AS ENUM ('members', 'roles');
ALTER TABLE friend_groups
  ADD COLUMN invite_policy invite_policy NOT NULL DEFAULT 'members';

-- composite-FK targets (id is already unique; these add the pair)
ALTER TABLE channels ADD CONSTRAINT channels_id_group_unique UNIQUE (id, group_id);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,                -- 1..32 chars, validated at API
  color       text,                         -- '#rrggbb' | null
  position    integer NOT NULL DEFAULT 0,   -- display order only
  permissions bigint  NOT NULL DEFAULT 0,   -- PERMISSIONS bitfield
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, group_id)
);
CREATE INDEX roles_group_id_idx ON roles(group_id);

CREATE TABLE member_roles (
  group_id    uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, user_id),
  FOREIGN KEY (group_id, user_id) REFERENCES friend_group_members(group_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, group_id) REFERENCES roles(id, group_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_group_user_idx ON member_roles(group_id, user_id);

CREATE TABLE channel_role_access (
  channel_id uuid NOT NULL,
  role_id    uuid NOT NULL,
  group_id   uuid NOT NULL,
  PRIMARY KEY (channel_id, role_id),
  FOREIGN KEY (channel_id, group_id) REFERENCES channels(id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, group_id)    REFERENCES roles(id, group_id)    ON DELETE CASCADE
);
CREATE INDEX channel_role_access_role_idx ON channel_role_access(role_id);
```

Repos: `rolesRepo` (CRUD, reorder, listForGroup, listForMember),
`channelAccessRepo` (get/replace per channel, `visibleChannelIdsForUser`),
`effectivePermissions(groupId, userId): bigint` (single OR query).
Seed: one "Moderator" role (MANAGE_MESSAGES | KICK_MEMBERS) on the seed server,
one restricted channel.

## 2. Types & protocol (`packages/types`, `packages/protocol`)

`packages/types`:

```ts
type RoleId = string;
const PERMISSIONS = { MANAGE_CHANNELS: 1 << 0, MANAGE_MESSAGES: 1 << 1,
  KICK_MEMBERS: 1 << 2, CREATE_INVITE: 1 << 3, MANAGE_ROLES: 1 << 4 } as const;
type PermissionBitfield = number;
interface Role { id; groupId; name; color: string | null; position: number;
  permissions: PermissionBitfield; createdAt: string }
type InvitePolicy = "members" | "roles";
// FriendGroup gains invitePolicy: InvitePolicy
// Channel gains restricted?: boolean (lock icon; access list stays behind its own endpoint)
// Member DTO (GET /groups/:id/members) gains roleIds: RoleId[]
```

`packages/protocol` — server→client only (all mutations are HTTP; no new
client events, no new error codes — invisible channel ⇒ `CHANNEL_NOT_FOUND`):

```ts
| { type: "role.created";          payload: { role: Role } }
| { type: "role.updated";          payload: { role: Role } }
| { type: "role.deleted";          payload: { groupId; roleId } }
| { type: "member.roles_updated";  payload: { groupId; userId; roleIds: RoleId[] } }
| { type: "channel.access_changed"; payload: { groupId; channelId } } // thin: client refetches
```

Plus zod schemas + factories, and a group-scoped variant on the mutation-bus
contract: `{ scope: "channel"; channelId } | { scope: "group"; groupId }`.

## 3. API (`apps/api`)

Shared permission service in `apps/api/src/lib/permissions.ts`:
`requireMember`, `requirePermission(bit)` (owner bypass),
`requireChannelVisible`. No inline role conditionals in routes.

| Method | Path | Guard |
|---|---|---|
| GET    | `/groups/:groupId/roles` | member |
| POST   | `/groups/:groupId/roles` | owner ∨ MANAGE_ROLES (+ escalation guard) |
| PATCH  | `/groups/:groupId/roles/:roleId` | same |
| DELETE | `/groups/:groupId/roles/:roleId` | same |
| PUT    | `/groups/:groupId/roles/positions` | same (body: ordered roleIds) |
| PUT    | `/groups/:groupId/members/:userId/roles` | owner ∨ MANAGE_ROLES; target ≠ guest; assignable roles ⊆ actor bits; MANAGE_ROLES-bearing roles owner-only |
| GET    | `/channels/:channelId/access` | owner ∨ MANAGE_CHANNELS |
| PUT    | `/channels/:channelId/access` | owner ∨ MANAGE_CHANNELS; body `{ roleIds }`, `[]` = public |
| PATCH  | `/groups/:groupId` | + `invitePolicy` field (owner only) |

Retrofits (same PR):

- `GET /groups/:groupId/channels` → filter by `visibleChannelIdsForUser`; add `restricted` flag.
- `GET/POST /channels/:channelId/messages` → 404 when invisible.
- `PATCH/DELETE /channels/:channelId` → owner ∨ MANAGE_CHANNELS (was owner-only) + visibility.
- `POST /media/token` → reject invisible voice channel.
- `POST /groups/:groupId/invites` → honor `invite_policy` (owner ∨ CREATE_INVITE when `roles`).
- `DELETE /groups/:groupId/members/:userId` → owner ∨ KICK_MEMBERS; owner never kickable.
- Message delete/moderation → author ∨ owner ∨ MANAGE_MESSAGES.
- All role endpoints 404 on `kind='group'`.
- Every mutation above publishes its event on the bus (group scope for role/member
  events, group scope for `channel.access_changed` too — losers of access must hear it).

## 4. Gateway (`apps/realtime`)

- Handshake: build `channelKinds` from `visibleChannelIdsForUser` instead of
  all group channels.
- New `groupId → Set<Connection>` index (membership is already fetched at attach).
- Bus handler for group-scoped mutations: (1) recompute affected connections'
  visible channel sets, diff against `SubscriptionRegistry` (needs
  `remove(conn, channelIds)` partial-remove API), (2) force voice.leave when a
  connection sits in a now-invisible voice channel, (3) forward the typed event.
- `message.send` / `typing.*` / `voice.join` against a non-subscribed channel
  keep answering `CHANNEL_NOT_FOUND`.

## 5. UI (`apps/desktop` renderer, frontend-ui)

- **ServerSettings tabs:** General (name/icon + invite policy), Members (list,
  role chips, assign popover, kick), Roles (list + editor: name, color,
  permission toggles, reorder; drag optional), Channels (existing management
  moved in).
- **Channel settings:** "Visibility" section — public / restricted with role
  multi-select (owner ∨ MANAGE_CHANNELS only).
- **Passive UI:** lock icon on restricted channels; member names colored by
  highest-positioned colored role; settings entry points gated by effective
  permissions (client-side gating is cosmetic only — server is authoritative).
- **Realtime handling:** on `role.*` / `member.roles_updated` /
  `channel.access_changed` invalidate the group's roles/members/channels
  queries; if the active channel disappears from the refetched list, navigate
  to the first visible channel.

## 6. Test plan

- **db:** cascade on member leave / role delete; cross-group FK rejection;
  `effectivePermissions` OR; `visibleChannelIdsForUser` (public, restricted,
  owner, multi-role).
- **api (integration):** escalation guard matrix (grant/deny per bit); guest
  role-assignment rejected; invite policy both modes; restricted channel 404s
  for outsiders on messages/patch/media-token; `kind='group'` 404s;
  member-endpoint `roleIds`.
- **gateway:** restricted-channel `message.created` not delivered to a
  non-role member; role grant mid-connection ⇒ subscription appears and
  events flow; revoke ⇒ events stop + forced voice.leave; existence non-leak
  (`CHANNEL_NOT_FOUND`).
- **regression:** zero-role server behaves exactly as pre-M9 (run existing
  suites untouched).
- **manual (qa checklist):** two clients — restrict a channel while B watches
  it; B's channel disappears without refresh; assign role back; B rejoins.

## 7. Task split & order

| # | Task | Agent | Branch | Depends on | Est |
|---|---|---|---|---|---|
| 1 | Migration 0005, schema.ts, repos, seed, db tests | database | `feat/roles-db` | 0004 merged | 1d |
| 2 | types + protocol events/schemas/factories + bus scope type | product-architect | `feat/roles-contract` | — (parallel with 1) | 0.5d |
| 3 | Permission service + role/access/invite-policy endpoints + retrofits | realtime-backend | `feat/roles-api` | 1, 2 | 1.5d |
| 4 | Gateway visibility filter, group index, resync, forced voice.leave | realtime-backend | `feat/roles-gateway` | 3 | 1d |
| 5 | ServerSettings tabs, channel visibility UI, role colors, event handling | frontend-ui | `feat/roles-ui` | 3 (API stable) | 2d |
| 6 | Integration/gateway/regression suites + manual checklist update | qa-test | `feat/roles-qa` | 4, 5 | 1d |
| 7 | Security review: escalation guard, visibility leaks, rate limits on role endpoints | security | review only | 4 | 0.5d |
| 8 | Update `docs/architecture/realtime.md` + overview after merge | docs | `docs/roles` | 6 | 0.5d |

Gates: `pnpm typecheck && pnpm lint && pnpm test` green at every merge;
gateway task (#4) additionally needs the two-client manual smoke before merge.
