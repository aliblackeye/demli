/**
 * KOYU MASA UI KIT — dev-only review surface for the founder gate (M16 G2).
 *
 * Reachable at `/ui-kit.html` under `pnpm --filter @demli/web dev`. Vite builds
 * from `index.html` alone, so nothing here ships (same as stage-harness).
 *
 * It renders the REAL primitives from @demli/ui with the REAL stylesheet
 * (globals.css via desktop-shell.css) and the real motion stack (LazyMotion
 * strict + MotionConfig), so what is reviewed here is what the product paints.
 * Swatches print the contrast ratio MEASURED from the token value, not a claim.
 *
 * Views (top bar, or `?view=`):
 *   kit    every primitive in every state
 *   auth   the real sign-in screen, re-skinned by the new tokens only
 *   stage  the real voice stage (seeded like stage-harness), tokens only
 *
 * The page chrome (section titles, notes) is Turkish developer text and stays
 * out of the i18n catalogs on purpose: it is never shown to a user. Every label
 * INSIDE a primitive demo uses a real product key, so the copy under review is
 * the copy that ships.
 */

import "../shim/demli-bridge";
import "../styles/desktop-shell.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import {
  Bell,
  Camera,
  Mic,
  MicOff,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  Settings,
  Trash2,
  UserPlus,
} from "lucide-react";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import {
  AvatarGroup,
  Badge,
  Button,
  Checkbox,
  Chip,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  CountBadge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Kbd,
  RadioGroup,
  RadioItem,
  ReactionChip,
  Select,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Slider,
  Switch,
  Textarea,
  Toaster,
  TooltipProvider,
  UserAvatar,
  buttonVariants,
  cn,
  contrastRatio,
  toast,
  type ToastVariant,
} from "@demli/ui";
import { MotionToast } from "@demli/app-ui";
import type { VoiceParticipant } from "@demli/media";
import type { User, UserId } from "@demli/types";
import { AuthScreen } from "../../../desktop/src/renderer/src/components/AuthScreen";
import { VideoStage } from "../../../desktop/src/renderer/src/components/VideoStage";
import { createDesktopI18n, useAppTranslation } from "../../../desktop/src/renderer/src/lib/i18n";
import { useAuthStore } from "../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../desktop/src/renderer/src/stores/chat-store";
import { useVideoStageStore } from "../../../desktop/src/renderer/src/stores/video-stage-store";
import { useVoiceStore } from "../../../desktop/src/renderer/src/stores/voice-store";

type View = "kit" | "auth" | "stage";
const VIEWS: { id: View; label: string }[] = [
  { id: "kit", label: "Parçalar" },
  { id: "auth", label: "Giriş ekranı" },
  { id: "stage", label: "Sesli sahne" },
];

function readView(): View {
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "auth" || v === "stage" ? v : "kit";
}

/* ── Page chrome ─────────────────────────────────────────────────────────── */

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} data-section={id} className="flex flex-col gap-4 rounded-card bg-app p-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-medium text-fg-display">{title}</h2>
        {note && <p className="text-label text-fg-faint">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-28 shrink-0 text-2xs font-semibold uppercase tracking-wider text-fg-faint">{label}</span>
      {children}
    </div>
  );
}

/* ── Foundations ─────────────────────────────────────────────────────────── */

const SURFACES = ["rail", "sidebar", "app", "surface", "raised", "raised-hover", "overlay"] as const;
const TEXT = ["fg-display", "fg", "fg-muted", "fg-faint", "fg-subtle"] as const;
const BRAND = ["accent", "accent-hover", "accent-pressed", "danger", "success", "warning", "online", "idle", "dnd", "offline"] as const;
const WASHES = ["glass", "glass-strong", "veil", "scrim", "selected", "accent-surface", "danger-surface", "accent-glow", "stroke", "stroke-strong"] as const;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

