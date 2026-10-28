/**
 * Tenor GIF search proxy (M19). Keeps the API key server-side and presents a
 * slim JSON surface to clients. Two endpoints:
 *
 *   GET /gif/search?q=...&limit=...&pos=...   → proxied `search`
 *   GET /gif/trending?limit=...&pos=...        → proxied `featured`
 *
 * Both answer 503 (GIF_DISABLED) when `TENOR_API_KEY` is not configured —
 * clients check `GET /gif/capabilities` (or just try and handle 503).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../../plugins/auth.js";
import { ApiError } from "../../errors.js";
import { userRateLimit } from "../../lib/rate-limit.js";

const TENOR_BASE = "https://tenor.googleapis.com/v2";

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  pos: z.string().max(200).optional(),
});

const trendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  pos: z.string().max(200).optional(),
});

interface TenorMediaFormat {
  url: string;
  dims: [number, number];
  size: number;
  duration: number;
}

interface TenorResult {
  id: string;
  title: string;
  media_formats: Record<string, TenorMediaFormat>;
  content_description: string;
}

interface TenorResponse {
  results: TenorResult[];
  next: string;
}

interface GifResult {
  id: string;
  title: string;
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  fullUrl: string;
  fullWidth: number;
  fullHeight: number;
  fullSize: number;
}

function mapResults(raw: TenorResponse): { results: GifResult[]; next: string } {
  return {
    next: raw.next ?? "",
    results: (raw.results ?? [])
      .map((r): GifResult | null => {
        const preview = r.media_formats?.tinygif ?? r.media_formats?.nanogif;
        const full = r.media_formats?.gif ?? r.media_formats?.mediumgif;
        if (!preview || !full) return null;
        return {
          id: r.id,
          title: r.title || r.content_description || "",
          previewUrl: preview.url,
          previewWidth: preview.dims[0]!,
          previewHeight: preview.dims[1]!,
          fullUrl: full.url,
          fullWidth: full.dims[0]!,
          fullHeight: full.dims[1]!,
          fullSize: full.size,
        };
      })
      .filter((r): r is GifResult => r !== null),
  };
}

export async function registerGifModule(server: FastifyInstance): Promise<void> {
  const apiKey = process.env.TENOR_API_KEY?.trim();

  function requireKey(): string {
    if (!apiKey) {
      throw new ApiError(503, "GIF_DISABLED", "GIF search is not available on this server.");
    }
    return apiKey;
  }

  server.get(
    "/gif/search",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }) },
    },
    async (request) => {
      const key = requireKey();
      requireUser(request);
      const { q, limit, pos } = searchQuerySchema.parse(request.query);
      const params = new URLSearchParams({
        q,
        key,
        limit: String(limit),
        media_filter: "tinygif,gif,mediumgif,nanogif",
        contentfilter: "medium",
      });
      if (pos) params.set("pos", pos);

      const res = await fetch(`${TENOR_BASE}/search?${params}`);
      if (!res.ok) {
        server.log.error({ status: res.status }, "tenor search failed");
        throw new ApiError(502, "GIF_UPSTREAM_ERROR", "GIF search provider error.");
      }
      return mapResults((await res.json()) as TenorResponse);
    },
  );

  server.get(
    "/gif/trending",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }) },
    },
    async (request) => {
      const key = requireKey();
      requireUser(request);
      const { limit, pos } = trendingQuerySchema.parse(request.query);
      const params = new URLSearchParams({
        key,
        limit: String(limit),
        media_filter: "tinygif,gif,mediumgif,nanogif",
        contentfilter: "medium",
      });
      if (pos) params.set("pos", pos);

      const res = await fetch(`${TENOR_BASE}/featured?${params}`);
      if (!res.ok) {
        server.log.error({ status: res.status }, "tenor trending failed");
        throw new ApiError(502, "GIF_UPSTREAM_ERROR", "GIF search provider error.");
      }
      return mapResults((await res.json()) as TenorResponse);
    },
  );
}
