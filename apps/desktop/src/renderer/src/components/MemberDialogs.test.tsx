// @vitest-environment jsdom
/**
 * The user / moderation confirmations, rendered for real (Radix dialog, the
 * shared shell, the ui-store slot). Only the network is replaced: each mutation
 * hook is a real `useMutation` whose `mutationFn` is a spy.
 *
 * Pins two audit findings (M16 Dalga 3):
 * - a DANGER dialog opens with Cancel focused, even when it has a field — a
 *   reflexive Enter in the ban reason used to submit the ban;
 * - every open is a fresh dialog: a cancelled draft, an old mutation error or
 *   the last timeout choice never comes back when the same dialog is reopened.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type { GroupId, UserId } from "@demli/types";
import type { MemberDialog } from "../stores/ui-store";
import type { MemberDialogs as MemberDialogsComponent } from "./MemberDialogs";

const calls = vi.hoisted(() => ({
  ban: vi.fn(async (_input: unknown) => undefined as unknown),
  kick: vi.fn(async (_input: unknown) => undefined as unknown),
  timeout: vi.fn(async (_input: unknown) => undefined as unknown),
  nickname: vi.fn(async (_input: unknown) => undefined as unknown),
  note: vi.fn(async (_input: unknown) => undefined as unknown),
}));

// lucide-react ships its own nested React copy that escapes the test aliases;
// icons are not what this test checks.
vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});
// react-remove-scroll is CJS with its own nested React (two hook dispatchers →
// "reading 'useRef'"); it only locks body scroll behind the modal, a no-op in
// jsdom. Same stand-in as packages/app-ui/src/test/react-remove-scroll-stub.tsx.
vi.mock("react-remove-scroll", async () => {
  const { forwardRef, Fragment, createElement } = await import("react");
  const RemoveScroll = Object.assign(
    forwardRef<HTMLElement, { children?: unknown }>(function RemoveScrollStub({ children }, _ref) {
      return createElement(Fragment, null, children as never);
    }),
    { classNames: { fullWidth: "", zeroRight: "" } },
  );
  return { RemoveScroll, default: RemoveScroll };
});
vi.mock("../queries/chat-queries", () => ({
  useBanMember: () => useMutation({ mutationFn: calls.ban }),
  useKickMember: () => useMutation({ mutationFn: calls.kick }),
  useTimeoutMember: () => useMutation({ mutationFn: calls.timeout }),
  useSetMemberNickname: () => useMutation({ mutationFn: calls.nickname }),
}));
vi.mock("../queries/social-queries", () => ({
  useSetPrivateNickname: () => useMutation({ mutationFn: calls.nickname }),
  useSetUserNote: () => useMutation({ mutationFn: calls.note }),
  useUnfriend: () => useMutation({ mutationFn: async () => undefined }),
  useUserNote: () => ({ data: { body: "Okul arkadaşı" }, isPending: false }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let MemberDialogs: typeof MemberDialogsComponent;
let setMemberDialog: (dialog: MemberDialog | null) => void;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const GROUP = "g1" as GroupId;
const USER = "u-ece" as UserId;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  ({ MemberDialogs } = await import("./MemberDialogs"));
  const { useUiStore } = await import("../stores/ui-store");
  setMemberDialog = (dialog) => useUiStore.getState().setMemberDialog(dialog);
}, 60_000);

beforeEach(() => {
  for (const spy of Object.values(calls)) spy.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider>
            <MemberDialogs />
          </TooltipProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
});

afterEach(() => {
  act(() => setMemberDialog(null));
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function open(dialog: MemberDialog): void {
  act(() => setMemberDialog(dialog));
}

function dialogEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error("no dialog open");
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...dialogEl().querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

/** Type into a React-controlled input the way the browser does. */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const cancelLabel = (): string => i18n.t("buttons.cancel");

