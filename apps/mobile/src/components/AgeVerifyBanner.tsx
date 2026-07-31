import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CalendarCheck, Check, X } from "lucide-react-native";
import { shouldPromptForBirthdate } from "@demli/client-core";
import { Text } from "@/components/ui/Text";
import { Button } from "@/components/Button";
import { BirthdateVerification } from "@/components/BirthdateVerification";
import { useAppTranslation } from "@/lib/i18n";
import { useMe } from "@/queries/social-queries";
import { useAgePromptStore } from "@/stores/age-prompt-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * The proactive, ONE-TIME "verify your age" reminder (mobile mirror of the
 * desktop corner pill).
 *
 * ── Why a dismissible strip and not a modal on launch ───────────────────────
 * Most accounts have no date of birth on file and today most of them will never
 * open an age-restricted channel. A launch-blocking prompt would punish everyone
 * for a feature they may never use — the founder's line is that nothing may make
 * the app unusable. So this is a compact strip at the top of the Home panel (the
 * landing surface, right where the connection banner already lives): impossible
 * to miss, in-flow so it never covers content, one tap to dismiss and then gone
 * for good — persisted per account. Enforcement stays at the NSFW channel gate,
 * which nobody can walk past.
 *
 * The sheet it opens hosts the SAME {@link BirthdateVerification} form the gate
 * uses, so the set-once confirmation and the under-18 warning are identical
 * wherever the user verifies.
 */
export function AgeVerifyBanner() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const userId = me.data?.id ?? null;
  const dismissed = useAgePromptStore((s) => (userId ? !!s.dismissedByUser[userId] : true));
  const dismiss = useAgePromptStore((s) => s.dismiss);

  const [open, setOpen] = useState(false);
  /** Set after a successful save so the sheet closes on the user's terms. */
  const [savedAdult, setSavedAdult] = useState<boolean | null>(null);

  const visible = shouldPromptForBirthdate({
    // `isFetched`, NOT `isSuccess`: `useMe` seeds itself from the auth-store user
    // via `initialData`, which makes the query "successful" on the very first
    // render. Only a resolved fetch means the real /users/me — the one endpoint
    // guaranteed to carry the me-only birthdate — actually landed, so without
    // this the strip would flash on every cold start.
    selfLoaded: me.isFetched && userId !== null,
    birthdateSet: Boolean(me.data?.birthdate),
    dismissed,
  });

  if (!visible && !open) return null;

  const close = (): void => {
    setOpen(false);
    setSavedAdult(null);
    // Closing a sheet you deliberately opened is an answer either way — you
    // verified, or you decided not to. Both retire the nudge for this account:
    // asking again after that is the nagging this design exists to avoid, and
    // the NSFW gate still stops anyone who actually needs to verify.
    if (userId) dismiss(userId);
  };

  return (
    <>
      {visible ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingVertical: space.sm,
            paddingHorizontal: space.md,
            backgroundColor: colors.surfaceRaised,
            borderBottomWidth: 1,
            borderBottomColor: colors.stroke,
          }}
        >
          <CalendarCheck size={16} color={colors.accent} />
          <Text style={{ color: colors.fg, fontSize: 13, flex: 1 }} numberOfLines={2}>
            {t("mobile:ageVerify.title")}
          </Text>
          <Pressable
            onPress={() => setOpen(true)}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "700" }}>
              {t("mobile:ageVerify.open")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => userId && dismiss(userId)}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:ageVerify.dismiss")}
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <X size={16} color={colors.fgFaint} />
          </Pressable>
        </View>
      ) : null}

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <Pressable
          onPress={close}
          accessibilityLabel={t("mobile:ageVerify.close")}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
        >
          {/* Sheet — its own Pressable swallows taps so they don't dismiss it. */}
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              borderCurve: "continuous",
              borderTopWidth: 1,
              borderColor: colors.stroke,
              paddingTop: space.sm,
              paddingBottom: space.md + insets.bottom,
              paddingHorizontal: space.md,
              maxHeight: "88%",
            }}
          >
            <View style={{ alignItems: "center", paddingBottom: space.sm }}>
              <View
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: radius.pill,
                  backgroundColor: colors.strokeStrong,
                }}
              />
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md }}>
              <Text
                variant="display"
                style={{ color: colors.fg, fontSize: 17, fontWeight: "800" }}
              >
                {t("mobile:ageVerify.title")}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}>
                {t("mobile:ageVerify.body")}
              </Text>

              {savedAdult === null ? (
                <BirthdateVerification onSaved={(user) => setSavedAdult(user.isAdult === true)} />
              ) : (
                <View style={{ gap: space.md }}>
                  <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
                    <Check size={16} color={colors.online} style={{ marginTop: 2 }} />
                    <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20, flex: 1 }}>
                      {savedAdult
                        ? t("mobile:birthdate.doneAdult")
                        : t("mobile:birthdate.doneMinor")}
                    </Text>
                  </View>
                  <Button label={t("mobile:ageVerify.close")} onPress={close} />
                </View>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
