// @vitest-environment jsdom
/**
 * The save bar must not claim "what saved is kept" when nothing saved: a Save
 * whose every step failed (e.g. a name-only edit whose PATCH fails) gets the
 * total-failure copy; only a Save where some step landed gets the partial copy.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});
vi.mock("../lib/i18n", () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../lib/account-manager", () => ({ logoutActiveAccount: async () => undefined }));

const { updateProfile, idle } = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  idle: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../queries/chat-queries", () => ({
  useUpdateProfile: () => ({ mutateAsync: updateProfile, isPending: false }),
  useUploadAvatar: idle,
  useUploadBanner: idle,
  useDeleteAccount: idle,
}));
vi.mock("./BirthdateVerification", () => ({ BirthdateVerification: () => null }));
vi.mock("./ImageCropDialog", () => ({ ImageCropDialog: () => null }));
vi.mock("./ProfileCard", () => ({ ProfileIdentityPreview: () => null }));
vi.mock("./MemberDialogs", () => ({ ConfirmDialogShell: () => null }));

import { ProfileSettings, saveFailureKind } from "./ProfileSettings";
import { useAuthStore } from "../stores/auth-store";
import type { User } from "@demli/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const typeInto = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  updateProfile.mockReset();
  useAuthStore.setState({
    user: { id: "u1", username: "baran", displayName: "Baran", bio: null, avatarUrl: null } as unknown as User,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(ProfileSettings)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("profile save failure copy", () => {
  it("a name-only edit whose save fails shows the total-failure copy", async () => {
    updateProfile.mockRejectedValue(new Error("network"));
    const name = host.querySelector<HTMLInputElement>("input[value='Baran']");
    expect(name).not.toBeNull();
    typeInto(name!, "Baran K");

    const form = host.querySelector<HTMLFormElement>("#profile-form")!;
    await act(async () => {
      form.requestSubmit();
    });

    expect(updateProfile).toHaveBeenCalledTimes(1);
    const text = document.body.textContent ?? "";
    expect(text).toContain("desktop:profile.saveFailedAll");
    expect(text).toContain("desktop:profile.saveFailedAllHint");
    expect(text).not.toContain("desktop:profile.saveFailedHint");
  });
});

describe("saveFailureKind", () => {
  it("is null when nothing failed", () => {
    expect(saveFailureKind(0, 3)).toBeNull();
  });
  it("is partial only when some attempted step landed", () => {
    expect(saveFailureKind(1, 3)).toBe("partial");
    expect(saveFailureKind(2, 3)).toBe("partial");
  });
  it("is total when every attempted step failed", () => {
    expect(saveFailureKind(1, 1)).toBe("total");
    expect(saveFailureKind(3, 3)).toBe("total");
  });
});
