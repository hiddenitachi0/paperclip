import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "chat-router.ts": "/api",
  "cloud-upstreams.ts": "/api",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "costs.ts": "/api",
  "cross-company-instructions.ts": "/api",
  "customer-inbox.ts": "/api",
  "dashboard.ts": "/api",
  "deploy-runner.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-dismissals.ts": "/api",
  "organization-checkup.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "instance-claude-auth.ts": "/api",
  "instance-security.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "lane-a.ts": "/api",
  "llms.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "preview-environments.ts": "/api",
  // Mounted at the server root (like plugin-ui-static.ts), documented under
  // /api so this coverage check still sees every method the proxy answers.
  "preview-proxy.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "teams-catalog.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
  // Agent role/job routes (DUR-114) are a new backend feature not yet in the public OpenAPI document.
  "agent-roles.ts",
  // MCP tool library routes (DUR-143) are a new backend feature not yet in the public OpenAPI document.
  "mcp-tool-library.ts",
  // Persona routes (DUR-133) are board-only and not yet in the public OpenAPI document.
  "personas.ts",
  // Persona publishing routes (DUR-134) are board/instance-admin-only and not yet in the public OpenAPI document.
  "persona-accounts.ts",
  // Operator change-log routes (DUR-312) are a new backend feature not yet in the public OpenAPI document.
  "change-log.ts",
  // Goal adoption dashboard routes (DUR-375) are a new backend feature not yet in the public OpenAPI document.
  "goal-adoption.ts",
  // MCP OAuth "Connect & sign in" routes (DUR-3909) are a new backend feature not yet in the public OpenAPI document.
  "mcp-oauth.ts",
]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const unknownRouteFiles: string[] = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      routes.add(`${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`);
    }

    if (file === "companies.ts" && source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")) {
      routes.add("POST /api/companies/import");
    }
  }

  return { routes, unknownRouteFiles: unknownRouteFiles.sort() };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe("Create an agent API key");
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
      // DUR-3977: the credential the Lane A transform lane actually takes.
      // Without a scheme in the document, a generated client has no way to
      // send it at all.
      ServiceTokenAuth: { type: "http", scheme: "bearer", bearerFormat: "Company Service Token" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
  });

  /**
   * DUR-3977: the contract another team implements against. Each assertion
   * below corresponds to a way a dashboard team could be misled into writing
   * code that cannot work.
   */
  describe("the Lane A transform lane advertises the credential it actually takes", () => {
    const transformOperations = [
      ["/api/lane-a/{agentId}/transform", "post"] as const,
      ["/api/lane-a/agents", "get"] as const,
    ];

    it("offers the service token first, and never the agent bearer token", () => {
      const { spec } = loadSpecRoutes();
      for (const [path, method] of transformOperations) {
        const operation = spec.paths[path][method];
        expect(operation.security, `${method} ${path}`).toEqual([
          { ServiceTokenAuth: [] },
          { BoardSessionAuth: [] },
          { BoardApiKeyAuth: [] },
        ]);
        // An agent key is refused with 403 by assertServiceOrBoard, so
        // advertising it would send a client straight into a 403 loop.
        expect(JSON.stringify(operation.security)).not.toContain("AgentBearerAuth");
        expect(operation["x-paperclip-authorization"]).toEqual({
          actor: "service_or_board",
          serviceTokenScope: "lane_a:transform",
          agentTokenRefused: true,
        });
      }
    });

    it("gives 429 a schema that carries the reason a caller must branch on", () => {
      const { spec } = loadSpecRoutes();
      const schema =
        spec.paths["/api/lane-a/{agentId}/transform"].post.responses["429"].content["application/json"].schema;
      // Either the inlined object or a $ref to the registered component.
      const resolved = schema.$ref
        ? spec.components.schemas[String(schema.$ref).split("/").pop()!]
        : schema;
      expect(resolved.properties.details).toBeDefined();
      expect(resolved.properties.details.properties.reason.enum).toEqual([
        "daily_call_cap",
        "monthly_budget",
        "concurrency_limit",
        "upstream_rate_limit",
      ]);
    });

    it("documents the statuses an unattended run has to branch on, and not the one that never fires", () => {
      const { spec } = loadSpecRoutes();
      const responses = spec.paths["/api/lane-a/{agentId}/transform"].post.responses;
      // 502 and 503 decide retry-vs-abort for a 1400-item run.
      expect(responses["502"]).toBeDefined();
      expect(responses["503"]).toBeDefined();
      // 401 is unreachable: an unknown, revoked or expired service token
      // leaves the request unauthenticated and assertServiceOrBoard answers
      // 403. Documenting 401 would have a dashboard wait forever for a signal
      // to rotate the token.
      expect(responses["401"]).toBeUndefined();
      expect(responses["403"]).toBeDefined();
      expect(JSON.stringify(responses["403"])).toContain(
        "A company service token or board access is required",
      );
    });
  });
});
