/**
 * Pick a video for a watch party — by searching YouTube from inside the app, or
 * by pasting a link (M20 wave 3).
 *
 * ## Why this is not "a browser inside the app"
 *
 * The founder asked for an in-app browser to pick from. It cannot be built:
 * `youtube.com` sends `X-Frame-Options: SAMEORIGIN`, so it refuses to be framed
 * at all, and reaching for an Electron `<webview>` would punch a hole straight
 * through the containment this feature is built on (one framed origin, one CSP
 * line, no new script origin). What the request actually WANTS — choose a video
 * without leaving the app, without hunting a link in a real browser — is what
 * this dialog does, through our own server's search route.
 *
 * ## One input, two meanings, and the quota is the reason
 *
 * YouTube's Data API gives this deployment roughly a hundred searches a DAY for
 * everyone combined. So:
 *
 *  - Nothing is searched while typing. A search happens on an EXPLICIT act —
 *    Enter, or the button — and never on a keystroke. A 300 ms debounce over a
 *    twelve-character query is still eight searches for one video; at ~100 a day
 *    that is the whole server's budget spent by two people looking for one clip.
 *  - A pasted link never searches at all. The submit handler parses the field
 *    first, and a parseable ref is used directly: the overwhelmingly common
 *    "somebody sent me a link" path costs zero quota.
 *  - Repeat submissions of the query already on screen do not re-search (see
 *    `lastQuery`), so a double-Enter or a second click is free.
 *
 * The caller owns the actual request and any further caching; this component
 * owns only the promise that a request is never issued without a deliberate act.
 *
 * ## When search is off, there is no search box
 *
 * A deployment with no API key answers `{ searchEnabled: false }`, and then the
 * search affordance is not rendered at all — not greyed out, not present-but-
 * failing (§35). The dialog becomes exactly the paste-a-link dialog it used to
 * be, with copy that says so.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, MonitorPlay, Search, TriangleAlert } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import { parseYouTubeVideoId } from "@demli/config";
import { formatWatchDuration, type WatchSearchFailure } from "./watchQueue";

/** One search hit, exactly as `GET /watch/search` returns it. */
export interface WatchPickerResult {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number | null;
  thumbnailUrl: string;
}

export type WatchPickerStatus = "idle" | "searching" | "done" | "error";

export interface WatchPickerSearchState {
  status: WatchPickerStatus;
  /** The query the current `results` / `failure` belong to. */
  query: string;
  results: readonly WatchPickerResult[];
  /** Set when `status === "error"`; decides which of the three copies shows. */
  failure: WatchSearchFailure | null;
}

export const IDLE_WATCH_SEARCH: WatchPickerSearchState = {
  status: "idle",
  query: "",
  results: [],
  failure: null,
};

/** What the picker is being used for — it only changes the verb and the title. */
export type WatchPickerMode = "start" | "change" | "queue";

export interface WatchVideoPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: WatchPickerMode;
  /**
   * Whether this deployment can search at all. `null` while capabilities are
   * still loading — treated as "not yet", so the search affordance appears once
   * and never flickers in and then out.
   */
  searchEnabled: boolean | null;
  search: WatchPickerSearchState;
  /** Run a search. Only ever called from an explicit user act — see the header. */
  onSearch: (query: string) => void;
  /** Clear whatever the last search left behind (called when the dialog opens). */
  onResetSearch: () => void;
  /**
   * A chosen video. `videoRef` is RAW — a pasted link or a picked id — because
   * the server owns normalization and re-parses it either way. `title` and
   * `durationSeconds` are passed through from a search hit so the queue can show
   * something more useful than an 11-character id.
   */
  onSubmit: (input: {
    videoRef: string;
    title?: string;
    durationSeconds?: number;
  }) => void;
}

