// @vitest-environment jsdom
/**
 * M16 composer behaviour that only exists once real keys hit the real textarea:
 *
 *   - ↑ in an EMPTY composer asks the thread to edit your last message — and
 *     only then: with text in the field ↑ is caret movement, and a thread with
 *     nothing editable must leave the key alone (no swallowed keystroke).
 *   - an in-place edit that closes hands focus back to THIS channel's composer.
 *   - a DM whose peer you blocked shows the honest notice + the unblock action
 *     instead of a textarea whose every send would bounce.
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";

/** Icons are decoration here; see MessageComposer.mention.test.tsx for why. */
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { createI18n, createMemoryStorage } from "@demli/i18n";
import type { Channel } from "@demli/types";
import { MessageComposer } from "./MessageComposer";
import {
  ComposerServicesProvider,
  type ComposerSendBlock,
  type ComposerServices,
} from "../data/composer-data";
import { onEditLastRequest, requestComposerFocus } from "../data/edit-request";
import { flush, mount, press } from "../test/dom";

const CHANNEL = { id: "ch-1", name: "general", kind: "text" } as unknown as Channel;

function services(sendBlock: ComposerSendBlock | null = null): ComposerServices {
  return {
    useMeId: () => "u-me",
    useUsers: () => ({}),
    useReplyTarget: () => undefined,
    useReplyAuthorName: () => null,
    useAllowBroadcast: () => false,
    useAttachmentsDisabled: () => true,
    useAttachmentDrafts: () => ({
      drafts: [],
      hasPending: false,
      hasDrafts: false,
      addFiles: () => {},
      removeDraft: () => {},
      retryDraft: () => {},
      clearDrafts: () => {},
    }),
    useSlowmodeCooldownUntil: () => 0,
    useSendBlock: () => sendBlock,
    getReplyTarget: () => undefined,
    clearReplyTarget: () => {},
    clearSlowmodeCooldown: () => {},
    getDraft: () => "",
    setDraft: () => {},
    clearDraft: () => {},
    flushDrafts: () => {},
    notifyTyping: () => {},
    notifyIdle: () => {},
    sendMessage: () => {},
    attachmentAccept: "",
    renderEmojiPicker: ({ children }) => children,
    renderAttachmentPreview: () => null,
  };
}

async function mountComposer(value: ComposerServices): Promise<HTMLElement> {
  const i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
  const view = mount(
    <I18nextProvider i18n={i18n}>
      <ComposerServicesProvider value={value}>
        <MessageComposer channel={CHANNEL} showAttachmentButton={false} />
      </ComposerServicesProvider>
    </I18nextProvider>,
  );
  return view.container;
}

/** Dispatch a keydown the way the browser does; returns whether it was cancelled. */
function keydown(target: HTMLElement, key: string): boolean {
  let cancelled = false;
  press(() => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    cancelled = event.defaultPrevented;
  });
  return cancelled;
}

function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  press(() => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("↑ to edit your last message", () => {
  it("asks THIS channel's thread, and swallows the key only when the thread took it", async () => {
    const container = await mountComposer(services());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const asked: string[] = [];
    const unsubscribe = onEditLastRequest((channelId) => {
      asked.push(channelId);
      return true;
    });

    expect(keydown(textarea, "ArrowUp")).toBe(true);
    expect(asked).toEqual(["ch-1"]);
    unsubscribe();
  });

  it("leaves ↑ alone when the thread has nothing to edit", async () => {
    const container = await mountComposer(services());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const unsubscribe = onEditLastRequest(() => false);

    expect(keydown(textarea, "ArrowUp")).toBe(false);
    unsubscribe();
  });

  it("is caret movement, not an edit, once the field has text", async () => {
    const container = await mountComposer(services());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const listener = vi.fn(() => true);
    const unsubscribe = onEditLastRequest(listener);

    typeInto(textarea, "selam");
    expect(keydown(textarea, "ArrowUp")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("focus hand-back after an edit", () => {
  it("focuses the composer of the named channel only", async () => {
    const container = await mountComposer(services());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.blur();

    press(() => requestComposerFocus("some-other-channel"));
    expect(document.activeElement).not.toBe(textarea);

    press(() => requestComposerFocus("ch-1"));
    await flush(2);
    expect(document.activeElement).toBe(textarea);
  });
});

describe("blocked DM", () => {
  it("replaces the textarea with the notice and routes unblock to the surface", async () => {
    const unblock = vi.fn();
    const container = await mountComposer(services({ kind: "blocked", name: "Can", unblock }));

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("You've blocked Can.");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Unblock");
    expect(button).toBeDefined();
    press(() => button?.click());
    expect(unblock).toHaveBeenCalledTimes(1);
  });
});
