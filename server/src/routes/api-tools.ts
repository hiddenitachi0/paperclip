import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import {
  agentApiToolSelectionSchema,
  apiToolBodySchema,
  apiToolImportOpenApiSchema,
  apiToolUpdateSchema,
  runApiToolActionSchema,
} from "@paperclipai/shared/validators/api-tool";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { agentService } from "../services/index.js";
import { apiToolService, type ApiToolServiceDeps } from "../services/api-tools.js";
import { importOpenApiActions } from "../services/api-tools-openapi.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * DUR-4004: "API with a key" tools.
 *
 * Board routes (the Tools page and the agent's Tools tab): any active member
 * of the company can read; only the company's owner or admin (or an instance
 * admin, or the local single-user board) can add, change, test, import or
 * delete a tool, or change which tools an agent has. Agents are refused on
 * every one of these, so an agent can never grant itself a tool.
 *
 * One route is for agents: running an action. An agent may run an action of
 * a tool that is ticked on for it, in its own company; a board user who can
 * write in the company may run one too (the Tools page's manual try-out).
 * The key is attached server-side; no route here ever returns it.
 *
 * Request bodies carry the key's secret id only, never a value, so a 4xx on
 * any of these routes cannot write a key to the log (the logger redacts by
 * field NAME).
 */

function assertCompanyOwnerOrAdmin(req: Request, companyId: string, what: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden(`Only a company owner or admin can change ${what}. You can see them, but not change them.`);
    }
  }
  assertCompanyAccess(req, companyId);
}

export function apiToolRoutes(rawDb: Db, deps: ApiToolServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = apiToolService(db, deps);
  const agentsSvc = agentService(db, { rawDb });

  function memberScope() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  function ownerOrAdminScope(what: string) {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId, what);
      return companyId;
    });
  }

  /** The run route: an agent of this company, or a board user who can write in it. */
  function runScope() {
    return companyScope(rawDb, (req) => {
      assertAuthenticated(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      if (req.actor.type !== "agent" && req.actor.type !== "board") {
        throw forbidden("Only an agent or a board user can run a tool action.");
      }
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  async function loadAgent(agentId: string) {
    const [agent] = await rawDb
      .select({ id: agents.id, companyId: agents.companyId, apiToolIds: agents.apiToolIds })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  function agentReadScope() {
    return companyScope(rawDb, async (req) => {
      assertAuthenticated(req);
      const agent = await loadAgent(req.params.agentId as string);
      if (req.actor.type === "agent") {
        // An agent may look up its own tools (that is how a full agent can
        // re-read its action list); never another agent's.
        if (req.actor.agentId !== agent.id) throw forbidden("An agent can only read its own tools.");
      } else {
        assertBoard(req);
      }
      assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  function agentWriteScope() {
    return companyScope(rawDb, async (req) => {
      const agent = await loadAgent(req.params.agentId as string);
      assertCompanyOwnerOrAdmin(req, agent.companyId, "an agent's tools");
      return agent.companyId;
    });
  }

  // ── Company tool library ────────────────────────────────────────────────

  router.get("/companies/:companyId/api-tools", memberScope(), async (req, res) => {
    res.json(await svc.list(req.params.companyId as string));
  });

  router.post("/companies/:companyId/api-tools", ownerOrAdminScope("tools"), validate(apiToolBodySchema), async (req, res) => {
    const created = await svc.create(req.params.companyId as string, req.body, {
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/api-tools/import-openapi",
    ownerOrAdminScope("tools"),
    validate(apiToolImportOpenApiSchema),
    async (req, res) => {
      res.json(await importOpenApiActions((req.body as { url: string }).url, { lookup: deps.lookup, testOnlyDial: deps.testOnlyDial }));
    },
  );

  router.get("/companies/:companyId/api-tools/:toolId", memberScope(), async (req, res) => {
    res.json(await svc.get(req.params.companyId as string, req.params.toolId as string));
  });

  router.patch("/companies/:companyId/api-tools/:toolId", ownerOrAdminScope("tools"), validate(apiToolUpdateSchema), async (req, res) => {
    res.json(await svc.update(req.params.companyId as string, req.params.toolId as string, req.body));
  });

  router.delete("/companies/:companyId/api-tools/:toolId", ownerOrAdminScope("tools"), async (req, res) => {
    await svc.remove(req.params.companyId as string, req.params.toolId as string);
    res.status(204).send();
  });

  router.post("/companies/:companyId/api-tools/:toolId/test", ownerOrAdminScope("tools"), async (req, res) => {
    res.json(
      await svc.test(req.params.companyId as string, req.params.toolId as string, {
        userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      }),
    );
  });

  // ── Running an action (agents and board) ────────────────────────────────

  router.post(
    "/companies/:companyId/api-tools/:toolId/actions/:action/run",
    runScope(),
    validate(runApiToolActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const toolId = req.params.toolId as string;
      const actionName = req.params.action as string;
      const { input } = req.body as { input: Record<string, unknown> };
      if (req.actor.type === "agent") {
        const agentId = req.actor.agentId ?? "";
        const agent = await loadAgent(agentId);
        const granted = Array.isArray(agent.apiToolIds) && (agent.apiToolIds as string[]).includes(toolId);
        if (!granted) {
          throw forbidden("This tool is not ticked on for you. Ask a company owner or admin to give it to you from your Tools tab.");
        }
        const result = await svc.runAction(companyId, toolId, actionName, input, {
          channel: "agent_run",
          agentId,
          userId: null,
          runId: req.actor.runId ?? null,
        });
        res.json(result);
        return;
      }
      const result = await svc.runAction(companyId, toolId, actionName, input, {
        channel: "board",
        agentId: null,
        userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
        runId: null,
      });
      res.json(result);
    },
  );

  // ── Per-agent checkbox assignment ───────────────────────────────────────

  router.get("/agents/:agentId/api-tools", agentReadScope(), async (req, res) => {
    const agent = await loadAgent(req.params.agentId as string);
    const selected = Array.isArray(agent.apiToolIds) ? (agent.apiToolIds as string[]) : [];
    if (req.actor.type === "agent") {
      res.json(await svc.listGranted(agent.companyId, selected));
      return;
    }
    res.json(await svc.listForAgent(agent.companyId, selected));
  });

  router.post("/agents/:agentId/api-tools/sync", agentWriteScope(), validate(agentApiToolSelectionSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await loadAgent(agentId);
    const uniqueIds = [...new Set((req.body as { desiredToolIds: string[] }).desiredToolIds)];
    for (const toolId of uniqueIds) {
      // svc.get is company-scoped: another company's tool is "not found".
      try {
        await svc.get(agent.companyId, toolId);
      } catch {
        throw unprocessable(`Tool ${toolId} does not belong to this agent's company`);
      }
    }
    res.json(await agentsSvc.syncApiToolSelection(agentId, uniqueIds));
  });

  return router;
}
