import { useState } from "react";
import { View } from "react-native";
import { TriangleAlert } from "lucide-react-native";
import {
  ADULT_AGE,
  ageInYears,
  formatBirthdateDisplay,
  isBirthdateLockedError,
} from "@demli/client-core";
import type { User } from "@demli/types";
import { Text } from "@/components/ui/Text";
import { Button } from "@/components/Button";
import { BirthdateField } from "@/components/auth/BirthdateField";
import { useAppTranslation } from "@/lib/i18n";
import { localizeError } from "@/lib/errors";
import { useUpdateMe } from "@/queries/management-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * In-place date-of-birth entry — the mobile mirror of the desktop
 * `BirthdateVerification`. Rendered by the NSFW channel gate and by the one-time
 * "verify your age" reminder, so the promise is identical wherever it appears.
 *
 * ── Why it confirms before saving ───────────────────────────────────────────
 * `birthdate` is SET-ONCE: the server takes it exactly once and answers
 * `409 BIRTHDATE_LOCKED` afterwards, so a typo is permanent and a single tap on
 * "Save" is not an acceptable interaction. Step one types the date (the same
 * DD/MM/YYYY triple the sign-up screen uses — no new native module, OTA-safe);
 * step two confirms a sentence carrying the DATE and the AGE it produces, plus
 * the fact that it is written once. An entry that would make the user a minor
 * spells out the consequence BEFORE the write.
 *
 * On success `useUpdateMe` fans the returned self record into the auth store and
 * the `me` query cache, so `isAdult` flips for every reader at once: the gate
 * that mounted this form re-renders to the next stage with no reload.
 */

type Step = "input" | "confirm";

export function BirthdateVerification({
  onSaved,
}: {
  /**
   * Fired once the server accepted the date, with the updated self record.
   * `user.isAdult` is the authoritative outcome — never re-derive it from the
   * typed string, which is only what the user claimed.
   */
  onSaved?: (user: User) => void;
}) {
  const { t } = useAppTranslation();
  const updateMe = useUpdateMe();

  const [value, setValue] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("input");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const age = value === null ? null : ageInYears(value);
  const isAdultEntry = age !== null && age >= ADULT_AGE;

  const save = async (): Promise<void> => {
    if (saving || value === null || age === null) return;
    setSaving(true);
    setError(null);
    try {
      const { user } = await updateMe.mutateAsync({ birthdate: value });
      onSaved?.(user);
    } catch (err) {
      // A 409 means the server already holds a date of birth (another device, or
      // a stale view). Its value is the truth and the caller re-derives from the
      // refreshed `me` record — so say what happened rather than invite a retry
      // that can never succeed. `localizeError` maps the code to bespoke copy.
      setError(localizeError(err, t));
      if (isBirthdateLockedError(err)) setStep("input");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ alignSelf: "stretch", gap: space.md }}>
      {error ? (
        <View
          style={{
            backgroundColor: colors.dangerSurface,
            borderRadius: radius.sm,
            padding: space.sm,
          }}
        >
          <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
            {error}
          </Text>
        </View>
      ) : null}

      {/* Kept MOUNTED across both steps so tapping Back never wipes what the
          user typed (the field owns its own day/month/year state). */}
      <BirthdateField
        label={t("mobile:birthdate.label")}
        hint={t("mobile:birthdate.once")}
        onChange={(iso) => {
          setValue(iso);
          setError(null);
          // Editing after reaching the confirmation invalidates it — go back so
          // the sentence the user confirms always describes what is in the field.
          setStep("input");
        }}
      />

      {step === "input" ? (
        <Button
          label={t("mobile:birthdate.verify")}
          disabled={value === null}
          onPress={() => setStep("confirm")}
        />
      ) : (
        <View
          style={{
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.stroke,
            backgroundColor: colors.app,
          }}
        >
          <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20 }}>
            {t("mobile:birthdate.confirmQuestion", {
              date: formatBirthdateDisplay(value ?? ""),
              age: age ?? 0,
            })}
          </Text>
          <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
            {t("mobile:birthdate.once")}
          </Text>
          {/* The under-18 consequence is stated BEFORE the write, never after —
              this is the one screen where "undo" does not exist. */}
          {!isAdultEntry ? (
            <View style={{ flexDirection: "row", gap: space.xs, alignItems: "flex-start" }}>
              <TriangleAlert size={14} color={colors.danger} style={{ marginTop: 2 }} />
              <Text style={{ color: colors.danger, fontSize: 12, lineHeight: 17, flex: 1 }}>
                {t("mobile:birthdate.minorWarning")}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: space.sm, paddingTop: space.xs }}>
            <Button
              label={t("mobile:birthdate.back")}
              variant="ghost"
              disabled={saving}
              onPress={() => setStep("input")}
            />
            <Button
              label={t("mobile:birthdate.save")}
              loading={saving}
              onPress={() => void save()}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}
    </View>
  );
}
