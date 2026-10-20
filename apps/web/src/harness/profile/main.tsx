/**
 * IDENTITY HARNESS — dev-only review surface for M16 Dalga 3 "identity
 * everywhere" (avatar + banner crop editor, profile card, profile settings,
 * avatar lightbox, presence, member menu, moderation / block / status dialogs).
 *
 * Reachable at `/harness-profile.html` under `pnpm --filter @demli/web dev`.
 * Vite builds from `index.html` alone, so nothing here ships.
 *
 * Renders the REAL components (imported from the desktop renderer, not copies)
 * with the REAL stylesheet and the real motion stack (LazyMotion strict +
 * MotionConfig reducedMotion="user"). Only the transport is replaced
 * (./fixtures.ts), with realistic latency, so loading, error and success states
 * are the components' own.
 *
 * Views (top bar, or `?view=`): avatars · card · menu · dialogs · settings · crop.
 * The page chrome is Turkish developer text and stays out of the catalogs: a
 * user never sees it. Everything inside a component is real product copy.
 */

import "../../shim/demli-bridge";
import "../../styles/desktop-shell.css";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  TooltipProvider,
  UserAvatar,
  cn,
  type UserAvatarSize,
} from "@demli/ui";
import { RoleChip, TimeoutBadge } from "@demli/app-ui";
import type { GroupId, PresencePlatform, PresenceStatus, User, UserId } from "@demli/types";
import { AvatarLightbox } from "../../../../desktop/src/renderer/src/components/AvatarLightbox";
import { BlockUserDialog } from "../../../../desktop/src/renderer/src/components/BlockUserDialog";
import { CustomStatusDialog } from "../../../../desktop/src/renderer/src/components/CustomStatusDialog";
import { ImageCropDialog } from "../../../../desktop/src/renderer/src/components/ImageCropDialog";
import { MemberContextMenu } from "../../../../desktop/src/renderer/src/components/MemberContextMenu";
import { MemberDialogs } from "../../../../desktop/src/renderer/src/components/MemberDialogs";
import { NotificationMuteSubmenu } from "../../../../desktop/src/renderer/src/components/NotificationMuteSubmenu";
import { ProfileCard, presenceLabel } from "../../../../desktop/src/renderer/src/components/ProfileCard";
import { ProfileSettings } from "../../../../desktop/src/renderer/src/components/ProfileSettings";
import { createDesktopI18n, useAppTranslation } from "../../../../desktop/src/renderer/src/lib/i18n";
import type { ExportedImage } from "../../../../desktop/src/renderer/src/lib/image-file";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import { useUiStore } from "../../../../desktop/src/renderer/src/stores/ui-store";
import {
  BLOCKED,
  FAILING,
  FRIEND,
  GROUP_ID,
  IMAGES,
  INCOMING,
  LOADING,
  LONG_NAME,
  ME,
  PEOPLE,
  PLATFORMS,
  PRESENCE,
  STRANGER,
  harnessControls,
  installApiStubs,
  installImages,
  makeHarnessFiles,
  type HarnessFiles,
} from "./fixtures";

type View = "avatars" | "card" | "menu" | "dialogs" | "settings" | "crop";
const VIEWS: { id: View; label: string }[] = [
  { id: "avatars", label: "Avatar · durum" },
  { id: "card", label: "Profil kartı" },
  { id: "menu", label: "Üye menüsü" },
  { id: "dialogs", label: "Diyaloglar" },
  { id: "settings", label: "Profil ayarları" },
  { id: "crop", label: "Kırpma editörü" },
];

function readView(): View {
  const v = new URLSearchParams(window.location.search).get("view");
  return VIEWS.some((entry) => entry.id === v) ? (v as View) : "avatars";
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-display text-lg font-medium text-fg-display">{title}</h2>
        {note && <p className="text-label text-fg-faint">{note}</p>}
      </div>
      {children}
    </section>
  );
}

// ── Avatars & presence ─────────────────────────────────────────────────────

const SIZES: UserAvatarSize[] = ["xs", "sm", "md", "lg", "xl", "2xl"];
const STATUSES: PresenceStatus[] = ["online", "idle", "dnd", "offline"];

