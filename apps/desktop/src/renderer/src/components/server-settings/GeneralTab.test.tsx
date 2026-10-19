// @vitest-environment jsdom
/**
 * General tab draft guard — same contract as the role editor (RolesTab.test):
 * the form is compared against the server value it was seeded from, so a
 * `group.updated` refetch never turns an untouched form dirty (which would lock
 * the dialog), a dirty form keeps its draft and says the server moved, and our
 * own save adopts the server's answer.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FriendGroup, GroupId, UserId } from "@demli/types";

vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

vi.mock("../../lib/i18n", () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const state = vi.hoisted(() => ({
  updateMutate: null as unknown as (vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) => void,
}));

vi.mock("../../queries/chat-queries", () => ({
  useGroupDetails: () => ({ data: { channels: [], members: [] } }),
  useDeleteGroup: () => ({ isPending: false, mutate: vi.fn() }),
  useUploadGroupBanner: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateGroup: () => ({
    isPending: false,
    mutate: (vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) => state.updateMutate(vars, opts),
  }),
}));

import { GeneralTab } from "./GeneralTab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = (patch: Partial<FriendGroup> = {}): FriendGroup =>
  ({
    id: "g-1" as GroupId,
    name: "Çekirdek Kadro",
    ownerId: "u-1" as UserId,
    iconUrl: null,
    bannerUrl: null,
    systemChannelId: null,
    invitePolicy: "members",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  }) as FriendGroup;

let host: HTMLDivElement;
let root: Root;
const render = (g: FriendGroup): void =>
  act(() => root.render(createElement(GeneralTab, { group: g, isOwner: true })));
const nameInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>("#server-name")!;
const typeName = (value: string): void =>
  act(() => {
    const input = nameInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const unsavedBar = (): Element | null => document.querySelector("[data-unsaved-bar]");
const changedNotice = (): Element | null => document.querySelector("[data-changed-elsewhere]");

beforeEach(() => {
  state.updateMutate = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("GeneralTab — the draft follows the server it was seeded from", () => {
  it("a remote rename into a CLEAN form follows it and stays clean", () => {
    render(group());
    render(group({ name: "Gece Ekibi" }));
    expect(nameInput().value).toBe("Gece Ekibi");
    expect(unsavedBar()).toBeNull();
    expect(changedNotice()).toBeNull();
  });

  it("a remote rename under a DIRTY form keeps the draft and says so", () => {
    render(group());
    typeName("Kadro");
    expect(unsavedBar()).not.toBeNull();
    render(group({ name: "Gece Ekibi" }));
    expect(nameInput().value).toBe("Kadro");
    expect(changedNotice()).not.toBeNull();
  });

  it("our own save adopts the server's normalized answer — no phantom draft", () => {
    state.updateMutate = (_vars, opts) => opts?.onSuccess?.({ group: group({ name: "Kadro" }) });
    render(group());
    typeName("Kad​ro");
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "desktop:settingsUi.unsavedSave");
    act(() => save!.click());
    render(group({ name: "Kadro" }));
    expect(nameInput().value).toBe("Kadro");
    expect(unsavedBar()).toBeNull();
    expect(changedNotice()).toBeNull();
  });
});
