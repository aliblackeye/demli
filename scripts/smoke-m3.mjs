#!/usr/bin/env node
/**
 * Milestone 3 voice smoke: brings up the LiveKit dev server (docker compose),
 * boots the API, registers a user, creates a group + voice channel, requests
 * POST /media/token, and asserts the minted JWT is verifiable and scoped to
 * room=channelId / identity=userId. Then talks to the live LiveKit server via
 * RoomServiceClient (createRoom/listRooms) as a real-server sanity check.
 *
 * Media frames themselves are exercised by the desktop client (Milestone 3
 * renderer wiring) — this script proves the token/infra path end to end.
 *
 * Usage: node scripts/smoke-m3.mjs
 * Env:   DATABASE_URL, SMOKE_API_PORT (default 4092),
 *        LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
 *        (defaults match .env.example + docker-compose: devkey/devsecret)
 */

/* global console, fetch, setTimeout, Buffer, URL */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

// livekit-server-sdk is a dependency of @demli/api; resolve it from there.
const requireFromApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { RoomServiceClient, TokenVerifier } = requireFromApi("livekit-server-sdk");

const API_PORT = Number(process.env.SMOKE_API_PORT ?? 4092);
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/demli";
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "devsecret";
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

const children = [];
let failed = false;

function log(message) {
  console.log(`[smoke-m3] ${message}`);
}

function fail(message) {
  failed = true;
  console.error(`[smoke-m3] FAIL: ${message}`);
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  log(`PASS: ${message}`);
}

function stopAll() {
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
    } else {
      child.kill("SIGTERM");
    }
  }
}

function dumpLogsOnFailure() {
  if (!failed) return;
  for (const { name, logs } of children) {
    console.error(`\n[smoke-m3] --- last output from ${name} ---`);
    console.error(logs.join("").split("\n").slice(-25).join("\n"));
  }
}

async function waitFor(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) fail(`${label} did not come up in time`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
}

async function main() {
  // --- infra: livekit + database ---
  log("starting livekit via docker compose");
  const compose = spawnSync("docker", ["compose", "up", "-d", "livekit"], {
    shell: true,
    stdio: "inherit",
  });
  if (compose.status !== 0) fail("docker compose up -d livekit failed — is Docker running?");

  const roomService = new RoomServiceClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  );
  await waitFor("livekit", async () => {
    await roomService.listRooms();
    return true;
  });
  assert(true, `livekit server answers RoomService requests at ${LIVEKIT_URL}`);

  log(`migrating database (${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")})`);
  const migrate = spawnSync("pnpm", ["--filter", "@demli/db", "migrate"], {
    shell: true,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
  if (migrate.status !== 0) fail("db migrate failed — is docker compose up?");

  // --- api ---
  log(`starting api on :${API_PORT}`);
  const child = spawn("pnpm", ["--filter", "@demli/api", "start"], {
    shell: true,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DATABASE_URL,
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  children.push({ name: "api", child, logs });
  await waitFor("api /health", async () => (await fetch(`${API}/health`)).ok);
  log("api is healthy");

  // --- user + group + channels ---
  const suffix = Date.now().toString(36);
  const reg = await api("POST", "/auth/register", {
    body: { username: `smokem3_${suffix}`, password: "smoke-password-3", displayName: "Smoke M3" },
  });
  assert(reg.status === 201 && reg.json.token, "register user -> 201 + session token");
  const token = reg.json.token;
  const userId = reg.json.user.id;

  const group = await api("POST", "/groups", { token, body: { name: "Voice Smoke Crew" } });
  assert(group.status === 201, "create group -> 201");
  const groupId = group.json.group.id;

  const voice = await api("POST", `/groups/${groupId}/channels`, {
    token,
    body: { name: "smoke-lobby", kind: "voice" },
  });
  assert(voice.status === 201, "create voice channel -> 201");
  const voiceChannelId = voice.json.channel.id;

  const text = await api("POST", `/groups/${groupId}/channels`, {
    token,
    body: { name: "smoke-general", kind: "text" },
  });
  const textChannelId = text.json.channel.id;

  // --- token endpoint contract ---
  const denied = await api("POST", "/media/token", { body: { channelId: voiceChannelId } });
  assert(denied.status === 401, "media token without auth -> 401");

  const wrongKind = await api("POST", "/media/token", {
    token,
    body: { channelId: textChannelId },
  });
  assert(
    wrongKind.status === 400 && wrongKind.json.error.code === "INVALID_CHANNEL",
    "media token for a text channel -> 400 INVALID_CHANNEL",
  );

  const minted = await api("POST", "/media/token", {
    token,
    body: { channelId: voiceChannelId },
  });
  assert(minted.status === 200 && minted.json.token, "media token for voice channel -> 200 + JWT");
  assert(minted.json.url === LIVEKIT_URL, `token response carries livekit url (${LIVEKIT_URL})`);
  assert(minted.json.roomName === voiceChannelId, "token response roomName = voice channel id");
  assert(minted.json.identity === userId, "token response identity = user id");

  const grants = await new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).verify(
    minted.json.token,
  );
  assert(grants.video?.room === voiceChannelId, "JWT verifies; video grant room = channel id");
  assert(
    grants.video?.roomJoin === true &&
      grants.video?.canPublish === true &&
      grants.video?.canSubscribe === true,
    "JWT grants roomJoin + canPublish + canSubscribe",
  );
  const claims = decodeJwtPayload(minted.json.token);
  assert(claims.sub === userId, "JWT sub (identity) = user id");
  const lifetime = claims.exp - Math.floor(Date.now() / 1000);
  assert(
    lifetime > TOKEN_TTL_SECONDS - 300 && lifetime <= TOKEN_TTL_SECONDS + 300,
    `JWT TTL is ~6h (got ${(lifetime / 3600).toFixed(2)}h)`,
  );

  // --- live server sanity: create/list/delete a room ---
  const roomName = `smoke-m3-${suffix}`;
  await roomService.createRoom({ name: roomName, emptyTimeout: 60 });
  const rooms = await roomService.listRooms();
  assert(
    rooms.some((r) => r.name === roomName),
    "RoomServiceClient can create and list a room on the dev server",
  );
  await roomService.deleteRoom(roomName);

  log("SMOKE PASSED — livekit infra + media token contract verified end to end");
}

try {
  await main();
} catch (err) {
  failed = true;
  console.error(`[smoke-m3] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  dumpLogsOnFailure();
  stopAll();
}
