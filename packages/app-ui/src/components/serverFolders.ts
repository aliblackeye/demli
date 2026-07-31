/**
 * Server-folder model (collapsible rail folders) — the PURE, framework-free
 * core the GroupRail uses to group servers into collapsible folders.
 *
 * Split from the React hook / component on purpose: everything here is a plain
 * data transform (no React, no DOM, no localStorage), so the create/add/remove/
 * reorder/dissolve rules are unit-testable in a node vitest run.
 *
 * Design:
 *   - The STORED layout ({@link RailLayout}) is the user's INTENT — the ordered
 *     top-level entries (a bare server or a folder of servers) plus each folder's
 *     name/color/open + child order. It is the localStorage source of truth and
 *     is only ever changed by an explicit user action.
 *   - The DISPLAY ({@link reconcile}) merges that intent with the LIVE server
 *     list: it drops servers that are no longer joined, dissolves a folder that
 *     falls to a single server, drops an empty folder, and appends newly-joined
 *     servers at the end. This is render-only and is NEVER persisted on its own,
 *     so a transient empty `groups` (mid reload) can't wipe folders.
 *   - Every mutation normalizes against the CURRENT server ids, so a drop that
 *     touches a brand-new (not-yet-persisted) server still lands correctly.
 */

/** A bare server pinned at the top level of the rail. */
export interface ServerEntry {
  type: "server";
  id: string;
}

/** A folder: an ordered set of servers that collapses/expands in the rail. */
export interface FolderEntry {
  type: "folder";
  id: string;
  /** User label; "" renders the localized default ("Folder"). */
  name: string;
  /** Accent color as an `hsl(...)`/`#rgb` string, or null → seeded default. */
  color: string | null;
  /** Expanded (children listed) vs collapsed (2×2 preview tile). */
  open: boolean;
  /** Ordered child server ids. */
  children: string[];
}

export type LayoutEntry = ServerEntry | FolderEntry;

/** The persisted rail layout (localStorage). `version` guards future migrations. */
export interface RailLayout {
  version: 1;
  entries: LayoutEntry[];
}

export const EMPTY_LAYOUT: RailLayout = { version: 1, entries: [] };

/** A stable key for a top-level entry, used to address drop positions. */
export type EntryKey = string; // `server:<id>` | `folder:<id>`
/** The drop position "after the last entry". */
export const END = "end" as const;

export function entryKey(entry: LayoutEntry): EntryKey {
  return `${entry.type}:${entry.id}`;
}

// ── display model ───────────────────────────────────────────────────────────

export interface RailServerNode<G> {
  kind: "server";
  group: G;
}
export interface RailFolderNode<G> {
  kind: "folder";
  id: string;
  name: string;
  color: string | null;
  open: boolean;
  groups: G[];
}
export type RailNode<G> = RailServerNode<G> | RailFolderNode<G>;

/**
 * Merge the stored layout with the live server list into the render list.
 * Unknown servers are dropped, a folder with a single live server dissolves to a
 * bare server, an empty folder is dropped, and any live server not present in the
 * layout is appended at the end (a freshly-joined server).
 */
export function reconcile<G extends { id: string }>(
  layout: RailLayout,
  groups: readonly G[],
): RailNode<G>[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const placed = new Set<string>();
  const nodes: RailNode<G>[] = [];

  for (const entry of layout.entries) {
    if (entry.type === "server") {
      const g = byId.get(entry.id);
      if (g && !placed.has(entry.id)) {
        nodes.push({ kind: "server", group: g });
        placed.add(entry.id);
      }
      continue;
    }
    const members = entry.children
      .filter((id) => byId.has(id) && !placed.has(id))
      .map((id) => byId.get(id)!);
    if (members.length >= 2) {
      members.forEach((g) => placed.add(g.id));
      nodes.push({
        kind: "folder",
        id: entry.id,
        name: entry.name,
        color: entry.color,
        open: entry.open,
        groups: members,
      });
    } else if (members.length === 1) {
      // A folder that fell to one server reads as a plain server.
      const only = members[0]!;
      placed.add(only.id);
      nodes.push({ kind: "server", group: only });
    }
    // 0 live children → folder disappears.
  }

  for (const g of groups) {
    if (!placed.has(g.id)) nodes.push({ kind: "server", group: g });
  }
  return nodes;
}

// ── normalization ───────────────────────────────────────────────────────────

/**
 * Rewrite the layout so it holds EXACTLY the current servers, once each: prune
 * unknown ids, dissolve a folder with <2 live children (its one remaining server
 * becomes a bare entry in-place), drop empty folders, and append newly-joined
 * servers at the end. Idempotent. This is the canonical form persisted after any
 * mutation, and the base every mutation operates on.
 */
