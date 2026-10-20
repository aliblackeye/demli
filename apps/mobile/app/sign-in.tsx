import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { Text } from "@/components/ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { BrandMark } from "@/components/BrandMark";
import { TextField } from "@/components/TextField";
import { BirthdateField } from "@/components/auth/BirthdateField";
import { GoogleButton } from "@/components/auth/GoogleButton";
import {
  FIELD_OF,
  validateAuthForm,
  type AuthField,
  type AuthMode,
  type AuthValidationCode,
} from "@/components/auth/sign-in-validation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Glow } from "@/components/ui/Glow";
import { Touchable } from "@/components/ui/Touchable";
import { localizeError } from "@/lib/errors";
import { frozenAccountInfo } from "@/lib/frozen-account";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useAuthStore } from "@/stores/auth-store";
import { colors, motion, radius, space, typography } from "@/theme/theme";

/** Localized copy per validation outcome (the strictly-typed `t` checks each key). */
const VALIDATION_KEY = {
  username: "mobile:auth.validationUsername",
  passwordShort: "mobile:auth.validationPasswordShort",
  passwordRequired: "mobile:auth.validationPasswordRequired",
  birthdate: "mobile:auth.validationBirthdate",
} as const satisfies Record<AuthValidationCode, string>;

/** Fields entering/leaving with the register mode, and the reflow around them. */
const REVEAL_IN = FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System);
const REVEAL_OUT = FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System);
const REFLOW = LinearTransition.duration(motion.duration.standard).reduceMotion(ReduceMotion.System);

/**
 * Login/register gate — the mobile mirror of the desktop AuthScreen.
 *
 * Koyu Masa first impression: the black page with ONE coral light behind the
 * mark (the same light the boot splash ends on, so boot → sign-in is one
 * continuous surface), a display-face greeting, and the form on a borderless
 * radius-24 card of the base tone. Validation follows the system recipe: a
 * field's problem is written UNDER that field and the field takes the danger
 * wash; only a refusal from the server (wrong password, network, a frozen
 * account) is a form-level band above the fields. Switching to "create
 * account" cross-fades the greeting and reveals the extra fields in place.
 */
