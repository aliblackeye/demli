import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import demliLogo from "../assets/demli-logo.svg";
import { Button, Field, Input, cn } from "@demli/ui";
import { FormErrorAlert, transitions, viewFade } from "@demli/app-ui";
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
import { authScreenRootClass, AUTH_GLOW } from "./authScreenLayout";

type Mode = "login" | "register";

/** A validation failure, as a desktop:auth.errors.* key (translated at render). */
type AuthErrorKey =
  | "auth.errors.usernamePattern"
  | "auth.errors.passwordTooShort"
  | "auth.errors.passwordRequired"
  | "auth.errors.birthdateRequired"
  | "auth.errors.birthdateInvalid";

/** The field a validation failure belongs to — its message renders UNDER that field. */
type AuthField = "username" | "password" | "birthdate";

const FIELD_OF: Record<AuthErrorKey, AuthField> = {
  "auth.errors.usernamePattern": "username",
  "auth.errors.passwordTooShort": "password",
  "auth.errors.passwordRequired": "password",
  "auth.errors.birthdateRequired": "birthdate",
  "auth.errors.birthdateInvalid": "birthdate",
};

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

/**
 * The register-only fields slide open under the username instead of popping in:
 * height + opacity on the standard step, the same reveal the rail's folders use.
 * `overflow-hidden` only while it moves, so a focus ring is never clipped at rest.
 */
function Reveal({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <m.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1, transition: transitions.standard }}
      exit={{ height: 0, opacity: 0, transition: transitions.fast }}
      className="overflow-hidden"
    >
      {/* The gap lives INSIDE the animated box so the collapse closes it too. */}
      <div className="pt-4">{children}</div>
    </m.div>
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