export function normalizeLayout(layout: RailLayout, groupIds: readonly string[]): RailLayout {
  const known = new Set(groupIds);
  const seen = new Set<string>();
  const entries: LayoutEntry[] = [];

  for (const entry of layout.entries) {
    if (entry.type === "server") {
      if (known.has(entry.id) && !seen.has(entry.id)) {
        entries.push({ type: "server", id: entry.id });
        seen.add(entry.id);
      }
      continue;
    }
    const children = entry.children.filter((id) => known.has(id) && !seen.has(id));
    if (children.length >= 2) {
      children.forEach((id) => seen.add(id));
      entries.push({ ...entry, children });
    } else if (children.length === 1) {
      const only = children[0]!;
      entries.push({ type: "server", id: only });
      seen.add(only);
    }
  }

  for (const id of groupIds) {
    if (!seen.has(id)) {
      entries.push({ type: "server", id });
      seen.add(id);
    }
  }

  return { version: 1, entries };
}

// ── internal helpers ────────────────────────────────────────────────────────

/** Remove a server id from the top level AND from every folder's children. */
function withoutServer(entries: LayoutEntry[], id: string): LayoutEntry[] {
  return entries
    .filter((e) => !(e.type === "server" && e.id === id))
    .map((e) =>
      e.type === "folder" ? { ...e, children: e.children.filter((c) => c !== id) } : e,
    );
}

/** Index of the top-level entry with `key`, or -1. */
function indexOfKey(entries: LayoutEntry[], key: EntryKey): number {
  return entries.findIndex((e) => entryKey(e) === key);
}

/** Splice `entry` into `entries` before `beforeKey` (or at the end). */
function insertBefore(
  entries: LayoutEntry[],
  entry: LayoutEntry,
  beforeKey: EntryKey | typeof END | undefined,
): LayoutEntry[] {
  const next = [...entries];
  if (!beforeKey || beforeKey === END) {
    next.push(entry);
    return next;
  }
  const idx = indexOfKey(next, beforeKey);
  if (idx < 0) next.push(entry);
  else next.splice(idx, 0, entry);
  return next;
}

// ── mutations ───────────────────────────────────────────────────────────────
// Each takes the stored layout + the CURRENT server ids, and returns a fresh,
// normalized layout. They never mutate their inputs.

/**
 * Create a folder by dropping `draggedId` onto the top-level server `targetId`.
 * The new folder takes the target's position and contains [target, dragged].
 * No-op (returns normalized input) when dragging a server onto itself. If the
 * target is already inside a folder, this adds the dragged server to that folder.
 */
export function createFolder(
  layout: RailLayout,
  groupIds: readonly string[],
  draggedId: string,
  targetId: string,
  folderId: string,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  if (draggedId === targetId) return base;
  if (!groupIds.includes(draggedId) || !groupIds.includes(targetId)) return base;

  // The target must currently be a bare top-level server to seed a new folder.
  const targetIdx = indexOfKey(base.entries, `server:${targetId}`);
  if (targetIdx < 0) {
    // Target is inside a folder → treat as "add to that folder" instead.
    const folder = base.entries.find(
      (e): e is FolderEntry => e.type === "folder" && e.children.includes(targetId),
    );
    if (folder) return moveIntoFolder(base, groupIds, draggedId, folder.id, targetId);
    return base;
  }

  const cleaned = withoutServer(base.entries, draggedId);
  const at = indexOfKey(cleaned, `server:${targetId}`);
  const folder: FolderEntry = {
    type: "folder",
    id: folderId,
    name: "",
    color: null,
    open: false,
    children: [targetId, draggedId],
  };
  const next = [...cleaned];
  // Replace the bare target with the folder.
  next.splice(at, 1, folder);
  return normalizeLayout({ version: 1, entries: next }, groupIds);
}

/**
 * Move `draggedId` into folder `folderId`, before `beforeServerId` if given (a
 * reorder when the server is already in that folder), else appended.
 */
export function moveIntoFolder(
  layout: RailLayout,
  groupIds: readonly string[],
  draggedId: string,
  folderId: string,
  beforeServerId?: string,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  if (!groupIds.includes(draggedId)) return base;
  const target = base.entries.find(
    (e): e is FolderEntry => e.type === "folder" && e.id === folderId,
  );
  if (!target) return base;

  const entries = withoutServer(base.entries, draggedId).map((e) => {
    if (e.type !== "folder" || e.id !== folderId) return e;
    const children = e.children.filter((c) => c !== draggedId);
    const at =
      beforeServerId && beforeServerId !== draggedId
        ? children.indexOf(beforeServerId)
        : -1;
    if (at < 0) children.push(draggedId);
    else children.splice(at, 0, draggedId);
    return { ...e, children };
  });
  return normalizeLayout({ version: 1, entries }, groupIds);
}

