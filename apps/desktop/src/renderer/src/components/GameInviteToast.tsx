/**
 * Floating toast for incoming game invites — auto-dismisses after 60 s
 * (matching the server invite TTL). Accepting fires the REST accept
 * mutation; declining fires decline. Both clear the pending invite.
 */

import { useCallback, useEffect } from "react";
import { Gamepad2, X } from "lucide-react";
import { Button } from "@demli/ui";
import type { UserId } from "@demli/types";
import { useGameStore } from "../stores/game-store";
import { useChatStore } from "../stores/chat-store";
import { useGameAccept, useGameDecline } from "../queries/game-queries";
import { useAppTranslation } from "../lib/i18n";

const INVITE_TTL_MS = 60_000;

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

export function GameInviteToast() {
  const { t } = useAppTranslation();
  const invite = useGameStore((s) => s.pendingInvite);
  const dismissInvite = useGameStore((s) => s.dismissInvite);
  const acceptMut = useGameAccept();
  const declineMut = useGameDecline();

  const inviterName = useUserName(invite?.inviterUserId);

  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(dismissInvite, INVITE_TTL_MS);
    return () => clearTimeout(timer);
  }, [invite, dismissInvite]);

  const handleAccept = useCallback(() => {
    if (!invite) return;
    acceptMut.mutate(invite.gameId);
    dismissInvite();
  }, [invite, acceptMut, dismissInvite]);

  const handleDecline = useCallback(() => {
    if (!invite) return;
    declineMut.mutate(invite.gameId);
    dismissInvite();
  }, [invite, declineMut, dismissInvite]);

  if (!invite) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="flex items-center gap-3 rounded-xl bg-neutral-900/95 border border-neutral-700/60 px-4 py-3 shadow-2xl backdrop-blur-sm max-w-sm">
        <div className="flex-shrink-0 rounded-full bg-emerald-500/20 p-2">
          <Gamepad2 className="h-5 w-5 text-emerald-400" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-neutral-200 truncate">
            {t("games.inviteFrom", "{{name}} seni oyuna davet ediyor", { name: inviterName })}
          </div>
          <div className="text-xs text-neutral-400 mt-0.5">
            Mayın Tarlası Bayraklar
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            variant="default"
            size="sm"
            onClick={handleAccept}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3"
          >
            {t("games.accept", "Kabul")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDecline}
            className="text-neutral-400 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