function Swatch({ name, against }: { name: string; against?: string }): JSX.Element {
  const value = cssVar(name);
  let ratio: string | null = null;
  if (against) {
    try {
      ratio = contrastRatio(value, cssVar(against)).toFixed(2);
    } catch {
      ratio = null;
    }
  }
  return (
    <div className="flex w-36 flex-col gap-1.5" data-swatch={name} data-ratio={ratio ?? undefined}>
      <div className="h-14 rounded-lg" style={{ background: `var(--color-${name})` }} />
      <span className="text-xs font-medium text-fg">{name}</span>
      <span className="font-mono text-2xs text-fg-faint">{value}</span>
      {ratio && (
        <span className="text-2xs tabular-nums text-fg-muted">
          {ratio}:1 / {against}
        </span>
      )}
    </div>
  );
}

function Foundations(): JSX.Element {
  const [moved, setMoved] = useState(false);
  const [showToastBox, setShowToastBox] = useState(true);
  return (
    <>
      <Section id="colors" title="Renk" note="Kontrast oranları token değerlerinden ölçülür (WCAG 2.x). Metin tonları app (#0d0d0d) üzerinde.">
        <Row label="Yüzeyler">
          <div className="flex flex-wrap gap-3">
            {SURFACES.map((n) => (
              <Swatch key={n} name={n} />
            ))}
          </div>
        </Row>
        <Row label="Metin">
          <div className="flex flex-wrap gap-3">
            {TEXT.map((n) => (
              <Swatch key={n} name={n} against="app" />
            ))}
          </div>
        </Row>
        <Row label="Marka / durum">
          <div className="flex flex-wrap gap-3">
            {BRAND.map((n) => (
              <Swatch key={n} name={n} against="app" />
            ))}
          </div>
        </Row>
        <Row label="Saydamlar">
          <div className="flex flex-wrap gap-3">
            {WASHES.map((n) => (
              <Swatch key={n} name={n} />
            ))}
          </div>
        </Row>
      </Section>

      <Section id="type" title="Tipografi" note="Başlık Onest, gövde Inter — ikisi de OFL, paketli (latin + latin-ext).">
        <p className="font-display text-[56px] font-semibold leading-[1.1] tracking-[-0.2px] text-fg-display">Çayını al, gel.</p>
        <p className="font-display text-4xl font-medium leading-[1.1] text-fg-display">
          Akşam masası <span className="text-fg-faint">· 3 kişi</span>
        </p>
        <p className="font-display text-xl font-medium text-fg-display">Şifreni değiştir · İğdır · Ğ Ş İ ı ç ö ü</p>
        <p className="max-w-xl text-base leading-6 text-fg-muted">
          Gövde 16/24: Odada kim konuşuyorsa avatarının çevresinde mercan bir halka yanar; sessize alınan mikrofon pembe ikonla görünür.
        </p>
        <p className="text-sm font-medium tracking-[-0.28px] text-fg">UI 14 — Kanal ayarları, Davet bağlantısı, Ses düzeyi</p>
        <p className="text-label text-fg-faint">Etiket 13 — yardım ve doğrulama satırları</p>
        <p className="text-2xs tabular-nums text-fg-faint">Meta 11 — 21:04 · düzenlendi</p>
      </Section>

      <Section id="radius" title="Köşe ve hareket">
        <Row label="Radius">
          {(["sm", "md", "lg", "xl", "cta", "card", "panel", "pill"] as const).map((r) => (
            <div key={r} className="flex flex-col items-center gap-1.5">
              <div className="size-16 bg-raised" style={{ borderRadius: `var(--radius-${r})` }} />
              <span className="text-2xs text-fg-faint">{r}</span>
            </div>
          ))}
        </Row>
        <Row label="Yay (CSS)">
          <div className="relative h-10 w-72 rounded-pill bg-surface">
            <div
              data-testid="spring-box"
              className={cn(
                "absolute left-1 top-1 size-8 rounded-full bg-accent transition-transform motion-spring",
                moved ? "translate-x-[248px]" : "translate-x-0",
              )}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setMoved((m) => !m)}>
            Oynat
          </Button>
          <span className="text-label text-fg-faint">stiffness 500 · damping 60 · mass 1 → linear() 554ms</span>
        </Row>
        <Row label="Yay (m.*)">
          <div className="flex h-16 items-center">
            <AnimatePresence>
              {showToastBox && (
                <MotionToast key="t" className="rounded-xl surface-glass-strong px-4 py-2 text-sm text-fg">
                  MotionToast
                </MotionToast>
              )}
            </AnimatePresence>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowToastBox((s) => !s)}>
            Aç / kapat
          </Button>
        </Row>
      </Section>
    </>
  );
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */

