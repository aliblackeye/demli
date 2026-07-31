/**
 * Thin Supabase Storage wrapper (ADR 0008 §3) — the SOLE holder of the service
 * key inside the API. Every attachment endpoint mints signed upload/read URLs,
 * probes objects and purges bytes through this interface and nothing else, so
 * the privileged key never leaks into route handlers, DTOs, or clients (§28).
 *
 * Deliberately fetch-based against the Supabase Storage REST API rather than the
 * `@supabase/storage-js` SDK: the API bundle stays small and the dependency
 * surface minimal (plan §3 — "no SDK unless the plan says otherwise"). The REST
 * shapes below follow the documented Storage API; because the task forbids a
 * live upload smoke against the shared/prod bucket, this wrapper is exercised in
 * tests via injection/mocking — production URL shapes are covered by comments
 * and the integration flow runs against a mocked storage.
 */

import { ApiError } from "../errors.js";

/** A signed URL the client PUTs raw file bytes to (direct client→Supabase upload). */
export interface SignedUpload {
  /** Absolute URL the client uploads to (token embedded in the query). */
  uploadUrl: string;
  /** ISO instant after which the upload URL stops working. */
  expiresAt: string;
}

/** A short-lived signed read URL for one object. */
export interface SignedRead {
  url: string;
  /** ISO instant after which `url` must be re-requested. */
  expiresAt: string;
}

/** Result of probing an object: existence, total size, and its leading bytes. */
export interface ObjectProbe {
  exists: boolean;
  /** Total object size from the range response, or null when unknown/missing. */
  sizeBytes: number | null;
  /** Leading bytes for magic-byte sniffing (possibly shorter than requested). */
  head: Uint8Array;
}

/**
 * The storage surface the API depends on. Kept small and injectable so tests
 * pass a mock and never touch a live bucket.
 */
export interface AttachmentStorage {
  /** Sign a direct client upload to `path` (bucket-relative object key). */
  createSignedUploadUrl(path: string): Promise<SignedUpload>;
  /** Sign a short-lived read URL for `path`, valid for `ttlSeconds`. */
  createSignedReadUrl(path: string, ttlSeconds: number): Promise<SignedRead>;
  /** Range-GET the first `sniffBytes` of `path`: existence + size + head bytes. */
  probeObject(path: string, sniffBytes: number): Promise<ObjectProbe>;
  /**
   * Upload `bytes` to `path` THROUGH the API (M17, custom emoji).
   *
   * Deliberately different from the signed direct-upload path that attachments
   * use, and only for small objects. An attachment can be 100 MB, so routing it
   * through the API would be an obvious waste — hence the sign/PUT/complete
   * dance, with a magic-byte probe afterwards to check what the client actually
   * uploaded. A custom emoji is capped at 256 KB, and routing those bytes through
   * the API buys a strictly better security property: the server sniffs the REAL
   * bytes BEFORE anything is stored, so an unverified object never exists in the
   * bucket at all and there is no pending-row/orphan-sweep machinery to maintain.
   *
   * Callers MUST validate size and magic bytes before calling.
   */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Best-effort bulk delete of bucket-relative object keys. */
  remove(paths: string[]): Promise<void>;
}

/**
 * The storage surface avatar uploads depend on — a deliberately small subset
 * plus {@link AvatarStorage.publicUrl}. Avatars live in a PUBLIC bucket and are
 * served by a stable URL persisted on the user row (never signed per read like an
 * attachment), so the only extra operation over the emoji path is turning an
 * object key into its public URL. Kept injectable so tests never touch a bucket.
 */
export interface AvatarStorage {
  /** Upload verified avatar bytes to `path` (bucket-relative object key). */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Best-effort delete of a previous avatar object (superseded on re-upload). */
  remove(paths: string[]): Promise<void>;
  /** The stable public URL for `path` in this (public) bucket. Synchronous — no I/O. */
  publicUrl(path: string): string;
}

export interface SupabaseStorageConfig {
  supabaseUrl: string;
  serviceKey: string;
  bucket: string;
}

/** Supabase signed upload URLs default to a 2-hour validity. */
const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;

