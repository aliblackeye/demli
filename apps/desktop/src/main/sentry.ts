import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import {
  SENTRY_CLIENT,
  SENTRY_LIMITS,
  type SentryCaptureInput,
  type SentryDsn,
  type SentryEvent,
  type SentryFrame,
  type SentryInitOptions,
  type SentryTransport,
  type SentryTransportResult,
} from "./sentry-types";

/**
 * Sentry error reporting (main process) — minimal, dependency-free client.
 *
 * WHY NOT `@sentry/electron`: that SDK pulls `@sentry/node`, which drags the
 * whole OpenTelemetry auto-instrumentation stack (~20 packages plus
 * import-in-the-middle). Our packaging model bundles main/preload/renderer into
 * `out/` and ships ZERO node_modules (see electron-builder.yml `files`), so
 * vendoring it would mean re-introducing a runtime dep tree, a much larger
 * installer, and a much larger supply-chain surface in a repo that is going
 * public. Instead we speak Sentry's public envelope protocol directly: one
 * HTTPS POST of a JSON event. Full rationale + upgrade path: ADR 0018 and
 * docs/architecture/crash-reporting.md.
 *
 * OFF BY DEFAULT. {@link initSentry} is a no-op unless a valid https DSN is
 * supplied. With no DSN there is no state, no handler, and — guaranteed by
 * `sentry.test.ts` — not a single network request.
 *
 * PRIVACY (CLAUDE.md §28). This client can only ever send what a caller hands
 * it, and every string passes {@link scrubText} first:
 *   - No user identity is ever attached (no id, email, username, IP) — the
 *     equivalent of Sentry's `sendDefaultPii: false`, except it is structural:
 *     there is no code path that reads an account.
 *   - No message content, no channel/group names, no tokens: the only callers
 *     are the crash reporter's error paths, which carry error text + stacks.
 *   - Stack file paths are normalized to `app:///…` so a Windows/macOS home
 *     directory (which contains the user's name) can never leave the machine.
 *   - No breadcrumbs, no automatic HTTP/console instrumentation — the classic
 *     way user content leaks into an error tracker simply does not exist here.
 *
 * The pre-existing LOCAL crash log (main/crash-reporter.ts) is unchanged and
 * remains the primary record; Sentry is a strictly additive second sink.
 */

// ---------------------------------------------------------------------------
// Scrubbing (the `beforeSend` equivalent)
// ---------------------------------------------------------------------------

