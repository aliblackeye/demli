/**
 * Full-screen game overlay that shows the active Minesweeper Flags board
 * above the chat area. Mounts when `activeGame` is set in the game store
 * and unmounts when the game ends and the user dismisses the result.
 */

import { useCallback } from "react";
import { X } from "lucide-react";
import { Button } from "@demli/ui";
import type { UserId } from "@demli/types";
import { useGameStore } from "../stores/game-store";
import { useChatStore } from "../stores/chat-store";
import { MinesweeperBoard } from "./MinesweeperBoard";
import { useAppTranslation } from "../lib/i18n";

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

export function GameOverlay() {
  const { t } = useAppTranslation();
  const activeGame = useGameStore((s) => s.activeGame);
  const lastResult = useGameStore((s) => s.lastResult);
  const dismissResult = useGameStore((s) => s.dismissResult);

  const winnerName = useUserName(lastResult?.winnerUserId ?? undefined);

  const visible = activeGame || lastResult;

  const handleClose = useCallback(() => {
    dismissResult();
  }, [dismissResult]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-neutral-900/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-700/40">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-200">
            Mayın Tarlası Bayraklar
          </span>
          <span className="text-xs text-neutral-500">MSN</span>
        </div>
        {!activeGame && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="text-neutral-400 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Board area */}
      <div className="flex-1 flex items-center justify-center overflow-auto">
        {activeGame ? (
          <MinesweeperBoard />
        ) : lastResult ? (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="text-lg font-bold text-neutral-200">
              {t("games.gameOver", "Oyun Bitti")}
            </div>
            <div className="text-2xl tabular-nums text-neutral-300">
              {lastResult.scores["1"] ?? 0} – {lastResult.scores["2"] ?? 0}
            </div>
            {lastResult.winnerUserId && (
              <div className="text-sm text-neutral-400">
                {t("games.winner", "Kazanan")}: {winnerName}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={handleClose}>
              {t("games.close", "Kapat")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
