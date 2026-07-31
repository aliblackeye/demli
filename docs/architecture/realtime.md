# Realtime Architecture

Two transports, strictly separated:

- **WebSocket** (`apps/realtime`, `ws` library) — lightweight typed events: chat, presence,
  typing, and voice *signaling metadata* (who joined/left/muted).
- **WebRTC via LiveKit** — actual media: microphone audio, screen video, camera video later.

## Hard rule

**No audio/video frames over the WebSocket. Ever.** The socket carries small JSON events only.
Media bytes travel exclusively through LiveKit/WebRTC (see media.md). This is a non-negotiable
from CLAUDE.md §10/§35; the gateway rejects binary frames outright (`apps/realtime/src/gateway.ts`).

## Event contract

All event names and payloads are defined once, in `packages/protocol/src/index.ts`.
No other file may invent an event name — no magic strings.

Client → server:

```txt
message.send   typing.start   typing.stop
presence.update   voice.join   voice.leave
```

Server → client:

```txt
message.created   message.updated   message.deleted
typing.started    typing.stopped    presence.updated
voice.participant_joined   voice.participant_left
```

CLAUDE.md §10 also lists `voice.muted/unmuted` and `screen.started/stopped` semantics; voice and
screen share shipped without them — mute still rides `voice.participant_*` payload fields (`muted`).
They'll be added to the protocol union (in `packages/protocol` only) if a richer voice signaling
surface later needs them.

## Envelope and sequencing

Server events are wrapped in `RealtimeEnvelope<E>`:

```ts
interface RealtimeEnvelope<E> {
  event: E;
  seq: number;    // monotonic sequence for ordering / gap detection
  sentAt: string;
}
```

`seq` lets the client detect missed events after a reconnect (gap ⇒ refetch via HTTP API
instead of trusting the socket). `message.send` carries a client `nonce` so optimistic UI can
reconcile the echoed `message.created`.

## Gateway behavior

The gateway (`apps/realtime/src/gateway.ts`) is fully wired:

- **Auth on connect.** The socket handshakes with `ws://host/?token=<session token>`; the token
  is hashed and checked against the sessions table. Failure closes with **4401**. On success the
  client receives `auth.succeeded` with a presence snapshot.
- **Server-derived subscriptions.** The gateway subscribes the socket to every channel of every
  group the user belongs to. Clients never ask to join a channel, so they cannot subscribe to one
  they are not a member of.
- **Per-event zod validation.** Every inbound frame is `safeParse`d against the protocol's
  `clientToServerEventSchema`. Non-JSON closes 1003; an unknown event type closes 1008; a known
  type with an invalid payload gets an `error.raised` event (not a disconnect). Binary frames are
  rejected outright — media is LiveKit's job, never this socket.
- **Redis mutation bus.** `apps/api` and `apps/realtime` are separate processes, so an HTTP
  message edit/delete cannot reach the gateway's in-memory sockets directly. The API publishes the
  typed protocol event, tagged with its channel, to a Redis channel; every gateway instance
  subscribes and fans it out to local subscribers of that channel over the same enveloped,
  sequenced send path (`packages/db/src/redis/mutation-bus.ts`).
- Per-connection message rate limiting and a heartbeat that reaps dead sockets round it out.