function AvatarsView(): JSX.Element {
  const { t } = useAppTranslation();
  const [lightbox, setLightbox] = useState<{ url: string | null; name: string; seed: string } | null>(null);
  return (
    <div className="space-y-10">
      <Section title="Boylar" note="Fotoğraf · baş harf (sabit ton) · konuşan halka · 2px halka">
        {[
          { name: FRIEND.displayName, seed: FRIEND.id, src: IMAGES.portraitA, speaking: false },
          { name: STRANGER.displayName, seed: STRANGER.id, src: null, speaking: false },
          { name: INCOMING.displayName, seed: INCOMING.id, src: IMAGES.portraitB, speaking: true },
          { name: "Zeynep", seed: "u-zeynep", src: "data:image/png;base64,AAAAAAAA", speaking: false },
        ].map((row) => (
          <div key={row.seed} className="flex items-end gap-4 rounded-xl bg-app p-4" data-testid={`avatar-row-${row.seed}`}>
            {SIZES.map((size) => (
              <UserAvatar key={size} name={row.name} colorSeed={row.seed} src={row.src} size={size} speaking={row.speaking} />
            ))}
          </div>
        ))}
      </Section>
      <Section title="Durum rozetleri" note="Boyun %30'u · telefon rozeti · halka yüzey tonunu izler">
        <div className="flex flex-wrap gap-6 rounded-xl bg-app p-4">
          {STATUSES.flatMap((status) =>
            (["desktop", "mobile"] as PresencePlatform[]).map((platform) => (
              <div key={`${status}-${platform}`} className="flex flex-col items-center gap-2">
                <UserAvatar
                  name={ME.displayName}
                  colorSeed={ME.id}
                  src={IMAGES.portraitA}
                  size="lg"
                  presence={status}
                  presencePlatform={platform}
                  presenceLabel={presenceLabel(t, status, platform)}
                />
                <span className="text-2xs text-fg-faint">{presenceLabel(t, status, platform)}</span>
              </div>
            )),
          )}
        </div>
        <div
          className="flex gap-6 rounded-xl bg-surface p-4"
          style={{ "--avatar-ring": "var(--color-surface)" } as CSSProperties}
          data-testid="presence-on-surface"
        >
          <UserAvatar name="Ece" colorSeed="u-ece" src={IMAGES.portraitA} size="md" presence="online" presenceLabel={presenceLabel(t, "online")} />
          <UserAvatar name="Burak" colorSeed="u-burak" src={null} size="md" presence="dnd" presenceLabel={presenceLabel(t, "dnd")} />
        </div>
      </Section>
      <Section title="Rol ve zaman aşımı">
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-app p-4">
          <RoleChip name="Masa sahibi" color="#ff8464" />
          <RoleChip name="Film gecesi" color="#7dd3fc" />
          <RoleChip name="Renksiz rol" color={null} />
          <RoleChip name="Çok uzun bir rol adı örneği burada" color="#c4b5fd" size="sm" />
          <span className="inline-flex items-center gap-2 text-sm text-fg">
            {STRANGER.displayName}
            <TimeoutBadge timedOutUntil={new Date(Date.now() + 3_600_000).toISOString()} />
          </span>
        </div>
      </Section>
      <Section title="Avatar büyütme" note="Tekerlek imlece doğru yakınlaştırır · sürükle · ok tuşları · + − 0">
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="open-lightbox-photo"
            className="rounded-lg bg-raised px-3 py-2 text-sm text-fg hover:bg-raised-hover"
            onClick={() => setLightbox({ url: IMAGES.portraitA, name: FRIEND.displayName, seed: FRIEND.id })}
          >
            Fotoğraflı aç
          </button>
          <button
            type="button"
            data-testid="open-lightbox-initials"
            className="rounded-lg bg-raised px-3 py-2 text-sm text-fg hover:bg-raised-hover"
            onClick={() => setLightbox({ url: null, name: STRANGER.displayName, seed: STRANGER.id })}
          >
            Baş harfle aç
          </button>
        </div>
        <AvatarLightbox
          open={lightbox !== null}
          onOpenChange={(open) => !open && setLightbox(null)}
          url={lightbox?.url}
          name={lightbox?.name ?? ""}
          colorSeed={lightbox?.seed ?? ""}
        />
      </Section>
    </div>
  );
}

// ── Profile cards ──────────────────────────────────────────────────────────