export function WatchVideoPicker({
  open,
  onOpenChange,
  mode,
  searchEnabled,
  search,
  onSearch,
  onResetSearch,
  onSubmit,
}: WatchVideoPickerProps): JSX.Element {
  const { t } = useTranslation(["desktop"]);
  const [value, setValue] = useState("");
  const [linkError, setLinkError] = useState(false);
  /**
   * The last query THIS dialog asked for. Guards the repeat submission — a
   * second Enter on an unchanged field must not spend a second unit of a shared
   * daily budget. Kept in a ref: it never affects what is drawn.
   */
  const lastQueryRef = useRef<string | null>(null);
  const onResetSearchRef = useRef(onResetSearch);
  onResetSearchRef.current = onResetSearch;

  // Every opening starts clean. A query (or a link) left over from the previous
  // party is never the one being asked for now, and stale results next to an
  // empty box would look like an answer to a question nobody asked.
  useEffect(() => {
    if (!open) return;
    setValue("");
    setLinkError(false);
    lastQueryRef.current = null;
    onResetSearchRef.current();
  }, [open]);

  const canSearch = searchEnabled === true;

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    // A link wins, always, and spends no quota.
    const videoId = parseYouTubeVideoId(trimmed);
    if (videoId !== null) {
      setLinkError(false);
      onSubmit({ videoRef: trimmed });
      onOpenChange(false);
      return;
    }

    if (!canSearch) {
      // No search on this deployment: an unparseable string is simply a bad
      // link, and saying so is the whole of the honest answer.
      setLinkError(true);
      return;
    }

    setLinkError(false);
    if (lastQueryRef.current === trimmed && search.status !== "error") return;
    lastQueryRef.current = trimmed;
    onSearch(trimmed);
  };

  const pick = (result: WatchPickerResult): void => {
    onSubmit({
      videoRef: result.videoId,
      title: result.title,
      ...(result.durationSeconds === null
        ? {}
        : { durationSeconds: result.durationSeconds }),
    });
    onOpenChange(false);
  };

  const title =
    mode === "start"
      ? t("desktop:watchParty.startTitle")
      : mode === "change"
        ? t("desktop:watchParty.changeTitle")
        : t("desktop:watchParty.queueAddTitle");

  const action =
    mode === "start"
      ? t("desktop:watchParty.startAction")
      : mode === "change"
        ? t("desktop:watchParty.changeAction")
        : t("desktop:watchParty.queueAddAction");

  const failureMessage =
    search.status !== "error" || search.failure === null
      ? null
      : search.failure === "disabled"
        ? t("desktop:watchParty.searchDisabled")
        : search.failure === "quota"
          ? t("desktop:watchParty.searchQuota")
          : search.failure === "unavailable"
            ? t("desktop:watchParty.searchUnavailable")
            : t("desktop:watchParty.searchFailed");

  const showEmptyResults =
    canSearch && search.status === "done" && search.results.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {canSearch
              ? t("desktop:watchParty.searchDescription")
              : t("desktop:watchParty.linkDescription")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div className="flex items-center gap-2">
            {canSearch ? (
              <Search className="size-5 shrink-0 text-fg-muted" aria-hidden />
            ) : (
              <MonitorPlay className="size-5 shrink-0 text-fg-muted" aria-hidden />
            )}
            <Input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setLinkError(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submit();
              }}
              placeholder={
                canSearch
                  ? t("desktop:watchParty.searchPlaceholder")
                  : t("desktop:watchParty.linkPlaceholder")
              }
              aria-label={
                canSearch
                  ? t("desktop:watchParty.searchLabel")
                  : t("desktop:watchParty.linkLabel")
              }
              aria-invalid={linkError}
            />
            {/* The explicit search act. Rendered ONLY where search exists, so
                there is never a button whose whole job the server refuses. */}
            {canSearch && (
              <Button
                variant="secondary"
                onClick={submit}
                disabled={value.trim().length === 0 || search.status === "searching"}
              >
                {search.status === "searching" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
                {t("desktop:watchParty.searchAction")}
              </Button>
            )}
          </div>

          {linkError && (
            <p role="alert" className="text-xs text-danger">
              {t("desktop:watchParty.linkInvalid")}
            </p>
          )}

          {failureMessage !== null && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-fg"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>{failureMessage}</span>
            </p>
          )}

          {showEmptyResults && (
            <p className="rounded-lg border border-stroke bg-raised/60 px-3 py-2 text-xs text-fg-muted">
              {t("desktop:watchParty.searchNoResults", { query: search.query })}
            </p>
          )}

          {canSearch && search.results.length > 0 && (
            <ul
              aria-label={t("desktop:watchParty.searchResultsLabel")}
              className="max-h-72 space-y-1 overflow-y-auto"
            >
              {search.results.map((result) => {
                const duration = formatWatchDuration(result.durationSeconds);
                return (
                  <li key={result.videoId}>
                    <button
                      type="button"
                      onClick={() => pick(result)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg border border-transparent p-1.5 text-left transition-colors",
                        "hover:border-stroke hover:bg-raised/70 focus-visible:border-accent focus-visible:outline-none",
                      )}
                    >
                      {/* Served by i.ytimg.com, which is on the img-src allow
                          list for exactly this. `onError` collapses the element
                          rather than leaving a broken-image glyph if a single
                          thumbnail 404s. */}
                      <img
                        src={result.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        width={112}
                        height={63}
                        className="h-[63px] w-28 shrink-0 rounded-md bg-black object-cover"
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        {/* Untrusted YouTube text — a text node, never markup. */}
                        <span className="line-clamp-2 block text-xs leading-snug text-fg">
                          {result.title}
                        </span>
                        <span className="mt-1 block truncate text-2xs text-fg-faint">
                          {duration === null
                            ? result.channelTitle
                            : `${result.channelTitle} · ${duration}`}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="rounded-lg border border-stroke bg-raised/60 px-3 py-2 text-2xs leading-relaxed text-fg-muted">
            {t("desktop:watchParty.drmNote")}
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("desktop:watchParty.cancel")}
          </Button>
          {/* The footer verb commits the LINK in the field. It is meaningless
              for a search phrase, so it only appears once the field actually
              holds a video reference. */}
          {parseYouTubeVideoId(value.trim()) !== null && (
            <Button onClick={submit}>{action}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
