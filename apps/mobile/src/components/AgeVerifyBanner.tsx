import { useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { CalendarCheck, Check } from "lucide-react-native";
import { shouldPromptForBirthdate } from "@demli/client-core";
import { Text } from "@/components/ui/Text";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { BirthdateVerification } from "@/components/BirthdateVerification";
import { useAppTranslation } from "@/lib/i18n";
import { useMe } from "@/queries/social-queries";
import { useAgePromptStore } from "@/stores/age-prompt-store";
import { colors, space } from "@/theme/theme";

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
export function AgeVerifyBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useAppTranslation();
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
        <Banner
          variant="info"
          icon={CalendarCheck}
          title={t("mobile:ageVerify.title")}
          action={{ label: t("mobile:ageVerify.open"), onPress: () => setOpen(true) }}
          onDismiss={() => userId && dismiss(userId)}
          dismissLabel={t("mobile:ageVerify.dismiss")}
          style={[{ marginHorizontal: space.md, marginTop: space.sm }, style]}
        />
      ) : null}

      {/* The kit Sheet (borderless card, grabber, scrim, drag-to-close, the real
          keyboard lift for the date field) — not a hand-rolled Modal. */}
      <Sheet
        visible={open}
        onClose={close}
        title={t("mobile:ageVerify.title")}
        description={t("mobile:ageVerify.body")}
      >
        {savedAdult === null ? (
          <BirthdateVerification onSaved={(user) => setSavedAdult(user.isAdult === true)} />
        ) : (
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
              <Check size={16} color={colors.success} style={{ marginTop: 2 }} />
              <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20, flex: 1 }}>
                {savedAdult ? t("mobile:birthdate.doneAdult") : t("mobile:birthdate.doneMinor")}
              </Text>
            </View>
            <Button variant="secondary" block label={t("mobile:ageVerify.close")} onPress={close} />
          </View>
        )}
      </Sheet>
    </>
  );
}
