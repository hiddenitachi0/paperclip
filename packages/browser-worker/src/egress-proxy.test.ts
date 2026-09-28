import { createServer as createHttpServer, get as httpGet, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkHostAllowed,
  createEgressProxyServer,
  parseAbsoluteHttpTarget,
  parseConnectTarget,
  type DnsLookupResult,
} from "./egress-proxy.js";

const PUBLIC_LOOKUP = async (): Promise<DnsLookupResult[]> => [{ address: "93.184.216.1", family: 4 }];
const PRIVATE_LOOKUP = async (): Promise<DnsLookupResult[]> => [{ address: "10.1.2.3", family: 4 }];
const MIXED_LOOKUP = async (): Promise<DnsLookupResult[]> => [
  { address: "10.1.2.3", family: 4 },
  { address: "93.184.216.1", family: 4 },
];

describe("parseConnectTarget", () => {
  it("parses host:port", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
  });
  it("rejects a target with no port", () => {
    expect(parseConnectTarget("example.com")).toBeNull();
  });
  it("strips IPv6 brackets", () => {
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
  });
});

describe("parseAbsoluteHttpTarget", () => {
  it("parses an absolute http:// URL with default port 80", () => {
    expect(parseAbsoluteHttpTarget("http://example.com/path")).toEqual({ host: "example.com", port: 80 });
  });
  it("parses an explicit port", () => {
    expect(parseAbsoluteHttpTarget("http://example.com:8080/path")).toEqual({ host: "example.com", port: 8080 });
  });
  it("refuses https:// (that goes through CONNECT, not here)", () => {
    expect(parseAbsoluteHttpTarget("https://example.com/path")).toBeNull();
  });
  it("refuses a relative path", () => {
    expect(parseAbsoluteHttpTarget("/path")).toBeNull();
  });
});

