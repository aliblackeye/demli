import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ImagePlay, Search } from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@demli/ui";
import type { GifItem } from "@demli/client-core";
import { useAppTranslation } from "../lib/i18n";
import { api } from "../lib/api-client";
import { sendChatMessage } from "../realtime/connection";
import { useGifTrending, useGifSearch } from "../queries/gif-queries";

export function GifPicker({
  channelId,
  disabled,
}: {
  channelId: string;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-11 shrink-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("common:gif.title")}
                  disabled={disabled}
                  className="text-fg-faint data-[state=open]:bg-wash data-[state=open]:text-fg"
                >
                  <ImagePlay className="size-5" />
                </Button>
              </PopoverTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t("common:gif.title")}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          className="w-[380px] overflow-hidden rounded-xl border-border bg-surface p-0 shadow-xl"
          aria-label={t("common:gif.title")}
        >
          {open && (
            <GifPickerInner
              channelId={channelId}
              onClose={() => setOpen(false)}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function GifPickerInner({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const isSearching = debouncedQuery.length > 0;

  const trending = useGifTrending(!isSearching);
  const search = useGifSearch(debouncedQuery, isSearching);

  const active = isSearching ? search : trending;
  const gifs = active.data?.pages.flatMap((p) => p.results) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [debouncedQuery]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || active.isFetchingNextPage || !active.hasNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      active.fetchNextPage();
    }
  }, [active]);

  const pickGif = useCallback(
    async (gif: GifItem) => {
      if (sending) return;
      setSending(gif.id);
      try {
        const res = await fetch(gif.fullUrl);
        const blob = await res.blob();
        const ticket = await api.createAttachmentUploadUrl(channelId, {
          mime: "image/gif",
          sizeBytes: blob.size,
        });
        await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/gif" },
          body: blob,
        });
        const { attachment } = await api.completeAttachment(ticket.attachmentId, {
          width: gif.fullWidth,
          height: gif.fullHeight,
        });
        sendChatMessage(channelId, "", {
          attachmentIds: [attachment.id],
          attachments: [attachment],
          localAttachmentUrls: {},
        });
        onClose();
      } catch {
        // Upload failed — the user can try again.
      }
      setSending(null);
    },
    [channelId, onClose, sending],
  );

  return (
    <div className="flex h-[400px] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-4 shrink-0 text-fg-faint" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("common:gif.search")}
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
        />
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2"
      >
        {gifs.length === 0 && !active.isLoading ? (
          <p className="py-8 text-center text-sm text-fg-muted">{t("common:gif.noResults")}</p>
        ) : (
          <div className="columns-2 gap-2">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                disabled={sending !== null}
                onClick={() => pickGif(gif)}
                className={cn(
                  "mb-2 block w-full cursor-pointer overflow-hidden rounded-lg transition-opacity",
                  sending === gif.id && "opacity-50",
                )}
              >
                <img
                  src={gif.previewUrl}
                  width={gif.previewWidth}
                  height={gif.previewHeight}
                  alt={gif.title}
                  loading="lazy"
                  className="w-full rounded-lg object-cover"
                  style={{ aspectRatio: `${gif.previewWidth}/${gif.previewHeight}` }}
                />
              </button>
            ))}
          </div>
        )}
        {active.isFetchingNextPage && (
          <div className="flex justify-center py-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        )}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-center text-2xs text-fg-faint">
        Powered by {t("common:gif.poweredBy")}
      </div>
    </div>
  );
}

function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
