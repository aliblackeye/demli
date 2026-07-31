import { useState, type FormEvent } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import demliLogo from "../assets/demli-logo.svg";
import { Button, Input, cn } from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useAccountsStore } from "../stores/accounts-store";
import {
  cancelAddAccount,
  loginAndAddAccount,
  registerAndAddAccount,
} from "../lib/account-manager";
import { AuthUpdateFooter } from "./UpdateSettings";
import { DownloadPrompt } from "./DownloadPrompt";
import { authScreenRootClass } from "./authScreenLayout";

type Mode = "login" | "register";

/** A validation failure, as a desktop:auth.errors.* key (translated at render). */
type AuthErrorKey =
  | "auth.errors.usernamePattern"
  | "auth.errors.passwordTooShort"
  | "auth.errors.passwordRequired"
  | "auth.errors.birthdateRequired"
  | "auth.errors.birthdateInvalid";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * Google sign-in is a placeholder until the OAuth flow is wired (founder: "google
 * ile giriş yapı koyalım ama şuan aktif çalışmasın"). Flipping
 * `VITE_GOOGLE_AUTH_ENABLED=true` un-greys the button; the actual OAuth start is
 * still a TODO, so even then it does not authenticate yet.
 */
const GOOGLE_AUTH_ENABLED = import.meta.env.VITE_GOOGLE_AUTH_ENABLED === "true";

/** Today as `YYYY-MM-DD` — the max selectable birthdate (no future dates). */
function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function validate(
  mode: Mode,
  username: string,
  password: string,
  birthdate: string,
): AuthErrorKey | null {
  if (!USERNAME_PATTERN.test(username)) {
    return "auth.errors.usernamePattern";
  }
  if (mode === "register" && password.length < 8) {
    return "auth.errors.passwordTooShort";
  }
  if (mode === "login" && password.length === 0) {
    return "auth.errors.passwordRequired";
  }
  if (mode === "register") {
    if (birthdate.length === 0) {
      return "auth.errors.birthdateRequired";
    }
    // `<input type="date">` already yields YYYY-MM-DD; guard against a manually
    // typed / future / nonsensical value before it reaches the API.
    const parsed = new Date(birthdate);
    if (Number.isNaN(parsed.getTime()) || birthdate > todayISODate() || parsed.getUTCFullYear() < 1900) {
      return "auth.errors.birthdateInvalid";
    }
  }
  return null;
}

/** Inline 4-colour Google "G" (self-hosted SVG — CSP blocks remote assets). */
function GoogleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="size-4 shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-semibold uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

interface AuthScreenProps {
  /**
   * "primary" (default) — the full-screen sign-in gate shown when there is no
   * session. "add" — the SAME form shown as an overlay for the multi-account
   * "add account" flow (ADR 0013): it keeps the current session live and calls
   * the account-manager add helpers instead of the auth-store login/register.
   */
  variant?: "primary" | "add";
}

/** Login/register gate — the session gate (primary) or the add-account overlay. */
export function AuthScreen({ variant = "primary" }: AuthScreenProps): JSX.Element {
  const { t } = useAppTranslation();
  const isAdd = variant === "add";
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const notice = useAuthStore((s) => s.notice);
  // Re-auth (#100): the add overlay was opened for a stored account whose session
  // died — prefill its handle and focus the password. Read once at mount (the
  // overlay remounts each time it opens, so the initial value is always current).
  const reauthUsername = useAccountsStore((s) => s.reauthUsername);
  const isReauth = isAdd && reauthUsername !== null;

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState(isReauth ? reauthUsername : "");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (submitting) return;
    const trimmedUsername = username.trim();
    const validationError = validate(mode, trimmedUsername, password, birthdate);
    if (validationError) {
      setError(t(`desktop:${validationError}`));
      return;
    }
    setError(null);
    setSubmitting(true);
    const displayNameArg = displayName.trim() || undefined;
    const birthdateArg = mode === "register" ? birthdate : undefined;
    const action = isAdd
      ? mode === "login"
        ? loginAndAddAccount(trimmedUsername, password)
        : registerAndAddAccount(trimmedUsername, password, displayNameArg, birthdateArg)
      : mode === "login"
        ? login(trimmedUsername, password)
        : register(trimmedUsername, password, displayNameArg, birthdateArg);
    action
      .catch((err: unknown) => setError(localizeError(err, t)))
      .finally(() => setSubmitting(false));
  };

  const onGoogle = (): void => {
    // TODO(oauth): start the Google OAuth flow. Only reachable when
    // VITE_GOOGLE_AUTH_ENABLED is on, which must not happen before this lands.
  };

  const heading = isAdd
    ? t("desktop:accounts.addHeading")
    : mode === "login"
      ? t("desktop:auth.welcomeBack")
      : t("desktop:auth.createAccountHeading");
  const subtitle = isAdd
    ? t("desktop:accounts.addSubtitle")
    : mode === "login"
      ? t("desktop:auth.signInSubtitle")
      : t("desktop:auth.registerSubtitle");

  return (
    // The "add account" variant renders as a covering overlay over the running
    // app (fixed inset-0), NOT an in-flow block — see authScreenRootClass (that
    // in-flow bug was the P0 where "Hesap ekle" appeared to do nothing).
    <div className={authScreenRootClass(variant)}>
      <div className="w-[400px] max-w-[calc(100vw-2rem)]">
        {isAdd && (
          <button
            type="button"
            onClick={cancelAddAccount}
            className={cn(
              "mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg",
              "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <ArrowLeft className="size-3.5" />
            {t("desktop:accounts.addCancel")}
          </button>
        )}
        <div className="mb-6 flex flex-col items-center gap-3">
          {/* Transparent-background Demli mark: the plate's own rounded corners
              are the rounding, so no overflow/scale crop hack is needed. */}
          <img src={demliLogo} alt="Demli" className="size-14 drop-shadow-lg" />
          <div className="text-center">
            <h1 className="text-lg font-semibold text-fg">{heading}</h1>
            <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-stroke bg-surface p-5 shadow-2xl"
        >
          {!isAdd && notice && !error && (
            <p role="status" className="mb-4 rounded-md bg-idle/10 px-3 py-2 text-xs text-idle">
              {t(notice)}
            </p>
          )}
          {isReauth && !error && (
            <p role="status" className="mb-4 rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">
              {t("desktop:accounts.reauthNotice", { username: reauthUsername ?? "" })}
            </p>
          )}
          {error && <FormErrorAlert className="mb-4">{error}</FormErrorAlert>}

          <div className="space-y-4">
            <Field label={t("desktop:auth.usernameLabel")}>
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus={!isReauth}
                spellCheck={false}
                placeholder={t("desktop:auth.usernamePlaceholder")}
              />
            </Field>
            {mode === "register" && (
              <Field label={t("desktop:auth.displayNameLabel")}>
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="nickname"
                  maxLength={64}
                  placeholder={t("desktop:auth.displayNamePlaceholder")}
                />
              </Field>
            )}
            {mode === "register" && (
              <Field label={t("desktop:auth.birthdateLabel")}>
                <Input
                  type="date"
                  value={birthdate}
                  onChange={(event) => setBirthdate(event.target.value)}
                  max={todayISODate()}
                  autoComplete="bday"
                  aria-label={t("desktop:auth.birthdateLabel")}
                />
                <span className="mt-1 block text-2xs text-fg-faint">
                  {t("desktop:auth.birthdateHint")}
                </span>
              </Field>
            )}
            <Field label={t("desktop:auth.passwordLabel")}>
              {/*
                Reveal toggle. Typing a password blind is where most sign-in
                failures actually come from — a stuck Caps Lock or a keyboard
                layout you cannot see, on a field that then says only "wrong
                password". The eye costs one control and removes a whole class of
                self-inflicted lockout.
              */}
              <div className="relative">
                <Input
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus={isReauth}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  placeholder={
                    mode === "register"
                      ? t("desktop:auth.passwordPlaceholderRegister")
                      : t("desktop:auth.passwordPlaceholderLogin")
                  }
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setPasswordVisible((v) => !v)}
                  // Not a form control: tab order should run label → field →
                  // submit, and a keyboard user has no use for a visual reveal.
                  tabIndex={-1}
                  aria-label={
                    passwordVisible
                      ? t("desktop:auth.hidePassword")
                      : t("desktop:auth.showPassword")
                  }
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1.5",
                    "text-fg-faint transition-colors hover:text-fg",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  )}
                >
                  {passwordVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
          </div>

          <Button type="submit" disabled={submitting} className="mt-5 w-full">
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {mode === "login" ? t("desktop:auth.signIn") : t("desktop:auth.createAccount")}
          </Button>

          {/*
            Google sign-in renders ONLY when it works. It used to render greyed
            out with a "coming soon" hint on tap, which is a dead control: it
            occupies the spot a user reaches for, and the reward for reaching is
            an apology. Better to have one working way in than two, one of which
            lies (CLAUDE.md §35).

            `VITE_GOOGLE_AUTH_ENABLED=true` brings it back, and the whole block —
            divider included — comes with it. The backend half already exists
            (`POST /auth/google`, 501 while GOOGLE_CLIENT_ID is unset); what is
            missing is the client flow that fetches an ID token, so turning the
            flag on before that lands would just move the dead end one click in.
          */}
          {GOOGLE_AUTH_ENABLED && (
            <>
              <div className="my-4 flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-stroke" />
                <span className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                  {t("desktop:auth.orDivider")}
                </span>
                <span className="h-px flex-1 bg-stroke" />
              </div>

              <button
                type="button"
                onClick={onGoogle}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-md border border-stroke-strong px-4 py-2.5 text-sm font-medium",
                  "text-fg transition-colors motion-instant hover:bg-raised",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                )}
              >
                <GoogleIcon />
                {t("desktop:auth.continueWithGoogle")}
              </button>
            </>
          )}

          <p className="mt-4 text-center text-xs text-fg-muted">
            {mode === "login"
              ? t("desktop:auth.newToDemli")
              : t("desktop:auth.alreadyHaveAccount")}{" "}
            <button
              type="button"
              onClick={() => switchMode(mode === "login" ? "register" : "login")}
              className={cn(
                "cursor-pointer font-medium text-accent hover:underline",
                "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              )}
            >
              {mode === "login" ? t("desktop:auth.switchToRegister") : t("desktop:auth.switchToLogin")}
            </button>
          </p>
        </form>

        {/* Updates must be reachable without signing in: version + manual
            check; an available update surfaces via the global banner. Hidden in
            the add-account overlay (the app is already running/updated). */}
        {!isAdd && <AuthUpdateFooter />}
        {/* WEB ONLY: a slim "get the native app" line (renders nothing on the
            Electron desktop / native mobile builds, or on iOS). Hidden in the
            add-account overlay. */}
        {!isAdd && <DownloadPrompt variant="footer" />}
      </div>
    </div>
  );
}
