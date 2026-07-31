import type { FastifyInstance } from "fastify";

/** Reference module pattern: one folder per domain, one register function. */
export async function registerHealthModule(server: FastifyInstance): Promise<void> {
  server.get("/health", async () => ({
    status: "ok",
    service: "demli-api",
    time: new Date().toISOString(),
    // Restart detector: a low value right after an outage report means the
    // process (or its container) just came back — check `docker logs` for why.
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