/** Encode each path segment but preserve the `/` separators of the object key. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

class SupabaseAttachmentStorage implements AttachmentStorage {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: SupabaseStorageConfig) {
    this.base = `${config.supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
    this.headers = {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
    };
  }

  /** Resolve a Supabase-returned relative URL (`/object/...`) to an absolute one. */
  private absolute(relative: string): string {
    if (/^https?:\/\//i.test(relative)) return relative;
    const suffix = relative.startsWith("/") ? relative : `/${relative}`;
    return `${this.base}${suffix}`;
  }

  async createSignedUploadUrl(path: string): Promise<SignedUpload> {
    const res = await fetch(
      `${this.base}/object/upload/sign/${this.config.bucket}/${encodePath(path)}`,
      { method: "POST", headers: this.headers },
    );
    if (!res.ok) throw storageError("sign upload URL", res.status);
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new ApiError(502, "INTERNAL", "Storage did not return an upload URL.");
    return {
      uploadUrl: this.absolute(body.url),
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async createSignedReadUrl(path: string, ttlSeconds: number): Promise<SignedRead> {
    const res = await fetch(
      `${this.base}/object/sign/${this.config.bucket}/${encodePath(path)}`,
      {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      },
    );
    if (!res.ok) throw storageError("sign read URL", res.status);
    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const relative = body.signedURL ?? body.signedUrl;
    if (!relative) throw new ApiError(502, "INTERNAL", "Storage did not return a signed URL.");
    return {
      url: this.absolute(relative),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async probeObject(path: string, sniffBytes: number): Promise<ObjectProbe> {
    const res = await fetch(
      `${this.base}/object/${this.config.bucket}/${encodePath(path)}`,
      {
        method: "GET",
        headers: { ...this.headers, range: `bytes=0-${Math.max(0, sniffBytes - 1)}` },
      },
    );
    if (res.status === 404 || res.status === 400) {
      return { exists: false, sizeBytes: null, head: new Uint8Array(0) };
    }
    if (!res.ok) throw storageError("probe object", res.status);

    const head = new Uint8Array(await res.arrayBuffer());
    return { exists: true, sizeBytes: totalSizeFromRange(res.headers), head };
  }

  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // `x-upsert: false` so an emoji upload can never overwrite an existing
    // object. Paths are random UUIDs, so a collision means something is wrong —
    // failing loudly beats silently clobbering another group's emoji.
    const res = await fetch(`${this.base}/object/${this.config.bucket}/${encodePath(path)}`, {
      method: "POST",
      headers: {
        ...this.headers,
        "content-type": contentType,
        "x-upsert": "false",
      },
      // `Buffer`/`Uint8Array` is a valid BodyInit; copy into a fresh view so a
      // pooled Buffer's offset never sends neighbouring bytes.
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw storageError("upload object", res.status);
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const res = await fetch(`${this.base}/object/${this.config.bucket}`, {
      method: "DELETE",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) throw storageError("delete objects", res.status);
  }

  /**
   * The stable public URL for `path`. Only meaningful when this instance points
   * at a PUBLIC bucket (avatars): Supabase serves public objects at
   * `/storage/v1/object/public/<bucket>/<key>` with no token. Path segments are
   * encoded but the `/` separators preserved, exactly like the signed paths.
   */
  publicUrl(path: string): string {
    return `${this.base}/object/public/${this.config.bucket}/${encodePath(path)}`;
  }
}

/** `Content-Range: bytes 0-15/12345` → 12345; falls back to Content-Length. */
function totalSizeFromRange(headers: Headers): number | null {
  const contentRange = headers.get("content-range");
  if (contentRange) {
    const total = contentRange.split("/")[1];
    if (total && total !== "*") {
      const n = Number.parseInt(total, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  const contentLength = headers.get("content-length");
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function storageError(action: string, status: number): ApiError {
  // Never surface storage internals to a client; log-friendly message only.
  return new ApiError(502, "INTERNAL", `Storage backend failed to ${action} (status ${status}).`);
}

/**
 * Build the storage wrapper from env, or return `null` when the Supabase config
 * is incomplete — the signal that the attachments feature is disabled. Callers
 * MUST treat `null` as "feature off" and answer ATTACHMENTS_DISABLED; they must
 * never construct a client with partial config (which would fail per-request).
 */
export function createAttachmentStorage(env: {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  supabaseStorageBucket?: string;
}): AttachmentStorage | null {
  if (!env.supabaseUrl || !env.supabaseServiceKey || !env.supabaseStorageBucket) {
    return null;
  }
  return new SupabaseAttachmentStorage({
    supabaseUrl: env.supabaseUrl,
    serviceKey: env.supabaseServiceKey,
    bucket: env.supabaseStorageBucket,
  });
}

/**
 * Build the avatar (public bucket) storage wrapper from env, or return `null`
 * when it is not fully configured — the signal that avatar uploads are OFF.
 * Reuses the attachment SUPABASE_URL + service key but a SEPARATE public bucket
 * (`SUPABASE_AVATAR_BUCKET`), so turning uploads on is one env line for the
 * founder and production is untouched until then. Callers MUST treat `null` as
 * "feature off" and answer AVATAR_UPLOADS_DISABLED (503).
 */
export function createAvatarStorage(env: {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  supabaseAvatarBucket?: string;
}): AvatarStorage | null {
  if (!env.supabaseUrl || !env.supabaseServiceKey || !env.supabaseAvatarBucket) {
    return null;
  }
  return new SupabaseAttachmentStorage({
    supabaseUrl: env.supabaseUrl,
    serviceKey: env.supabaseServiceKey,
    bucket: env.supabaseAvatarBucket,
  });
}

/**
 * The bucket-relative object key for an avatar/banner URL, IFF it is one of ours
 * (a public URL in this bucket). Returns null for an external URL (a Google
 * avatar or a user-pasted link), so purging a superseded object never touches one
 * we do not own. Path segments are URL-decoded back to their stored form.
 *
 * Works for every image the public bucket holds — avatars, profile banners and
 * server banners all live in it under different prefixes — which is why it sits
 * here rather than inside one module: the group-banner path needs exactly the
 * same "is this mine to delete?" answer the profile path needed, and two copies
 * of an ownership test is how one of them ends up deleting an object it does not
 * own.
 */
export function ownedObjectPath(url: string | null, storage: AvatarStorage): string | null {
  if (!url) return null;
  const prefix = storage.publicUrl("");
  if (!url.startsWith(prefix)) return null;
  const encoded = url.slice(prefix.length);
  try {
    return encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}
