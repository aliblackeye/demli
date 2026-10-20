/**
 * Fake realtime gateway for the chat harness (DEV ONLY, `&live=1`).
 *
 * The send path is the product's, end to end: the real composer calls the real
 * `sendChatMessage`, the real persistent outbox queues it, the real
 * RealtimeClient writes `message.send` to a socket — and this socket answers
 * the way the gateway does: the handshake (`auth.succeeded`) on open, then the
 * `message.created` echo carrying the client's nonce. So the optimistic →
 * confirmed hand-over the harness checks is the one users get, not a hand-set
 * store mutation.
 *
 * Only sockets to the realtime origin are faked; every other WebSocket (Vite's
 * HMR channel) is the browser's own.
 */
import { ME_ID } from "./fixtures";

const REALTIME_URL = (import.meta.env.VITE_REALTIME_URL as string | undefined) ?? "ws://localhost:4001";
/** Server-side latency of the echo — long enough to see the "sending" frame. */
const ECHO_DELAY_MS = 350;

const RealWebSocket = window.WebSocket;
let serverSeq = 0;
let serverIds = 0;

class FakeGatewaySocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeGatewaySocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    window.setTimeout(() => {
      this.readyState = FakeGatewaySocket.OPEN;
      this.onopen?.(new Event("open"));
      this.emit({ type: "auth.succeeded", payload: { userId: ME_ID, presence: [], voiceOccupancy: [] } });
    }, 30);
  }

  send(data: string): void {
    let frame: { type?: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      return;
    }
    if (frame.type !== "message.send" || !frame.payload) return;
    const { channelId, content, nonce } = frame.payload as { channelId: string; content: string; nonce: string };
    window.setTimeout(() => {
      serverIds += 1;
      this.emit({
        type: "message.created",
        payload: {
          id: `m-live-${serverIds}`,
          channelId,
          authorId: ME_ID,
          content,
          kind: "user",
          createdAt: new Date().toISOString(),
          updatedAt: null,
          deletedAt: null,
          reactions: [],
          nonce,
        },
      });
    }, ECHO_DELAY_MS);
  }

  close(): void {
    this.readyState = FakeGatewaySocket.CLOSED;
  }

  private emit(event: unknown): void {
    if (this.readyState !== FakeGatewaySocket.OPEN) return;
    serverSeq += 1;
    const data = JSON.stringify({ event, seq: serverSeq, sentAt: new Date().toISOString() });
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

/** Route realtime-origin sockets to the fake gateway; leave every other socket real. */
export function installFakeGateway(): void {
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const href = typeof url === "string" ? url : url.href;
    if (href.startsWith(REALTIME_URL)) return new FakeGatewaySocket(href);
    return new RealWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
}
