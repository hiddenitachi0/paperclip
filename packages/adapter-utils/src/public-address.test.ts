import { describe, expect, it } from "vitest";
import { isNonPublicAddress, isPrivateIP } from "./public-address.js";

describe("isPrivateIP", () => {
  it("blocks RFC 1918 ranges", () => {
    expect(isPrivateIP("10.1.2.3")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.32.0.1")).toBe(false);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });

  it("blocks loopback and link-local, including the cloud metadata address", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("169.254.169.254")).toBe(true);
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  it("blocks IPv6 unique local addresses", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd00::1")).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 addresses before checking", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:23.227.38.65")).toBe(false);
  });

  it("leaves carrier-grade NAT and public addresses alone", () => {
    expect(isPrivateIP("100.101.102.103")).toBe(false);
    expect(isPrivateIP("23.227.38.65")).toBe(false);
  });
});

describe("isNonPublicAddress", () => {
  it("blocks everything isPrivateIP blocks", () => {
    expect(isNonPublicAddress("10.1.2.3")).toBe(true);
    expect(isNonPublicAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("additionally blocks carrier-grade NAT 100.64.0.0/10 (tailnet addresses live here)", () => {
    expect(isNonPublicAddress("100.64.0.1")).toBe(true);
    expect(isNonPublicAddress("100.100.100.100")).toBe(true);
    expect(isNonPublicAddress("100.127.255.255")).toBe(true);
    expect(isNonPublicAddress("100.63.255.255")).toBe(false); // just outside the /10
    expect(isNonPublicAddress("100.128.0.0")).toBe(false); // just outside the /10
  });

  it("blocks 0.0.0.0/8, the 192.0.0.0/24 IETF block, and the 198.18.0.0/15 benchmark range", () => {
    expect(isNonPublicAddress("0.1.2.3")).toBe(true);
    expect(isNonPublicAddress("192.0.0.1")).toBe(true);
    expect(isNonPublicAddress("198.18.0.1")).toBe(true);
    expect(isNonPublicAddress("198.19.255.255")).toBe(true);
  });

  it("blocks multicast/reserved space and IPv6 multicast/NAT64/documentation ranges", () => {
    expect(isNonPublicAddress("224.0.0.1")).toBe(true);
    expect(isNonPublicAddress("ff02::1")).toBe(true);
    expect(isNonPublicAddress("64:ff9b::1")).toBe(true);
    expect(isNonPublicAddress("2001:db8::1")).toBe(true);
  });

  it("treats anything that is not an IP literal as unsafe (hostnames must be resolved first)", () => {
    expect(isNonPublicAddress("not-an-ip")).toBe(true);
    expect(isNonPublicAddress("example.ts.net")).toBe(true);
  });

  it("lets ordinary public addresses through", () => {
    expect(isNonPublicAddress("23.227.38.65")).toBe(false);
    expect(isNonPublicAddress("2620:127:f00f:5::")).toBe(false);
  });
});
