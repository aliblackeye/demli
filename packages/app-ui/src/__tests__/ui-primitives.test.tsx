// @vitest-environment jsdom
/**
 * Behaviour + accessibility contract of the Koyu Masa primitives in
 * @demli/ui, asserted on real mounts (packages/ui has no DOM test runner of
 * its own; this package's harness is the one that keeps a single React copy).
 *
 * What is pinned: roles and ARIA state, keyboard models (radio roving focus,
 * slider steps, select listbox), validation wiring, toast lifecycle, and the
 * two class-level rules a regression would silently break — no white ink on
 * the light danger fill, and tailwind-merge keeping the custom text sizes.
 */
import { createElement, useState } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// lucide-react resolves its own React copy under the hoisted layout — see the
// sibling DOM tests. Icons are decoration here.
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import {
  Button,
  Checkbox,
  CountBadge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  RadioGroup,
  RadioItem,
  Select,
  Slider,
  Switch,
  Toaster,
  TooltipProvider,
  UserAvatar,
  buttonVariants,
  cn,
  dismissToast,
  toast,
} from "@demli/ui";
import { flush, mount, press } from "../test/dom";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
});

function render(node: JSX.Element): void {
  cleanup = mount(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>).unmount;
}

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no element for ${selector}`);
  return node;
};

function key(target: Element, k: string): void {
  press(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function click(target: Element): void {
  press(() => {
    (target as HTMLElement).click();
  });
}

describe("cn (tailwind-merge with the app's own scale)", () => {
  it("keeps a custom text size next to a text colour", () => {
    expect(cn("text-badge", "text-fg-muted")).toBe("text-badge text-fg-muted");
    expect(cn("text-label", "text-fg")).toBe("text-label text-fg");
  });

  it("lets a call site replace a named radius", () => {
    expect(cn("rounded-lg", "rounded-card")).toBe("rounded-card");
  });
});

describe("Button", () => {
  it("has the five Koyu Masa variants and never puts white ink on danger", () => {
    for (const variant of ["primary", "secondary", "accent", "danger", "ghost"] as const) {
      expect(buttonVariants({ variant })).toMatch(/bg-/);
    }
    expect(buttonVariants({ variant: "danger" })).not.toContain("text-white");
    expect(buttonVariants({ variant: "danger" })).toContain("text-danger");
  });

  it("loading blocks clicks and announces busy, keeping the label in the DOM", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Kaydet
      </Button>,
    );
    const button = $<HTMLButtonElement>("button");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Kaydet");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("names itself from the label and exposes toggle state", () => {
    render(
      <IconButton label="Mikrofonu kapat" pressed>
        <svg />
      </IconButton>,
    );
    const button = $("button");
    expect(button.getAttribute("aria-label")).toBe("Mikrofonu kapat");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows its tooltip on keyboard focus", async () => {
    render(
      <IconButton label="Ekranı paylaş">
        <svg />
      </IconButton>,
    );
    press(() => $("button").focus());
    await flush();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Ekranı paylaş");
  });
});

describe("Switch", () => {
  it("is a switch whose aria-checked follows clicks", () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Gürültü engelleme" onCheckedChange={onChange} />);
    const sw = $('[role="switch"]');
    expect(sw.getAttribute("aria-checked")).toBe("false");
    click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("does not toggle while disabled", () => {
    render(<Switch aria-label="x" disabled />);
    const sw = $('[role="switch"]');
    click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
});

describe("Checkbox", () => {
  it("announces mixed, toggles from its label", () => {
    function Harness(): JSX.Element {
      const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
      return <Checkbox label="Hepsini seç" checked={checked} onCheckedChange={setChecked} />;
    }
    render(<Harness />);
    const box = $('[role="checkbox"]');
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    click($("label"));
    expect(box.getAttribute("aria-checked")).toBe("true");
  });
});

describe("RadioGroup", () => {
  function renderGroup(): void {
    render(
      <RadioGroup aria-label="Kalite" defaultValue="b">
        <RadioItem value="a" label="Düşük" />
        <RadioItem value="b" label="Orta" />
        <RadioItem value="c" label="Yüksek" disabled />
        <RadioItem value="d" label="Kaynak" />
      </RadioGroup>,
    );
  }

  const radios = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
  const checked = (): string | undefined =>
    radios().find((r) => r.getAttribute("aria-checked") === "true")?.textContent ?? undefined;

  it("is a single tab stop on the selected option", () => {
    renderGroup();
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("arrow keys move and select, skipping disabled; Home/End jump", () => {
    renderGroup();
    key(radios()[1] as HTMLElement, "ArrowDown");
    expect(checked()).toBe("Kaynak");
    expect(document.activeElement?.textContent).toBe("Kaynak");
    key(radios()[3] as HTMLElement, "ArrowDown");
    expect(checked()).toBe("Düşük");
    key(radios()[0] as HTMLElement, "End");
    expect(checked()).toBe("Kaynak");
    key(radios()[3] as HTMLElement, "Home");
    expect(checked()).toBe("Düşük");
  });
});

describe("Slider", () => {
  it("exposes its value and steps with the keyboard, clamped", () => {
    const onCommit = vi.fn();
    render(
      <Slider
        aria-label="Ses"
        defaultValue={50}
        step={5}
        formatValue={(v) => `%${v}`}
        onValueCommit={onCommit}
      />,
    );
    const thumb = $('[role="slider"]');
    expect(thumb.getAttribute("aria-valuenow")).toBe("50");
    expect(thumb.getAttribute("aria-valuetext")).toBe("%50");
    key(thumb, "ArrowRight");
    expect(thumb.getAttribute("aria-valuenow")).toBe("55");
    key(thumb, "PageUp");
    expect(thumb.getAttribute("aria-valuenow")).toBe("100");
    key(thumb, "Home");
    expect(thumb.getAttribute("aria-valuenow")).toBe("0");
    key(thumb, "ArrowLeft");
    expect(thumb.getAttribute("aria-valuenow")).toBe("0");
    press(() => {
      thumb.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    });
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });
});

describe("Select", () => {
  const OPTIONS = [
    { value: "mic1", label: "Yeti" },
    { value: "mic2", label: "Kulaklık", disabled: true },
    { value: "mic3", label: "Dahili" },
  ];

  it("opens a listbox from the keyboard, moves past disabled options, chooses with Enter", async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Mikrofon" placeholder="Bir mikrofon seç" options={OPTIONS} onValueChange={onChange} />,
    );
    const trigger = $('[role="combobox"]');
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.textContent).toContain("Bir mikrofon seç");
    key(trigger, "ArrowDown");
    await flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = $('[role="listbox"]');
    const activeLabel = (): string | null | undefined =>
      document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(activeLabel()).toBe("Yeti");
    key(list, "ArrowDown");
    expect(activeLabel()).toBe("Dahili");
    key(list, "Enter");
    await flush();
    expect(onChange).toHaveBeenCalledWith("mic3");
    expect(trigger.textContent).toContain("Dahili");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("type-ahead jumps to a matching label", async () => {
    render(<Select aria-label="Mikrofon" placeholder="Seç" options={OPTIONS} />);
    key($('[role="combobox"]'), "Enter");
    await flush();
    const list = $('[role="listbox"]');
    key(list, "d");
    expect(document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.textContent).toBe("Dahili");
  });
});

describe("Field", () => {
  it("labels the control and wires help / error for assistive tech", () => {
    function Harness({ error }: { error?: string }): JSX.Element {
      return (
        <Field label="Kullanıcı adı" help="Harf, rakam ve alt çizgi." error={error}>
          <Input />
        </Field>
      );
    }
    render(<Harness />);
    const input = $<HTMLInputElement>("input");
    expect($("label").getAttribute("for")).toBe(input.id);
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Harf, rakam ve alt çizgi.",
    );
    expect(input.getAttribute("aria-invalid")).toBeNull();

    cleanup?.();
    render(<Harness error="Bu alan zorunlu." />);
    const invalid = $<HTMLInputElement>("input");
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(invalid.getAttribute("aria-errormessage") ?? "");
    expect(message?.textContent).toBe("Bu alan zorunlu.");
    expect(invalid.getAttribute("aria-describedby")).toBe(message?.id);
  });
});

describe("Toast", () => {
  it("announces politely, alerts for danger, and leaves when dismissed", async () => {
    render(<Toaster label="Bildirimler" dismissLabel="Kapat" />);
    let first = 0;
    press(() => {
      first = toast({ title: "Görsel kaydedildi" });
      toast({ title: "Mesaj gönderilemedi", variant: "danger" });
    });
    expect($("section").getAttribute("aria-label")).toBe("Bildirimler");
    expect($('[role="status"]').textContent).toContain("Görsel kaydedildi");
    expect($('[role="alert"]').textContent).toContain("Mesaj gönderilemedi");

    press(() => dismissToast(first));
    expect($('[role="status"]').getAttribute("data-state")).toBe("closed");
    await flush(450);
    expect(document.querySelector('[role="status"]')).toBeNull();

    click($('[role="alert"] button[aria-label="Kapat"]'));
    await flush(450);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("auto-dismisses after its duration", async () => {
    vi.useFakeTimers();
    render(<Toaster label="Bildirimler" dismissLabel="Kapat" />);
    press(() => {
      toast({ title: "Bağlantı geri geldi", duration: 1000 });
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000 + 450);
    });
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});

describe("CountBadge", () => {
  it("renders nothing for zero and caps large counts", () => {
    render(
      <div>
        <CountBadge count={0} />
        <CountBadge count={120} label="120 okunmamış mesaj" />
      </div>,
    );
    const badges = document.querySelectorAll("div > span");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("99+");
    expect(badges[0]?.getAttribute("aria-label")).toBe("120 okunmamış mesaj");
  });
});

describe("UserAvatar", () => {
  it("draws the coral speaking ring and a 30% presence dot", () => {
    render(<UserAvatar name="Ece Kaya" src={null} size="lg" presence="online" speaking />);
    const circle = $('span[aria-hidden="true"]');
    expect(circle.className).toContain("var(--color-accent)");
    const dot = $('[role="img"]');
    expect(dot.style.width).toBe("24px");
  });
});

describe("Menus", () => {
  it("destructive item uses the pink wash, never a solid fill with white ink", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem danger>Sunucudan at</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await flush();
    const item = $('[role="menuitem"]');
    expect(item.className).toContain("text-danger");
    expect(item.className).not.toContain("text-white");
    expect(item.className).not.toMatch(/data-\[highlighted\]:bg-danger(\s|$)/);
  });
});
