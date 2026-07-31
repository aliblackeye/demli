import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT,
  createFolder,
  moveIntoFolder,
  moveToTopLevel,
  normalizeLayout,
  parseLayout,
  reconcile,
  removeFolder,
  renameFolder,
  reorderTopLevel,
  serializeLayout,
  setFolderColor,
  toggleFolder,
  type FolderEntry,
  type RailFolderNode,
  type RailLayout,
} from "./serverFolders";

/** Minimal stand-in for a live server (reconcile only needs an id). */
const g = (id: string) => ({ id });
const ids = (list: string[]) => list;

/** A layout with a single folder holding `children`. */
function folderLayout(children: string[], extra: Partial<FolderEntry> = {}): RailLayout {
  return {
    version: 1,
    entries: [{ type: "folder", id: "f1", name: "", color: null, open: false, children, ...extra }],
  };
}

describe("reconcile", () => {
  it("keeps a flat, layout-free rail as bare servers in group order", () => {
    const nodes = reconcile(EMPTY_LAYOUT, [g("a"), g("b"), g("c")]);
    expect(nodes.map((n) => (n.kind === "server" ? n.group.id : `f:${n.id}`))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("renders a folder with its live members and bare servers around it", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "folder", id: "f1", name: "Games", color: null, open: true, children: ["b", "c"] },
      ],
    };
    const nodes = reconcile(layout, [g("a"), g("b"), g("c")]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "server", group: { id: "a" } });
    const folder = nodes[1] as RailFolderNode<{ id: string }>;
    expect(folder.kind).toBe("folder");
    expect(folder.open).toBe(true);
    expect(folder.groups.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("dissolves a folder that dropped to a single live server", () => {
    const nodes = reconcile(folderLayout(["b", "gone"]), [g("b")]);
    expect(nodes).toEqual([{ kind: "server", group: { id: "b" } }]);
  });

  it("drops an empty folder and appends brand-new servers at the end", () => {
    const layout = folderLayout(["x", "y"]); // both gone
    const nodes = reconcile(layout, [g("new1"), g("new2")]);
    expect(nodes.map((n) => (n.kind === "server" ? n.group.id : "?"))).toEqual(["new1", "new2"]);
  });

  it("never renders an unknown (left) server", () => {
    const nodes = reconcile({ version: 1, entries: [{ type: "server", id: "ghost" }] }, [g("a")]);
    expect(nodes).toEqual([{ kind: "server", group: { id: "a" } }]);
  });
});

describe("createFolder", () => {
  it("groups the dragged server onto the target into a new folder in place", () => {
    const next = createFolder(EMPTY_LAYOUT, ids(["a", "b", "c"]), "c", "a", "fNEW");
    // a-folder takes a's slot; b follows.
    expect(next.entries[0]).toMatchObject({ type: "folder", id: "fNEW", children: ["a", "c"] });
    expect(next.entries[1]).toEqual({ type: "server", id: "b" });
  });

  it("is a no-op when dropping a server onto itself", () => {
    const before = normalizeLayout(EMPTY_LAYOUT, ids(["a", "b"]));
    const after = createFolder(EMPTY_LAYOUT, ids(["a", "b"]), "a", "a", "fX");
    expect(after).toEqual(before);
  });

  it("adds to the existing folder when the target already lives in one", () => {
    const layout = folderLayout(["a", "b"]);
    const next = createFolder(layout, ids(["a", "b", "c"]), "c", "b", "fIGNORED");
    const folder = next.entries.find((e) => e.type === "folder") as FolderEntry;
    expect(folder.children).toContain("c");
  });
});

describe("moveIntoFolder", () => {
  it("appends a server to the folder and removes it from the top level", () => {
    const layout = folderLayout(["a", "b"]);
    const next = moveIntoFolder(layout, ids(["a", "b", "c"]), "c", "f1");
    const folder = next.entries.find((e) => e.type === "folder") as FolderEntry;
    expect(folder.children).toEqual(["a", "b", "c"]);
    expect(next.entries.some((e) => e.type === "server" && e.id === "c")).toBe(false);
  });

  it("reorders within the folder when inserting before a member", () => {
    const layout = folderLayout(["a", "b", "c"]);
    const next = moveIntoFolder(layout, ids(["a", "b", "c"]), "c", "f1", "a");
    const folder = next.entries.find((e) => e.type === "folder") as FolderEntry;
    expect(folder.children).toEqual(["c", "a", "b"]);
  });
});

describe("moveToTopLevel", () => {
  it("extracts a server from a folder back to the top level", () => {
    const layout = folderLayout(["a", "b", "c"]);
    const next = moveToTopLevel(layout, ids(["a", "b", "c"]), "a");
    expect(next.entries.some((e) => e.type === "server" && e.id === "a")).toBe(true);
    const folder = next.entries.find((e) => e.type === "folder") as FolderEntry;
    expect(folder.children).toEqual(["b", "c"]);
  });

  it("dissolves the folder when extraction leaves a single member", () => {
    const layout = folderLayout(["a", "b"]);
    const next = moveToTopLevel(layout, ids(["a", "b"]), "a");
    expect(next.entries.every((e) => e.type === "server")).toBe(true);
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?")).sort()).toEqual(["a", "b"]);
  });

  it("inserts before a given top-level entry key", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "server", id: "b" },
        { type: "server", id: "c" },
      ],
    };
    const next = moveToTopLevel(layout, ids(["a", "b", "c"]), "c", "server:a");
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?"))).toEqual(["c", "a", "b"]);
  });
});

