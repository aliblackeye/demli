import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { Text } from "@/components/ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { BirthdateField } from "@/components/auth/BirthdateField";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { localizeError } from "@/lib/errors";
import { frozenAccountInfo } from "@/lib/frozen-account";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space } from "@/theme/theme";

type Mode = "login" | "register";

/** Stable validation outcomes, mapped to localized copy at render. */
type ValidationCode = "username" | "passwordShort" | "passwordRequired" | "birthdate";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

function validate(
  mode: Mode,
  username: string,
  password: string,
  birthdate: string | null,
): ValidationCode | null {
  if (!USERNAME_PATTERN.test(username)) return "username";
  if (mode === "register" && password.length < 8) return "passwordShort";
  if (mode === "register" && !birthdate) return "birthdate";
  if (mode === "login" && password.length === 0) return "passwordRequired";
  return null;
}

/** Login/register gate — the mobile mirror of the desktop AuthScreen. */
export default function SignIn() {
  const { t, i18n } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const notice = useAuthStore((s) => s.notice);
  const status = useAuthStore((s) => s.status);

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Frozen (soft-deleted) account caught on login — offers reactivation (M15).
  const [frozenPurgeAt, setFrozenPurgeAt] = useState<string | null | undefined>(undefined);
  const isFrozen = frozenPurgeAt !== undefined;

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setFrozenPurgeAt(undefined);
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
    const validationError = validate(mode, trimmed, password, birthdate);
    if (validationError) {
      const keys = {
        username: "mobile:auth.validationUsername",
        passwordShort: "mobile:auth.validationPasswordShort",
        passwordRequired: "mobile:auth.validationPasswordRequired",
        birthdate: "mobile:auth.validationBirthdate",
      } as const;
      setError(t(keys[validationError]));
      return;
    }
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

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: space.xl,
          paddingTop: insets.top + space.xl,
          paddingBottom: insets.bottom + space.xl,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", gap: space.md }}>
          {/* The real Demli mark, md = the desktop AuthScreen's size-14 (56px).
              Its plate carries its own rounding, so no tinted box around it. */}
          <BrandMark size="md" />
          <View style={{ alignItems: "center", gap: space.xs }}>
            <Text variant="display" style={{ color: colors.fg, fontSize: 20, fontWeight: "700" }}>
              {mode === "login"
                ? t("mobile:auth.welcomeBackTitle")
                : t("mobile:auth.createAccountTitle")}
            </Text>
            <Text style={{ color: colors.fgMuted, fontSize: 14 }}>
              {mode === "login"
                ? t("mobile:auth.welcomeBackSubtitle")
                : t("mobile:auth.createAccountSubtitle")}
            </Text>
          </View>
        </View>

        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.stroke,
            borderWidth: 1,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            padding: space.lg,
            gap: space.lg,
          }}
        >
          {noticeText && !error && !isFrozen ? (
            // Warning wash — `colors.warning` (#e8c34a) at 12%, the same hue as
            // the notice text so the pill reads as one tinted block.
            <View style={{ backgroundColor: "rgba(232,195,74,0.12)", borderRadius: radius.sm, padding: space.sm }}>
              <Text style={{ color: colors.warning, fontSize: 13 }}>{noticeText}</Text>
            </View>
          ) : null}

          {isFrozen ? (
            <View
              style={{
                backgroundColor: colors.accentSurface,
                borderRadius: radius.sm,
                padding: space.md,
                gap: space.sm,
              }}
            >
              <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "700" }}>
                {t("mobile:auth.frozenTitle")}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
                {purgeDate
                  ? t("mobile:auth.frozenBodyDated", { date: purgeDate })
                  : t("mobile:auth.frozenBody")}
              </Text>
              <Button
                label={t("mobile:auth.frozenReactivate")}
                onPress={() => runAuth(true)}
                loading={submitting}
                style={{ borderRadius: radius.md }}
              />
            </View>
          ) : null}

          {error ? (
            <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
              <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
                {error}
              </Text>
            </View>
          ) : null}

          <TextField
            label={t("mobile:auth.usernameLabel")}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            spellCheck={false}
            placeholder={t("mobile:auth.usernamePlaceholder")}
          />
          {mode === "register" ? (
            <TextField
              label={t("mobile:auth.displayNameLabel")}
              value={displayName}
              onChangeText={setDisplayName}
              autoComplete="name"
              maxLength={64}
              placeholder={t("mobile:auth.displayNamePlaceholder")}
            />
          ) : null}
          <TextField
            label={t("mobile:auth.passwordLabel")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={
              mode === "register"
                ? t("mobile:auth.passwordPlaceholderRegister")
                : t("mobile:auth.passwordPlaceholderLogin")
            }
          />
          {mode === "register" ? (
            <BirthdateField
              label={t("mobile:auth.birthdateLabel")}
              hint={t("mobile:auth.birthdateHint")}
              onChange={setBirthdate}
            />
          ) : null}

          <Button
            label={mode === "login" ? t("buttons.signIn") : t("mobile:auth.createAccountButton")}
            onPress={() => runAuth(false)}
            loading={submitting}
          />

          <GoogleButton />

          <View style={{ flexDirection: "row", justifyContent: "center", gap: space.xs }}>
            <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
              {mode === "login"
                ? t("mobile:auth.newToDemli")
                : t("mobile:auth.alreadyHaveAccount")}
            </Text>
            <Pressable onPress={() => switchMode(mode === "login" ? "register" : "login")}>
              <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
                {mode === "login"
                  ? t("mobile:auth.createAnAccount")
                  : t("mobile:auth.signInInstead")}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
