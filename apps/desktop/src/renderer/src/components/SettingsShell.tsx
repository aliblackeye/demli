import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, m, type Variants } from "framer-motion";
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  EyeOff,
  Headphones,
  Languages,
  LogOut,
  Mic,
  MonitorSmartphone,
  Palette,
  ShieldBan,
  SlidersHorizontal,
  Tag,
  User,
  Video,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogPortal, DialogPrimitive, cn } from "@demli/ui";
import { springs, transitions } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { useIsMobileViewport } from "../hooks/useMediaQuery";
import { useUiStore, type SettingsSection } from "../stores/ui-store";
import { logoutActiveAccount } from "../lib/account-manager";
import { useOverlayCovering } from "../notifications/visible-conversation";
import { BlockedUsersSettings } from "./BlockedUsersSettings";
import { DeviceSettingsForm } from "./DeviceSettingsForm";
import { IgnoredUsersSettings } from "./IgnoredUsersSettings";
import { NicknamesSettings } from "./NicknamesSettings";
import { SessionsSettings } from "./SessionsSettings";
import { LanguageSettings } from "./LanguageSettings";
import { MicSettingsForm } from "./MicSettingsForm";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SoundSettings } from "./SoundSettings";
import { SystemSettings } from "./SystemSettings";
import { VideoSettingsForm } from "./VideoSettingsForm";
import { SettingsGroup, SettingsNote } from "./settings-kit";
// CriticalUpdateOverlay is mounted at the App root (works pre-login too).
import { UpdateSettings } from "./UpdateSettings";

/**
 * A miniature of the app painted with the REAL surface tokens — so the theme
 * card previews what the theme is, not a grey box standing in for it.
 */
function ThemePreview({ muted }: { muted?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("flex h-16 overflow-hidden rounded-lg bg-rail", muted && "opacity-40 grayscale")}
    >
      <span className="flex w-5 flex-col items-center gap-1 pt-1.5">
        <span className="size-3 rounded-[5px] bg-accent" />
        <span className="size-3 rounded-[5px] bg-raised" />
      </span>
      <span className="flex w-10 flex-col gap-1 bg-sidebar px-1.5 pt-2">
        <span className="h-1 w-6 rounded-full bg-raised" />
        <span className="h-1 w-5 rounded-full bg-accent-surface" />
        <span className="h-1 w-7 rounded-full bg-raised" />
      </span>
      <span className="flex flex-1 flex-col justify-end gap-1 bg-app p-1.5">
        <span className="h-1 w-3/4 rounded-full bg-raised" />
        <span className="h-1 w-1/2 rounded-full bg-raised" />
        <span className="mt-0.5 h-2.5 rounded-[5px] bg-surface" />
      </span>
    </span>
  );
}

function AppearanceSection(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("desktop:settings.appearance.theme")} cardClassName="p-3">
        <div role="radiogroup" aria-label={t("desktop:settings.appearance.theme")} className="flex flex-wrap gap-3">
          <button
            type="button"
            role="radio"
            aria-checked="true"
            className={cn(
              "w-40 cursor-pointer rounded-xl bg-accent-surface p-2 text-left",
              "shadow-[inset_0_0_0_1px_rgb(255_132_100/0.45)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
            )}
          >
            <ThemePreview />
            <span className="mt-2 flex items-center justify-between px-1 text-sm font-medium text-accent-hover">
              {t("desktop:settings.appearance.dark")}
              <Check aria-hidden className="size-4" />
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked="false"
            disabled
            className="w-40 cursor-not-allowed rounded-xl bg-raised/40 p-2 text-left"
          >
            <ThemePreview muted />
            <span className="mt-2 block px-1 text-sm font-medium text-fg-faint">
              {t("desktop:settings.appearance.lightLater")}
            </span>
          </button>
        </div>
      </SettingsGroup>
      <SettingsNote icon={Palette}>{t("desktop:settings.appearance.note")}</SettingsNote>
    </div>
  );
}

