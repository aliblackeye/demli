#!/usr/bin/env node
/**
 * Chat-reliability end-to-end smoke (Milestone 2 hardening).
 *
 * Boots the API and the realtime gateway against the shared Postgres + Redis,
 * then verifies the two gaps this branch closes:
 *
 *   (a) GAP 1 — nonce idempotency: sending the SAME message.send twice
 *       (identical nonce) persists exactly ONE row and both echoes carry the
 *       same canonical message id.
 *   (b) GAP 2 — API→realtime pub/sub: with two WS clients on a channel, client
 *       A edits a message over HTTP and client B receives message.updated; A
 *       deletes it over HTTP and client B receives message.deleted.
 *
 * Plain Node (>=22, global fetch + WebSocket), no extra dependencies. A
 * black-box wire-level client, so it speaks raw protocol JSON on purpose;
 * typed consumers must use @demli/protocol instead.
 *
 * Usage: node scripts/smoke-chat-reliability.mjs
 * Env:   DATABASE_URL, REDIS_URL, SMOKE_API_PORT (4096), SMOKE_RT_PORT (4097)
 */

/* global console, fetch, setTimeout, clearTimeout, WebSocket */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const API_PORT = Number(process.env.SMOKE_API_PORT ?? 4096);
const RT_PORT = Number(process.env.SMOKE_RT_PORT ?? 4097);
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/demli";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const children = [];
let failed = false;

function log(message) {
  console.log(`[smoke] ${message}`);
}

function fail(message) {
  failed = true;
  console.error(`[smoke] FAIL: ${message}`);
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  log(`PASS: ${message}`);
}