/**
 * Login/register gate — the session gate (primary) or the add-account overlay.
 *
 * Koyu Masa first impression: the black page with ONE coral light above the
 * card (the landing's "dem" glow, the same light the boot splash ends on, so
 * boot → sign-in is one continuous surface), the mark, a display-face heading,
 * and the form on a borderless radius-24 card. Validation follows the system
 * recipe: a field's problem is written UNDER that field and the field takes the
 * danger wash; only a refusal from the server (wrong password, network) is a
 * form-level band.
 */
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
  /** A field-scoped validation failure (rendered under its field). */
  const [fieldError, setFieldError] = useState<AuthErrorKey | null>(null);
  /** A form-level failure from the server (rendered as the band above the fields). */
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Bumped by every submit that fails validation: after that render (the field
   * now carries aria-invalid + its error as the description) focus moves to the
   * first invalid control, so the screen reader reads the error and the user is
   * already where the fix goes — the submit never appears to "do nothing".
   */
  const [invalidSubmit, setInvalidSubmit] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (invalidSubmit === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidSubmit]);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setFieldError(null);
  };

  /** Editing the field that was wrong clears its message; the others stay put. */
  const clearFieldError = (field: AuthField): void => {
    if (fieldError && FIELD_OF[fieldError] === field) setFieldError(null);
  };

  const errorFor = (field: AuthField): string | undefined =>
    fieldError && FIELD_OF[fieldError] === field ? t(`desktop:${fieldError}`) : undefined;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (submitting) return;
    const trimmedUsername = username.trim();
    const validationError = validate(mode, trimmedUsername, password, birthdate);
    if (validationError) {
      setError(null);
      setFieldError(validationError);
      setInvalidSubmit((n) => n + 1);
      return;
    }
    setFieldError(null);
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
    <div className={authScreenRootClass(variant)} style={{ backgroundImage: AUTH_GLOW }}>
      <div className="w-[400px] max-w-[calc(100vw-2rem)] py-8">
        {isAdd && (
          <Button variant="ghost" size="sm" onClick={cancelAddAccount} className="-ml-2 mb-4">
            <ArrowLeft aria-hidden className="size-3.5" />
            {t("desktop:accounts.addCancel")}
          </Button>
        )}
        <div className="mb-7 flex flex-col items-center gap-4">
          {/* Transparent-background Demli mark: the plate's own rounded corners
              are the rounding, so no overflow/scale crop hack is needed. */}
          <img src={demliLogo} alt="Demli" className="size-14" draggable={false} />
          {/* Heading + subtitle cross-fade when the mode flips, so the change of
              task is felt, not just read (opacity only — nothing shifts). */}
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={isAdd ? "add" : mode}
              variants={viewFade}
              initial="initial"
              animate="animate"
              exit="exit"
              className="text-center"
            >
              <h1 className="font-display text-[28px] font-semibold leading-[1.1] tracking-[-0.01em] text-fg-display">
                {heading}
              </h1>
              <p className="mt-2 text-sm text-fg-muted">{subtitle}</p>
            </m.div>
          </AnimatePresence>
        </div>

        <form ref={formRef} onSubmit={onSubmit} noValidate className="rounded-card bg-app p-6">
          {!isAdd && notice && !error && (
            <FormErrorAlert tone="warning" className="mb-5">
              {t(notice)}
            </FormErrorAlert>
          )}
          {isReauth && !error && (
            <FormErrorAlert tone="accent" className="mb-5">
              {t("desktop:accounts.reauthNotice", { username: reauthUsername ?? "" })}
            </FormErrorAlert>
          )}
          {error && <FormErrorAlert className="mb-5">{error}</FormErrorAlert>}

          <Field label={t("desktop:auth.usernameLabel")} error={errorFor("username")} announceError>
            <Input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                clearFieldError("username");
              }}
              autoComplete="username"
              autoFocus={!isReauth}
              spellCheck={false}
              placeholder={t("desktop:auth.usernamePlaceholder")}
            />
          </Field>

          <AnimatePresence initial={false}>
            {mode === "register" && (
              <Reveal key="register-fields">
                <div className="space-y-4">
                  <Field label={t("desktop:auth.displayNameLabel")}>
                    <Input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      autoComplete="nickname"
                      maxLength={64}
                      placeholder={t("desktop:auth.displayNamePlaceholder")}
                    />
                  </Field>
                  <Field
                    label={t("desktop:auth.birthdateLabel")}
                    help={t("desktop:auth.birthdateHint")}
                    error={errorFor("birthdate")}
                    announceError
                  >
                    <Input
                      type="date"
                      value={birthdate}
                      onChange={(event) => {
                        setBirthdate(event.target.value);
                        clearFieldError("birthdate");
                      }}
                      max={todayISODate()}
                      autoComplete="bday"
                    />
                  </Field>
                </div>
              </Reveal>
            )}
          </AnimatePresence>

          <Field
            label={t("desktop:auth.passwordLabel")}
            error={errorFor("password")}
            announceError
            className="mt-4"
          >
            {/*
              Reveal toggle. Typing a password blind is where most sign-in
              failures actually come from — a stuck Caps Lock or a keyboard
              layout you cannot see, on a field that then says only "wrong
              password". The eye costs one control and removes a whole class of
              self-inflicted lockout. (The Field wires label/aria to the INPUT,
              so the wrapper below forwards those props to it.)
            */}
            <PasswordInput
              visible={passwordVisible}
              onToggle={() => setPasswordVisible((v) => !v)}
              showLabel={t("desktop:auth.showPassword")}
              hideLabel={t("desktop:auth.hidePassword")}
              value={password}
              onChange={(value) => {
                setPassword(value);
                clearFieldError("password");
              }}
              autoFocus={isReauth}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={
                mode === "register"
                  ? t("desktop:auth.passwordPlaceholderRegister")
                  : t("desktop:auth.passwordPlaceholderLogin")
              }
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            className="mt-6 w-full"
          >
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
                <span className="text-label text-fg-faint">{t("desktop:auth.orDivider")}</span>
                <span className="h-px flex-1 bg-stroke" />
              </div>

              <Button type="button" variant="secondary" size="lg" onClick={onGoogle} className="w-full">
                <GoogleIcon />
                {t("desktop:auth.continueWithGoogle")}
              </Button>
            </>
          )}

          <p className="mt-5 text-center text-label text-fg-muted">
            {mode === "login"
              ? t("desktop:auth.newToDemli")
              : t("desktop:auth.alreadyHaveAccount")}{" "}
            <button
              type="button"
              onClick={() => switchMode(mode === "login" ? "register" : "login")}
              className={cn(
                "cursor-pointer rounded-sm font-medium text-accent transition-colors motion-hover hover:text-accent-hover",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
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

/**
 * The password input + its reveal eye. A component of its own because `Field`
 * clones its ONE child to wire `id` / `aria-describedby` / `aria-invalid`: those
 * props arrive here and are forwarded to the real `<input>`, so the label and
 * the error line stay attached to the field, not to the wrapper.
 */
function PasswordInput({
  visible,
  onToggle,
  showLabel,
  hideLabel,
  value,
  onChange,
  autoFocus,
  autoComplete,
  placeholder,
  ...wired
}: {
  visible: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus: boolean;
  autoComplete: string;
  placeholder: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-errormessage"?: string;
}): JSX.Element {
  return (
    <div className="relative">
      <Input
        {...wired}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="pr-11"
      />
      <button
        type="button"
        onClick={onToggle}
        // Not a form control: tab order should run label → field → submit, and
        // a keyboard user has no use for a visual reveal.
        tabIndex={-1}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        className={cn(
          "absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-sm",
          "text-fg-faint transition-colors motion-hover hover:bg-wash hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        )}
      >
        {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
