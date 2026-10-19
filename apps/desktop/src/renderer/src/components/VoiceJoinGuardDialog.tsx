/**
 * Confirmation shown before an INTERRUPTING voice-channel join (founder UX #6):
 * joining while a screen share is live (it will stop), a DM/group call is live
 * (it will end), or while sitting in another voice channel (it will be left).
 * Driven by {@link useVoiceJoinGuard}; mounted ONCE at the app root so any join
 * entry point (channel row, command menu) shares one dialog. A non-interrupting
 * join never opens this — it joins straight through.
 *
 * The body lists every consequence that applies (they combine: sharing your
 * screen mid-call surfaces both the "screen share will stop" and "leave your
 * call" lines) plus the always-shown target line. The destructive confirm button
 * is deliberately NOT auto-focused so a stray Enter can't switch rooms; Esc /
 * overlay click / Cancel all keep the current session (Radix focus-trap + Esc).
 */

import * as React from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { LogOut, MonitorX, PhoneOff, Volume2 } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceJoinGuard } from "../stores/voice-join-guard-store";

const DESC_ID = "voice-join-guard-desc";

export function VoiceJoinGuardDialog(): JSX.Element | null {
  const { t } = useAppTranslation();
  const pending = useVoiceJoinGuard((s) => s.pending);
  const confirm = useVoiceJoinGuard((s) => s.confirm);
  const cancel = useVoiceJoinGuard((s) => s.cancel);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  if (!pending) return null;

  const { consequences, channelName } = pending;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <DialogContent
        className="max-w-sm"
        closeLabel={t("buttons.close")}
        aria-describedby={DESC_ID}
        onOpenAutoFocus={(e) => {
          // Land focus on CANCEL, never the destructive confirm — a stray Enter
          // on open must not silently switch voice rooms (founder UX #6).
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("desktop:voice.joinGuard.title")}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul id={DESC_ID} className="flex flex-col gap-1 rounded-xl bg-surface p-2 text-label">
            {consequences.stopsScreenShare && (
              <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-fg">
                <MonitorX aria-hidden className="mt-px size-4 shrink-0 text-danger" />
                <span>{t("desktop:voice.joinGuard.screenShare")}</span>
              </li>
            )}
            {consequences.leavesCall && (
              <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-fg">
                <PhoneOff aria-hidden className="mt-px size-4 shrink-0 text-danger" />
                <span>{t("desktop:voice.joinGuard.leaveCall")}</span>
              </li>
            )}
            {consequences.leavesChannel && (
              <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-fg">
                <LogOut aria-hidden className="mt-px size-4 shrink-0 text-danger" />
                <span>{t("desktop:voice.joinGuard.leaveChannel")}</span>
              </li>
            )}
            <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-fg-muted">
              <Volume2 aria-hidden className="mt-px size-4 shrink-0 text-accent" />
              <span>{t("desktop:voice.joinGuard.joinTarget", { channel: channelName })}</span>
            </li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} variant="secondary" onClick={cancel}>
            {t("desktop:voice.joinGuard.cancel")}
          </Button>
          <Button variant="accent" onClick={confirm} data-testid="join-guard-confirm">
            {t("desktop:voice.joinGuard.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