describe("checkHostAllowed", () => {
  it("allows a public host on port 443", async () => {
    const result = await checkHostAllowed("example.com", 443, { lookup: PUBLIC_LOOKUP });
    expect(result).toEqual({ ok: true, resolvedAddress: "93.184.216.1" });
  });

  it("refuses a port other than 80/443", async () => {
    const result = await checkHostAllowed("example.com", 8080, { lookup: PUBLIC_LOOKUP });
    expect(result).toEqual({ ok: false, reason: "port_not_allowed" });
  });

  it("refuses a host that resolves to a private address", async () => {
    const result = await checkHostAllowed("internal.example", 443, { lookup: PRIVATE_LOOKUP });
    expect(result).toEqual({ ok: false, reason: "address_not_public" });
  });

  it("picks the public address when a host resolves to both private and public (multi-homed)", async () => {
    const result = await checkHostAllowed("multihomed.example", 443, { lookup: MIXED_LOOKUP });
    expect(result.ok).toBe(true);
    expect(result.resolvedAddress).toBe("93.184.216.1");
  });

  it("refuses a blocked host suffix even though it would resolve publicly", async () => {
    const result = await checkHostAllowed("agent.ts.net", 443, {
      lookup: PUBLIC_LOOKUP,
      blockedHostSuffixes: ["ts.net"],
    });
    expect(result).toEqual({ ok: false, reason: "host_blocked" });
  });

  it("does not refuse a host that merely contains the suffix as a substring", async () => {
    const result = await checkHostAllowed("notts.net.example.com", 443, {
      lookup: PUBLIC_LOOKUP,
      blockedHostSuffixes: ["ts.net"],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses the instance's exact public host when listed", async () => {
    const result = await checkHostAllowed("myinstance.paperclip.ing", 443, {
      lookup: PUBLIC_LOOKUP,
      blockedHostSuffixes: ["myinstance.paperclip.ing"],
    });
    expect(result).toEqual({ ok: false, reason: "host_blocked" });
  });

  it("checks an IP literal target directly without a DNS lookup", async () => {
    const result = await checkHostAllowed("169.254.169.254", 443, {
      lookup: async () => {
        throw new Error("must not call DNS for an IP literal");
      },
    });
    expect(result).toEqual({ ok: false, reason: "address_not_public" });
  });

  it("refuses when DNS resolution fails", async () => {
    const result = await checkHostAllowed("nowhere.invalid", 443, {
      lookup: async () => {
        throw new Error("NXDOMAIN");
      },
    });
    expect(result).toEqual({ ok: false, reason: "dns_failed" });
  });

  it("refuses an empty host", async () => {
    const result = await checkHostAllowed("", 443, { lookup: PUBLIC_LOOKUP });
    expect(result.reason).toBe("invalid_target");
  });
});

describe("createEgressProxyServer", () => {
  let proxy: Server | undefined;
  let target: Server | undefined;

  const closeServer = (server: Server | undefined) =>
    new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

  afterEach(async () => {
    await closeServer(proxy);
    await closeServer(target);
    proxy = undefined;
    target = undefined;
  });

  it("tunnels a CONNECT request to the checked address via testOnlyDial and logs bytes", async () => {
    target = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from target");
    });
    await new Promise<void>((resolve) => target!.listen(0, "127.0.0.1", resolve));
    const targetPort = (target!.address() as AddressInfo).port;

    const logs: Array<{ allowed: boolean; host: string; port: number }> = [];
    proxy = createEgressProxyServer({
      lookup: PUBLIC_LOOKUP,
      testOnlyDial: () => ({ host: "127.0.0.1", port: targetPort }),
      onLog: (entry) => logs.push(entry),
    });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy!.address() as AddressInfo).port;

    // Speak raw CONNECT + HTTP over the tunneled socket, like Chromium would
    // (minus TLS -- the tunnel itself does not care what is inside it).
    const socket = netConnect(proxyPort, "127.0.0.1");
    const response = await new Promise<string>((resolve, reject) => {
      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("hello from target")) resolve(buf);
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        socket.once("data", (chunk: Buffer) => {
          expect(chunk.toString("utf8")).toContain("200 Connection Established");
          socket.write("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
        });
      });
    });
    expect(response).toContain("hello from target");
    socket.destroy();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const tunnelLog = logs.find((l) => l.allowed && l.port === 443);
    expect(tunnelLog).toBeTruthy();
  });

  it("refuses a CONNECT to a private address with a 403 and closes the socket", async () => {
    proxy = createEgressProxyServer({ lookup: PRIVATE_LOOKUP });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy!.address() as AddressInfo).port;

    const socket = netConnect(proxyPort, "127.0.0.1");
    const response = await new Promise<string>((resolve, reject) => {
      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(buf));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("CONNECT internal.example:443 HTTP/1.1\r\nHost: internal.example:443\r\n\r\n");
      });
    });
    expect(response).toContain("403");
  });

  it("proxies a plain absolute-URI HTTP GET to the checked address", async () => {
    target = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain http ok");
    });
    await new Promise<void>((resolve) => target!.listen(0, "127.0.0.1", resolve));
    const targetPort = (target!.address() as AddressInfo).port;

    proxy = createEgressProxyServer({
      lookup: PUBLIC_LOOKUP,
      testOnlyDial: () => ({ host: "127.0.0.1", port: targetPort }),
    });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy!.address() as AddressInfo).port;

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: "http://example.com/",
          headers: { host: "example.com" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("plain http ok");
  });

  it("refuses a plain HTTP request to a disallowed port", async () => {
    proxy = createEgressProxyServer({ lookup: PUBLIC_LOOKUP });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy!.address() as AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      httpGet(
        { host: "127.0.0.1", port: proxyPort, path: "http://example.com:8080/", headers: { host: "example.com:8080" } },
        (res) => resolve(res.statusCode ?? 0),
      ).on("error", reject);
    });
    expect(status).toBe(403);
  });
});