/** JWT-shaped tokens (`eyJ…header.payload.signature`). */
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** `Authorization: Bearer <token>` / bare `Bearer <token>`. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** Email addresses. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Windows home directory: `C:\Users\<name>` (any drive letter, any separator). */
const WIN_HOME_RE = /([A-Za-z]:[\\/])Users[\\/][^\\/:*?"<>|\r\n]+/gi;
/** macOS home directory: `/Users/<name>`. */
const MAC_HOME_RE = /\/Users\/[^/\s:"'<>|]+/g;
/** Linux home directory: `/home/<name>`. */
const NIX_HOME_RE = /\/home\/[^/\s:"'<>|]+/g;
/** Query strings / fragments on URLs — invite codes, tokens, signed URLs. */
const URL_QUERY_RE = /(https?:\/\/[^\s"'<>]*?)[?#][^\s"'<>]*/gi;
/**
 * Long opaque runs: API keys, signatures, base64 blobs. Conservative length so
 * ordinary identifiers and minified bundle hashes in stacks survive readable.
 */
const LONG_SECRET_RE = /[A-Za-z0-9_-]{48,}/g;

/**
 * Redact anything that could carry personal data or a credential.
 *
 * Order matters: token shapes are matched BEFORE the generic long-run rule so
 * the output stays readable (`[jwt]` rather than `[redacted]`). Applied to every
 * string that reaches the wire — message, exception value, extras — and to raw
 * stacks before they are parsed.
 */
export function scrubText(input: string): string {
  return input
    .replace(JWT_RE, "[jwt]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(EMAIL_RE, "[email]")
    .replace(URL_QUERY_RE, "$1?[redacted]")
    .replace(WIN_HOME_RE, "$1Users\\[user]")
    .replace(MAC_HOME_RE, "/Users/[user]")
    .replace(NIX_HOME_RE, "/home/[user]")
    .replace(LONG_SECRET_RE, "[redacted]");
}

/**
 * Reduce an absolute source path to a stable, user-agnostic identifier.
 *
 * A packaged stack frame looks like
 * `C:\Users\ali\AppData\Local\Programs\Demli\resources\app.asar\out\main\index.js`.
 * We keep only the part from the build-output marker onward (`app:///out/main/index.js`),
 * which is both privacy-safe and better for Sentry grouping (identical across
 * machines). Anything without a recognizable marker collapses to its basename.
 */
export function normalizeFramePath(raw: string): string {
  let path = raw.trim();
  // Strip URL schemes used by Chromium/Node frames.
  path = path.replace(/^(file:\/\/\/?|app:\/\/\/?|electron:\/\/\/?)/i, "");
  // Windows separators -> POSIX so the markers below match on every platform.
  path = path.replace(/\\/g, "/");

  if (path.startsWith("node:") || path.startsWith("<anonymous")) {
    return path;
  }

  for (const marker of ["/out/", "/dist/", "/assets/", "/node_modules/"]) {
    const at = path.lastIndexOf(marker);
    if (at !== -1) {
      return `app://${path.slice(at)}`;
    }
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return basename.length > 0 ? `app:///${basename}` : "app:///unknown";
}

/**
 * Parse a V8 stack string into Sentry frames.
 *
 * Handles both `at fn (path:line:col)` and the anonymous `at path:line:col`
 * form. Frames are returned OLDEST FIRST, which is the order Sentry renders
 * bottom-to-top, and capped at {@link SENTRY_LIMITS.frames}.
 */
export function parseStack(stack: string | undefined): SentryFrame[] {
  if (!stack) {
    return [];
  }
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n")) {
    const match =
      /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line) ?? undefined;
    if (!match) {
      continue;
    }
    const [, fnName, file, lineNo, colNo] = match;
    if (!file || !lineNo || !colNo) {
      continue;
    }
    const filename = normalizeFramePath(file);
    frames.push({
      filename,
      ...(fnName ? { function: fnName } : {}),
      lineno: Number(lineNo),
      colno: Number(colNo),
      // Anything we shipped lives under app:///out or app:///assets; a
      // node: builtin or a node_modules frame is not "ours".
      in_app:
        filename.startsWith("app:///out/") ||
        filename.startsWith("app:///assets/"),
    });
    if (frames.length >= SENTRY_LIMITS.frames) {
      break;
    }
  }
  return frames.reverse();
}

// ---------------------------------------------------------------------------
// DSN
// ---------------------------------------------------------------------------

/**
 * Parse a Sentry DSN into its ingest endpoint.
 *
 * Returns `null` for anything unusable — empty, malformed, non-https, missing
 * key or project id. A `null` here means the client stays disabled, which is
 * the safe direction: a typo can never turn into a half-working reporter.
 */
export function parseDsn(raw: string | undefined): SentryDsn | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // https only. Diagnostics must never travel in plaintext (same rule as the
  // auto-update feed).
  if (url.protocol !== "https:") {
    return null;
  }
  const publicKey = url.username;
  if (!publicKey) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^\d+$/.test(projectId)) {
    return null;
  }
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  const query = new URLSearchParams({
    sentry_key: publicKey,
    sentry_version: "7",
    sentry_client: `${SENTRY_CLIENT.name}/${SENTRY_CLIENT.version}`,
  });
  return {
    publicKey,
    host: url.host,
    projectId,
    envelopeUrl: `https://${url.host}${prefix}/api/${projectId}/envelope/?${query.toString()}`,
  };
}

// ---------------------------------------------------------------------------
// Event + envelope construction (pure)
// ---------------------------------------------------------------------------

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Build the Sentry event body. Pure — exported so tests can assert the payload. */
export function buildEvent(
  input: SentryCaptureInput,
  config: {
    release: string;
    environment: string;
    osName: string;
    electronVersion?: string;
    eventId: string;
    timestamp: number;
  },
): SentryEvent {
  const message = clamp(
    scrubText(input.message).trim() || "Unknown error",
    SENTRY_LIMITS.message,
  );
  const frames = parseStack(
    input.stack ? scrubText(input.stack) : undefined,
  );

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    extra[key] = clamp(scrubText(value), SENTRY_LIMITS.message);
  }
  if (input.componentStack) {
    // Component stacks are React element names — no user content — but scrub
    // anyway so a path baked into a lazy-import frame cannot slip through.
    extra["componentStack"] = clamp(
      scrubText(input.componentStack),
      SENTRY_LIMITS.message,
    );
  }

  return {
    event_id: config.eventId,
    timestamp: config.timestamp,
    platform: input.process === "main" ? "node" : "javascript",
    level: input.level ?? "error",
    logger: `demli.desktop.${input.process}`,
    release: `demli-desktop@${config.release}`,
    environment: config.environment,
    sdk: { name: SENTRY_CLIENT.name, version: SENTRY_CLIENT.version },
    tags: {
      process: input.process,
      os: config.osName,
    },
    contexts: {
      os: { name: config.osName },
      runtime: { name: "electron", version: config.electronVersion ?? "unknown" },
      app: { app_version: config.release },
    },
    exception: {
      values: [
        {
          type: input.type ?? "Error",
          value: message,
          ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
          mechanism: {
            type: `demli.${input.process}`,
            handled: input.handled ?? true,
          },
        },
      ],
    },
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/**
 * Wrap an event in a Sentry envelope: a newline-delimited document of
 * `<envelope header>\n<item header>\n<item payload>\n`.
 */
export function buildEnvelope(event: SentryEvent, dsn: string): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn,
  });
  const payload = JSON.stringify(event);
  const itemHeader = JSON.stringify({
    type: "event",
    content_type: "application/json",
    length: Buffer.byteLength(payload, "utf8"),
  });
  return `${header}\n${itemHeader}\n${payload}\n`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Default sender: one `node:https` POST, hard-timeout, never throws.
 * Any failure (offline, DNS, TLS, 5xx) resolves to status 0 and is forgotten —
 * error reporting must never affect the app.
 */
const httpsTransport: SentryTransport = (url, body) =>
  new Promise<SentryTransportResult>((resolve) => {
    let settled = false;
    const done = (result: SentryTransportResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-sentry-envelope",
            "content-length": Buffer.byteLength(body, "utf8"),
          },
          timeout: SENTRY_LIMITS.timeoutMs,
        },
        (res) => {
          const retryAfter = Number(res.headers["retry-after"]);
          res.resume(); // drain, we do not care about the body
          res.on("end", () =>
            done({
              status: res.statusCode ?? 0,
              ...(Number.isFinite(retryAfter) && retryAfter > 0
                ? { retryAfterMs: retryAfter * 1000 }
                : {}),
            }),
          );
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done({ status: 0 });
      });
      req.on("error", () => done({ status: 0 }));
      req.end(body);
    } catch {
      done({ status: 0 });
    }
  });

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