export default function SignIn() {
  const { t, i18n } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const notice = useAuthStore((s) => s.notice);
  const status = useAuthStore((s) => s.status);

  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [birthdate, setBirthdate] = useState<string | null>(null);
  /** A field-scoped validation failure (rendered under its field). */
  const [fieldError, setFieldError] = useState<AuthValidationCode | null>(null);
  /** A form-level failure from the server (rendered as the band above the fields). */
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Frozen (soft-deleted) account caught on login — offers reactivation (M15).
  const [frozenPurgeAt, setFrozenPurgeAt] = useState<string | null | undefined>(undefined);
  const isFrozen = frozenPurgeAt !== undefined;

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setFieldError(null);
    setFrozenPurgeAt(undefined);
  };

  const errorFor = (field: AuthField): string | null =>
    fieldError && FIELD_OF[fieldError] === field ? t(VALIDATION_KEY[fieldError]) : null;

  const clearFieldError = (field: AuthField) => {
    if (fieldError && FIELD_OF[fieldError] === field) setFieldError(null);
  };

  const purgeDate = useMemo(() => {
    if (!frozenPurgeAt) return null;
    const d = new Date(frozenPurgeAt);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(d);
    } catch {
      return d.toLocaleDateString();
    }
  }, [frozenPurgeAt, i18n.language]);

  const runAuth = (reactivate: boolean) => {
    if (submitting) return;
    const trimmed = username.trim();
    const validationError = validateAuthForm(mode, trimmed, password, birthdate);
    if (validationError) {
      setFieldError(validationError);
      setError(null);
      return;
    }
    setFieldError(null);
    setError(null);
    setSubmitting(true);
    const action =
      mode === "login"
        ? login(trimmed, password, reactivate)
        : register(trimmed, password, displayName.trim() || undefined, birthdate ?? undefined);
    action
      .catch((err: unknown) => {
        const frozen = mode === "login" ? frozenAccountInfo(err) : null;
        if (frozen) {
          setFrozenPurgeAt(frozen.purgeAt);
          setError(null);
        } else {
          setFrozenPurgeAt(undefined);
          setError(localizeError(err, t));
        }
      })
      .finally(() => setSubmitting(false));
  };

  const noticeText =
    notice === "sessionExpired"
      ? t("errors.sessionExpired")
      : notice === "network"
        ? t("errors.network")
        : null;

  // A successful login/register flips the store to "authenticated". This screen
  // is the active route (not index), so nothing else navigates us away — redirect
  // into the app here, mirroring the boot gate in index.tsx.
  if (status === "authenticated") return <Redirect href="/groups" />;

  const isRegister = mode === "register";

  return (
    <View style={{ flex: 1, backgroundColor: colors.rail }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: space.lg,
          paddingTop: insets.top + space.xl,
          // The live IME height: KeyboardAvoidingView gets no inset under
          // Android edge-to-edge (lib/use-keyboard-height).
          paddingBottom: insets.bottom + space.xl + keyboard,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", gap: space.lg }}>
          <View style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center" }}>
            <Glow size={300} style={{ top: -122, left: -122 }} />
            {/* The real Demli mark, md = the desktop AuthScreen's size-14 (56px). */}
            <BrandMark size="md" />
          </View>
          <Animated.View
            key={mode}
            entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            style={{ alignItems: "center", gap: space.xs }}
          >
            <Text
              variant="display"
              accessibilityRole="header"
              style={{ color: colors.fgDisplay, fontSize: 26, lineHeight: 32, fontWeight: "600", letterSpacing: -0.2, textAlign: "center" }}
            >
              {isRegister ? t("mobile:auth.createAccountTitle") : t("mobile:auth.welcomeBackTitle")}
            </Text>
            <Text style={{ color: colors.fgMuted, fontSize: 15, lineHeight: 21, textAlign: "center" }}>
              {isRegister ? t("mobile:auth.createAccountSubtitle") : t("mobile:auth.welcomeBackSubtitle")}
            </Text>
          </Animated.View>
        </View>

        <Animated.View
          layout={REFLOW}
          style={{
            width: "100%",
            maxWidth: 440,
            alignSelf: "center",
            backgroundColor: colors.app,
            borderRadius: radius.card,
            borderCurve: "continuous",
            padding: space.xl,
            gap: space.lg,
          }}
        >
          {noticeText && !error && !isFrozen ? (
            <Banner variant="warning" title={noticeText} />
          ) : null}

          {isFrozen ? (
            <Animated.View
              entering={REVEAL_IN}
              accessibilityRole="alert"
              style={{
                backgroundColor: colors.accentSurface,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                padding: space.lg,
                gap: space.sm,
              }}
            >
              <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "600" }}>
                {t("mobile:auth.frozenTitle")}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
                {purgeDate
                  ? t("mobile:auth.frozenBodyDated", { date: purgeDate })
                  : t("mobile:auth.frozenBody")}
              </Text>
              <Button
                variant="accent"
                label={t("mobile:auth.frozenReactivate")}
                onPress={() => runAuth(true)}
                loading={submitting}
                style={{ marginTop: space.xs }}
              />
            </Animated.View>
          ) : null}

          {error ? <Banner variant="danger" title={error} onDismiss={() => setError(null)} /> : null}

          <Animated.View layout={REFLOW}>
            <TextField
              label={t("mobile:auth.usernameLabel")}
              value={username}
              onChangeText={(next) => {
                setUsername(next);
                clearFieldError("username");
              }}
              error={errorFor("username")}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              spellCheck={false}
              returnKeyType="next"
              placeholder={t("mobile:auth.usernamePlaceholder")}
            />
          </Animated.View>
          {isRegister ? (
            <Animated.View entering={REVEAL_IN} exiting={REVEAL_OUT} layout={REFLOW}>
              <TextField
                label={t("mobile:auth.displayNameLabel")}
                value={displayName}
                onChangeText={setDisplayName}
                autoComplete="name"
                maxLength={64}
                placeholder={t("mobile:auth.displayNamePlaceholder")}
              />
            </Animated.View>
          ) : null}
          <Animated.View layout={REFLOW}>
            <TextField
              label={t("mobile:auth.passwordLabel")}
              value={password}
              onChangeText={(next) => {
                setPassword(next);
                clearFieldError("password");
              }}
              error={errorFor("password")}
              secureTextEntry
              autoCapitalize="none"
              autoComplete={isRegister ? "new-password" : "current-password"}
              textContentType={isRegister ? "newPassword" : "password"}
              returnKeyType={isRegister ? "next" : "go"}
              onSubmitEditing={isRegister ? undefined : () => runAuth(false)}
              placeholder={
                isRegister
                  ? t("mobile:auth.passwordPlaceholderRegister")
                  : t("mobile:auth.passwordPlaceholderLogin")
              }
            />
          </Animated.View>
          {isRegister ? (
            <Animated.View entering={REVEAL_IN} exiting={REVEAL_OUT} layout={REFLOW}>
              <BirthdateField
                label={t("mobile:auth.birthdateLabel")}
                hint={t("mobile:auth.birthdateHint")}
                error={errorFor("birthdate")}
                onChange={(iso) => {
                  setBirthdate(iso);
                  clearFieldError("birthdate");
                }}
              />
            </Animated.View>
          ) : null}

          <Animated.View layout={REFLOW} style={{ gap: space.lg }}>
            <Button
              variant="primary"
              size="lg"
              block
              label={isRegister ? t("mobile:auth.createAccountButton") : t("buttons.signIn")}
              onPress={() => runAuth(false)}
              loading={submitting}
              style={{ marginTop: space.xs }}
            />

            <GoogleButton />

            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: space.xs }}>
              <Text style={{ color: colors.fgMuted, fontSize: typography.size.label, lineHeight: 18 }}>
                {isRegister ? t("mobile:auth.alreadyHaveAccount") : t("mobile:auth.newToDemli")}
              </Text>
              <Touchable
                onPress={() => switchMode(isRegister ? "login" : "register")}
                accessibilityRole="button"
                pressedTone={colors.accentSurface}
                hitSlop={10}
                style={{ borderRadius: radius.sm, paddingHorizontal: space.xs, paddingVertical: 2 }}
              >
                <Text style={{ color: colors.accent, fontSize: typography.size.label, lineHeight: 18, fontWeight: "600" }}>
                  {isRegister ? t("mobile:auth.signInInstead") : t("mobile:auth.createAnAccount")}
                </Text>
              </Touchable>
            </View>
          </Animated.View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