function startService(name, filter, port) {
  const child = spawn("pnpm", ["--filter", filter, "start"], {
    shell: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL, REDIS_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  children.push({ name, child, logs });
  return child;
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
    console.error(`\n[smoke] --- last output from ${name} ---`);
    console.error(logs.join("").split("\n").slice(-25).join("\n"));
  }
}

async function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("API /health did not come up in time");
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
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

/** Minimal wire-level WS client: collects envelopes, supports waiting. */
function connectWs(token, label) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${RT_PORT}/?token=${encodeURIComponent(token)}`);
    const envelopes = [];
    const waiters = [];
    socket.addEventListener("message", (event) => {
      envelopes.push(JSON.parse(String(event.data)));
      for (const wake of waiters.splice(0)) wake();
    });
    socket.addEventListener("error", () => reject(new Error(`${label}: ws error`)));
    socket.addEventListener("open", () =>
      resolve({
        socket,
        envelopes,
        send: (event) => socket.send(JSON.stringify(event)),
        close: () => socket.close(),
        matches: (type, predicate = () => true) =>
          envelopes.filter((e) => e?.event?.type === type && predicate(e.event)),
        async waitFor(type, predicate = () => true, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          let scanned = 0;
          for (;;) {
            for (; scanned < envelopes.length; scanned++) {
              const env = envelopes[scanned];
              if (env?.event?.type === type && predicate(env.event)) return env;
            }
            if (Date.now() > deadline) {
              fail(
                `${label}: timed out waiting for ${type} (saw: ${envelopes
                  .map((e) => e?.event?.type)
                  .join(", ")})`,
              );
            }
            await new Promise((r) => {
              const t = setTimeout(r, 100);
              waiters.push(() => {
                clearTimeout(t);
                r();
              });
            });
          }
        },
      }),
    );
  });
}

async function main() {
  log(`migrating database (${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")})`);
  const migrate = spawnSync("pnpm", ["--filter", "@demli/db", "migrate"], {
    shell: true,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
  if (migrate.status !== 0) fail("db migrate failed — is docker compose up?");

  log(`starting api on :${API_PORT} and realtime on :${RT_PORT} (redis ${REDIS_URL})`);
  startService("api", "@demli/api", API_PORT);
  startService("realtime", "@demli/realtime", RT_PORT);
  await waitForHealth();
  log("api is healthy");

  const suffix = Date.now().toString(36);
  const [alice, bob] = [`rela_${suffix}`, `relb_${suffix}`];

  // --- HTTP setup: two users, group, channel, invite redeem ---
  const regA = await api("POST", "/auth/register", {
    body: { username: alice, password: "smoke-password-1", displayName: "Rel A" },
  });
  assert(regA.status === 201 && regA.json.token, `register ${alice} -> 201 + token`);
  const regB = await api("POST", "/auth/register", {
    body: { username: bob, password: "smoke-password-2", displayName: "Rel B" },
  });
  assert(regB.status === 201 && regB.json.token, `register ${bob} -> 201 + token`);
  const tokenA = regA.json.token;
  const tokenB = regB.json.token;

  const group = await api("POST", "/groups", { token: tokenA, body: { name: "Reliability Crew" } });
  assert(group.status === 201, "create group -> 201");
  const groupId = group.json.group.id;

  const channel = await api("POST", `/groups/${groupId}/channels`, {
    token: tokenA,
    body: { name: "rel-general", kind: "text" },
  });
  assert(channel.status === 201, "create text channel -> 201");
  const channelId = channel.json.channel.id;

  const invite = await api("POST", `/groups/${groupId}/invites`, {
    token: tokenA,
    body: { maxUses: 2 },
  });
  assert(invite.status === 201, "create invite -> 201");
  const redeem = await api("POST", `/invites/${invite.json.invite.code}/redeem`, { token: tokenB });
  assert(redeem.status === 200 && redeem.json?.group?.id === groupId, "B redeems invite -> joins group");

  // --- WS: both users connect (B after redeem so it subscribes to the channel) ---
  const wsA = await connectWs(tokenA, "wsA");
  const wsB = await connectWs(tokenB, "wsB");
  await wsA.waitFor("auth.succeeded");
  await wsB.waitFor("auth.succeeded");
  log("both WS clients handshaked");

  // === GAP 1: idempotent retried send ===
  const nonce = `rel-nonce-${suffix}`;
  const content = `dedupe me ${suffix}`;
  const frame = { type: "message.send", payload: { channelId, content, nonce } };

  wsA.send(frame);
  const firstEcho = await wsA.waitFor("message.created", (e) => e.payload.nonce === nonce);
  const canonicalId = firstEcho.event.payload.id;

  // Retry the identical frame (as if the first echo had been lost).
  wsA.send(frame);
  await new Promise((r) => setTimeout(r, 800)); // let the retry persist + re-broadcast

  const echoes = wsA.matches("message.created", (e) => e.payload.nonce === nonce);
  assert(echoes.length >= 2, `both sends echoed (got ${echoes.length})`);
  const echoIds = new Set(echoes.map((e) => e.event.payload.id));
  assert(echoIds.size === 1 && echoIds.has(canonicalId), "both echoes carry ONE canonical id");

  const list = await api("GET", `/channels/${channelId}/messages?limit=100`, { token: tokenA });
  const persisted = list.json.messages.filter((m) => m.content === content);
  assert(persisted.length === 1, `exactly ONE persisted row for the retried send (got ${persisted.length})`);
  assert(persisted[0]?.id === canonicalId, "persisted row is the canonical message");

  // === GAP 2: API-originated edit/delete broadcast over Redis pub/sub ===
  const seed = await api("POST", `/channels/${channelId}/messages`, {
    token: tokenA,
    body: { content: `edit-target ${suffix}` },
  });
  assert(seed.status === 201, "A creates a message over HTTP -> 201");
  const targetId = seed.json.message.id;

  const editContent = `edited over http ${suffix}`;
  const edit = await api("PATCH", `/messages/${targetId}`, {
    token: tokenA,
    body: { content: editContent },
  });
  assert(edit.status === 200, "A edits the message over HTTP -> 200");
  const gotUpdate = await wsB.waitFor("message.updated", (e) => e.payload.id === targetId);
  assert(gotUpdate.event.payload.content === editContent, "B receives message.updated with new content");
  assert(typeof gotUpdate.seq === "number", "message.updated arrives in a sequenced envelope");

  const del = await api("DELETE", `/messages/${targetId}`, { token: tokenA });
  assert(del.status === 204, "A deletes the message over HTTP -> 204");
  const gotDelete = await wsB.waitFor("message.deleted", (e) => e.payload.messageId === targetId);
  assert(gotDelete.event.payload.channelId === channelId, "B receives message.deleted for the message");

  wsA.close();
  wsB.close();
  log("SMOKE PASSED — nonce dedupe + api→realtime edit/delete broadcast verified end to end");
}

try {
  await main();
} catch (err) {
  failed = true;
  console.error(`[smoke] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  dumpLogsOnFailure();
  stopAll();
}