/**
 * "Genel" — desktop system settings (tray, launch-at-startup) + app updates.
 * These are main-process backed (window.demli.system / .updates) and are not
 * part of the ui-store `SettingsSection` union, so this section is driven by a
 * local view flag in {@link SettingsShell} rather than the store.
 */
function GeneralSection(): JSX.Element {
  return (
    <div className="space-y-8">
      <SystemSettings />
      <UpdateSettings />
    </div>
  );
}

/**
 * Sections that are not part of the ui-store `SettingsSection` union — "General"
 * (main-process backed), "Sounds" (renderer-local sound prefs) and "Language".
 * A local flag decides whether one of them or a store-driven section shows.
 * Each id resolves to a desktop:settings.nav.* label.
 */
type LocalSection =
  | "general"
  | "sounds"
  | "notifications"
  | "language"
  | "microphone"
  | "video"
  // M18 — the blocked-users list. Local rather than a ui-store `SettingsSection`
  // because nothing deep-links to it; it is reached from the nav only.
  | "blocked"
  // ADR 0019 — the ignore list and the private-nickname list. Same reasoning as
  // "blocked", and deliberately THREE separate entries rather than one merged
  // "privacy" panel: a block, an ignore and a nickname are three different
  // promises, and stacking them in one scroll is how users conflate them.
  | "ignored"
  | "nicknames"
  | null;

/** A settings nav entry: a store-driven `SettingsSection` or a local-only view. */
type NavEntry =
  | { kind: "store"; id: SettingsSection }
  | { kind: "local"; id: Exclude<LocalSection, null> };

/**
 * Nav groups in display order. "My Account" and "Profile" are now the SINGLE
 * unified `profile` panel (founder M15). The media cluster — Voice (device
 * pickers), Microphone (input mode + quality) and Video (camera + screen quality)
 * — sits together, with Appearance and the rest after. Store-driven and local-only
 * sections interleave, so a single ordered list drives them both.
 */
const NAV_GROUPS: { group: "user" | "app"; entries: NavEntry[] }[] = [
  {
    group: "user",
    entries: [
      { kind: "store", id: "profile" },
      { kind: "store", id: "sessions" },
      { kind: "local", id: "blocked" },
      { kind: "local", id: "ignored" },
      { kind: "local", id: "nicknames" },
    ],
  },
  {
    group: "app",
    entries: [
      { kind: "store", id: "voice" },
      { kind: "local", id: "microphone" },
      { kind: "local", id: "video" },
      { kind: "store", id: "appearance" },
      { kind: "local", id: "general" },
      { kind: "local", id: "sounds" },
      { kind: "local", id: "notifications" },
      { kind: "local", id: "language" },
    ],
  },
];

/** Lucide glyph per nav id — keyed by the same id used for the i18n label. */
const NAV_ICONS: Record<string, LucideIcon> = {
  profile: User,
  sessions: MonitorSmartphone,
  blocked: ShieldBan,
  ignored: EyeOff,
  nicknames: Tag,
  voice: Headphones,
  microphone: Mic,
  video: Video,
  appearance: Palette,
  general: SlidersHorizontal,
  sounds: Volume2,
  notifications: Bell,
  language: Languages,
};

/**
 * The settings LAYER: it replaces the app rather than floating over it, so it
 * arrives from a hair larger and settles (no slide — a layer change, not a
 * panel), and leaves the same way, faster.
 */
const layerMotion: Variants = {
  initial: { opacity: 0, scale: 1.015 },
  animate: { opacity: 1, scale: 1, transition: transitions.standard },
  exit: { opacity: 0, scale: 1.015, transition: transitions.fast },
};

/** A section's content settling in after a nav change (enter-only, no exit). */
const sectionMotion: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: springs.position },
};

/** Mobile master/detail: the detail page travels in from the side it lives on. */
const pageMotion = (direction: 1 | -1): Variants => ({
  initial: { opacity: 0, x: 24 * direction },
  animate: { opacity: 1, x: 0, transition: springs.position },
  exit: { opacity: 0, x: -12 * direction, transition: transitions.instant },
});