/**
 * Pull `draggedServerId` out to the top level (from wherever it is), inserted
 * before `beforeKey` or appended. Extracting the second-to-last member of a
 * folder dissolves it (via normalization).
 */
export function moveToTopLevel(
  layout: RailLayout,
  groupIds: readonly string[],
  draggedServerId: string,
  beforeKey?: EntryKey | typeof END,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  if (!groupIds.includes(draggedServerId)) return base;
  const cleaned = withoutServer(base.entries, draggedServerId);
  const next = insertBefore(cleaned, { type: "server", id: draggedServerId }, beforeKey);
  return normalizeLayout({ version: 1, entries: next }, groupIds);
}

/**
 * Reorder a whole top-level entry (a bare server or a folder) to before
 * `beforeKey`, or to the end. A no-op when it would land in its own spot.
 */
export function reorderTopLevel(
  layout: RailLayout,
  groupIds: readonly string[],
  draggedKey: EntryKey,
  beforeKey?: EntryKey | typeof END,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  if (draggedKey === beforeKey) return base;
  const idx = indexOfKey(base.entries, draggedKey);
  if (idx < 0) return base;
  const entry = base.entries[idx]!;
  const cleaned = base.entries.filter((_, i) => i !== idx);
  const next = insertBefore(cleaned, entry, beforeKey);
  return normalizeLayout({ version: 1, entries: next }, groupIds);
}

/** Toggle a folder's expanded state. */
export function toggleFolder(
  layout: RailLayout,
  groupIds: readonly string[],
  folderId: string,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  const entries = base.entries.map((e) =>
    e.type === "folder" && e.id === folderId ? { ...e, open: !e.open } : e,
  );
  return { version: 1, entries };
}

/** Set a folder's open state explicitly. */
export function setFolderOpen(
  layout: RailLayout,
  groupIds: readonly string[],
  folderId: string,
  open: boolean,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  const entries = base.entries.map((e) =>
    e.type === "folder" && e.id === folderId ? { ...e, open } : e,
  );
  return { version: 1, entries };
}

/** Rename a folder ("" clears back to the default label). */
export function renameFolder(
  layout: RailLayout,
  groupIds: readonly string[],
  folderId: string,
  name: string,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  const entries = base.entries.map((e) =>
    e.type === "folder" && e.id === folderId ? { ...e, name: name.trim().slice(0, 60) } : e,
  );
  return { version: 1, entries };
}

/** Recolor a folder (null → seeded default). */
export function setFolderColor(
  layout: RailLayout,
  groupIds: readonly string[],
  folderId: string,
  color: string | null,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  const entries = base.entries.map((e) =>
    e.type === "folder" && e.id === folderId ? { ...e, color } : e,
  );
  return { version: 1, entries };
}

/**
 * Dissolve a folder: its servers return to the top level, in order, at the
 * folder's former position.
 */
export function removeFolder(
  layout: RailLayout,
  groupIds: readonly string[],
  folderId: string,
): RailLayout {
  const base = normalizeLayout(layout, groupIds);
  const idx = base.entries.findIndex((e) => e.type === "folder" && e.id === folderId);
  if (idx < 0) return base;
  const folder = base.entries[idx] as FolderEntry;
  const replacement: LayoutEntry[] = folder.children.map((id) => ({ type: "server", id }));
  const next = [...base.entries];
  next.splice(idx, 1, ...replacement);
  return normalizeLayout({ version: 1, entries: next }, groupIds);
}

// ── (de)serialization ───────────────────────────────────────────────────────

/**
 * Parse a persisted layout, tolerating any shape (older/newer/corrupt) by
 * falling back to the empty layout. Only well-formed entries survive.
 */
export function parseLayout(raw: string | null | undefined): RailLayout {
  if (!raw) return EMPTY_LAYOUT;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return EMPTY_LAYOUT;
    const entriesRaw = (data as { entries?: unknown }).entries;
    if (!Array.isArray(entriesRaw)) return EMPTY_LAYOUT;
    const entries: LayoutEntry[] = [];
    for (const item of entriesRaw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === "server" && typeof rec.id === "string") {
        entries.push({ type: "server", id: rec.id });
      } else if (
        rec.type === "folder" &&
        typeof rec.id === "string" &&
        Array.isArray(rec.children)
      ) {
        entries.push({
          type: "folder",
          id: rec.id,
          name: typeof rec.name === "string" ? rec.name : "",
          color: typeof rec.color === "string" ? rec.color : null,
          open: rec.open === true,
          children: rec.children.filter((c): c is string => typeof c === "string"),
        });
      }
    }
    return { version: 1, entries };
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function serializeLayout(layout: RailLayout): string {
  return JSON.stringify(layout);
}
