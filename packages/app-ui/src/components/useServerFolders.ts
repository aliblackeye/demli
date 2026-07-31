/**
 * useServerFolders — the React seam over the pure {@link serverFolders} model.
 *
 * Owns the localStorage persistence (per-account) and the display list, and
 * exposes stable action callbacks the GroupRail wires to its drag/drop + context
 * menu. All structural rules live in the pure module; this hook is only state +
 * storage + the derived render list.
 *
 * Persistence: keyed per account (`demli:server-folders:v1:<accountId>`), so
 * two accounts on one machine keep independent folder layouts. Writes happen
 * ONLY on an explicit action — never on load or on a groups tick — so a
 * transient empty `groups` can't erase a saved layout. Backend sync is a future
 * step (the layout is a plain JSON blob that can be POSTed to a user-prefs
 * endpoint later without touching this contract).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellGroup } from "../data/shell-data";
import {
  EMPTY_LAYOUT,
  createFolder as createFolderOp,
  moveIntoFolder as moveIntoFolderOp,
  moveToTopLevel as moveToTopLevelOp,
  parseLayout,
  reconcile,
  removeFolder as removeFolderOp,
  renameFolder as renameFolderOp,
  reorderTopLevel as reorderTopLevelOp,
  serializeLayout,
  setFolderColor as setFolderColorOp,
  toggleFolder as toggleFolderOp,
  type EntryKey,
  type END,
  type RailLayout,
  type RailNode,
} from "./serverFolders";

const STORAGE_PREFIX = "demli:server-folders:v1:";

function storageKey(accountId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${accountId && accountId.length > 0 ? accountId : "anon"}`;
}

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function loadLayout(key: string): RailLayout {
  if (!hasStorage()) return EMPTY_LAYOUT;
  try {
    return parseLayout(window.localStorage.getItem(key));
  } catch {
    return EMPTY_LAYOUT;
  }
}

function saveLayout(key: string, layout: RailLayout): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(key, serializeLayout(layout));
  } catch {
    // Quota / privacy mode — folders simply won't persist this session.
  }
}

let folderCounter = 0;
function nextFolderId(): string {
  folderCounter += 1;
  return `fld_${Date.now().toString(36)}_${folderCounter.toString(36)}`;
}

export interface UseServerFolders {
  /** The reconciled render list (bare servers + folders), live-groups-merged. */
  nodes: RailNode<ShellGroup>[];
  /** Drop a server onto a top-level server → make a folder of the two. */
  createFolderFrom: (draggedId: string, targetServerId: string) => void;
  /** Drop a server into a folder (optionally before a member, for reordering). */
  addToFolder: (draggedId: string, folderId: string, beforeServerId?: string) => void;
  /** Pull a server out to the top level, before an entry key or at the end. */
  extractToTop: (draggedServerId: string, beforeKey?: EntryKey | typeof END) => void;
  /** Reorder a whole top-level entry (server or folder). */
  reorderTop: (draggedKey: EntryKey, beforeKey?: EntryKey | typeof END) => void;
  /** Expand/collapse a folder. */
  toggleOpen: (folderId: string) => void;
  /** Rename a folder ("" → default label). */
  rename: (folderId: string, name: string) => void;
  /** Recolor a folder (null → seeded default). */
  recolor: (folderId: string, color: string | null) => void;
  /** Dissolve a folder back into bare servers. */
  dissolve: (folderId: string) => void;
}

export function useServerFolders(
  accountId: string | null | undefined,
  groups: readonly ShellGroup[],
): UseServerFolders {
  const key = storageKey(accountId);
  const [layout, setLayout] = useState<RailLayout>(() => loadLayout(key));

  // Reload when the active account changes — never persists, so switching
  // accounts can't cross-contaminate the two saved layouts.
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setLayout(loadLayout(key));
  }, [key]);

  // Latest group ids, via a ref so the action callbacks stay stable identities
  // (the rail's drag handlers depend on them; churn would break in-flight drags).
  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;

  // Persist ONLY here — every layout change flows through an action.
  const apply = useCallback((op: (prev: RailLayout, ids: readonly string[]) => RailLayout) => {
    setLayout((prev) => {
      const next = op(prev, groupIdsRef.current);
      saveLayout(keyRef.current, next);
      return next;
    });
  }, []);

  const nodes = useMemo(() => reconcile(layout, groups), [layout, groups]);

  const createFolderFrom = useCallback(
    (draggedId: string, targetServerId: string) =>
      apply((prev, ids) => createFolderOp(prev, ids, draggedId, targetServerId, nextFolderId())),
    [apply],
  );
  const addToFolder = useCallback(
    (draggedId: string, folderId: string, beforeServerId?: string) =>
      apply((prev, ids) => moveIntoFolderOp(prev, ids, draggedId, folderId, beforeServerId)),
    [apply],
  );
  const extractToTop = useCallback(
    (draggedServerId: string, beforeKey?: EntryKey | typeof END) =>
      apply((prev, ids) => moveToTopLevelOp(prev, ids, draggedServerId, beforeKey)),
    [apply],
  );
  const reorderTop = useCallback(
    (draggedKey: EntryKey, beforeKey?: EntryKey | typeof END) =>
      apply((prev, ids) => reorderTopLevelOp(prev, ids, draggedKey, beforeKey)),
    [apply],
  );
  const toggleOpen = useCallback(
    (folderId: string) => apply((prev, ids) => toggleFolderOp(prev, ids, folderId)),
    [apply],
  );
  const rename = useCallback(
    (folderId: string, name: string) => apply((prev, ids) => renameFolderOp(prev, ids, folderId, name)),
    [apply],
  );
  const recolor = useCallback(
    (folderId: string, color: string | null) =>
      apply((prev, ids) => setFolderColorOp(prev, ids, folderId, color)),
    [apply],
  );
  const dissolve = useCallback(
    (folderId: string) => apply((prev, ids) => removeFolderOp(prev, ids, folderId)),
    [apply],
  );

  return {
    nodes,
    createFolderFrom,
    addToFolder,
    extractToTop,
    reorderTop,
    toggleOpen,
    rename,
    recolor,
    dissolve,
  };
}
