/**
 * SSRF guard unit tests (M17, CLAUDE.md §28). The blocklist is the single most
 * security-critical piece of unfurl, so it is exhaustively table-tested: private,
 * loopback, link-local (incl. the 169.254.169.254 cloud-metadata endpoint),
 * CGNAT, multicast/reserved, and the IPv6 equivalents — including IPv4-mapped
 * bypass forms — must ALL be blocked; public unicast must be allowed.
 */

import { describe, expect, it } from "vitest";
import { ipToBytes, isBlockedAddress } from "../ssrf.js";

describe("isBlockedAddress — IPv4", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1", // CGNAT lower
    "100.127.255.255", // CGNAT upper
    "127.0.0.1",
    "127.255.255.255",
    "169.254.0.1",
    "169.254.169.254", // cloud metadata — the classic SSRF target
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.0.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "11.0.0.1", // 11/8 is public
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "169.253.255.255", // just below link-local
    "169.255.0.1", // just above link-local
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "192.167.255.255", // just below 192.168/16
    "192.169.0.1", // just above 192.168/16
    "198.17.255.255", // just below 198.18/15
    "198.20.0.1", // just above 198.18/15
    "223.255.255.255", // just below multicast
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }
});

describe("isBlockedAddress — IPv6", () => {
  const blocked = [
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "fe80::abcd:1234", // link-local
    "fc00::1", // unique-local
    "fd12:3456:789a::1", // unique-local
    "ff02::1", // multicast
    "::ffff:10.0.0.1", // IPv4-mapped private (bypass form)
    "::ffff:169.254.169.254", // IPv4-mapped metadata (bypass form)
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::7f00:1", // IPv4-compatible loopback (::127.0.0.1)
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = [
    "2001:4860:4860::8888", // Google public DNS
    "2606:4700:4700::1111", // Cloudflare public DNS
    "::ffff:8.8.8.8", // IPv4-mapped PUBLIC address stays allowed
    "2a00:1450:4001:81b::200e",
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }
});

describe("isBlockedAddress — malformed input fails closed", () => {
  for (const bad of ["", "not-an-ip", "999.999.999.999", "10.0.0", "::gggg", "1.2.3.4.5"]) {
    it(`blocks ${JSON.stringify(bad)}`, () => expect(isBlockedAddress(bad)).toBe(true));
  }
});

describe("ipToBytes", () => {
  it("parses IPv4 to 4 octets", () => {
    expect(ipToBytes("192.168.1.2")).toEqual([192, 168, 1, 2]);
  });
  it("parses IPv6 to 16 bytes with :: compression", () => {
    expect(ipToBytes("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("parses IPv4-mapped IPv6", () => {
    expect(ipToBytes("::ffff:1.2.3.4")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4,
    ]);
  });
  it("returns null for a non-IP", () => {
    expect(ipToBytes("example.com")).toBeNull();
  });
});
