/**
 * Shared integration-test harness for the gateway suites: DB reachability
 * probe + a WebSocket test client that records every server frame.
 *
 * Not a test file itself (vitest only includes files ending in `.test.ts`).
 */

import WebSocket from "ws";
import { createDb } from "@demli/db";
import {
  serverEnvelopeSchema,
  type ClientToServerEvent,
  type ServerEnvelope,
  type ServerEventOf,
  type ServerEventType,
} from "@demli/protocol";

export const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

export async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

/**
 * A UNIQUE `x-forwarded-for` per test socket, so the gateway's per-address
 * handshake limit (connection-limits.ts) gives every client its own bucket
 * instead of collapsing the whole suite into 127.0.0.1's. Same technique the API
 * suites already use for the per-IP login limit — and it exercises the real
 * production code path, where Caddy is what sets this header.
 */
let forwardedForCounter = 0;
export function nextTestClientIp(): string {
  const n = (forwardedForCounter += 1);
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

export class TestClient {
  readonly envelopes: ServerEnvelope[] = [];
  /**
   * Every server frame VERBATIM, before zod parsing. `serverEnvelopeSchema`
   * strips unknown keys, so leak assertions (e.g. "no `storagePath` ever goes
   * over the wire", ADR 0008 §2) MUST run against these raw strings.
   */
  readonly rawFrames: string[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<number>;

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on("close", (code) => resolve(code));
    });
    socket.on("message", (raw) => {
      const frame = String(raw);
      this.rawFrames.push(frame);
      // Every server frame must be a valid enveloped protocol event.
      const envelope = serverEnvelopeSchema.parse(JSON.parse(frame));
      this.envelopes.push(envelope);
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) wake();
    });
  }

  static async connect(
    port: number,
    token: string | null,
    platform?: "desktop" | "mobile",
  ): Promise<TestClient> {
    const query = token
      ? `?token=${encodeURIComponent(token)}${platform ? `&platform=${platform}` : ""}`
      : "";
    const url = `ws://127.0.0.1:${port}/${query}`;
    const socket = new WebSocket(url, { headers: { "x-forwarded-for": nextTestClientIp() } });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("close", () => resolve()); // rejected handshakes still "open" then close
      socket.once("error", reject);
    });
    return client;
  }

  send(event: ClientToServerEvent): void {
    this.socket.send(JSON.stringify(event));
  }

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  async waitFor<T extends ServerEventType>(
    type: T,
    predicate: (event: ServerEventOf<T>) => boolean = () => true,
    timeoutMs = 4000,
  ): Promise<ServerEventOf<T>> {
    const started = Date.now();
    let scanned = 0;
    for (;;) {
      for (; scanned < this.envelopes.length; scanned++) {
        const envelope = this.envelopes[scanned];
        if (envelope && envelope.event.type === type) {
          const event = envelope.event as ServerEventOf<T>;
          if (predicate(event)) return event;
        }
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for ${type}; saw [${this.envelopes
            .map((e) => e.event.type)
            .join(", ")}]`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}
