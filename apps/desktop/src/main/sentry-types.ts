/**
 * Shared Sentry contract (desktop).
 *
 * Pure TypeScript types plus tuning constants, importing NOTHING from
 * `electron` or `node` — mirroring `crash-reporter-types.ts`. That keeps it
 * safe to import from the main process, from unit tests, and (type-only) from
 * anywhere else without dragging a runtime dependency along.
 *
 * Do not add electron/node imports here.
 */

/** Which process an event came from. Becomes the `process` tag in Sentry. */
export type SentryProcessTag = "main" | "renderer";

/** Sentry severity levels we actually emit. */
export type SentryLevel = "fatal" | "error" | "warning";

/** Parsed pieces of a Sentry DSN (`https://<publicKey>@<host>/<projectId>`). */
export interface SentryDsn {
  /** The public key (DSN username). Safe to embed in a client. */
  publicKey: string;
  /** Host (+ port) of the ingest endpoint. */
  host: string;
  /** Numeric project id (last DSN path segment). */
  projectId: string;
  /** Fully built envelope endpoint, query string included. */
  envelopeUrl: string;
}

/** One normalized stack frame, in Sentry's wire shape. */
export interface SentryFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** The subset of the Sentry event schema this client produces. */
export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node" | "javascript";
  level: SentryLevel;
  logger: string;
  release: string;
  environment: string;
  sdk: { name: string; version: string };
  tags: Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  exception: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: { frames: SentryFrame[] };
      mechanism: { type: string; handled: boolean };
    }>;
  };
  extra?: Record<string, string>;
}

/** What the caller hands us; everything else is derived. */
export interface SentryCaptureInput {
  /** Error message. Scrubbed before it leaves the machine. */
  message: string;
  /** Optional JS stack trace. Paths are normalized, never sent verbatim. */
  stack?: string;
  /** Optional React component stack (renderer errors only). */
  componentStack?: string;
  /** Which process produced it. */
  process: SentryProcessTag;
  /** Severity (default `error`). */
  level?: SentryLevel;
  /** Error class name, when known (used for Sentry grouping). */
  type?: string;
  /** True when the app caught and handled the error itself. */
  handled?: boolean;
  /**
   * Extra diagnostic key/values. STRINGS ONLY, and they are scrubbed like the
   * message — never put user content, tokens, ids, or free text here.
   */
  extra?: Record<string, string>;
}

/**
 * A pluggable network sender. The default is a `node:https` POST; tests inject
 * a fake so we can assert that a disabled client performs ZERO requests.
 */
export type SentryTransport = (
  url: string,
  body: string,
) => Promise<SentryTransportResult>;

export interface SentryTransportResult {
  status: number;
  /** Milliseconds to back off for, parsed from a 429 `Retry-After`. */
  retryAfterMs?: number;
}

/** Everything {@link initSentry} needs. Nothing is read from globals. */
export interface SentryInitOptions {
  /**
   * The DSN. **Empty / missing / malformed disables the client entirely** — no
   * init, no state, no network. This is the default: the app ships with no DSN.
   */
  dsn: string | undefined;
  /** App version, becomes the Sentry release (`demli-desktop@<version>`). */
  release: string;
  /** `production` for packaged builds, `development` otherwise. */
  environment: string;
  /** `process.platform` — recorded as a coarse OS tag (no version, no hostname). */
  osName: string;
  /** Electron runtime version, for the `runtime` context. */
  electronVersion?: string;
  /** Override the network sender (tests). */
  transport?: SentryTransport;
}

/** Bounds + tuning. Deliberately small: this is diagnostics, not analytics. */
export const SENTRY_LIMITS = {
  /** Max characters kept from a message (Sentry truncates far later anyway). */
  message: 1000,
  /** Max stack frames sent per event. */
  frames: 30,
  /** Max events sent per app run — a crash loop can never spam the quota. */
  eventsPerSession: 25,
  /** How many event fingerprints we remember for deduplication. */
  dedupe: 50,
  /** Network timeout for one envelope POST (ms). */
  timeoutMs: 10_000,
  /** Fallback backoff when a 429 has no usable `Retry-After` (ms). */
  defaultBackoffMs: 60_000,
} as const;

/** Identifies this hand-rolled client in Sentry's UI. See ADR 0016. */
export const SENTRY_CLIENT = {
  name: "demli.desktop.minimal",
  version: "1.0.0",
} as const;
