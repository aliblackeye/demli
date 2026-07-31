import type { ChannelId } from "@demli/types";

const EMPTY: ReadonlySet<never> = new Set();

/** Channel → connections routing table. Generic so it is trivially testable. */
export class SubscriptionRegistry<TConn> {
  private readonly byChannel = new Map<ChannelId, Set<TConn>>();
  private readonly byConn = new Map<TConn, Set<ChannelId>>();

  add(conn: TConn, channelIds: Iterable<ChannelId>): void {
    const owned = this.byConn.get(conn) ?? new Set<ChannelId>();
    this.byConn.set(conn, owned);
    for (const channelId of channelIds) {
      owned.add(channelId);
      let subs = this.byChannel.get(channelId);
      if (!subs) {
        subs = new Set();
        this.byChannel.set(channelId, subs);
      }
      subs.add(conn);
    }
  }

  /**
   * Remove a connection from its subscriptions. With no `channelIds` the
   * connection is dropped from every channel (socket close). With `channelIds`
   * only those channels are removed — the partial unsubscribe the visibility
   * resync uses when a connection loses access to a subset of channels.
   */
  remove(conn: TConn, channelIds?: Iterable<ChannelId>): void {
    const owned = this.byConn.get(conn);
    if (!owned) return;

    // Snapshot: the full-remove path (`channelIds` omitted) iterates the same
    // set it mutates below.
    const targets = channelIds ?? [...owned];
    for (const channelId of targets) {
      if (!owned.delete(channelId)) continue;
      const subs = this.byChannel.get(channelId);
      subs?.delete(conn);
      if (subs && subs.size === 0) this.byChannel.delete(channelId);
    }
    if (owned.size === 0) this.byConn.delete(conn);
  }

  subscribers(channelId: ChannelId): ReadonlySet<TConn> {
    return this.byChannel.get(channelId) ?? (EMPTY as ReadonlySet<TConn>);
  }

  isSubscribed(conn: TConn, channelId: ChannelId): boolean {
    return this.byConn.get(conn)?.has(channelId) ?? false;
  }
}
