/**
 * ConfirmSheet — the designed replacement for `Alert.alert` confirms on the
 * identity, settings and admin screens: a kit {@link Sheet} with a title, the
 * consequence stated in one or two plain lines, and the actions stacked
 * thumb-first (the one that DOES the thing on top, "keep / cancel" below).
 *
 * Why not the native dialog: it cannot carry the design system (Onest title,
 * pink danger action that keeps ≥4.5:1, coral accent), it cannot show a busy
 * state while the request runs, and it cannot say what failed without a second
 * dialog. Here the confirm button spins while `busy`, the sheet stays put, and
 * an `error` line appears in place — the user never loses the context of what
 * they were confirming.
 *
 * Dismissal (drag, scrim, back) is the cancel path, and is refused while busy
 * so a running request can't be orphaned by a stray swipe.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { Banner } from "@/components/ui/Banner";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Text } from "@/components/ui/Text";
import { space } from "@/theme/theme";

export type ConfirmSheetProps = {
  visible: boolean;
  title: string;
  /** What will happen — the consequence, in plain words. */
  body?: string;
  /** Extra lines under the body (a second paragraph, a list of effects). */
  children?: ReactNode;
  confirmLabel: string;
  confirmIcon?: LucideIcon;
  /** `danger` for destructive actions, `accent` for a warm yes, `primary` neutral. */
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  cancelLabel: string;
  onCancel: () => void;
  /** A third path between the two (e.g. "Save and leave" on an unsaved-changes prompt). */
  alternative?: {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant;
    icon?: LucideIcon;
    /** The running request is THIS path (the spinner goes here, not on confirm). */
    loading?: boolean;
  };
  /** The confirm request is running: spinner on the button, sheet locked. */
  busy?: boolean;
  /** The confirm request failed — shown in place, the sheet stays open to retry. */
  error?: string | null;
  errorTitle?: string;
};

export function ConfirmSheet({
  visible,
  title,
  body,
  children,
  confirmLabel,
  confirmIcon,
  confirmVariant = "danger",
  onConfirm,
  cancelLabel,
  onCancel,
  alternative,
  busy = false,
  error,
  errorTitle,
}: ConfirmSheetProps) {
  return (
    <Sheet
      visible={visible}
      onClose={() => {
        if (!busy) onCancel();
      }}
      dismissible={!busy}
      title={title}
      contentPadding={space.lg}
      footer={
        <View style={{ gap: space.sm }}>
          {alternative ? (
            <Button
              label={alternative.label}
              icon={alternative.icon}
              variant={alternative.variant ?? "accent"}
              size="lg"
              block
              onPress={alternative.onPress}
              loading={busy && alternative.loading === true}
              disabled={busy && alternative.loading !== true}
            />
          ) : null}
          <Button
            label={confirmLabel}
            icon={confirmIcon}
            variant={confirmVariant}
            size="lg"
            block
            loading={busy && alternative?.loading !== true}
            disabled={busy && alternative?.loading === true}
            haptic="medium"
            onPress={onConfirm}
          />
          <Button label={cancelLabel} variant="ghost" size="lg" block onPress={onCancel} disabled={busy} />
        </View>
      }
    >
      {body ? (
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 21 }}>
          {body}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Banner variant="danger" title={errorTitle ?? error} description={errorTitle ? error : undefined} style={{ marginTop: space.sm }} />
      ) : null}
    </Sheet>
  );
}
