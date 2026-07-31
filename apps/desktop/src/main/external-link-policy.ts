/**
 * Which urls the app is willing to hand to the OS browser.
 *
 * Pure and electron-free so the decision can be unit-tested — the same shape as
 * `frame-navigation-policy.ts` and `image-actions-policy.ts`, and for the same
 * reason: a security predicate that can only be exercised by launching the app
 * is a security predicate nobody exercises.
 *
 * ## Why this exists at all
 *
 * `shell.openExternal` hands a string to the operating system, which picks a
 * handler by SCHEME. `https:` opens a browser tab; a custom scheme can start a
 * registered application with an attacker-chosen argument, and `file:` opens
 * local content. So the scheme — not the host — is the security boundary here,
 * and it is checked by PARSING the url, never by prefix-matching it.
 *
 * ## Why the host is NOT restricted
 *
 * Unlike the image-action allow-list, there is no fixed set of legitimate hosts:
 * the whole point is that a user clicked a link someone posted in chat. The bar
 * is therefore "a real web address, opened in a browser, after a click in OUR
 * ui" — which is what the caller-side rules enforce (see `external-link.ts`:
 * only the top frame of one of our own windows may invoke this, and the window
 * open handler is an unconditional deny so embedded third-party content has no
 * path in).
 */

/**
 * The window-open decision: DENY, always.
 *
 * Installed as the app window's `setWindowOpenHandler`. It takes NO ARGUMENTS on
 * purpose — the handler is called with the requested url, and a function that
 * cannot see the url cannot be talked into branching on it. That is the whole
 * property this change is about: the previous handler forwarded any `https://`
 * url to `shell.openExternal`, which was reachable from the Watch Party embed's
 * own links (M20 / ADR 0016) and made a hostile embed a launcher for arbitrary
 * urls. Our own links go through the validated `external-link:open` IPC instead.
 *
 * Lives in the policy module (not inline in `index.ts`) so the guarantee is
 * unit-testable without booting Electron.
 */
export function denyWindowOpen(): { readonly action: "deny" } {
  return { action: "deny" } as const;
}

/**
 * Longest url we will forward.
 *
 * Chosen to be comfortably above any real shared link while keeping a bound on
 * what crosses IPC and reaches an OS API. Matches the image-action cap, so the
 * two url-taking channels refuse at the same size.
 */
export const EXTERNAL_LINK_MAX_URL_LENGTH = 2048;

/** The only schemes a browser tab can come from. */
const OPENABLE_PROTOCOLS: readonly string[] = ["http:", "https:"];

/**
 * The NORMALIZED url that may be handed to `shell.openExternal`, or `null`.
 *
 * Returns the serialized form rather than a boolean on purpose: validating one
 * string and then forwarding a DIFFERENT one is the parse-versus-use gap, and it
 * is not theoretical here. `new URL()` accepts input the serializer would rewrite,
 * so a raw string that passes this check can still carry things the parsed object
 * never contained:
 *
 *   `https://good.test/a" --gpu-launcher=calc.exe`  → quote and spaces survive
 *   `ht\ttps://evil.test/x`                          → tab inside the scheme
 *   `"  \r\n https://evil.test/x"`                   → leading control characters
 *   `https://еxample.test/` (Cyrillic е)             → homograph, not punycode
 *
 * On Windows that string reaches `ShellExecute` and then the default browser's
 * registry `%1` template, which is the classic argument-injection shape — and the
 * whole string is attacker-chosen (a link pasted into chat, clicked in the message
 * renderer). Current Chrome/Firefox defend themselves, but that puts the defence
 * in someone else's product. Forwarding `.href` closes it here, and folds the
 * homograph to punycode as a side effect.
 *
 * Fails CLOSED. Refused: anything that is not a string, an empty or oversized
 * string, anything that does not parse as an absolute url (a bare path, a
 * protocol-relative `//host`), any scheme other than http/https (`javascript:`,
 * `data:`, `file:`, `mailto:`, `ms-msdt:` and every other custom handler), a url
 * carrying embedded credentials (`https://user:pass@host` — a phishing shape the
 * browser's address bar renders confusingly), and a url with no host.
 */
export function openableExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > EXTERNAL_LINK_MAX_URL_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (!OPENABLE_PROTOCOLS.includes(parsed.protocol)) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname === "") return null;
  // Re-check the SERIALIZED form against the length bound: percent-encoding can
  // only grow the string, and the cap exists to bound what reaches an OS API.
  if (parsed.href.length > EXTERNAL_LINK_MAX_URL_LENGTH) return null;
  return parsed.href;
}

/** Boolean convenience for call sites that only need the verdict. */
export function isOpenableExternalUrl(value: unknown): boolean {
  return openableExternalUrl(value) !== null;
}