const isStoreEntry = (entry: NavEntry): entry is { kind: "store"; id: SettingsSection } =>
  entry.kind === "store";

/**
 * Settings surface. Two responsive shapes share one component:
 *
 *  - WIDE (Electron / desktop web): a FULL-SCREEN layer over the app — the nav
 *    column on the left (right-aligned, so the eye lands where the content
 *    starts), the section on the right with the close control and its ESC hint
 *    pinned beside it. A single accent-soft pill marks the active entry and
 *    travels between entries on the authored position spring.
 *  - NARROW (mobile web, `useIsMobileViewport`): a FULL-PAGE surface — a category
 *    list you tap into a section, with a back arrow (founder: "webe mobilden
 *    girdiğinde settings modal değil, full açılması gerekirdi bi sayfa gibi").
 *
 * Both are composed from the raw Radix Dialog primitives (via {@link
 * DialogPrimitive}) with `forceMount` so Framer's <AnimatePresence> drives a real
 * enter/exit — while Radix still supplies the focus trap, Esc-to-close and
 * scroll-lock. The layer sits at z-[55]: ABOVE the app shell, the mobile
 * navigation drawer (z-50) and the command menu (z-50) — fixing the founder P0
 * where "sol menü modalın önüne geçmiş" — yet below the add-account overlay
 * (z-[60]), call ring (z-[70]+) and critical overlays (z-[100]). Confirmations
 * opened from inside a section lift themselves to z-[58] (ConfirmDialog
 * `layer="settings"`).
 *
 * Unsaved edits: a section that holds a draft declares it via
 * `ui-store.settingsDirty`; Esc, the close button and EVERY nav switch (store-
 * driven and local alike) are parked behind the section's own discard prompt.
 */
