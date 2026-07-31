# syntax=docker/dockerfile:1

# Demli API image (Fastify). The app runs its TypeScript entrypoint directly
# with tsx — exactly like `pnpm --filter @demli/api start` in dev, so there
# is no separate compile step to drift from. Build context MUST be the repo
# root so the pnpm workspace + lockfile are available (see docker-compose.prod).
#
# The same image is reused by the one-shot `migrate` service, which runs
# packages/db's migrate script (tsx + drizzle) that ships as an API dependency.

# ---- base: Node 22 + pnpm (pinned by root package.json "packageManager") ----
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install only the API's slice of the workspace ---------------------
# `--filter @demli/api...` installs the API and its workspace dependencies
# (config, db, types) and their externals — never the Electron desktop app.
# argon2 is a native module; give this stage the build toolchain so the runtime
# image can stay slim.
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --filter @demli/api...

# ---- runtime: slim, non-root -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 4000
# tsx binary is linked into the package's node_modules by pnpm.
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
