import { useAppTranslation } from "@/lib/i18n";
import { useVoiceStore } from "@/stores/voice-store";
import { space } from "@/theme/theme";
import { Banner } from "../ui/Banner";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { localizeVoiceError } from "./voice-error";

/**
 * The voice notices every call surface shows — the DM call (InCallView, also
 * after a group upgrade) and the server / group-DM voice room — so a mic,
 * camera, screen or reconnect failure reads the same wherever the user is. The
 * mobile twin of what the desktop VoicePanel renders under its status line: the
 * "you're the only one here" countdown, then the §26 voice error (localized,
 * never a stack trace). One component, so the surfaces cannot drift again.
 *
 * Both are the kit's Banner: it drops in on the standard step and retracts on
 * the fast one, so an error that clears (a reconnect that succeeded) leaves
 * instead of blinking out, and the danger one is announced as an alert.
 */
export function VoiceNotices({ marginTop }: { marginTop?: number }) {
  const { t } = useAppTranslation();
  const error = useVoiceStore((s) => s.error);
  const message = localizeVoiceError(error, t);

  return (
    <>
      <AloneCountdownNotice marginTop={marginTop} />
      {message ? (
        <Banner
          variant="danger"
          title={message}
          style={{ marginHorizontal: space.lg, marginTop: marginTop ?? space.sm }}
        />
      ) : null}
    </>
  );
}
