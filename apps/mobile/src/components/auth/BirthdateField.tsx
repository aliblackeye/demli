import { useState } from "react";
import { View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * A dependency-free date-of-birth entry (M15) — three numeric fields (day /
 * month / year) that assemble an ISO `YYYY-MM-DD` string. React Native ships no
 * native date input and the founder brief forbids adding a heavy date-picker
 * native module (OTA must stay intact), so this is pure JS: it validates a real,
 * non-future calendar date and reports the ISO value (or `null` while
 * incomplete/invalid) to the caller, which owns the "18+" derivation and save.
 */

/** True when d/m/y form a real, non-future calendar date at/after 1900. */
function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false; // e.g. Feb 30 rolled over
  }
  // No future dates.
  return date.getTime() <= Date.now();
}

/** Assemble an ISO date string, or null when the parts don't form a valid date. */
function toIso(dayStr: string, monthStr: string, yearStr: string): string | null {
  if (yearStr.length !== 4 || monthStr.length === 0 || dayStr.length === 0) return null;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (!isValidDate(year, month, day)) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function Field(props: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  maxLength: number;
  flex: number;
  accessibilityLabel: string;
}) {
  return (
    <View style={{ flex: props.flex }}>
      <TextInput
        value={props.value}
        onChangeText={(t) => props.onChangeText(t.replace(/[^0-9]/g, "").slice(0, props.maxLength))}
        placeholder={props.placeholder}
        placeholderTextColor={colors.fgFaint}
        keyboardType="number-pad"
        maxLength={props.maxLength}
        accessibilityLabel={props.accessibilityLabel}
        style={{
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.stroke,
          borderWidth: 1,
          borderRadius: radius.md,
          borderCurve: "continuous",
          color: colors.fg,
          fontSize: 15,
          textAlign: "center",
          paddingHorizontal: space.sm,
          paddingVertical: space.md,
        }}
      />
    </View>
  );
}

export function BirthdateField({
  label,
  hint,
  onChange,
}: {
  label?: string;
  hint?: string;
  /** Fires with a valid ISO `YYYY-MM-DD`, or null while the entry is incomplete/invalid. */
  onChange: (iso: string | null) => void;
}) {
  const { t } = useAppTranslation();
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");

  const update = (nextDay: string, nextMonth: string, nextYear: string) => {
    setDay(nextDay);
    setMonth(nextMonth);
    setYear(nextYear);
    onChange(toIso(nextDay, nextMonth, nextYear));
  };

  return (
    <View style={{ gap: space.xs }}>
      {label ? (
        <Text
          style={{
            color: colors.fgFaint,
            fontSize: typography.size["2xs"],
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {label}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Field
          value={day}
          onChangeText={(v) => update(v, month, year)}
          placeholder={t("mobile:auth.birthdatePlaceholderDay")}
          maxLength={2}
          flex={1}
          accessibilityLabel={t("mobile:auth.birthdatePlaceholderDay")}
        />
        <Field
          value={month}
          onChangeText={(v) => update(day, v, year)}
          placeholder={t("mobile:auth.birthdatePlaceholderMonth")}
          maxLength={2}
          flex={1}
          accessibilityLabel={t("mobile:auth.birthdatePlaceholderMonth")}
        />
        <Field
          value={year}
          onChangeText={(v) => update(day, month, v)}
          placeholder={t("mobile:auth.birthdatePlaceholderYear")}
          maxLength={4}
          flex={1.4}
          accessibilityLabel={t("mobile:auth.birthdatePlaceholderYear")}
        />
      </View>
      {hint ? <Text style={{ color: colors.fgFaint, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}
