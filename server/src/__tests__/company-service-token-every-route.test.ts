import { randomUUID } from "node:crypto";
import type { Express } from "express";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyServiceTokenService } from "../services/company-service-tokens.js";

/**
 * DUR-3977: EVERY route in the real app, driven by a real service token.
 *
 * Why this file exists, and why it is not another hand-written list.
 *
 * A company service token is the first credential Paperclip hands to a system
 * outside itself. "What can it reach" was answered twice before this, and both
 * answers were lists a person typed:
 *
 *   - company-service-token-auth.test.ts probes a handful of synthetic
 *     handlers built for the test. It passed while the shipped credential
 *     could read the company dashboard and call POST /api/chat/classify.
 *   - company-service-token-route-table.test.ts pins ten real routes by name.
 *     It passed while five more routes — the static /api/skills and
 *     /api/teams/catalog reads — still answered 200, because nobody had
 *     thought to type those ten names plus those five.
 *
 * That is the same failure both times: two lists that must agree, with
 * nothing enforcing the agreement. So this file writes no list of routes at
 * all. It builds the production app with `createApp` — every router the real
 * server mounts, in the real order, behind the real middleware — records
 * every route registration as it is made, and fires a real minted token at
 * all of them. The only list here is the ANSWER: the set of routes that may
 * reply 2xx. Add a route to the server and it is probed automatically; if it
 * lets a service token in, this test fails and someone has to decide, on
 * purpose, whether to widen the answer.
 */

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-service-token-every-route";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest-service-token-every-route";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-service-token-every-route/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the exhaustive service-token route probe on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * The whole answer, in one place.
 *
 * A service token may reach the two Lane A routes it is issued for, and
 * nothing else. Everything else in the app must refuse it.
 *
 * `POST /api/lane-a/:agentId/transform` is checked separately below rather
 * than listed here: with no model key in the test environment it stops at 503
 * INSIDE the handler, which is what "the credential was accepted" looks like
 * for that route.
 */
const AUTHENTICATED_2XX_GRANT = ["GET /api/lane-a/agents"];

/**
 * Routes that answer 2xx to ANY caller because they are deliberately
 * unauthenticated: the load-balancer health probe and the published API
 * description. They are not a service-token grant and they carry no tenant
 * data. They are named here rather than filtered by a pattern so that a new
 * unauthenticated route shows up as a test failure and has to be added on
 * purpose.
 */
const UNAUTHENTICATED_BY_DESIGN = ["GET /api/health/", "GET /api/openapi.json"];

/**
 * Nothing is skipped. There is deliberately no "routes we do not probe" list
 * here, because such a list is exactly the thing that let the original hole
 * ship: a route nobody drove is a route nobody checked. If a future route
 * holds the connection open (a server-sent-event stream, say) this test will
 * time out rather than quietly pass, and whoever added it has to decide what
 * to do about it in the open.
 */

type Registration = { owner: unknown; method: string; path: string };
type Mount = { parent: unknown; prefix: string; child: unknown };

/**
 * Records every route registration made while `build()` runs.
 *
 * Express 5 keeps no mount path on a Layer, so a finished app cannot be asked
 * "what full URL is this route on". Recording the registrations as they
 * happen answers that without depending on router internals: `route(path)`
 * gives the path and the owning router, `use(prefix, router)` gives the
 * mount, and the two compose into full paths afterwards.
 */