describe("reorderTopLevel", () => {
  it("moves a top-level entry before another", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "server", id: "b" },
        { type: "server", id: "c" },
      ],
    };
    const next = reorderTopLevel(layout, ids(["a", "b", "c"]), "server:c", "server:a");
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?"))).toEqual(["c", "a", "b"]);
  });

  it("moves an entry to the end when no beforeKey is given", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "server", id: "b" },
      ],
    };
    const next = reorderTopLevel(layout, ids(["a", "b"]), "server:a");
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?"))).toEqual(["b", "a"]);
  });
});

describe("folder metadata", () => {
  it("toggles open state", () => {
    const layout = folderLayout(["a", "b"], { open: false });
    const opened = toggleFolder(layout, ids(["a", "b"]), "f1");
    expect((opened.entries[0] as FolderEntry).open).toBe(true);
  });

  it("renames (trimmed, capped) and clears with an empty string", () => {
    const layout = folderLayout(["a", "b"]);
    const renamed = renameFolder(layout, ids(["a", "b"]), "f1", "  Squad  ");
    expect((renamed.entries[0] as FolderEntry).name).toBe("Squad");
  });

  it("recolors a folder", () => {
    const layout = folderLayout(["a", "b"]);
    const colored = setFolderColor(layout, ids(["a", "b"]), "f1", "hsl(10 50% 50%)");
    expect((colored.entries[0] as FolderEntry).color).toBe("hsl(10 50% 50%)");
  });

  it("dissolves a folder back into bare servers at its position", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "folder", id: "f1", name: "", color: null, open: false, children: ["b", "c"] },
        { type: "server", id: "d" },
      ],
    };
    const next = removeFolder(layout, ids(["a", "b", "c", "d"]), "f1");
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("normalizeLayout", () => {
  it("is idempotent", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "folder", id: "f1", name: "x", color: null, open: true, children: ["a", "b"] },
        { type: "server", id: "c" },
      ],
    };
    const once = normalizeLayout(layout, ids(["a", "b", "c"]));
    const twice = normalizeLayout(once, ids(["a", "b", "c"]));
    expect(twice).toEqual(once);
  });

  it("de-duplicates a server that appears both top-level and in a folder", () => {
    const layout: RailLayout = {
      version: 1,
      entries: [
        { type: "server", id: "a" },
        { type: "folder", id: "f1", name: "", color: null, open: false, children: ["a", "b"] },
      ],
    };
    // "a" is claimed top-level first, so the folder keeps only "b" → dissolves.
    const next = normalizeLayout(layout, ids(["a", "b"]));
    expect(next.entries.map((e) => (e.type === "server" ? e.id : "?"))).toEqual(["a", "b"]);
  });
});

describe("serialization", () => {
  it("round-trips a layout", () => {
    const layout = folderLayout(["a", "b"], { name: "Games", color: "hsl(1 2% 3%)", open: true });
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("falls back to empty on garbage / null", () => {
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseLayout("not json{")).toEqual(EMPTY_LAYOUT);
    expect(parseLayout('{"entries":"nope"}')).toEqual(EMPTY_LAYOUT);
  });

  it("keeps only well-formed entries", () => {
    const raw = JSON.stringify({
      entries: [
        { type: "server", id: "a" },
        { type: "server" }, // missing id → dropped
        { type: "folder", id: "f1", children: ["b", 5, "c"] }, // non-string child pruned
        { type: "bogus" },
      ],
    });
    const parsed = parseLayout(raw);
    expect(parsed.entries).toEqual([
      { type: "server", id: "a" },
      { type: "folder", id: "f1", name: "", color: null, open: false, children: ["b", "c"] },
    ]);
  });
});