export function SettingsShell(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const section = useUiStore((s) => s.settingsSection);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const settingsDirty = useUiStore((s) => s.settingsDirty);
  const pendingSettingsNav = useUiStore((s) => s.pendingSettingsNav);
  const [localSection, setLocalSection] = useState<LocalSection>(null);
  const isMobile = useIsMobileViewport();
  // Mobile master/detail: false = category list page, true = a section page.
  const [mobileDetail, setMobileDetail] = useState(false);
  /**
   * A switch to a LOCAL section that was parked behind an unsaved draft. The
   * store's guard only knows store-driven sections, so the shell keeps the
   * local target itself and raises the section's discard prompt by parking a
   * no-op store navigation (the current section). Discard → the guard clears
   * `settingsDirty` → we finish the switch; keep editing → we drop it.
   */
  const pendingLocalRef = useRef<Exclude<LocalSection, null> | null>(null);

  // The id currently shown drives the title AND the content crossfade key:
  // a local-only view (if active) wins, otherwise the store-driven section.
  // Kept as a literal union (no `: string`) so the typed i18n key resolves.
  const activeId = localSection ?? section;
  const version = window.demli?.appInfo.version;

  // Every time the sheet opens (or closes) on mobile, start at the category
  // list: the top-level list is always the entry point.
  useEffect(() => {
    setMobileDetail(false);
  }, [open]);

  // Finish (or drop) a parked local switch once the section's prompt resolves.
  useEffect(() => {
    if (pendingSettingsNav !== null || pendingLocalRef.current === null) return;
    const target = pendingLocalRef.current;
    pendingLocalRef.current = null;
    if (!settingsDirty) {
      setLocalSection(target);
      setMobileDetail(true);
    }
  }, [pendingSettingsNav, settingsDirty]);

  // Settings covers the whole shell, so while it is open NOTHING behind it counts
  // as "the conversation the user is reading" — a message arriving in the channel
  // underneath must still notify (notifications/notify-policy.ts).
  useOverlayCovering(open);

  const selectEntry = (entry: NavEntry): void => {
    if (isStoreEntry(entry)) {
      setLocalSection(null);
      setSettingsSection(entry.id);
      // When the guard parked this switch, the prompt is up; the detail page
      // (mobile) follows once it lands.
      if (!useUiStore.getState().settingsDirty) setMobileDetail(true);
      return;
    }
    if (localSection === entry.id) {
      setMobileDetail(true);
      return;
    }
    if (useUiStore.getState().settingsDirty) {
      pendingLocalRef.current = entry.id;
      useUiStore.setState({ pendingSettingsNav: section });
      return;
    }
    setLocalSection(entry.id);
    setMobileDetail(true);
  };

  const isEntryActive = (entry: NavEntry): boolean =>
    isStoreEntry(entry) ? localSection === null && section === entry.id : localSection === entry.id;

  const renderSection = (): JSX.Element => (
    <>
      {localSection === "microphone" ? (
        <MicSettingsForm />
      ) : localSection === "video" ? (
        <VideoSettingsForm />
      ) : localSection === "general" ? (
        <GeneralSection />
      ) : localSection === "sounds" ? (
        <SoundSettings />
      ) : localSection === "notifications" ? (
        <NotificationSettings />
      ) : localSection === "language" ? (
        <LanguageSettings />
      ) : localSection === "blocked" ? (
        <BlockedUsersSettings />
      ) : localSection === "ignored" ? (
        <IgnoredUsersSettings />
      ) : localSection === "nicknames" ? (
        <NicknamesSettings />
      ) : (
        <>
          {section === "profile" && <ProfileSettings />}
          {section === "sessions" && <SessionsSettings />}
          {section === "voice" && <DeviceSettingsForm />}
          {section === "appearance" && <AppearanceSection />}
        </>
      )}
    </>
  );

  const logout = (): void => {
    // Logging out leaves this account entirely, so it BYPASSES the
    // unsaved-changes guard: parking the close behind a prompt would sign the
    // user out while the settings layer stayed open over a signed-out app.
    useUiStore.getState().setSettingsDirty(false);
    closeSettings();
    void logoutActiveAccount();
  };

  /**
   * Esc closes the layer (Radix, through the dirty guard) — except when it is
   * answering a LOCAL question first: an inline editor marked `data-esc-local`
   * (the nickname field) cancels itself on Esc, and that must not also close
   * the whole settings layer.
   */
  const onEscapeKeyDown = (event: globalThis.KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-esc-local]")) event.preventDefault();
  };

  const footer = (
    <>
      <button
        type="button"
        onClick={logout}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-fg-muted transition-colors motion-hover",
          "hover:bg-danger-surface hover:text-danger active:bg-danger/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger",
        )}
      >
        <LogOut className="size-4 shrink-0" />
        <span>{t("desktop:settings.account.logout")}</span>
      </button>
      {version && <p className="select-text px-2.5 pt-2 text-2xs text-fg-faint">v{version}</p>}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeSettings()}>
      <AnimatePresence>
        {open && (
          <DialogPortal forceMount key="settings">
            {/* Opaque base under the layer so the scale-in never shows the app. */}
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: transitions.fast }}
                exit={{ opacity: 0, transition: transitions.fast }}
                className="fixed inset-0 z-[55] bg-rail"
              />
            </DialogPrimitive.Overlay>

            {isMobile ? (
              /* ── NARROW: full-page master/detail ── */
              <DialogPrimitive.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onEscapeKeyDown={onEscapeKeyDown}
              >
                <m.div
                  variants={layerMotion}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  data-settings-layer="narrow"
                  className="fixed inset-0 z-[55] flex flex-col bg-app"
                >
                  <DialogPrimitive.Title className="sr-only">
                    {t("desktop:settings.title")}
                  </DialogPrimitive.Title>
                  <AnimatePresence mode="wait" initial={false}>
                    {mobileDetail ? (
                      <m.div
                        key={`detail-${activeId}`}
                        variants={pageMotion(1)}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex min-h-0 flex-1 flex-col"
                      >
                        <header className="flex h-14 shrink-0 items-center gap-2 px-2 shadow-[inset_0_-1px_0_var(--color-stroke)]">
                          <MobileHeaderButton label={t("buttons.back")} onClick={() => setMobileDetail(false)}>
                            <ArrowLeft className="size-5" />
                          </MobileHeaderButton>
                          <h1 className="min-w-0 flex-1 truncate font-display text-base font-medium text-fg-display">
                            {t(`desktop:settings.nav.${activeId}`)}
                          </h1>
                          <DialogPrimitive.Close asChild>
                            <MobileHeaderButton label={t("desktop:settings.close")}>
                              <X className="size-5" />
                            </MobileHeaderButton>
                          </DialogPrimitive.Close>
                        </header>
                        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
                          {renderSection()}
                        </main>
                      </m.div>
                    ) : (
                      <m.div
                        key="list"
                        variants={pageMotion(-1)}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex min-h-0 flex-1 flex-col"
                      >
                        <header className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
                          <h1 className="font-display text-lg font-medium text-fg-display">
                            {t("desktop:settings.title")}
                          </h1>
                          <DialogPrimitive.Close asChild>
                            <MobileHeaderButton label={t("desktop:settings.close")}>
                              <X className="size-5" />
                            </MobileHeaderButton>
                          </DialogPrimitive.Close>
                        </header>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6 pt-2">
                          {NAV_GROUPS.map((group) => (
                            <div key={group.group} className="mb-5">
                              <h2 className="px-2 pb-2 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                                {t(`desktop:settings.groups.${group.group}`)}
                              </h2>
                              <div className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
                                {group.entries.map((entry) => {
                                  const Icon = NAV_ICONS[entry.id];
                                  return (
                                    <button
                                      key={entry.id}
                                      type="button"
                                      onClick={() => selectEntry(entry)}
                                      className={cn(
                                        "flex h-12 w-full cursor-pointer items-center gap-3 px-3.5 text-left text-sm text-fg transition-colors motion-hover",
                                        "hover:bg-raised/50 active:bg-raised focus-visible:outline-none focus-visible:bg-raised/50",
                                        // Inset: the overflow-hidden card would clip an outer ring.
                                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                                      )}
                                    >
                                      {Icon && <Icon className="size-4 shrink-0 text-fg-muted" />}
                                      <span className="min-w-0 flex-1 truncate">
                                        {t(`desktop:settings.nav.${entry.id}`)}
                                      </span>
                                      <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                          <div className="mt-2">{footer}</div>
                        </div>
                      </m.div>
                    )}
                  </AnimatePresence>
                </m.div>
              </DialogPrimitive.Content>
            ) : (
              /* ── WIDE: full-screen layer (nav | section | close) ── */
              <DialogPrimitive.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onEscapeKeyDown={onEscapeKeyDown}
              >
                <m.div
                  variants={layerMotion}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  data-settings-layer="wide"
                  className="fixed inset-0 z-[55] flex bg-app"
                >
                  <DialogPrimitive.Title className="sr-only">
                    {t("desktop:settings.title")}
                  </DialogPrimitive.Title>

                  <nav
                    aria-label={t("desktop:settings.title")}
                    className="flex min-w-0 flex-[1_0_15rem] justify-end bg-sidebar"
                  >
                    <div className="flex w-[15.5rem] flex-col overflow-y-auto py-12 pl-4 pr-2">
                      <SettingsNav
                        groups={NAV_GROUPS}
                        isActive={isEntryActive}
                        activeKey={activeId}
                        onSelect={selectEntry}
                      />
                      <div className="mt-4 px-0.5 pt-4 shadow-[inset_0_1px_0_var(--color-stroke)]">
                        {footer}
                      </div>
                    </div>
                  </nav>

                  <div className="flex min-w-0 flex-[1_1_50rem]">
                    <main className="min-w-0 flex-1 overflow-y-auto" data-settings-scroll>
                      <m.div
                        key={activeId}
                        variants={sectionMotion}
                        initial="initial"
                        animate="animate"
                        className="max-w-[46rem] px-10 pb-24 pt-12"
                      >
                        <h2 className="mb-6 font-display text-[22px] font-medium leading-tight text-fg-display">
                          {t(`desktop:settings.nav.${activeId}`)}
                        </h2>
                        {renderSection()}
                      </m.div>
                    </main>
                    <div className="flex w-20 shrink-0 justify-start pt-12">
                      <div className="flex flex-col items-center gap-1.5">
                        <DialogPrimitive.Close
                          aria-label={t("desktop:settings.close")}
                          aria-keyshortcuts="Escape"
                          className={cn(
                            "flex size-9 cursor-pointer items-center justify-center rounded-full text-fg-muted",
                            "shadow-[inset_0_0_0_1.5px_var(--color-stroke-strong)] transition-[color,background-color,box-shadow] motion-hover",
                            "hover:bg-wash hover:text-fg hover:shadow-[inset_0_0_0_1.5px_var(--color-fg-faint)] active:bg-wash-strong",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
                          )}
                        >
                          <X className="size-[18px]" />
                        </DialogPrimitive.Close>
                        <span aria-hidden className="text-2xs font-semibold text-fg-faint">
                          {t("desktop:settings.esc")}
                        </span>
                      </div>
                    </div>
                  </div>
                </m.div>
              </DialogPrimitive.Content>
            )}
          </DialogPortal>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

/** 44px round header control for the narrow layout (thumb target). */
const MobileHeaderButton = forwardRef<
  HTMLButtonElement,
  { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function MobileHeaderButton({ label, children, className, ...rest }, ref) {
  // forwardRef + prop spread: it is also the `asChild` target of Radix's Close,
  // which hands it a ref and its own click handler.
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      {...rest}
      className={cn(
        "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors motion-hover",
        "hover:bg-wash hover:text-fg active:bg-wash-strong",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
    >
      {children}
    </button>
  );
});

/**
 * The wide nav: group labels + entries, with ONE accent-soft pill that slides to
 * the active entry (measured `offsetTop`, position spring). Arrow keys walk the
 * entries, Home/End jump to the ends; Enter/Space select (native buttons).
 */
function SettingsNav({
  groups,
  isActive,
  activeKey,
  onSelect,
}: {
  groups: typeof NAV_GROUPS;
  isActive: (entry: NavEntry) => boolean;
  activeKey: string;
  onSelect: (entry: NavEntry) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [indicatorY, setIndicatorY] = useState<number | null>(null);

  const measure = useCallback(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    setIndicatorY(active ? active.offsetTop : null);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, activeKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-settings-nav]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div ref={listRef} className="relative" onKeyDown={onKeyDown}>
      {indicatorY !== null && (
        <m.span
          aria-hidden
          data-settings-indicator
          className="pointer-events-none absolute inset-x-0 top-0 h-9 rounded-lg bg-accent-surface"
          initial={false}
          animate={{ y: indicatorY }}
          transition={springs.position}
        />
      )}
      {groups.map((group, groupIndex) => (
        <div key={group.group} className={cn(groupIndex > 0 && "mt-5")}>
          <h3 className="px-2.5 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t(`desktop:settings.groups.${group.group}`)}
          </h3>
          <div className="space-y-0.5">
            {group.entries.map((entry) => {
              const Icon = NAV_ICONS[entry.id];
              const active = isActive(entry);
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-settings-nav
                  onClick={() => onSelect(entry)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors motion-hover",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    active
                      ? "font-medium text-accent-hover"
                      : "text-fg-muted hover:bg-hover hover:text-fg active:bg-raised",
                  )}
                >
                  {Icon && (
                    <Icon
                      className={cn(
                        "size-4 shrink-0 transition-colors motion-hover",
                        active ? "text-accent" : "text-fg-faint",
                      )}
                    />
                  )}
                  <span className="truncate">{t(`desktop:settings.nav.${entry.id}`)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
