import { useEffect, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import {
  ArrowLeft,
  Bell,
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
import { overlayFade, popIn, viewFade } from "@demli/app-ui";
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
// CriticalUpdateOverlay is mounted at the App root (works pre-login too).
import { UpdateSettings } from "./UpdateSettings";

function AppearanceSection(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="pb-2 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
          {t("desktop:settings.appearance.theme")}
        </legend>
        <div role="radiogroup" aria-label={t("desktop:settings.appearance.theme")} className="flex gap-3">
          <button
            type="button"
            role="radio"
            aria-checked="true"
            className={cn(
              "w-36 cursor-pointer rounded-lg border border-accent/60 bg-app p-3 text-left",
              "ring-1 ring-accent/40",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <span className="block h-10 rounded-md bg-raised" aria-hidden />
            <span className="mt-2 block text-sm font-medium text-fg">
              {t("desktop:settings.appearance.dark")}
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked="false"
            disabled
            className="w-36 cursor-not-allowed rounded-lg border border-stroke bg-surface p-3 text-left opacity-50"
          >
            <span className="block h-10 rounded-md bg-fg-muted/30" aria-hidden />
            <span className="mt-2 block text-sm font-medium text-fg-muted">
              {t("desktop:settings.appearance.lightLater")}
            </span>
          </button>
        </div>
      </fieldset>
      <p className="text-xs leading-relaxed text-fg-faint">
        {t("desktop:settings.appearance.note")}
      </p>
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
    <div className="space-y-6">
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
 * Settings surface. Two responsive shapes share one component:
 *
 *  - WIDE (Electron / desktop web): a large centered MODAL over a dark, blurred
 *    backdrop, with a vertical category rail on the left and the selected section
 *    on the right.
 *  - NARROW (mobile web, `useIsMobileViewport`): a FULL-PAGE surface — a category
 *    list you tap into a section, with a back arrow (founder: "webe mobilden
 *    girdiğinde settings modal değil, full açılması gerekirdi bi sayfa gibi").
 *
 * Both are composed from the raw Radix Dialog primitives (via {@link
 * DialogPrimitive}) with `forceMount` so Framer's <AnimatePresence> drives a real
 * enter/exit — while Radix still supplies the focus trap, Esc-to-close and
 * scroll-lock. The modal/page sits at z-[55]: ABOVE the app shell, the mobile
 * navigation drawer (z-50) and the command menu (z-50) — fixing the founder P0
 * where "sol menü modalın önüne geçmiş" — yet below the add-account overlay
 * (z-[60]), call ring (z-[70]+) and critical overlays (z-[100]).
 *
 * The section *content* is untouched — the existing forms (ProfileSettings,
 * DeviceSettingsForm, SessionsSettings, …) are shared by both shapes.
 */
export function SettingsShell(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const section = useUiStore((s) => s.settingsSection);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const [localSection, setLocalSection] = useState<LocalSection>(null);
  const isMobile = useIsMobileViewport();
  // Mobile master/detail: false = category list page, true = a section page.
  const [mobileDetail, setMobileDetail] = useState(false);

  // The id currently shown drives the header title AND the content crossfade key:
  // a local-only view (if active) wins, otherwise the store-driven section.
  // Kept as a literal union (no `: string`) so the typed i18n key resolves.
  const activeId = localSection ?? section;
  const version = window.demli?.appInfo.version;

  // Every time the sheet opens (or closes) on mobile, start at the category
  // list: the top-level list is always the entry point.
  useEffect(() => {
    setMobileDetail(false);
  }, [open]);

  // Settings covers the whole shell, so while it is open NOTHING behind it counts
  // as "the conversation the user is reading" — a message arriving in the channel
  // underneath must still notify (notifications/notify-policy.ts).
  useOverlayCovering(open);

  const selectEntry = (entry: NavEntry): void => {
    if (entry.kind === "store") {
      setLocalSection(null);
      setSettingsSection(entry.id);
    } else {
      setLocalSection(entry.id);
    }
    setMobileDetail(true);
  };

  const isEntryActive = (entry: NavEntry): boolean =>
    entry.kind === "store" ? localSection === null && section === entry.id : localSection === entry.id;

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

  const logoutButton = (
    <button
      type="button"
      onClick={() => {
        // Logging out leaves this account entirely, so it BYPASSES the
        // unsaved-changes guard: parking the close behind a prompt would sign the
        // user out while the settings modal stayed open over a signed-out app.
        useUiStore.getState().setSettingsDirty(false);
        closeSettings();
        void logoutActiveAccount();
      }}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-fg-muted transition-colors motion-instant",
        "hover:bg-danger/10 hover:text-danger",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60",
      )}
    >
      <LogOut className="size-4 shrink-0" />
      <span>{t("desktop:settings.account.logout")}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeSettings()}>
      <AnimatePresence>
        {open && (
          <DialogPortal forceMount key="settings">
            {/* Dark, blurred backdrop — opacity-only fade (shared preset). */}
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                variants={overlayFade}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed inset-0 z-[55] bg-black/70 backdrop-blur-sm"
              />
            </DialogPrimitive.Overlay>

            {isMobile ? (
              /* ── NARROW: full-page master/detail ── */
              <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                <m.div
                  variants={overlayFade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed inset-0 z-[55] flex flex-col bg-app"
                >
                  <DialogPrimitive.Title className="sr-only">
                    {t("desktop:settings.title")}
                  </DialogPrimitive.Title>

                  {mobileDetail ? (
                    <>
                      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-stroke px-3">
                        <button
                          type="button"
                          onClick={() => setMobileDetail(false)}
                          aria-label={t("buttons.back")}
                          className={cn(
                            "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors motion-instant",
                            "hover:bg-raised hover:text-fg",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                          )}
                        >
                          <ArrowLeft className="size-5" />
                        </button>
                        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
                          {t(`desktop:settings.nav.${activeId}`)}
                        </h1>
                        <DialogPrimitive.Close
                          aria-label={t("desktop:settings.close")}
                          className={cn(
                            "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors motion-instant",
                            "hover:bg-raised hover:text-fg",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                          )}
                        >
                          <X className="size-5" />
                        </DialogPrimitive.Close>
                      </header>
                      <main className="min-h-0 flex-1 overflow-y-auto">
                        <m.div
                          key={activeId}
                          variants={viewFade}
                          initial="initial"
                          animate="animate"
                          className="px-4 py-5"
                        >
                          {renderSection()}
                        </m.div>
                      </main>
                    </>
                  ) : (
                    <>
                      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stroke px-4">
                        <h1 className="text-base font-semibold text-fg">
                          {t("desktop:settings.title")}
                        </h1>
                        <DialogPrimitive.Close
                          aria-label={t("desktop:settings.close")}
                          className={cn(
                            "flex size-9 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors motion-instant",
                            "hover:bg-raised hover:text-fg",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                          )}
                        >
                          <X className="size-5" />
                        </DialogPrimitive.Close>
                      </header>
                      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
                        {NAV_GROUPS.map((group) => (
                          <div key={group.group} className="mb-5">
                            <h2 className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                              {t(`desktop:settings.groups.${group.group}`)}
                            </h2>
                            <div className="overflow-hidden rounded-xl border border-stroke bg-surface">
                              {group.entries.map((entry, i) => {
                                const Icon = NAV_ICONS[entry.id];
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    onClick={() => selectEntry(entry)}
                                    className={cn(
                                      "flex h-12 w-full cursor-pointer items-center gap-3 px-3.5 text-left text-sm text-fg transition-colors motion-instant",
                                      "hover:bg-white/[0.04] focus-visible:outline-none focus-visible:bg-white/[0.04]",
                                      i > 0 && "border-t border-stroke",
                                    )}
                                  >
                                    {Icon && <Icon className="size-4 shrink-0 text-fg-faint" />}
                                    <span className="min-w-0 flex-1 truncate">
                                      {t(`desktop:settings.nav.${entry.id}`)}
                                    </span>
                                    <ChevronRight className="size-4 shrink-0 text-fg-faint" />
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}

                        <div className="mt-2 border-t border-stroke pt-4">{logoutButton}</div>
                        {version && (
                          <p className="select-text px-2.5 pt-2 text-2xs text-fg-faint">v{version}</p>
                        )}
                      </div>
                    </>
                  )}
                </m.div>
              </DialogPrimitive.Content>
            ) : (
              /* ── WIDE: centered modal card (rail + section) ─────────────────
                  A STATIC full-screen centering layer is the focus-trap boundary;
                  keeping it transform-free (separate from the animated card) means
                  Framer's scale/opacity never fights a translate-centering
                  transform. Clicking the empty margin closes. */
              <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                <div
                  className="fixed inset-0 z-[55] flex items-center justify-center p-6"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) closeSettings();
                  }}
                >
                  <DialogPrimitive.Title className="sr-only">
                    {t("desktop:settings.title")}
                  </DialogPrimitive.Title>

                  <m.div
                    variants={popIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className={cn(
                      "flex h-[min(44rem,calc(100vh-3rem))] w-[min(62rem,calc(100vw-3rem))] overflow-hidden",
                      "rounded-2xl border border-stroke bg-app shadow-elevated glass-edge",
                    )}
                  >
                    {/* ── Left: vertical category rail ─────────────────────── */}
                    <nav
                      aria-label={t("desktop:settings.title")}
                      className="flex w-60 shrink-0 flex-col border-r border-stroke bg-sidebar"
                    >
                      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
                        {NAV_GROUPS.map((group) => (
                          <div key={group.group} className="mb-4">
                            <h3 className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                              {t(`desktop:settings.groups.${group.group}`)}
                            </h3>
                            <div className="space-y-0.5">
                              {group.entries.map((entry) => {
                                const Icon = NAV_ICONS[entry.id];
                                const active = isEntryActive(entry);
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    onClick={() => selectEntry(entry)}
                                    aria-current={active ? "true" : undefined}
                                    className={cn(
                                      "relative flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors motion-instant",
                                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                                      active
                                        ? "bg-accent-surface font-medium text-fg"
                                        : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
                                    )}
                                  >
                                    {active && (
                                      <span
                                        aria-hidden
                                        className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
                                      />
                                    )}
                                    {Icon && (
                                      <Icon
                                        className={cn(
                                          "size-4 shrink-0",
                                          active ? "text-accent" : "text-fg-faint",
                                        )}
                                      />
                                    )}
                                    <span className="truncate">
                                      {t(`desktop:settings.nav.${entry.id}`)}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Footer: quick logout + app version. */}
                      <div className="shrink-0 border-t border-stroke p-3">
                        {logoutButton}
                        {version && (
                          <p className="select-text px-2.5 pt-2 text-2xs text-fg-faint">v{version}</p>
                        )}
                      </div>
                    </nav>

                    {/* ── Right: header + selected section ──────────────────── */}
                    <div className="flex min-w-0 flex-1 flex-col bg-app">
                      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stroke px-6">
                        <h1 className="text-base font-semibold text-fg">
                          {t(`desktop:settings.nav.${activeId}`)}
                        </h1>
                        <div className="flex items-center gap-2">
                          <span className="hidden text-2xs font-semibold text-fg-faint wide:block">
                            {t("desktop:settings.esc")}
                          </span>
                          <DialogPrimitive.Close
                            aria-label={t("desktop:settings.close")}
                            className={cn(
                              "flex size-8 cursor-pointer items-center justify-center rounded-full border border-stroke-strong text-fg-muted transition-colors motion-instant",
                              "hover:bg-raised hover:text-fg",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                            )}
                          >
                            <X className="size-4" />
                          </DialogPrimitive.Close>
                        </div>
                      </header>

                      <main className="min-h-0 flex-1 overflow-y-auto">
                        {/* Keyed on the active id → a quick opacity fade whenever the
                            section changes (opacity-only preset, never layout). */}
                        <m.div
                          key={activeId}
                          variants={viewFade}
                          initial="initial"
                          animate="animate"
                          className="mx-auto max-w-2xl px-8 py-8"
                        >
                          {renderSection()}
                        </m.div>
                      </main>
                    </div>
                  </m.div>
                </div>
              </DialogPrimitive.Content>
            )}
          </DialogPortal>
        )}
      </AnimatePresence>
    </Dialog>
  );
}