describe("danger dialogs open on Cancel", () => {
  it.each<MemberDialog>([
    { kind: "ban", userId: USER, displayName: "Ece", groupId: GROUP },
    { kind: "kick", userId: USER, displayName: "Ece", groupId: GROUP },
    { kind: "unfriend", userId: USER, displayName: "Ece" },
  ])("$kind focuses Cancel, never the field or the action", (dialog) => {
    open(dialog);
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.textContent).toBe(cancelLabel());
    // Cancel is a plain button: Enter on it dismisses, it cannot submit the form.
    expect((focused as HTMLButtonElement).type).toBe("button");
    expect(calls.ban).not.toHaveBeenCalled();
    expect(calls.kick).not.toHaveBeenCalled();
  });

  it("the ban reason field is NOT focused on open (a stray Enter there would ban)", () => {
    open({ kind: "ban", userId: USER, displayName: "Ece", groupId: GROUP });
    expect(document.activeElement?.tagName).not.toBe("INPUT");
    expect(dialogEl().querySelector("input")).not.toBeNull();
  });

  it("timeout opens on the chosen duration radio, which cannot submit", () => {
    open({ kind: "timeout", userId: USER, displayName: "Ece", groupId: GROUP });
    const focused = document.activeElement as HTMLButtonElement;
    expect(focused.getAttribute("role")).toBe("radio");
    expect(focused.type).toBe("button");
  });
});

describe("every open is a fresh dialog", () => {
  it("a cancelled nickname draft does not come back; the saved value does", () => {
    const dialog: MemberDialog = {
      kind: "friendNickname",
      userId: USER,
      displayName: "Ecem",
      realName: "Ece Yılmaz",
      current: "Ecem",
    };
    open(dialog);
    const input = dialogEl().querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("Ecem");
    typeInto(input, "TYPO");
    expect(input.value).toBe("TYPO");
    act(() => buttonByText(cancelLabel()).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    open({ ...dialog });
    expect((dialogEl().querySelector("input") as HTMLInputElement).value).toBe("Ecem");
    expect(calls.nickname).not.toHaveBeenCalled();
  });

  it("a ban reason typed and cancelled is gone on reopen", () => {
    const dialog: MemberDialog = { kind: "ban", userId: USER, displayName: "Ece", groupId: GROUP };
    open(dialog);
    typeInto(dialogEl().querySelector("input") as HTMLInputElement, "spam reason");
    act(() => buttonByText(cancelLabel()).click());
    open({ ...dialog });
    expect((dialogEl().querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("the timeout resets to its 5-minute default after a cancelled '1 week'", () => {
    const dialog: MemberDialog = { kind: "timeout", userId: USER, displayName: "Ece", groupId: GROUP };
    open(dialog);
    const checked = (): string | null | undefined =>
      dialogEl().querySelector('[role="radio"][aria-checked="true"]')?.textContent;
    const week = [...dialogEl().querySelectorAll<HTMLButtonElement>('[role="radio"]')].at(-1);
    act(() => week?.click());
    expect(checked()).toBe(week?.textContent);
    act(() => buttonByText(cancelLabel()).click());

    open({ ...dialog });
    expect(checked()).toBe(i18n.t("desktop:userMenu.durationMinutes", { count: 5 }));
  });

  it("a failed kick's error does not reappear when the dialog is reopened", async () => {
    calls.kick.mockRejectedValue(new Error("boom"));
    const dialog: MemberDialog = { kind: "kick", userId: USER, displayName: "Ece", groupId: GROUP };
    open(dialog);
    await act(async () => {
      buttonByText(i18n.t("desktop:userMenu.kickConfirm")).click();
    });
    // Let the rejected mutation settle and re-render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls.kick).toHaveBeenCalledTimes(1);
    expect(dialogEl().querySelector('[role="alert"]')).not.toBeNull();
    act(() => buttonByText(cancelLabel()).click());

    open({ ...dialog });
    expect(dialogEl().querySelector('[role="alert"]')).toBeNull();
  });
});