async function recordRoutesWhileBuilding(build: () => Promise<Express>): Promise<{
  app: Express;
  routes: Array<{ method: string; path: string }>;
}> {
  const routerProto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router())) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const originalRoute = routerProto.route;
  const originalUse = routerProto.use;

  const registrations: Registration[] = [];
  const mounts: Mount[] = [];

  routerProto.route = function patchedRoute(this: unknown, path: unknown) {
    const route = originalRoute.call(this, path) as Record<string, unknown>;
    const owner = this;
    for (const method of HTTP_METHODS) {
      const original = route[method] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== "function") continue;
      route[method] = function patchedMethod(this: unknown, ...args: unknown[]) {
        registrations.push({ owner, method: method.toUpperCase(), path: String(path) });
        return original.apply(this, args);
      };
    }
    return route;
  };

  routerProto.use = function patchedUse(this: unknown, ...args: unknown[]) {
    const [first, ...rest] = args;
    const prefix = typeof first === "string" ? first : "";
    const handlers = typeof first === "string" ? rest : args;
    for (const handler of handlers.flat()) {
      // A mounted router is a function carrying a `stack`; plain middleware is
      // not, and mounts nothing we can reach.
      if (typeof handler === "function" && Array.isArray((handler as { stack?: unknown }).stack)) {
        mounts.push({ parent: this, prefix, child: handler });
      }
    }
    return originalUse.apply(this, args);
  };

  let app: Express;
  try {
    app = await build();
  } finally {
    routerProto.route = originalRoute;
    routerProto.use = originalUse;
  }

  // Walk out from the app's own root router, accumulating mount prefixes. A
  // router mounted twice yields both paths, which is what the server does too.
  const routes: Array<{ method: string; path: string }> = [];
  const seen = new Set<string>();
  const queue: Array<{ router: unknown; prefix: string }> = [
    { router: (app as unknown as { router: unknown }).router, prefix: "" },
  ];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const { router, prefix } = queue.shift()!;
    if (visited.has(router)) continue;
    visited.add(router);
    for (const registration of registrations) {
      if (registration.owner !== router) continue;
      const full = normalizePath(prefix + registration.path);
      const key = `${registration.method} ${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method: registration.method, path: full });
    }
    for (const mount of mounts) {
      if (mount.parent !== router) continue;
      queue.push({ router: mount.child, prefix: normalizePath(prefix + mount.prefix) });
    }
  }
  return { app, routes };
}

function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed;
  return collapsed;
}

/** Turn a route pattern into a URL a request can actually be sent to. */
function concreteUrl(pattern: string, ids: { companyId: string; agentId: string }): string {
  return pattern
    .replace(/\{\/?\*[A-Za-z0-9_]*\}/g, "/x")
    .replace(/\*[A-Za-z0-9_]*/g, "x")
    .replace(/\{\/?:companyId\}/g, `/${ids.companyId}`)
    .replace(/\{\/?:agentId\}/g, `/${ids.agentId}`)
    .replace(/\{\/?:([A-Za-z0-9_]+)\}/g, () => `/${randomUUID()}`)
    .replace(/:companyId(?![A-Za-z0-9_])/g, ids.companyId)
    .replace(/:agentId(?![A-Za-z0-9_])/g, ids.agentId)
    .replace(/:id(?![A-Za-z0-9_])/g, ids.agentId)
    .replace(/:[A-Za-z0-9_]+/g, () => randomUUID());
}

describeEmbeddedPostgres("DUR-3977: what a company service token reaches in the WHOLE app", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: Express;
  let routes: Array<{ method: string; path: string }> = [];
  let companyId!: string;
  let agentId!: string;
  let token!: string;
  let previousAnthropicKey: string | undefined;

  beforeAll(async () => {
    previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    // With no model key, the transform handler stops at 503 instead of making
    // a real model call. Reaching that 503 is the proof the credential was
    // accepted; every other route must never get that far.
    delete process.env.ANTHROPIC_API_KEY;

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3977-every-route-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Produkttekster",
      role: "general",
      status: "idle",
      laneAEnabled: true,
    });
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: null,
      scopes: ["lane_a:transform"],
    });
    token = created.token;

    // Any read or write through this stub is a route that got past every
    // authorization gate, so make it loud rather than silent.
    const storageStub = {
      getObjectStream: async () => {
        throw new Error("a service token reached object storage");
      },
      getObject: async () => {
        throw new Error("a service token reached object storage");
      },
      putObject: async () => {
        throw new Error("a service token reached object storage");
      },
      deleteObject: async () => {
        throw new Error("a service token reached object storage");
      },
    } as never;

    const { createApp } = await import("../app.js");
    const recorded = await recordRoutesWhileBuilding(
      () =>
        createApp(db, {
          uiMode: "none",
          serverPort: 0,
          storageService: storageStub,
          deploymentMode: "authenticated",
          deploymentExposure: "local",
          allowedHostnames: ["localhost", "127.0.0.1"],
          bindHost: "127.0.0.1",
          authReady: true,
          companyDeletionEnabled: false,
          instanceId: "vitest-service-token-every-route",
        } as never) as Promise<Express>,
    );
    app = recorded.app;
    // Everything the app registers, including the handful mounted outside
    // /api (the llms.txt reads, the plugin UI static server and the preview
    // proxy). Those are routes a credential can be pointed at too.
    routes = recorded.routes;
  }, 300_000);

  afterAll(async () => {
    if (previousAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    const shutdown = (app as unknown as { locals?: { paperclipShutdown?: () => void } })?.locals
      ?.paperclipShutdown;
    shutdown?.();
    await tempDb?.cleanup();
  });

  it("enumerated the real route table, not a handful of test routers", () => {
    // A failure here means the recorder stopped seeing registrations (an
    // Express upgrade, most likely) and the probe below would be vacuously
    // green. Fix the recorder rather than lowering this number.
    expect(routes.length).toBeGreaterThan(400);
    const paths = routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("POST /api/lane-a/:agentId/transform");
    expect(paths).toContain("GET /api/lane-a/agents");
    expect(paths).toContain("POST /api/chat/classify");
    expect(paths).toContain("GET /api/skills/available");
  });

  it("answers 2xx on EXACTLY the routes it was issued for, across the whole app", async () => {
    const results: Array<{ method: string; path: string; url: string; status: number }> = [];

    for (const route of routes) {
      const method = route.method.toLowerCase() as (typeof HTTP_METHODS)[number];
      if (!HTTP_METHODS.includes(method)) continue;

      const url = concreteUrl(route.path, { companyId, agentId });
      let pending = (request(app) as unknown as Record<string, (u: string) => request.Test>)[
        method
      ](url).set("authorization", `Bearer ${token}`);
      if (["post", "put", "patch"].includes(method)) {
        // A body that satisfies the most common validators, so a route that
        // would accept the token fails on authorization rather than on a
        // missing field (a 400 would read as "refused" and hide the hole).
        pending = pending.send({
          companyId,
          agentId,
          input: "Stol i eik.",
          message: "hei",
          name: "x",
        });
      }

      let status = 0;
      try {
        status = (await pending.timeout({ deadline: 15_000 })).status;
      } catch (err) {
        status = (err as { status?: number }).status ?? -1;
      }
      results.push({ method: route.method, path: route.path, url, status });
    }

    const twoXx = results
      .filter((result) => result.status >= 200 && result.status < 300)
      .map((result) => `${result.method} ${result.path}`)
      .sort();

    const distribution = new Map<number, number>();
    for (const result of results) {
      distribution.set(result.status, (distribution.get(result.status) ?? 0) + 1);
    }
    const summary = [...distribution.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${count}x${status}`)
      .join(" / ");

    // Printed on success as well as failure: the status spread is the
    // evidence the probe actually drove the app, and it is what a reviewer
    // reads in CI without re-running anything.
    process.stderr.write(`DUR-3977 service-token probe: ${results.length} routes -> ${summary}\n`);

    expect(
      twoXx,
      `probed ${results.length} routes (${summary}); unexpected 2xx above the grant`,
    ).toEqual([...AUTHENTICATED_2XX_GRANT, ...UNAUTHENTICATED_BY_DESIGN].sort());

    // The other half of the claim: the route the token IS for stays reachable.
    // Without this, deleting the whole feature would make the test pass.
    const transform = results.find(
      (result) => `${result.method} ${result.path}` === "POST /api/lane-a/:agentId/transform",
    );
    expect(transform?.status, "the transform route must still accept the token").toBe(503);
  }, 600_000);
});
