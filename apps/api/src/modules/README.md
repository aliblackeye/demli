# API Modules

One folder per domain module. Each module exports a single `register<Name>Module(server)` function and validates all input at the boundary with zod.

Planned modules (Milestone 2):

- `auth/` — sessions, login
- `users/` — profiles
- `groups/` — friend groups + membership
- `channels/` — text/voice channels
- `messages/` — message CRUD + pagination
- `presence/` — presence snapshots
- `media/` — LiveKit token endpoint (Milestone 3)
- `invites/` — invite links

`health/` exists now as the reference pattern.
