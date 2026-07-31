import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { BirthdateField } from "@/components/auth/BirthdateField";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { localizeError } from "@/lib/errors";
import { frozenAccountInfo } from "@/lib/frozen-account";
import { loginAndAddAccount, registerAndAddAccount } from "@/lib/account-manager";
import { colors, radius, space } from "@/theme/theme";

type Mode = "login" | "register";
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

/**
 * "Add account" (M15 / ADR 0013): sign in to a SECOND account without dropping the
 * current session. On success the manager stores the account and runs the ordered
 * switch onto it; we then dismiss back to the app. Mirrors sign-in.tsx (birthdate
 * on register, Google placeholder, frozen-account reactivation) but calls the
 * account-manager add helpers.
 */
export default function AddAccountScreen() {
  const { t, i18n } = useAppTranslation();
  const insets = useSafeAreaInsets();

  // Re-auth entry (#100): the switcher sends us here when a stored account's
  // session is dead — prefill its handle and show a "signed out" notice.
  const params = useLocalSearchParams<{ username?: string; reauth?: string }>();
  const isReauth = params.reauth === "1";

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState(params.username ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
        ? loginAndAddAccount(trimmed, password, reactivate)
        : registerAndAddAccount(trimmed, password, displayName.trim() || undefined, birthdate ?? undefined);
    action
      .then(() => {
        router.back();
      })
      .catch((err: unknown) => {
        const frozen = mode === "login" ? frozenAccountInfo(err) : null;
        if (frozen) {
          setFrozenPurgeAt(frozen.purgeAt);
          setError(null);
        } else {
          setFrozenPurgeAt(undefined);
          setError(localizeError(err, t));
        }
        setSubmitting(false);
      });
  };

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
          paddingBottom: insets.bottom + space.xl,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", gap: space.xs }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 20, fontWeight: "700" }}>
            {t("mobile:accounts.addHeading")}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {t("mobile:accounts.addSubtitle")}
          </Text>
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
          {isReauth && !isFrozen ? (
            <View style={{ backgroundColor: colors.accentSurface, borderRadius: radius.sm, padding: space.sm }}>
              <Text style={{ color: colors.fg, fontSize: 13 }}>
                {t("mobile:accounts.reauthNotice", { username: params.username ?? "" })}
              </Text>
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
            autoFocus={isReauth}
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
