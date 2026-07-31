// @vitest-environment jsdom
/**
 * "Right-click a user → Mention" must produce a REAL mention, not text that
 * looks like one.
 *
 * The founder's report was "bahset deyince chate yazdı fakat otomatik seçmedi
 * kişiyi": the name landed in the composer, and the sent message pinged nobody.
 * That failure is invisible to a test of the composer's state — the token is
 * there, the pending list is there — and only shows up at the wire boundary. So
 * this test drives the real composer through the real emitter and asserts on the
 * string handed to `sendMessage`: it must contain `<@id>`, never `@Name`.
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";

/**
 * lucide-react ships with its own physical copy of react under the repo's
 * hoisted node_modules layout (see ../test/dom for the whole story), so a real
 * icon render throws "Cannot read properties of null (reading 'useContext')".
 * Icons are decoration for this test — every one becomes an empty <svg>.
 */
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    // NB: `then` and symbol keys MUST stay undefined. A namespace object that
    // answers `then` with a function looks like a thenable, and the loader
    // awaits it forever — the module never resolves and the run simply hangs.
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    // Vitest rejects a mock that does not "have" an export the code imports, so
    // every icon name must answer true here as well as on `get`.
    has: (target, name) => real(name) || name in target,
  });
});

import { createI18n, createMemoryStorage } from "@demli/i18n";
import type { Channel } from "@demli/types";
import { MessageComposer } from "./MessageComposer";
import { ComposerServicesProvider, type ComposerServices } from "../data/composer-data";
import { requestMentionInsert } from "../data/mention-insert";
import { flush, mount, press } from "../test/dom";

const CHANNEL = { id: "ch-1", name: "general", kind: "text" } as unknown as Channel;
const ALI = {
  id: "u-ali",
  displayName: "Ali Kara",
  username: "ali",
  avatarUrl: "https://cdn.example/ali.png",
};

interface Harness {
  services: ComposerServices;
  sent: string[];
  drafts: Map<string, string>;
}

function makeServices(): Harness {
  const sent: string[] = [];
  const drafts = new Map<string, string>();
  const services: ComposerServices = {
    useMeId: () => "u-me",
    useUsers: () => ({ [ALI.id]: ALI }),
    useReplyTarget: () => undefined,
    useReplyAuthorName: () => null,
    useAllowBroadcast: () => true,
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
    getReplyTarget: () => undefined,
    clearReplyTarget: () => {},
    clearSlowmodeCooldown: () => {},
    getDraft: (channelId) => drafts.get(channelId) ?? "",
    setDraft: (channelId, text) => {
      drafts.set(channelId, text);
    },
    clearDraft: (channelId) => {
      drafts.delete(channelId);
    },
    flushDrafts: () => {},
    notifyTyping: () => {},
    notifyIdle: () => {},
    sendMessage: (_channelId, text) => {
      sent.push(text);
    },
    attachmentAccept: "",
    renderEmojiPicker: ({ children }) => children,
    renderAttachmentPreview: () => null,
  };
  return { services, sent, drafts };
}

async function mountComposer(): Promise<Harness & { textarea: HTMLTextAreaElement }> {
  const harness = makeServices();
  const i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
  const view = mount(
    <I18nextProvider i18n={i18n}>
      <ComposerServicesProvider value={harness.services}>
        <MessageComposer channel={CHANNEL} showAttachmentButton={false} />
      </ComposerServicesProvider>
    </I18nextProvider>,
  );
  const textarea = view.container.querySelector("textarea");
  if (!textarea) throw new Error("composer did not render a textarea");
  return { ...harness, textarea };
}

/** Type into the composer the way a user does (React-controlled value). */
function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  press(() => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement): void {
  press(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

describe("user menu → Mention", () => {
  it("sends a real <@id> mention, not the display name", async () => {
    const { textarea, sent } = await mountComposer();

    press(() => requestMentionInsert({ userId: ALI.id, label: ALI.displayName }));
    await flush(5);
    expect(textarea.value, "nothing was inserted into the composer").toBe("@Ali Kara ");

    pressEnter(textarea);
    expect(sent).toEqual(["<@u-ali>"]);
    expect(sent[0]).not.toContain("@Ali Kara");
  });

  it("keeps the rest of the message intact around the mention", async () => {
    const { textarea, sent } = await mountComposer();

    press(() => requestMentionInsert({ userId: ALI.id, label: ALI.displayName }));
    await flush(5);
    typeInto(textarea, `${textarea.value}bugün müsait misin?`);
    pressEnter(textarea);

    expect(sent).toEqual(["<@u-ali> bugün müsait misin?"]);
  });

  it("inserts a boundary space when the caret is glued to a word", async () => {
    // `selam@Ali Kara` is NOT a mention on the wire (an `@` after a word char is
    // an address, deliberately). Without the boundary the message would be sent
    // as prose with nothing visibly wrong — the exact reported symptom.
    const { textarea, sent } = await mountComposer();
    typeInto(textarea, "selam");
    press(() => textarea.setSelectionRange(5, 5));

    press(() => requestMentionInsert({ userId: ALI.id, label: ALI.displayName }));
    await flush(5);
    expect(textarea.value).toBe("selam @Ali Kara ");

    pressEnter(textarea);
    expect(sent).toEqual(["selam <@u-ali>"]);
  });

  it("inserts at the caret rather than always appending", async () => {
    const { textarea, sent } = await mountComposer();
    typeInto(textarea, "selam naber");
    press(() => textarea.setSelectionRange(6, 6));

    press(() => requestMentionInsert({ userId: ALI.id, label: ALI.displayName }));
    await flush(5);
    expect(textarea.value).toBe("selam @Ali Kara naber");

    pressEnter(textarea);
    expect(sent).toEqual(["selam <@u-ali> naber"]);
  });

  it("mentions two people in one message", async () => {
    const { textarea, sent } = await mountComposer();
    press(() => requestMentionInsert({ userId: ALI.id, label: "Ali" }));
    await flush(5);
    press(() => requestMentionInsert({ userId: "u-alix", label: "Alix" }));
    await flush(5);

    pressEnter(textarea);
    expect(sent).toEqual(["<@u-ali> <@u-alix>"]);
  });

  it("stops listening once the composer unmounts", async () => {
    const { textarea } = await mountComposer();
    const before = textarea.value;
    // Unmounting is what a channel switch does; a leaked subscription would keep
    // writing into a dead composer (and replay into the next one).
    const spy = vi.spyOn(console, "error");
    press(() => requestMentionInsert({ userId: ALI.id, label: ALI.displayName }));
    await flush(5);
    expect(textarea.value).not.toBe(before);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
