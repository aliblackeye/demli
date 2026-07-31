import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadError, uploadToSignedUrl, type UploadProgress } from "../upload.js";

/**
 * Minimal XMLHttpRequest stand-in. `vitest` runs in Node with no real XHR, so we
 * script the lifecycle: `open`/`setRequestHeader`/`send` are recorded, then the
 * test drives `emitProgress`/`succeed`/`fail`/`abort` to fire the handlers the
 * code under test attaches.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  sent = false;

  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.sent = true;
    this.body = body;
  }

  abort(): void {
    this.onabort?.();
  }

  // --- test drivers ---
  emitProgress(loaded: number, total: number, computable = true): void {
    this.upload.onprogress?.({
      loaded,
      total,
      lengthComputable: computable,
    } as ProgressEvent);
  }

  succeed(status = 200): void {
    this.status = status;
    this.onload?.();
  }

  fail(status = 500): void {
    this.status = status;
    this.onload?.();
  }

  networkError(): void {
    this.onerror?.();
  }
}

function installFakeXHR(): typeof FakeXHR {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  return FakeXHR;
}

function blob(bytes = 1024, type = "image/png"): Blob {
  return { size: bytes, type } as unknown as Blob;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadToSignedUrl", () => {
  it("PUTs to the url with the blob's Content-Type and resolves on 2xx", async () => {
    installFakeXHR();
    const promise = uploadToSignedUrl("https://storage/signed?token=x", blob(2048, "image/webp"));

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://storage/signed?token=x");
    expect(xhr.headers["Content-Type"]).toBe("image/webp");
    expect(xhr.sent).toBe(true);

    xhr.succeed(200);
    await expect(promise).resolves.toBeUndefined();
  });

  it("honours an explicit contentType override", async () => {
    installFakeXHR();
    const promise = uploadToSignedUrl("https://s/u", blob(10, ""), { contentType: "video/mp4" });
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.headers["Content-Type"]).toBe("video/mp4");
    xhr.succeed();
    await promise;
  });

  it("reports progress ticks, passing total=0 when the length is not computable", async () => {
    installFakeXHR();
    const ticks: UploadProgress[] = [];
    const promise = uploadToSignedUrl("https://s/u", blob(1000), {
      onProgress: (p) => ticks.push(p),
    });

    const xhr = FakeXHR.instances[0]!;
    xhr.emitProgress(250, 1000);
    xhr.emitProgress(1000, 1000);
    xhr.emitProgress(1000, 0, false);
    xhr.succeed();
    await promise;

    expect(ticks).toEqual([
      { loaded: 250, total: 1000 },
      { loaded: 1000, total: 1000 },
      { loaded: 1000, total: 0 },
    ]);
  });

  it("rejects with an UploadError carrying the status on a non-2xx", async () => {
    installFakeXHR();
    const promise = uploadToSignedUrl("https://s/u", blob());
    FakeXHR.instances[0]!.fail(403);

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(403);
    expect((err as UploadError).aborted).toBe(false);
  });

  it("rejects with an UploadError on a transport error (status 0)", async () => {
    installFakeXHR();
    const promise = uploadToSignedUrl("https://s/u", blob());
    FakeXHR.instances[0]!.networkError();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(0);
  });

  it("rejects immediately when the signal is already aborted, without opening a request", async () => {
    installFakeXHR();
    const controller = new AbortController();
    controller.abort();

    const err = await uploadToSignedUrl("https://s/u", blob(), {
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).aborted).toBe(true);
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("aborts the in-flight request when the signal fires", async () => {
    installFakeXHR();
    const controller = new AbortController();
    const promise = uploadToSignedUrl("https://s/u", blob(), { signal: controller.signal });

    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).aborted).toBe(true);
  });
});
