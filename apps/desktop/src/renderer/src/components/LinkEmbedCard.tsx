import { memo, useState } from "react";
import type { MessageEmbed } from "@demli/types";
import { openExternalUrl } from "@demli/app-ui";

/**
 * Link-preview cards (M17). Rendered below a message's text from
 * the server-unfurled `MessageEmbed[]`. Every field is presentational metadata —
 * title/description/siteName render as PLAIN TEXT (never markdown/HTML), so a
 * hostile page title cannot inject markup (CLAUDE.md §28). A card only opens the
 * URL when it is http(s); a broken image collapses to a text-only card (§26 — no
 * broken-image icon). A message shows at most {@link MAX_EMBEDS} cards.
 */

/** Cap so a message never floods the column with preview cards. */
const MAX_EMBEDS = 3;
/** Reserved image height — a fixed box so the async image load never reflows the row. */
const IMAGE_HEIGHT_CLASS = "h-44";

/** Only http(s) links are openable/loadable — the backend filters, the client re-checks. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Bare host for a fallback accessible name (no URL constructor — RN parity). */
function displayHost(url: string): string {
  const host = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  return host ? host.replace(/^www\./i, "") : url;
}

/**
 * Open in the OS browser through the shared platform seam.
 *
 * NOT `window.open`: the desktop window's `setWindowOpenHandler` is an
 * unconditional deny (so an embedded third-party frame cannot use it as a url
 * launcher), and `openExternalUrl` routes to the validated preload verb there
 * while keeping a plain `noopener` tab on web.
 */
function openExternal(url: string): void {
  if (!isHttpUrl(url)) return;
  openExternalUrl(url);
}

const LinkEmbedCard = memo(function LinkEmbedCard({
  embed,
}: {
  embed: MessageEmbed;
}): JSX.Element {
  const [imageBroken, setImageBroken] = useState(false);
  const clickable = isHttpUrl(embed.url);
  const imageUrl =
    embed.imageUrl !== null && isHttpUrl(embed.imageUrl) && !imageBroken ? embed.imageUrl : null;
  // Fallback name for the (decorative-alt) image affordance when the card has no
  // title to act as the link's accessible name.
  const linkLabel = embed.title ?? embed.siteName ?? displayHost(embed.url);

  return (
    <div className="max-w-[620px] overflow-hidden rounded-md border border-stroke bg-[#171c25]">
      <div className="border-l-2 border-accent px-3 py-2">
        {embed.siteName && (
          <div className="text-2xs font-medium text-fg-faint">{embed.siteName}</div>
        )}
        {embed.title &&
          (clickable ? (
            <button
              type="button"
              onClick={() => openExternal(embed.url)}
              className="mt-0.5 line-clamp-2 rounded-sm text-left text-sm font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              {embed.title}
            </button>
          ) : (
            <div className="mt-0.5 line-clamp-2 text-sm font-semibold text-fg">{embed.title}</div>
          ))}
        {embed.description && (
          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-muted">
            {embed.description}
          </p>
        )}
        {imageUrl && (
          <div className="mt-2 overflow-hidden rounded">
            {clickable ? (
              <button
                type="button"
                onClick={() => openExternal(embed.url)}
                aria-label={linkLabel}
                className="block w-full cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <img
                  src={imageUrl}
                  alt=""
                  loading="lazy"
                  onError={() => setImageBroken(true)}
                  className={`w-full object-cover ${IMAGE_HEIGHT_CLASS}`}
                />
              </button>
            ) : (
              <img
                src={imageUrl}
                alt=""
                loading="lazy"
                onError={() => setImageBroken(true)}
                className={`w-full object-cover ${IMAGE_HEIGHT_CLASS}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * The stack of link-preview cards under a message (capped at {@link MAX_EMBEDS}).
 * Memoized: an unchanged `embeds` reference (the fold preserves it for untouched
 * messages) skips this subtree entirely (§27).
 */
export const MessageEmbeds = memo(function MessageEmbeds({
  embeds,
}: {
  embeds: MessageEmbed[];
}): JSX.Element {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {embeds.slice(0, MAX_EMBEDS).map((embed, i) => (
        <LinkEmbedCard key={`${embed.url}-${i}`} embed={embed} />
      ))}
    </div>
  );
});
