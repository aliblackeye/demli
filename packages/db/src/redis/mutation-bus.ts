import { z } from "zod";
import { serverToClientEventSchema, type ServerToClientEvent } from "@demli/protocol";
import { createRedisClient, type RedisClient } from "./client.js";

/**
 * Redis pub/sub bridge for API-originated realtime mutations.
 *
 * `apps/api` and `apps/realtime` are separate processes. HTTP-originated
 * message edits/deletes persist in Postgres but never reached connected WS
 * clients because the API cannot touch the gateway's in-memory sockets. This
 * bus is the seam: the API publishes a typed protocol event tagged with its
 * channel, and every realtime instance subscribes and fans it out to the
 * local sockets subscribed to that channel (using the gateway's normal
 * enveloped, sequenced send path).
 *
 * Payloads carry existing `@demli/protocol` server events only — there are
 * no event-name string literals here (CLAUDE.md §24). Lives in `@demli/db`
 * (the one package both apps already import) so the typed codec is defined
 * once with no import cycle: db → protocol → {types, config}.
 */

/** Single Redis channel; the app channelId travels inside the payload. */
export const MUTATION_CHANNEL = "demli:realtime:mutations";

/**
 * A realtime mutation to fan out: a server→client protocol event plus its
 * routing scope. Exactly one of `channelId` / `groupId` / `userId` is set:
 *
 * - `channelId` — channel-scoped (the original shape): the gateway broadcasts
 *   `event` to local subscribers of that channel (`message.*`, `typing.*`,
 *   `voice.*`).
 * - `groupId` — group-scoped (M9, ADR 0007): role/access mutations that must
 *   reach a whole server. The gateway resyncs the affected group's connections
 *   and forwards the thin event (`role.*`, `member.roles_updated`,
 *   `channel.access_changed`). The resync path lives in `apps/realtime`
 *   (roles-gateway); the HTTP API only publishes.
 * - `userId` — user-scoped (M13, ADR 0010 §4): social events that target one
 *   user regardless of channel/group. The gateway forwards `event` to that
 *   user's live connections via the existing `connectionsByUser` index
 *   (`friend.request_received`, `friend.request_accepted`, `friend.removed`,
 *   `dm.created`).
 *
 * The three ids are mutually exclusive — the schema rejects payloads that set
 * more than one or none, so a consumer can branch on which is present.
 */
export interface RealtimeMutation {
  channelId?: string;
  groupId?: string;
  userId?: string;
  event: ServerToClientEvent;
}

const realtimeMutationSchema = z
  .object({
    channelId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    event: serverToClientEventSchema,
  })
  .refine(
    (m) =>
      [m.channelId, m.groupId, m.userId].filter((v) => v !== undefined).length === 1,
    { message: "exactly one of channelId / groupId / userId must be set" },
  );

export function serializeMutation(mutation: RealtimeMutation): string {
  return JSON.stringify(mutation);
}

/**
 * Parse + validate a wire payload. Returns null for malformed JSON or any
 * payload that is not a known protocol event — we never trust the wire, even
 * our own Redis channel.
 */
export function parseMutation(raw: string): RealtimeMutation | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = realtimeMutationSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** Full duplex bus. */
export interface RealtimeMutationBus {
  publish(mutation: RealtimeMutation): Promise<void>;
  subscribe(handler: (mutation: RealtimeMutation) => void): Promise<void>;
  close(): Promise<void>;
}

/** The API only needs the publish half. */
export type RealtimeMutationPublisher = Pick<RealtimeMutationBus, "publish">;

/**
 * ioredis-backed bus. A subscriber connection cannot issue normal commands, so
 * publish and subscribe use separate lazily-created connections. `apps/api`
 * only ever publishes; `apps/realtime` only ever subscribes — so each process
 * opens a single connection.
 */
export class RedisMutationBus implements RealtimeMutationBus {
  private pub: RedisClient | null = null;
  private sub: RedisClient | null = null;
  private readonly handlers = new Set<(mutation: RealtimeMutation) => void>();

  constructor(
    private readonly url: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async publish(mutation: RealtimeMutation): Promise<void> {
    try {
      if (!this.pub) {
        this.pub = createRedisClient(this.url);
        this.pub.on("error", (err) => this.log(`redis pub error: ${err.message}`));
      }
      await this.pub.publish(MUTATION_CHANNEL, serializeMutation(mutation));
    } catch (err) {
      // The DB write is already the source of truth; a failed fan-out must
      // never fail the HTTP request. Clients recover missed events on the next
      // reconnect/refetch (seq-gap detection).
      this.log(`mutation publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async subscribe(handler: (mutation: RealtimeMutation) => void): Promise<void> {
    this.handlers.add(handler);
    if (this.sub) return;
    const sub = createRedisClient(this.url);
    sub.on("error", (err) => this.log(`redis sub error: ${err.message}`));
    sub.on("message", (_channel: string, payload: string) => {
      const mutation = parseMutation(payload);
      if (!mutation) {
        this.log("dropped malformed realtime mutation payload");
        return;
      }
      for (const h of this.handlers) h(mutation);
    });
    this.sub = sub;
    await sub.subscribe(MUTATION_CHANNEL);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
    this.pub = null;
    this.sub = null;
  }
}

/**
 * Same-process bus for tests: delivers synchronously but still round-trips
 * through the wire codec, so `subscribe` handlers see exactly what the Redis
 * path would deliver (and serialization is exercised).
 */
export class InMemoryMutationBus implements RealtimeMutationBus {
  private readonly handlers = new Set<(mutation: RealtimeMutation) => void>();

  async publish(mutation: RealtimeMutation): Promise<void> {
    const decoded = parseMutation(serializeMutation(mutation));
    if (!decoded) return;
    for (const handler of this.handlers) handler(decoded);
  }

  async subscribe(handler: (mutation: RealtimeMutation) => void): Promise<void> {
    this.handlers.add(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