interface ActiveClient {
  dsn: SentryDsn;
  rawDsn: string;
  release: string;
  environment: string;
  osName: string;
  electronVersion?: string;
  transport: SentryTransport;
}

/** `null` = disabled. This is the default and the shipped state. */
let client: ActiveClient | null = null;
let sentCount = 0;
let disabledUntil = 0;
const seen = new Set<string>();

/**
 * Initialize the reporter. Safe to call once, early (before `app.whenReady()`).
 *
 * Returns `true` only when a valid DSN produced an active client. With no DSN —
 * the default for every build until the founder pastes one in — this returns
 * `false` immediately and the module stays completely inert.
 */
export function initSentry(options: SentryInitOptions): boolean {
  const dsn = parseDsn(options.dsn);
  if (!dsn) {
    client = null;
    return false;
  }
  client = {
    dsn,
    rawDsn: (options.dsn ?? "").trim(),
    release: options.release,
    environment: options.environment,
    osName: options.osName,
    ...(options.electronVersion
      ? { electronVersion: options.electronVersion }
      : {}),
    transport: options.transport ?? httpsTransport,
  };
  sentCount = 0;
  disabledUntil = 0;
  seen.clear();
  return true;
}

/** True when a valid DSN was supplied and the client may send. */
export function isSentryEnabled(): boolean {
  return client !== null;
}

/** Test/teardown helper: return to the disabled default state. */
export function resetSentryForTests(): void {
  client = null;
  sentCount = 0;
  disabledUntil = 0;
  seen.clear();
}

/**
 * Fingerprint used for in-session deduplication: the same error thrown in a
 * loop costs one event, not a thousand.
 */
function fingerprint(input: SentryCaptureInput): string {
  const firstFrame = input.stack?.split("\n")[1]?.trim() ?? "";
  return `${input.process}|${input.type ?? ""}|${input.message}|${firstFrame}`.slice(
    0,
    300,
  );
}

/**
 * Send one error to Sentry. NO-OP when disabled, rate-limited, or duplicated.
 * Fire-and-forget: never throws, never rejects, never blocks the caller.
 */
export function captureSentryError(input: SentryCaptureInput): void {
  const active = client;
  if (!active) {
    return; // disabled — the shipped default. No state touched, no request made.
  }
  if (sentCount >= SENTRY_LIMITS.eventsPerSession) {
    return;
  }
  if (disabledUntil > Date.now()) {
    return;
  }
  const key = fingerprint(input);
  if (seen.has(key)) {
    return;
  }
  if (seen.size >= SENTRY_LIMITS.dedupe) {
    seen.clear();
  }
  seen.add(key);
  sentCount += 1;

  const event = buildEvent(input, {
    release: active.release,
    environment: active.environment,
    osName: active.osName,
    ...(active.electronVersion
      ? { electronVersion: active.electronVersion }
      : {}),
    eventId: randomUUID().replace(/-/g, ""),
    timestamp: Math.floor(Date.now() / 1000),
  });

  const body = buildEnvelope(event, active.rawDsn);
  void active
    .transport(active.dsn.envelopeUrl, body)
    .then((result) => {
      if (result.status === 429) {
        disabledUntil =
          Date.now() + (result.retryAfterMs ?? SENTRY_LIMITS.defaultBackoffMs);
      }
    })
    .catch(() => {
      // Swallow — a reporting failure must stay invisible.
    });
}
