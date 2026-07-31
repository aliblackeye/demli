#!/usr/bin/env node
/**
 * Milestone 2 end-to-end smoke: boots the API and the realtime gateway,
 * registers two users over HTTP, builds a group + channel + invite, connects
 * two WebSocket clients, and verifies message.send → persisted → broadcast.
 *
 * Plain Node (>=22, global fetch + WebSocket), no extra dependencies.
 * This script is a black-box wire-level client, so it intentionally speaks
 * raw protocol JSON; typed consumers must use @demli/protocol instead.
 *
 * Usage: node scripts/smoke-m2.mjs
 * Env:   DATABASE_URL, SMOKE_API_PORT (default 4090), SMOKE_RT_PORT (default 4091)
 */

/* global console, fetch, setTimeout, clearTimeout, WebSocket */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const API_PORT = Number(process.env.SMOKE_API_PORT ?? 4090);
const RT_PORT = Number(process.env.SMOKE_RT_PORT ?? 4091);
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/demli";

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
    env: { ...process.env, PORT: String(port), DATABASE_URL },
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
      // Only claim a JSON body when one is actually sent.
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

  log(`starting api on :${API_PORT} and realtime on :${RT_PORT}`);
  startService("api", "@demli/api", API_PORT);
  startService("realtime", "@demli/realtime", RT_PORT);
  await waitForHealth();
  log("api is healthy");

  const suffix = Date.now().toString(36);
  const [alice, bob] = [`smokea_${suffix}`, `smokeb_${suffix}`];

  // --- HTTP: register two users, build group/channel/invite ---
  const regA = await api("POST", "/auth/register", {
    body: { username: alice, password: "smoke-password-1", displayName: "Smoke A" },
  });
  assert(regA.status === 201 && regA.json.token, `register ${alice} -> 201 + token`);
  const regB = await api("POST", "/auth/register", {
    body: { username: bob, password: "smoke-password-2", displayName: "Smoke B" },
  });
  assert(regB.status === 201 && regB.json.token, `register ${bob} -> 201 + token`);
  const tokenA = regA.json.token;
  const tokenB = regB.json.token;

  const group = await api("POST", "/groups", {
    token: tokenA,
    body: { name: "Smoke Crew" },
  });
  assert(group.status === 201, "create group -> 201");
  const groupId = group.json.group.id;

  const channel = await api("POST", `/groups/${groupId}/channels`, {
    token: tokenA,
    body: { name: "smoke-general", kind: "text" },
  });
  assert(channel.status === 201, "create text channel -> 201");
  const channelId = channel.json.channel.id;

  const invite = await api("POST", `/groups/${groupId}/invites`, {
    token: tokenA,
    body: { maxUses: 2 },
  });
  assert(invite.status === 201, "create invite -> 201");

  const redeem = await api("POST", `/invites/${invite.json.invite.code}/redeem`, {
    token: tokenB,
  });
  assert(
    redeem.status === 200 && redeem.json?.group?.id === groupId,
    `B redeems invite -> joins group (got ${redeem.status} ${JSON.stringify(redeem.json)})`,
  );

  // --- WS: both users connect, A sends, B receives ---
  const wsA = await connectWs(tokenA, "wsA");
  const wsB = await connectWs(tokenB, "wsB");
  const authA = await wsA.waitFor("auth.succeeded");
  const authB = await wsB.waitFor("auth.succeeded");
  assert(
    authA.event.payload.userId === regA.json.user.id,
    "A receives auth.succeeded with own userId",
  );
  assert(Array.isArray(authB.event.payload.presence), "B receives presence snapshot");

  const nonce = `smoke-${suffix}`;
  const content = `smoke message ${suffix}`;
  wsA.send({ type: "message.send", payload: { channelId, content, nonce } });

  const gotB = await wsB.waitFor("message.created", (e) => e.payload.content === content);
  assert(gotB.event.payload.authorId === regA.json.user.id, "B receives message.created from A");
  assert(typeof gotB.seq === "number", "broadcast arrives in a sequenced envelope");

  const echoA = await wsA.waitFor("message.created", (e) => e.payload.content === content);
  assert(echoA.event.payload.nonce === nonce, "A's echo carries the original nonce");

  const list = await api("GET", `/channels/${channelId}/messages?limit=10`, { token: tokenB });
  assert(
    list.status === 200 && list.json.messages.some((m) => m.content === content),
    "GET messages returns the persisted message",
  );

  wsA.close();
  wsB.close();
  log("SMOKE PASSED — send → persist → broadcast verified end to end");
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