function CardTrigger({ person, label }: { person: User; label: string }): JSX.Element {
  const avatar = person.id === FRIEND.id ? IMAGES.portraitA : person.id === INCOMING.id ? IMAGES.portraitB : person.id === LONG_NAME.id ? IMAGES.landscape : null;
  return (
    <ProfileCard userId={person.id} groupId={GROUP_ID}>
      <button
        type="button"
        data-testid={`card-${person.id}`}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors motion-hover hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <UserAvatar name={person.displayName} colorSeed={person.id} src={avatar} size="md" presence={PRESENCE[person.id]} presencePlatform={PLATFORMS[person.id]} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{person.displayName}</span>
          <span className="block truncate text-2xs text-fg-faint">{label}</span>
        </span>
      </button>
    </ProfileCard>
  );
}

function CardView(): JSX.Element {
  return (
    <Section title="Profil kartı" note="Bir satıra tıkla. Her durum gerçek bileşen + gerçek sorgu kancası.">
      <div className="w-72 space-y-0.5 rounded-xl bg-sidebar p-2" style={{ "--avatar-ring": "var(--color-sidebar)" } as CSSProperties}>
        <CardTrigger person={FRIEND} label="arkadaş · banner · roller · not" />
        <CardTrigger person={STRANGER} label="tanımadık · banner yok" />
        <CardTrigger person={INCOMING} label="gelen istek · hareketli banner" />
        <CardTrigger person={LONG_NAME} label="giden istek · uzun ad/durum" />
        <CardTrigger person={BLOCKED} label="engellendi" />
        <CardTrigger person={ME} label="kendi kartın" />
        <CardTrigger person={LOADING} label="yükleniyor (hiç bitmez)" />
        <CardTrigger person={FAILING} label="hata + tekrar dene" />
      </div>
    </Section>
  );
}

// ── Member menu ────────────────────────────────────────────────────────────

