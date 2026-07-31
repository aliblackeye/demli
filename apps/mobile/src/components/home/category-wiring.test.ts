/**
 * Source-level invariants for channel categories on MOBILE (M18 parity).
 *
 * Five things can rot here and none of them shows up as a type error:
 *
 *  1. The list starts deciding placement for itself. The bucket model, the
 *     nudges and the reorder payload live in @demli/client-core precisely
 *     because desktop, web and mobile must agree; a local `sort`/`filter` here
 *     is how the three start disagreeing about where a channel belongs.
 *  2. The reorder request is hand-built. The server renumbers positions densely
 *     from 0 over exactly the ids it is given, so a partial bucket collides the
 *     moved channel with neighbours nobody touched. `toReorderPayload` is the
 *     only thing that gets that right by construction.
 *  3. Management controls become visible-but-refused. Category create/rename/
 *     delete and every placement entry need owner ∨ MANAGE_CHANNELS; the API
 *     answers 403 otherwise, so an unauthorized viewer must see NOTHING, not a
 *     disabled row (§35).
 *  4. Uncategorized channels stop being first. A pre-M18 server is entirely the
 *     uncategorized bucket — if it ever renders below the categories, every
 *     server that never made one looks broken.
 *  5. Live category events go back to being ignored. The four `category.*` cases
 *     were explicit no-op stopgaps until this wave; a refactor that "tidies" them
 *     back into the no-op arm silently kills live sidebar updates.
 *
 * The mobile app has no RN render harness (node-environment vitest), so the
 * repo's established way to assert component wiring is to read the source — the
 * same technique voice-channel-chat-wiring.test.ts uses.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(HERE, relative), "utf8");

const list = read("./ServerChannelList.tsx");
const categorySheet = read("./CategoryActionSheet.tsx");
const channelSheet = read("./ChannelActionSheet.tsx");
const moveSheet = read("./ChannelMoveSheet.tsx");
const editor = read("../../../app/(app)/category-editor.tsx");
const newChannel = read("../../../app/(app)/new-channel.tsx");
const realtime = read("../../realtime/connection.ts");

describe("placement decisions come from the shared rules, never from this list", () => {
  it("builds its buckets with the shared model instead of grouping by hand", () => {
    expect(list).toMatch(/buildSidebarBuckets\(channels, categories \?\? \[\]\)/);
    expect(list).toMatch(/from "@demli\/client-core"/);
  });

  it("moves channels and categories with the shared nudge/move helpers", () => {
    expect(list).toMatch(/nudgeChannel\(buckets, channelId, direction\)/);
    expect(list).toMatch(/nudgeCategory\(categoryIds, categoryId, direction\)/);
    expect(list).toMatch(/moveChannel\(buckets, channelId, \{ categoryId, beforeChannelId: null \}\)/);
  });

  it("never hand-builds a reorder body — the whole changed bucket or nothing", () => {
    const commit = list.slice(list.indexOf("const commitReorder"), list.indexOf("const moveChannelSlot"));
    expect(commit).toMatch(/toReorderPayload\(\{/);
    // A null payload means nothing moved; firing anyway would send a body the
    // API rejects as empty.
    expect(commit).toMatch(/if \(!payload\) return;/);
    // No local position arithmetic: the payload builder owns it.
    expect(commit).not.toMatch(/position/);
  });

  it("asks the shared rule which destinations a move offers", () => {
    expect(moveSheet).toMatch(/channelMoveDestinations\(buckets, target\.channelId\)/);
    // The "am I already in this bucket" exclusion must not be re-derived here.
    expect(moveSheet).not.toMatch(/\.filter\(/);
  });
});

describe("an unauthorized viewer sees no category management", () => {
  it("gates the category menu on the shared rule, which returns [] without the bit", () => {
    expect(categorySheet).toMatch(/categoryMenuItems\(\{/);
    expect(categorySheet).toMatch(/canManageChannels,/);
    // Absent, not disabled: the sheet only opens when the rule produced entries.
    expect(categorySheet).toMatch(/visible=\{target !== null && items\.length > 0\}/);
    expect(categorySheet).not.toMatch(/disabled=/);
  });

  it("gates the row's placement entries on the same shared rule", () => {
    expect(channelSheet).toMatch(/channelPlacementMenuItems\(target\.placement\)/);
    expect(channelSheet).toMatch(/placementItems\.length > 0/);
  });

  it("hides create-category and the header's manage target behind canManageChannels", () => {
    expect(list).toMatch(/const canManageChannels = isOwner \|\| can\(PERMISSIONS\.MANAGE_CHANNELS\)/);
    // The "create category" row sits in the same authorized block as "new channel".
    const tail = list.slice(list.lastIndexOf("{canManageChannels ? ("));
    expect(tail).toMatch(/mobile:group\.newChannel/);
    expect(tail).toMatch(/mobile:category\.createCategory/);
    // The header's ⋮ is rendered conditionally rather than disabled.
    const header = list.slice(
      list.indexOf("const renderCategoryHeader"),
      list.indexOf("if (isLoading && !data)"),
    );
    expect(header).toMatch(/\{canManageChannels \? \(/);
    expect(header).not.toMatch(/disabled/);
  });

  it("deletes only behind a confirm that promises the channels survive", () => {
    const confirm = list.slice(
      list.indexOf("const confirmDeleteCategory"),
      list.indexOf("/** Resolve a sheet target"),
    );
    expect(confirm).toMatch(/mobile:category\.deleteTitle/);
    expect(confirm).toMatch(/mobile:category\.deleteBody/);
    expect(confirm).toMatch(/style: "destructive"/);
  });
});

describe("uncategorized channels render first", () => {
  it("reads the uncategorized bucket out of the model and renders it before categories", () => {
    expect(list).toMatch(/const uncategorized = buckets\.find\(\(b\) => b\.category === null\)/);
    const body = list.slice(list.indexOf("<SectionLabel>{t(\"mobile:group.textChannels\")}"));
    // The category sections come strictly AFTER the uncategorized ones.
    expect(body.indexOf("buckets\n          .filter((bucket) => bucket.category !== null)")).
      toBeGreaterThan(body.indexOf("mobile:group.voiceChannels"));
  });

  it("keeps the familiar Text/Voice split for the uncategorized bucket only", () => {
    expect(list).toMatch(
      /const textChannels = \(uncategorized\?\.channels \?\? \[\]\)\.filter\(\(c\) => c\.kind === "text"\)/,
    );
    // A category keeps the owner's arrangement — re-splitting it by kind would
    // throw away the ordering they set.
    const categorySection = list.slice(
      list.indexOf("{buckets\n          .filter((bucket) => bucket.category !== null)"),
      // lastIndexOf: `{canManageChannels ? (` also appears inside the category
      // header renderer, which sits ABOVE this section — the first match would
      // slice backwards and silently produce an empty string that passes a
      // `not.toMatch` for the wrong reason.
      list.lastIndexOf("{canManageChannels ? ("),
    );
    expect(categorySection.length).toBeGreaterThan(0);
    expect(categorySection).toMatch(/bucket\.channels\.map\(\(channel\) => renderChannelRow\(channel\)\)/);
    expect(categorySection).not.toMatch(/kind === "text"|kind === "voice"/);
  });
});

describe("collapsing survives a relaunch", () => {
  it("reads and writes the persisted store rather than local component state", () => {
    expect(list).toMatch(/useCollapsedCategoryIds\(groupId\)/);
    expect(list).toMatch(/useCollapsedCategoriesStore\(\(s\) => s\.toggle\)/);
    const header = list.slice(
      list.indexOf("const renderCategoryHeader"),
      list.indexOf("if (isLoading && !data)"),
    );
    expect(header).toMatch(/toggleCollapsed\(groupId, category\.id\)/);
    // A plain useState here is exactly the regression this asserts against.
    expect(header).not.toMatch(/useState/);
  });

  it("labels the toggle for a screen reader in both directions", () => {
    const header = list.slice(
      list.indexOf("const renderCategoryHeader"),
      list.indexOf("if (isLoading && !data)"),
    );
    expect(header).toMatch(/mobile:category\.expandA11y/);
    expect(header).toMatch(/mobile:category\.collapseA11y/);
    expect(header).toMatch(/accessibilityState=\{\{ expanded: !collapsed \}\}/);
  });
});

describe("every new tap target is big enough to hit", () => {
  it("keeps the category header's controls at 44pt", () => {
    const header = list.slice(
      list.indexOf("const renderCategoryHeader"),
      list.indexOf("if (isLoading && !data)"),
    );
    expect(header).toMatch(/minHeight: 44/);
    expect(header).toMatch(/minWidth: 44/);
  });
});

describe("category events update the list live", () => {
  it("no longer treats the four category events as no-ops", () => {
    const arm = realtime.slice(
      realtime.indexOf("case SERVER_EVENT.categoryCreated"),
      realtime.indexOf("case SERVER_EVENT.blocksUpdated"),
    );
    expect(arm).toMatch(/queryKeys\.categories\(event\.payload\.category\.groupId\)/);
    expect(arm).toMatch(/queryKeys\.categories\(event\.payload\.groupId\)/);
    // Delete and reorder move CHANNELS too, so group details must be refreshed
    // or the list keeps filing them under a category that is gone or stale.
    expect(arm).toMatch(/queryKeys\.groupDetails\(event\.payload\.groupId\)/);
  });

  it("never resubscribes the gateway for a category change", () => {
    // A category grants no permissions and changes no visibility (ADR 0007), so
    // a re-handshake here would be a pointless reconnect on every rename.
    const arm = realtime.slice(
      realtime.indexOf("case SERVER_EVENT.categoryCreated"),
      realtime.indexOf("case SERVER_EVENT.customStatusUpdated"),
    );
    expect(arm).not.toMatch(/resubscribe/i);
  });
});

describe("creating a channel inside a category actually files it there", () => {
  it("passes the category through from the header's + to the create call", () => {
    expect(list).toMatch(/onCreateChannel=\{\(target\) => openNewChannel\(target\.categoryId\)\}/);
    expect(list).toMatch(/params: categoryId \? \{ groupId, categoryId \} : \{ groupId \}/);
    expect(newChannel).toMatch(/\.\.\.\(categoryId \? \{ categoryId \} : \{\}\)/);
  });

  it("keeps a plain 'new channel' uncategorized", () => {
    // Sending `categoryId: null` explicitly would be equivalent, but only the
    // conditional spread guarantees a plain create never carries a stale param.
    expect(newChannel).toMatch(/const categoryId = \(params\.categoryId \?\? null\)/);
  });
});

describe("the category editor is one screen for create and rename", () => {
  it("switches on the presence of a categoryId rather than a mode flag", () => {
    expect(editor).toMatch(/const isRename = categoryId !== null/);
    expect(editor).toMatch(/if \(isRename\) renameCategory\.mutate/);
    expect(editor).toMatch(/else createCategory\.mutate/);
  });

  it("validates the name against the shared limit, not a local number", () => {
    expect(editor).toMatch(/CATEGORY_NAME_MAX_LENGTH/);
    expect(editor).toMatch(/from "@demli\/config"/);
    expect(editor).toMatch(/mobile:category\.nameRequired/);
  });
});
