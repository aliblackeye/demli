/**
 * Outbound backpressure guard for gateway connections.
 *
 * A WebSocket peer that stops DRAINING its socket — while the connection itself
 * stays alive — makes the server queue every subsequent broadcast for it. The
 * heartbeat reaper does not help here: it only reclaims sockets that stop
 * answering pings, and a slow consumer is not a dead one. Without a ceiling the
 * queue grows until the process dies, which makes this the cheapest
 * memory-exhaustion path into the gateway.
 *
 * Kept in its own module (like `rate-limit.ts`) so the policy is unit-testable
 * without a real socket, network, or clock.
 */

/**
 * Default ceiling on a connection's unflushed write queue, in bytes.
 *
 * 1 MiB is ~40× the largest single server frame (a message with full content and
 * attachments is ≈26 KB) and roughly a thousand queued chat events. An honest
 * client cannot reach it: a slow link still drains — the kernel keeps flushing as
 * ACKs arrive — so the queue only stays this deep when the peer has stopped
 * reading altogether. Deliberately generous, so a 2G-grade mobile connection in
 * a busy group is never mistaken for an attacker.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** The slice of a WebSocket this guard needs — everything else is irrelevant. */
export interface BackpressureSocket {
  /** Bytes queued but not yet flushed to the OS. */
  readonly bufferedAmount: number;
  terminate(): void;
}

/**
 * Drop `socket` when its write queue is over `maxBufferedBytes`; returns true
 * when it did, in which case the caller must not write to the socket.
 *
 * `terminate()` rather than `close()`: a peer this far behind is by definition
 * not reading, so a courtesy close frame would only queue behind the same
 * backlog, and `ws` would then hold the whole buffer alive for its 30 s close
 * timeout — exactly the memory this guard exists to release. The client sees an
 * abnormal close (1006) and reconnects with backoff like after any other drop,
 * so an honest client that somehow trips this self-heals.
 */
export function dropIfOverBuffered(
  socket: BackpressureSocket,
  maxBufferedBytes: number = MAX_BUFFERED_BYTES,
  onDrop?: (bufferedAmount: number) => void,
): boolean {
  const buffered = socket.bufferedAmount;
  if (buffered <= maxBufferedBytes) return false;
  onDrop?.(buffered);
  socket.terminate();
  return true;
}
