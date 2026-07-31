# syntax=docker/dockerfile:1

# Demli realtime WebSocket gateway image. Runs its TypeScript entrypoint
# directly with tsx (mirrors `pnpm --filter @demli/realtime start`). Build
# context MUST be the repo root (pnpm workspace + lockfile). See
# docker-compose.prod.yml.

# ---- base: Node 22 + pnpm (pinned by root package.json "packageManager") ----
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install only the gateway's slice of the workspace ----------------
# `--filter @demli/realtime...` installs realtime + its workspace deps
# (config, db, protocol, types) and their externals. db pulls in argon2 (native)
# for its seed script, so keep the build toolchain here.
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --filter @demli/realtime...

# ---- runtime: slim, non-root -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
WORKDIR /app/apps/realtime
USER node
EXPOSE 4001
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
