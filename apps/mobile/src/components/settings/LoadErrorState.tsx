import { CloudOff } from "lucide-react-native";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/Button";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { colors } from "@/theme/theme";

/**
 * A failed load, said as one: what failed (the caller's title), why (the
 * localized error), and a Retry that spins while it runs. The same block the
 * server-settings screen uses, extracted so an admin screen never falls back to
 * "not found" when the truth is "could not load" (§26).
 */
export function LoadErrorState({
  title,
  error,
  onRetry,
  retrying,
  compact = false,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  compact?: boolean;
}) {
  const { t } = useAppTranslation();
  return (
    <EmptyState
      tone="error"
      compact={compact}
      icon={<CloudOff size={22} color={colors.danger} />}
      title={title}
      subtitle={localizeError(error, t)}
      action={<Button label={t("common:buttons.retry")} variant="secondary" size="sm" onPress={onRetry} loading={retrying} />}
    />
  );
}
