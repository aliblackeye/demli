/**
 * SSRF guard (CLAUDE.md §28 — life-or-death for unfurl). Given a resolved IP
 * string, decide whether it is safe to connect to. The unfurl fetcher resolves
 * every hostname (and every redirect hop) and passes EACH resolved address
 * through {@link isBlockedAddress}; a single blocked address rejects the fetch.
 *
 * Fails CLOSED: anything not provably a public, routable unicast address is
 * blocked. Covers private ranges, loopback, link-local (incl. the
 * 169.254.169.254 cloud-metadata endpoint), CGNAT, multicast/reserved, and the
 * IPv6 equivalents — including IPv4-mapped/embedded IPv6 forms that are a classic
 * SSRF bypass (`::ffff:169.254.169.254`, `::7f00:1`).
 *
 * Pure and dependency-light (only `node:net` for IP classification) so it is
 * directly unit-testable with no network or mocking.
 */

import net from "node:net";

/** Parse an IPv4 dotted-quad into 4 octets, or null when malformed. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Two hex groups → their two bytes (big-endian). */
function groupBytes(group: number): [number, number] {
  return [(group >> 8) & 0xff, group & 0xff];
}

/** Split a colon-run into hex groups (and expand a trailing embedded IPv4). */
function toGroups(part: string): number[] | null {
  if (part === "") return [];
  const tokens = part.split(":");
  const groups: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.includes(".")) {
      // Embedded IPv4 must be the final token (e.g. ::ffff:1.2.3.4).
      if (i !== tokens.length - 1) return null;
      const v4 = parseIpv4(token);
      if (!v4) return null;
      groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0));
      groups.push(((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      groups.push(parseInt(token, 16));
    }
  }
  return groups;
}

/** Expand any IPv6 literal into 16 bytes, or null when malformed. */
function parseIpv6(value: string): number[] | null {
  let addr = value;
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  let groups: number[];
  if (halves.length === 2) {
    const left = toGroups(halves[0] ?? "");
    const right = toGroups(halves[1] ?? "");
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null; // "::" must stand for ≥1 zero group
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const only = toGroups(addr);
    if (!only) return null;
    groups = only;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const [hi, lo] = groupBytes(group);
    bytes.push(hi, lo);
  }
  return bytes;
}

/** Classify + parse an IP literal into its bytes (4 for v4, 16 for v6). */
export function ipToBytes(ip: string): number[] | null {
  if (net.isIPv4(ip)) return parseIpv4(ip);
  if (net.isIPv6(ip)) return parseIpv6(ip);
  return null;
}

/** Blocked IPv4 ranges: not a public routable unicast address. */
function isBlockedIpv4(bytes: number[]): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (metadata!)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 special
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** True when 16 bytes are an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`). */
function isIpv4Mapped(bytes: number[]): boolean {
  for (let i = 0; i < 10; i += 1) if ((bytes[i] ?? 0) !== 0) return false;
  return (bytes[10] ?? 0) === 0xff && (bytes[11] ?? 0) === 0xff;
}

/** Blocked IPv6 ranges (after unwrapping IPv4-mapped/compatible forms). */
function isBlockedIpv6(bytes: number[]): boolean {
  // IPv4-mapped ::ffff:a.b.c.d — re-check the embedded IPv4.
  if (isIpv4Mapped(bytes)) return isBlockedIpv4(bytes.slice(12));

  // IPv4-compatible ::a.b.c.d (first 12 bytes zero) — includes :: and ::1.
  let firstTwelveZero = true;
  for (let i = 0; i < 12; i += 1) {
    if ((bytes[i] ?? 0) !== 0) {
      firstTwelveZero = false;
      break;
    }
  }
  if (firstTwelveZero) return isBlockedIpv4(bytes.slice(12));

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True when it is NOT safe to connect to `ip` (private/loopback/link-local/
 * metadata/CGNAT/multicast/reserved, IPv4 or IPv6). An unparseable value is
 * blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const bytes = ipToBytes(ip);
  if (!bytes) return true;
  return bytes.length === 4 ? isBlockedIpv4(bytes) : isBlockedIpv6(bytes);
}