const BUTTON_VARIANTS = ["primary", "secondary", "accent", "danger", "ghost"] as const;
type ButtonVariantName = (typeof BUTTON_VARIANTS)[number];

/** The tone a variant takes on hover / press, forced so both states can be reviewed side by side. */
const FORCED_STATE: Record<ButtonVariantName, { hover: string; pressed: string }> = {
  primary: { hover: "bg-inverse-hover", pressed: "bg-inverse-pressed" },
  secondary: { hover: "bg-raised-hover", pressed: "bg-raised-pressed" },
  accent: { hover: "bg-accent-hover", pressed: "bg-accent-pressed" },
  danger: { hover: "bg-danger/20", pressed: "bg-danger/28" },
  ghost: { hover: "bg-surface text-fg", pressed: "bg-app text-fg" },
};

function Buttons(): JSX.Element {
  const { t } = useAppTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Section id="buttons" title="Buton" note="5 tür × 3 boy. Hover yalnız ton (200ms); basılı daha koyu/açık ton; devre dışı %40; yükleniyor genişliği korur.">
      {(["lg", "md", "sm"] as const).map((size) => (
        <Row key={size} label={size}>
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant} size={size} data-variant={variant} data-size={size}>
              {variant === "danger" ? t("common:buttons.delete") : variant === "accent" ? t("desktop:invite.linkLabel") : t("common:buttons.save")}
            </Button>
          ))}
        </Row>
      ))}
      {(["hover", "pressed"] as const).map((state) => (
        <Row key={state} label={state === "hover" ? "hover" : "basılı"}>
          {BUTTON_VARIANTS.map((variant) => (
            <span key={variant} className={cn(buttonVariants({ variant, size: "md" }), FORCED_STATE[variant][state], "pointer-events-none")}>
              {t("common:buttons.save")}
            </span>
          ))}
        </Row>
      ))}
      <Row label="devre dışı">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} disabled>
            {t("common:buttons.save")}
          </Button>
        ))}
      </Row>
      <Row label="yükleniyor">
        <Button variant="primary" loading={busy} onClick={() => setBusy(true)}>
          {t("common:buttons.save")}
        </Button>
        <Button variant="accent" loading>
          {t("common:buttons.create")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setBusy(false)}>
          {t("common:buttons.cancel")}
        </Button>
      </Row>
    </Section>
  );
}

function IconButtons(): JSX.Element {
  const { t } = useAppTranslation();
  const [muted, setMuted] = useState(false);
  return (
    <Section id="icon-buttons" title="İkon butonu + ipucu" note="Etiket zorunlu: hem erişilebilir ad hem ipucu metni. Klavyeyle odaklanınca da ipucu açılır.">
      {(["sm", "md", "lg"] as const).map((size) => (
        <Row key={size} label={size}>
          <IconButton size={size} label={t("desktop:devices.camera")}>
            <Camera />
          </IconButton>
          <IconButton size={size} variant="ghost" label={t("common:a11y.moreActions")}>
            <MoreHorizontal />
          </IconButton>
          <IconButton size={size} active label={t("desktop:devices.input")}>
            <Settings />
          </IconButton>
          <IconButton size={size} variant="danger" label={t("desktop:voice.disconnect")}>
            <PhoneOff />
          </IconButton>
          <IconButton size={size} disabled label={t("desktop:devices.camera")}>
            <MonitorUp />
          </IconButton>
        </Row>
      ))}
      <Row label="araç çubuğu">
        <div data-kit="toolbar" className="flex items-center gap-0.5 rounded-lg bg-overlay p-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={t("desktop:devices.camera")}>
            <Camera className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("desktop:devices.input")}>
            <Settings className="size-4" />
          </Button>
          <IconButton size="sm" variant="ghost" label={t("common:a11y.moreActions")}>
            <MoreHorizontal />
          </IconButton>
        </div>
      </Row>
      <Row label="aç/kapa">
        <IconButton pressed={muted} variant={muted ? "danger" : "solid"} label={t("desktop:devices.input")} onClick={() => setMuted((m) => !m)}>
          {muted ? <MicOff /> : <Mic />}
        </IconButton>
        <span className="text-label text-fg-faint">aria-pressed={String(muted)}</span>
      </Row>
    </Section>
  );
}

