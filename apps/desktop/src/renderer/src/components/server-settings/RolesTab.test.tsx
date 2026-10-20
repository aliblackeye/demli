// @vitest-environment jsdom
/**
 * Roles tab: the two failures the M16 audit proved on the real page.
 *
 *  1. A failed roles load must read as a FAILURE (alert + retry), never as
 *     "no roles yet, create one" — that empty state invites duplicates of roles
 *     that really exist.
 *  2. The draft guard compares the editor against the server value it was
 *     seeded from. A refetch carrying someone else's edit must not make an
 *     untouched editor dirty (that locked the dialog and invited saving stale
 *     values over theirs); a dirty editor keeps the draft and says the role
 *     changed underneath it; our own save adopts the server's (normalized)
 *     answer instead of leaving a phantom draft.
 *
 * The query hooks are stand-ins driven by plain variables — what is under test
 * is the component's reading of query state, not TanStack Query.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupId, Role, RoleId } from "@demli/types";

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

type RolesState = {
  data: Role[] | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

const state = vi.hoisted(() => ({
  roles: null as unknown as RolesState,
  updatePending: false,
  updateMutate: null as unknown as (vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) => void,
}));

vi.mock("../../queries/chat-queries", () => ({
  useRoles: () => state.roles,
  useGroupDetails: () => ({ data: { members: [] } }),
  useCreateRole: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteRole: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateRole: () => ({
    isPending: state.updatePending,
    mutate: (vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) => state.updateMutate(vars, opts),
  }),
}));

import { RolesTab } from "./RolesTab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GROUP = "g-1" as GroupId;
const role = (patch: Partial<Role> = {}): Role => ({
  id: "r-1" as RoleId,
  groupId: GROUP,
  name: "Moderatör",
  color: "#3498db",
  position: 0,
  permissions: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

let host: HTMLDivElement;
let root: Root;

const render = (): void => act(() => root.render(createElement(RolesTab, { groupId: GROUP, canManage: true })));
const nameInput = (): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>('input[placeholder="desktop:serverSettings.rolePlaceholder"]');
  expect(el).not.toBeNull();
  return el!;
};
const typeName = (value: string): void =>
  act(() => {
    const input = nameInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const unsavedBar = (): Element | null => document.querySelector("[data-unsaved-bar]");
const changedNotice = (): Element | null => document.querySelector("[data-changed-elsewhere]");
const loaded = (roles: Role[]): RolesState => ({
  data: roles,
  isPending: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(async () => undefined),
});

beforeEach(() => {
  state.roles = loaded([role()]);
  state.updatePending = false;
  state.updateMutate = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("RolesTab — a failed load is said as a failure", () => {
  it("shows an alert with retry, not the 'create your first role' empty state", () => {
    const refetch = vi.fn(async () => undefined);
    state.roles = { data: undefined, isPending: false, isError: true, isFetching: false, error: new Error("x"), refetch };
    render();
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(document.body.textContent).not.toContain("desktop:serverSettings.rolesEmptyManage");
    const retry = [...document.querySelectorAll("button")].find((b) => b.textContent === "buttons.retry");
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("still shows the empty state for a LOADED empty list", () => {
    state.roles = loaded([]);
    render();
    expect(document.body.textContent).toContain("desktop:serverSettings.rolesEmptyManage");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("RolesTab — the draft guard follows the server it was seeded from", () => {
  it("a remote rename refetched into a CLEAN editor follows it and stays clean", () => {
    render();
    expect(unsavedBar()).toBeNull();
    state.roles = loaded([role({ name: "Yönetici" })]);
    render();
    expect(nameInput().value).toBe("Yönetici");
    expect(unsavedBar()).toBeNull();
    expect(changedNotice()).toBeNull();
  });

  it("a remote rename under a DIRTY editor keeps the draft and says so", () => {
    render();
    typeName("Usta");
    expect(unsavedBar()).not.toBeNull();
    state.roles = loaded([role({ name: "Yönetici" })]);
    render();
    expect(nameInput().value).toBe("Usta");
    expect(changedNotice()).not.toBeNull();
    // "Son hâlini yükle" adopts the server value: draft and notice both go.
    const load = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "desktop:settingsUi.changedElsewhereLoad",
    );
    act(() => load!.click());
    expect(nameInput().value).toBe("Yönetici");
    expect(changedNotice()).toBeNull();
    expect(unsavedBar()).toBeNull();
  });

  it("our own save adopts the server's normalized answer — no phantom draft", () => {
    state.updateMutate = (_vars, opts) => {
      // The API strips an invisible character the client kept.
      opts?.onSuccess?.({ role: role({ name: "Usta" }) });
    };
    render();
    typeName("Us­ta");
    expect(unsavedBar()).not.toBeNull();
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "desktop:serverSettings.saveRole");
    act(() => save!.click());
    state.roles = loaded([role({ name: "Usta" })]);
    render();
    expect(nameInput().value).toBe("Usta");
    expect(unsavedBar()).toBeNull();
    expect(changedNotice()).toBeNull();
  });
});