function MenuView(): JSX.Element {
  return (
    <div className="space-y-10">
      <Section title="Üye bağlam menüsü" note="Sağ tıkla. Sen sunucu sahibisin: moderasyon bölümü, rol alt menüsü, tehlikeli öğeler.">
        <div className="w-72 space-y-0.5 rounded-xl bg-sidebar p-2">
          {[FRIEND, STRANGER, INCOMING].map((person) => (
            <MemberContextMenu
              key={person.id}
              target={{ userId: person.id, displayName: person.displayName, username: person.username }}
              groupId={GROUP_ID}
            >
              <div
                data-testid={`menu-${person.id}`}
                tabIndex={0}
                className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors motion-hover hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <UserAvatar name={person.displayName} colorSeed={person.id} src={person.id === FRIEND.id ? IMAGES.portraitA : null} size="sm" presence={PRESENCE[person.id]} />
                <span className="truncate text-sm text-fg">{person.displayName}</span>
              </div>
            </MemberContextMenu>
          ))}
          <MemberContextMenu target={{ userId: ME.id, displayName: ME.displayName, username: ME.username }} groupId={GROUP_ID}>
            <div data-testid="menu-self" tabIndex={0} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface">
              <UserAvatar name={ME.displayName} colorSeed={ME.id} src={null} size="sm" />
              <span className="truncate text-sm text-fg">{ME.displayName} (sen)</span>
            </div>
          </MemberContextMenu>
        </div>
      </Section>
      <Section title="Bildirim susturma alt menüsü" note="Kanal satırında sağ tık.">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div data-testid="mute-row" tabIndex={0} className="w-72 rounded-lg bg-sidebar px-3 py-2 text-sm text-fg-muted hover:bg-surface">
              # genel
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <NotificationMuteSubmenu scope="channel" targetId="c-genel" isMuted />
          </ContextMenuContent>
        </ContextMenu>
      </Section>
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function DialogsView(): JSX.Element {
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);
  const setCustomStatusDialogOpen = useUiStore((s) => s.setCustomStatusDialogOpen);
  const base = { userId: STRANGER.id, displayName: STRANGER.displayName, groupId: GROUP_ID };
  const buttons: Array<{ id: string; label: string; open: () => void }> = [
    { id: "kick", label: "At", open: () => setMemberDialog({ kind: "kick", ...base }) },
    { id: "ban", label: "Yasakla", open: () => setMemberDialog({ kind: "ban", ...base }) },
    { id: "timeout", label: "Zaman aşımı", open: () => setMemberDialog({ kind: "timeout", ...base }) },
    { id: "unfriend", label: "Arkadaşlıktan çıkar", open: () => setMemberDialog({ kind: "unfriend", userId: FRIEND.id, displayName: FRIEND.displayName }) },
    { id: "note", label: "Not", open: () => setMemberDialog({ kind: "note", userId: FRIEND.id, displayName: FRIEND.displayName }) },
    { id: "nickname", label: "Takma ad", open: () => setMemberDialog({ kind: "friendNickname", userId: FRIEND.id, displayName: FRIEND.displayName, realName: FRIEND.displayName, current: "Ecem" }) },
    { id: "block", label: "Engelle", open: () => setBlockDialog({ userId: STRANGER.id, displayName: STRANGER.displayName, blocked: false }) },
    { id: "unblock", label: "Engeli kaldır", open: () => setBlockDialog({ userId: BLOCKED.id, displayName: BLOCKED.displayName, blocked: true }) },
    { id: "status", label: "Özel durum", open: () => setCustomStatusDialogOpen(true) },
  ];
  return (
    <Section title="Diyaloglar" note="Hepsi gerçek bileşen; gönderim stub API'ye gider (gecikmeli).">
      <div className="flex flex-wrap gap-2">
        {buttons.map((button) => (
          <button
            key={button.id}
            type="button"
            data-testid={`dialog-${button.id}`}
            onClick={button.open}
            className="rounded-lg bg-raised px-3 py-2 text-sm text-fg transition-colors motion-hover hover:bg-raised-hover"
          >
            {button.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

function SettingsView(): JSX.Element {
  const [fail, setFail] = useState(harnessControls.failNextAvatarUpload);
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-label text-fg-muted">
        <input
          type="checkbox"
          data-testid="fail-next-avatar"
          checked={fail}
          onChange={(event) => {
            harnessControls.failNextAvatarUpload = event.target.checked;
            setFail(event.target.checked);
          }}
        />
        Sonraki avatar yüklemesi ağ hatasıyla düşsün (Tekrar dene yolunu görmek için)
      </label>
      {/* The settings shell's content column: max-w-2xl inside a scrolling main. */}
      <main className="h-[calc(100vh-9rem)] overflow-y-auto rounded-xl bg-app" data-testid="settings-scroll">
        <div className="mx-auto max-w-2xl px-8 py-8">
          <ProfileSettings />
        </div>
      </main>
    </div>
  );
}

// ── Crop editor ────────────────────────────────────────────────────────────

function CropView(): JSX.Element {
  const [files, setFiles] = useState<HarnessFiles | null>(null);
  const [target, setTarget] = useState<{ kind: "avatar" | "banner"; file: File } | null>(null);
  const [result, setResult] = useState<ExportedImage | null>(null);
  useEffect(() => {
    void makeHarnessFiles().then(setFiles);
  }, []);
  const cases: Array<{ id: string; label: string; kind: "avatar" | "banner"; file?: File }> = files
    ? [
        { id: "avatar-photo", label: "Avatar · büyük foto", kind: "avatar", file: files.photo },
        { id: "avatar-small", label: "Avatar · küçük foto (büyütülmez)", kind: "avatar", file: files.smallPhoto },
        { id: "avatar-gif", label: "Avatar · GIF (ilk kare)", kind: "avatar", file: files.stillFromGif },
        { id: "banner-landscape", label: "Banner · manzara", kind: "banner", file: files.landscape },
        { id: "banner-portrait", label: "Banner · dikey foto", kind: "banner", file: files.photo },
        { id: "banner-gif", label: "Banner · hareketli GIF", kind: "banner", file: files.animatedGif },
        { id: "error-type", label: "Hata · metin dosyası", kind: "avatar", file: files.notAnImage },
        { id: "error-pixels", label: "Hata · 30000² başlık", kind: "banner", file: files.pixelBomb },
      ]
    : [];
  return (
    <Section title="Kırpma editörü" note="Gerçek ImageCropDialog. Uygula → dışa aktarılan dosya aşağıda (boyut, tür, bayt).">
      <div className="flex flex-wrap gap-2" aria-busy={!files}>
        {cases.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`crop-${entry.id}`}
            onClick={() => entry.file && setTarget({ kind: entry.kind, file: entry.file })}
            className="rounded-lg bg-raised px-3 py-2 text-sm text-fg transition-colors motion-hover hover:bg-raised-hover"
          >
            {entry.label}
          </button>
        ))}
      </div>
      {result && (
        <div className="flex items-center gap-4 rounded-xl bg-app p-4" data-testid="crop-result">
          <img
            src={result.previewUrl}
            alt=""
            className={cn("bg-rail object-cover", result.width === result.height ? "size-24 rounded-full" : "h-24 rounded-lg")}
          />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-label">
            <dt className="text-fg-faint">tür</dt>
            <dd className="text-fg" data-testid="crop-result-mime">{result.mime}</dd>
            <dt className="text-fg-faint">boyut</dt>
            <dd className="text-fg" data-testid="crop-result-size">{result.width}×{result.height}</dd>
            <dt className="text-fg-faint">bayt</dt>
            <dd className="text-fg" data-testid="crop-result-bytes">{result.byteLength}</dd>
            <dt className="text-fg-faint">hareketli</dt>
            <dd className="text-fg" data-testid="crop-result-animated">{String(result.animated)}</dd>
          </dl>
        </div>
      )}
      <ImageCropDialog
        kind={target?.kind ?? "avatar"}
        file={target?.file ?? null}
        onCancel={() => setTarget(null)}
        onApply={(image) => {
          setResult(image);
          setTarget(null);
        }}
        identity={{ name: ME.displayName, username: ME.username, seed: ME.id, avatarUrl: IMAGES.portraitA, bannerUrl: IMAGES.wideBanner }}
      />
    </Section>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────

function Harness(): JSX.Element {
  const [view, setView] = useState<View>(readView);
  const go = (next: View): void => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState(null, "", url);
    setView(next);
  };
  return (
    <div className="h-full overflow-y-auto bg-rail text-fg">
      <nav className="sticky top-0 z-40 flex h-14 items-center gap-3 px-4 surface-glass">
        <span className="font-display text-base font-semibold text-fg-display">Kimlik</span>
        <span className="hidden text-label text-fg-faint md:inline">harness · yalnız geliştirme</span>
        <div className="ml-auto flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Görünüm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              data-testid={`view-${v.id}`}
              onClick={() => go(v.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors motion-hover",
                view === v.id ? "bg-accent-surface text-accent-hover" : "text-fg-muted hover:bg-surface hover:text-fg",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="mx-auto max-w-5xl px-6 py-8">
        {view === "avatars" && <AvatarsView />}
        {view === "card" && <CardView />}
        {view === "menu" && <MenuView />}
        {view === "dialogs" && <DialogsView />}
        {view === "settings" && <SettingsView />}
        {view === "crop" && <CropView />}
      </div>
      {/* Mounted once, like the app shell does. */}
      <MemberDialogs />
      <BlockUserDialog />
      <CustomStatusDialog />
    </div>
  );
}

function seedStores(): void {
  useAuthStore.setState({ user: ME, status: "authenticated", token: "harness" } as never);
  useChatStore.setState({
    users: Object.fromEntries(PEOPLE.map((p) => [p.id, p])) as Record<UserId, User>,
    presence: PRESENCE as Record<UserId, PresenceStatus>,
    presencePlatforms: PLATFORMS as Record<UserId, PresencePlatform>,
    customStatuses: Object.fromEntries(
      PEOPLE.filter((p) => p.customStatus).map((p) => [p.id, p.customStatus]),
    ) as Record<UserId, string>,
    activeChannelId: "c-genel",
    activeGroupId: GROUP_ID as GroupId,
  } as never);
}

function Root(): JSX.Element | null {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  const [ready, setReady] = useState(false);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
    [],
  );
  useEffect(() => {
    void (async () => {
      await installImages();
      installApiStubs((user) => useAuthStore.setState({ user } as never));
      seedStores();
      const instance = await createDesktopI18n();
      const lang = new URLSearchParams(window.location.search).get("lang");
      if (lang === "en" || lang === "tr") await instance.changeLanguage(lang);
      setI18n(instance);
      setReady(true);
    })();
  }, []);
  if (!i18n || !ready) return null;
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {/* Same motion wiring as App.tsx: a motion.* element anywhere below
            would throw here exactly as it would in the product. */}
        <LazyMotion features={domAnimation} strict>
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={350} skipDelayDuration={200}>
              <Harness />
            </TooltipProvider>
          </MotionConfig>
        </LazyMotion>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
