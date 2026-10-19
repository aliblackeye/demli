/**
 * Settings building blocks — the mobile reading of the design system's
 * "Ayarlar" recipe: groups sit on a surface card (radius 16, no border), rows
 * inside it are separated by an inset hairline, switches live in setting rows,
 * and destructive work goes into a pink-tinted "danger zone" card.
 *
 *   SettingsSection   eyebrow + card + an optional footnote under the card
 *   SettingsRow       icon box · title/subtitle · value/trailing · chevron
 *   SettingsSwitch    a row whose control is the kit Switch (the row is the target)
 *   SettingsBlock     free-form padded content inside a card (chips, slider, text)
 *   DangerZone        the pink card for account/server deletion
 *
 * Rows press as a TONE change only (founder rule: rows never lift or bounce).
 * Every row is ≥52pt tall; disabled rows go to 40% and stop announcing as
 * buttons-you-can-press. The hairline separators are decorative and hidden
 * from TalkBack.
 */
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { SwitchTrack } from "@/components/ui/Switch";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { haptics } from "@/lib/haptics";
import { colors, radius, space, typography } from "@/theme/theme";

/** Small uppercase eyebrow above a group. */
export function SectionEyebrow({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: space.xs, paddingBottom: space.sm }, style]}>
      <Text
        accessibilityRole="header"
        style={{
          color: colors.fgFaint,
          fontSize: typography.size["2xs"],
          lineHeight: 14,
          fontWeight: "600",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/** Hairline between rows, inset past the icon box. */
function RowSeparator({ inset }: { inset: number }) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ height: 1, marginLeft: inset, backgroundColor: colors.stroke }}
    />
  );
}

export function SettingsSection({
  title,
  footer,
  children,
  separatorInset = space.lg,
  style,
  tone = "surface",
}: {
  title?: string;
  /** Faint note under the card — what the group's settings actually do. */
  footer?: string;
  children: ReactNode;
  /** Left inset of the hairlines (rows with an icon box pass 64). */
  separatorInset?: number;
  style?: StyleProp<ViewStyle>;
  /** `danger` tints the card for destructive groups. */
  tone?: "surface" | "danger";
}) {
  const items = Children.toArray(children).filter((c) => isValidElement(c));
  return (
    <View style={style}>
      {title ? <SectionEyebrow>{title}</SectionEyebrow> : null}
      <View
        style={{
          backgroundColor: tone === "danger" ? colors.dangerSurface : colors.surface,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          overflow: "hidden",
        }}
      >
        {items.map((child, i) => (
          <Fragment key={(isValidElement(child) && child.key) || i}>
            {i > 0 ? <RowSeparator inset={separatorInset} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, paddingTop: space.sm, fontWeight: "400" }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/** The 32px icon box every settings row leads with. */
export function RowIcon({ icon: Icon, tone = "default" }: { icon: LucideIcon; tone?: "default" | "accent" | "danger" }) {
  const ink = tone === "accent" ? colors.accent : tone === "danger" ? colors.danger : colors.fgMuted;
  const bg = tone === "accent" ? colors.accentSurface : tone === "danger" ? colors.dangerSurface : colors.surfaceRaised;
  return (
    <View
      importantForAccessibility="no"
      style={{ width: 32, height: 32, borderRadius: radius.md, borderCurve: "continuous", backgroundColor: bg, alignItems: "center", justifyContent: "center" }}
    >
      <Icon size={17} color={ink} strokeWidth={2} />
    </View>
  );
}

export const ROW_ICON_INSET = space.lg + 32 + space.md;

export function SettingsRow({
  icon,
  leading,
  title,
  subtitle,
  value,
  trailing,
  onPress,
  onLongPress,
  destructive = false,
  accent = false,
  disabled = false,
  busy = false,
  chevron,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: {
  icon?: LucideIcon;
  /** Custom leading content (an avatar) instead of the icon box. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Short current value on the right ("Türkçe", "3 cihaz"). */
  value?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  /** Coral title — a "create / add" row. */
  accent?: boolean;
  disabled?: boolean;
  /** Working: a spinner replaces the chevron and the row is inert. */
  busy?: boolean;
  /** Defaults to "has an onPress". */
  chevron?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}) {
  const interactive = !!(onPress || onLongPress);
  const titleColor = destructive ? colors.danger : accent ? colors.accent : colors.fg;
  const showChevron = chevron ?? (interactive && !destructive);
  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || busy || !interactive}
      dimmed={disabled}
      pressedTone={destructive ? colors.dangerSurface : colors.wash}
      accessibilityRole={interactive ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy }}
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 52,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
      }}
    >
      {leading ?? (icon ? <RowIcon icon={icon} tone={destructive ? "danger" : accent ? "accent" : "default"} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: titleColor, fontSize: 15, lineHeight: 20, fontWeight: "500" }} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text type="meta" tone="faint" style={{ fontWeight: "400" }} numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text type="meta" tone="muted" numberOfLines={1} style={{ maxWidth: "40%", fontWeight: "400" }}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {busy ? (
        <ActivityIndicator size="small" color={colors.fgMuted} />
      ) : showChevron ? (
        <ChevronRight size={18} color={colors.fgSubtle} />
      ) : null}
    </Touchable>
  );
}

/**
 * A setting that is on or off. The whole row toggles (≥52pt), announced as a
 * switch with its state; the description says what the switch actually does.
 */
export function SettingsSwitch({
  icon,
  title,
  description,
  value,
  onValueChange,
  disabled = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Touchable
      onPress={() => {
        haptics.selection();
        onValueChange(!value);
      }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={description}
      accessibilityState={{ checked: value }}
      pressedTone={colors.wash}
      style={{
        flexDirection: "row",
        alignItems: description ? "flex-start" : "center",
        gap: space.md,
        minHeight: 52,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
      }}
    >
      {icon ? <RowIcon icon={icon} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>{title}</Text>
        {description ? (
          <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
            {description}
          </Text>
        ) : null}
      </View>
      <View style={description ? { paddingTop: 2 } : null}>
        <SwitchTrack value={value} />
      </View>
    </Touchable>
  );
}

/** Free-form content inside a settings card: a labelled chip set, a slider, a note. */
export function SettingsBlock({
  label,
  hint,
  children,
  disabled = false,
}: {
  label?: string;
  hint?: string;
  children?: ReactNode;
  /** Dims and freezes the block (a setting another setting currently overrides). */
  disabled?: boolean;
}) {
  return (
    <View
      pointerEvents={disabled ? "none" : "auto"}
      accessibilityState={{ disabled }}
      style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, opacity: disabled ? 0.4 : 1 }}
    >
      {label ? (
        <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>{label}</Text>
      ) : null}
      {children}
      {hint ? (
        <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Destructive group: a pink-tinted card whose body states the consequence. */
export function DangerZone({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View>
      <SectionEyebrow>{title}</SectionEyebrow>
      <View
        style={{
          backgroundColor: colors.dangerSurface,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          padding: space.lg,
          gap: space.md,
        }}
      >
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
          {description}
        </Text>
        {children}
      </View>
    </View>
  );
}