/* ── Identity ────────────────────────────────────────────────────────────── */

const PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><radialGradient id="g" cx="35%" cy="30%"><stop offset="0" stop-color="#ffa48c"/><stop offset="1" stop-color="#5b2a1f"/></radialGradient></defs><rect width="80" height="80" fill="url(#g)"/><circle cx="40" cy="32" r="14" fill="#2b1510"/><rect x="18" y="50" width="44" height="30" rx="22" fill="#2b1510"/></svg>',
  );

const PEOPLE = [
  { id: "u-baran", name: "Baran Yıldız", src: PHOTO },
  { id: "u-ece", name: "Ece Kaya", src: null },
  { id: "u-kaan", name: "Kaan Demir", src: null },
  { id: "u-selin", name: "Selin Ak", src: null },
  { id: "u-mert", name: "Mert Can", src: null },
  { id: "u-deniz", name: "Deniz Şahin", src: null },
];

function Identity(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <Section id="avatars" title="Avatar" note="Her boyda 2px yüzey halkası; konuşan +2px mercan; durum noktası boyun %30'u (en az 10px).">
      <Row label="boylar">
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <UserAvatar key={size} name="Baran Yıldız" colorSeed="u-baran" src={PHOTO} size={size} />
        ))}
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <UserAvatar key={`i-${size}`} name="Ece Kaya" colorSeed="u-ece" src={null} size={size} />
        ))}
      </Row>
      <Row label="durum">
        {(["online", "idle", "dnd", "offline"] as const).map((status) => (
          <UserAvatar key={status} name="Kaan Demir" colorSeed="u-kaan" src={null} size="md" presence={status} />
        ))}
        <UserAvatar name="Selin Ak" colorSeed="u-selin" src={null} size="md" presence="online" presencePlatform="mobile" />
        <UserAvatar name="Baran Yıldız" colorSeed="u-baran" src={PHOTO} size="lg" presence="dnd" />
      </Row>
      <Row label="konuşuyor">
        <UserAvatar name="Baran Yıldız" colorSeed="u-baran" src={PHOTO} size="md" speaking />
        <UserAvatar name="Ece Kaya" colorSeed="u-ece" src={null} size="lg" speaking presence="online" />
      </Row>
      <Row label="küme">
        <AvatarGroup members={PEOPLE.slice(0, 3)} size="sm" label="Baran, Ece, Kaan" />
        <AvatarGroup members={PEOPLE} size="md" max={4} label="Baran, Ece, Kaan, Selin +2" />
      </Row>
      <Row label="rozetler">
        <Badge>{t("desktop:members.ownerBadge")}</Badge>
        <Badge variant="accent">{t("desktop:voice.statusConnected")}</Badge>
        <Badge variant="success">{t("desktop:members.online")}</Badge>
        <Badge variant="warning">{t("desktop:members.idle")}</Badge>
        <Badge variant="danger">{t("desktop:voice.statusError")}</Badge>
        <span className="rounded-lg bg-[linear-gradient(135deg,#3a2a24,#14100e)] p-2">
          <Badge variant="veil">● {t("desktop:voice.statusConnected")}</Badge>
        </span>
        <CountBadge count={3} label="3" />
        <CountBadge count={128} label="128" />
        <CountBadge count={7} tone="muted" label="7" />
      </Row>
      <Row label="çipler">
        <span className="text-sm text-fg">
          Akşam <Chip variant="mention">@Ece</Chip> geliyor musun?
        </span>
        <Chip variant="role" dotColor="#3498db">Moderatör</Chip>
        <Chip variant="role" dotColor="#e91e63">Kurucu</Chip>
        <Chip>Filtre</Chip>
        <ReactionChip emoji="😂" count={3} mine label="😂 3" />
        <ReactionChip emoji="🔥" count={1} mine={false} label="🔥 1" />
      </Row>
      <Row label="kısayol">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
        <Kbd>Esc</Kbd>
      </Row>
    </Section>
  );
}

/* ── Forms ───────────────────────────────────────────────────────────────── */

function Forms(): JSX.Element {
  const { t } = useAppTranslation();
  const [name, setName] = useState("");
  const [noise, setNoise] = useState(true);
  const [mode, setMode] = useState("voice");
  const [volume, setVolume] = useState(80);
  const [device, setDevice] = useState<string | undefined>(undefined);
  const nameError = name.length > 0 && name.length < 3 ? t("common:validation.tooShort", { min: 3 }) : undefined;
  const deviceOptions = useMemo(
    () => [
      { value: "default", label: t("desktop:devices.systemDefault") },
      { value: "comms", label: t("desktop:devices.communications") },
      { value: "mic1", label: t("desktop:devices.microphoneN", { number: 1 }), description: "USB" },
      { value: "mic2", label: t("desktop:devices.microphoneN", { number: 2 }), disabled: true },
    ],
    [t],
  );
  return (
    <Section id="forms" title="Form" note="Kenarsız alan; odakta raised ton + mercan imleç. Hata = alanın zemini pembe yıkama + altta 13px mesaj; çerçeve/ikon yok.">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Field label={t("desktop:invite.codeLabel")} help={t("desktop:invite.description")}>
          <Input placeholder="demli-akşam" />
        </Field>
        <Field label={t("desktop:invite.linkLabel")} error={nameError ?? t("common:validation.invalidUrl")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="https://" />
        </Field>
        <Field label={t("desktop:invite.codeLabel")}>
          <Input disabled value="demli-akşam" readOnly />
        </Field>
        <Field label={t("desktop:devices.input")} help={t("desktop:devices.note")}>
          <Select placeholder={t("desktop:devices.systemDefault")} options={deviceOptions} value={device} onValueChange={setDevice} />
        </Field>
        <Field label={t("desktop:devices.output")} error={t("common:validation.invalidOption")}>
          <Select placeholder={t("desktop:devices.systemDefault")} options={deviceOptions} />
        </Field>
        <Field label={t("desktop:devices.camera")}>
          <Select placeholder={t("desktop:devices.systemDefault")} options={deviceOptions} disabled />
        </Field>
        <Field label={t("desktop:customStatus.textLabel")} className="md:col-span-2">
          <Textarea rows={3} placeholder={t("desktop:customStatus.textPlaceholder")} />
        </Field>
      </div>

      <Row label="anahtar">
        <Switch checked={noise} onCheckedChange={setNoise} aria-label={t("desktop:sound.effects")} />
        <Switch defaultChecked={false} aria-label={t("desktop:sound.messageNotif")} />
        <Switch disabled checked aria-label={t("desktop:sound.effects")} />
        <Switch disabled aria-label={t("desktop:sound.effects")} />
      </Row>
      <Row label="onay kutusu">
        <Checkbox label={t("desktop:sound.effects")} description={t("desktop:sound.effectsDesc")} defaultChecked />
        <Checkbox label={t("desktop:sound.messageNotif")} />
        <Checkbox label={t("desktop:members.online")} checked="indeterminate" />
        <Checkbox label={t("desktop:members.offline")} disabled />
      </Row>
      <div className="max-w-md">
        <RadioGroup aria-label={t("desktop:micSettings.inputModeHeading")} value={mode} onValueChange={setMode}>
          <RadioItem value="ptt" label={t("desktop:micSettings.inputPushToTalk")} description={t("desktop:micSettings.inputPushToTalkDesc")} />
          <RadioItem value="voice" label={t("desktop:micSettings.inputVoiceActivity")} description={t("desktop:micSettings.inputVoiceActivityDesc")} />
          <RadioItem value="open" label={t("desktop:micSettings.inputOpenMic")} description={t("desktop:micSettings.inputOpenMicDesc")} disabled />
        </RadioGroup>
      </div>
      <Row label="sürgü">
        <div className="w-80">
          <Slider aria-label={t("desktop:sound.volume")} value={volume} onValueChange={setVolume} showValue formatValue={(v) => `%${v}`} />
        </div>
        <div className="w-80">
          <Slider aria-label={t("desktop:sound.volume")} defaultValue={40} disabled showValue formatValue={(v) => `%${v}`} />
        </div>
      </Row>
    </Section>
  );
}

/* ── Overlays ────────────────────────────────────────────────────────────── */

function Overlays(): JSX.Element {
  const { t } = useAppTranslation();
  const [quality, setQuality] = useState("auto");
  const [hideMuted, setHideMuted] = useState(false);
  const fire = (variant: ToastVariant): void => {
    const copy: Record<ToastVariant, string> = {
      neutral: t("desktop:invite.copied"),
      success: t("desktop:voice.statusConnected"),
      accent: t("desktop:voice.sessionReplaced"),
      danger: t("desktop:voice.statusError"),
    };
    toast({
      title: copy[variant],
      variant,
      action: variant === "danger" ? { label: t("common:buttons.retry"), onClick: () => undefined } : undefined,
    });
  };
  return (
    <Section id="overlays" title="Menü, kiplik, çekmece, bildirim" note="Menüler cam (%92 + blur), satır hover'ı raised ton; tehlike satırı pembe yıkama. Kiplik: scrim + blur(4), kart radius 24.">
      <Row label="menü">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" data-testid="menu-trigger">
              <MoreHorizontal className="size-4" />
              {t("common:a11y.moreActions")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("desktop:members.membersNav")}</DropdownMenuLabel>
            <DropdownMenuItem>
              <UserPlus className="size-4" />
              {t("desktop:invite.linkLabel")}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Bell className="size-4" />
              {t("desktop:sound.messageNotif")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={quality} onValueChange={setQuality}>
              <DropdownMenuRadioItem value="auto">{t("desktop:devices.systemDefault")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="comms">{t("desktop:devices.communications")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger>
              <Trash2 className="size-4" />
              {t("common:buttons.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex h-10 items-center rounded-lg bg-surface px-4 text-label text-fg-muted">Sağ tıkla → bağlam menüsü</div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{t("desktop:members.membersNav")}</ContextMenuLabel>
            <ContextMenuItem>{t("common:buttons.copy")}</ContextMenuItem>
            <ContextMenuCheckboxItem checked={hideMuted} onCheckedChange={setHideMuted}>
              {t("desktop:sound.messageNotif")}
            </ContextMenuCheckboxItem>
            <ContextMenuSeparator />
            <ContextMenuItem danger>{t("common:buttons.remove")}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Row>
      <Row label="kiplik">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">{t("common:buttons.leave")}</Button>
          </DialogTrigger>
          <DialogContent closeLabel={t("common:buttons.close")} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("common:buttons.leave")}</DialogTitle>
              <DialogDescription>{t("desktop:voice.endedAlone")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost">{t("common:buttons.cancel")}</Button>
              <Button variant="danger">{t("common:buttons.leave")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">{t("desktop:invite.codeLabel")}</Button>
          </DialogTrigger>
          <DialogContent closeLabel={t("common:buttons.close")}>
            <DialogHeader>
              <DialogTitle>{t("desktop:invite.title", { group: "Akşam masası" })}</DialogTitle>
              <DialogDescription>{t("desktop:invite.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <Field label={t("desktop:invite.linkLabel")}>
                <Input readOnly value="https://app.getdemli.com/invite/aksam" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost">{t("common:buttons.cancel")}</Button>
              <Button variant="accent">{t("common:buttons.copy")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>
      <Row label="çekmece">
        {(["right", "left", "bottom"] as const).map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild>
              <Button variant="secondary">{side}</Button>
            </SheetTrigger>
            <SheetContent side={side} closeLabel={t("common:buttons.close")}>
              <SheetHeader>
                <SheetTitle>{t("desktop:members.membersNav")}</SheetTitle>
                <SheetDescription>{t("desktop:members.headerCount", { count: 6 })}</SheetDescription>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-1">
                {PEOPLE.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface">
                    <UserAvatar name={p.name} colorSeed={p.id} src={p.src} size="sm" presence={i < 3 ? "online" : "offline"} />
                    <span className={cn("text-sm", i < 3 ? "text-fg" : "text-fg-faint")}>{p.name}</span>
                  </div>
                ))}
              </SheetBody>
            </SheetContent>
          </Sheet>
        ))}
      </Row>
      <Row label="bildirim">
        {(["neutral", "success", "accent", "danger"] as const).map((variant) => (
          <Button key={variant} variant="secondary" size="sm" data-toast={variant} onClick={() => fire(variant)}>
            {variant}
          </Button>
        ))}
      </Row>
      <Row label="iskelet">
        <div role="status" aria-label={t("desktop:voice.statusJoining")} className="flex w-80 items-center gap-3">
          <Skeleton shape="circle" width={40} />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton shape="line" width="60%" />
            <Skeleton shape="line" />
          </div>
        </div>
        <Skeleton shape="rect" width={160} height={90} />
      </Row>
      <Row label="iskelet · popover tonunda">
        <div
          data-kit="skeleton-on-surface"
          role="status"
          aria-label={t("desktop:voice.statusJoining")}
          className="flex w-80 items-center gap-3 rounded-xl bg-surface p-4"
        >
          <Skeleton shape="circle" width={48} />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton shape="line" height={18} className="w-36" />
            <Skeleton shape="line" className="w-24" />
          </div>
        </div>
      </Row>
    </Section>
  );
}

/* ── Product screens on the new tokens ───────────────────────────────────── */

const NAMES = ["Ali", "Burak", "Mert", "Can", "Deniz", "Ece"];

function seedStage(speaking: number[]): void {
  const users: Record<string, User> = {};
  NAMES.forEach((n, i) => {
    users[`user-${i}`] = {
      id: `user-${i}` as UserId,
      username: n.toLowerCase(),
      displayName: n,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  });
  useChatStore.setState({ users: users as Record<UserId, User> });
  useAuthStore.setState({ user: users["user-0"] as User, status: "authenticated", token: "harness" });
  useVoiceStore.setState({
    status: "connected",
    roomId: "harness-room",
    roomLabel: { channelName: "akşam odası", groupName: "Demli" },
    micEnabled: true,
    participants: NAMES.map(
      (_, i): VoiceParticipant => ({
        userId: `user-${i}` as UserId,
        identity: `user-${i}`,
        micEnabled: i !== 3,
        speaking: speaking.includes(i),
        screenSharing: false,
        cameraEnabled: false,
        volume: 1,
        deafened: false,
        isLocal: i === 0,
      }),
    ),
  });
  useVideoStageStore.setState({ focusedKey: null });
}

function StageView(): JSX.Element {
  const [speaking, setSpeaking] = useState<number[]>([1]);
  useEffect(() => seedStage(speaking), [speaking]);
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        {NAMES.map((n, i) => (
          <Button
            key={n}
            size="sm"
            variant={speaking.includes(i) ? "accent" : "secondary"}
            onClick={() => setSpeaking((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))}
          >
            {n}
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 bg-app">
        <VideoStage />
      </div>
    </div>
  );
}

function AuthView(): JSX.Element {
  useEffect(() => {
    useAuthStore.setState({ user: null, status: "unauthenticated", token: null });
  }, []);
  return (
    <div className="relative h-[calc(100vh-3.5rem)] overflow-hidden">
      <AuthScreen />
    </div>
  );
}

/* ── Shell ───────────────────────────────────────────────────────────────── */

function Kit(): JSX.Element {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-2 p-2">
      <Foundations />
      <Buttons />
      <IconButtons />
      <Identity />
      <Forms />
      <Overlays />
    </div>
  );
}

function Harness(): JSX.Element {
  const { t } = useAppTranslation();
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
        <span className="font-display text-base font-semibold text-fg-display">Koyu Masa</span>
        <span className="hidden text-label text-fg-faint md:inline">UI kit · yalnız geliştirme</span>
        <div className="ml-auto flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Görünüm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
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
      {view === "kit" && <Kit />}
      {view === "auth" && <AuthView />}
      {view === "stage" && <StageView />}
      <Toaster label={t("common:a11y.notifications")} dismissLabel={t("common:buttons.close")} />
    </div>
  );
}

function Root(): JSX.Element | null {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  const queryClient = useMemo(() => new QueryClient(), []);
  useEffect(() => {
    void createDesktopI18n().then(setI18n);
  }, []);
  if (!i18n) return null;
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
