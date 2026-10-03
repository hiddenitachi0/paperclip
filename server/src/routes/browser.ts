/**
 * DUR-4013 step 3: `/api/browser/...`, the browse-and-forms REST surface the
 * thin MCP wrapper (`packages/mcp-server/src/browser-stdio.ts`) calls. Every
 * route here is agent-only, authenticated with that agent's own run JWT --
 * per the design, "Full runs only": a quick agent's requests never carry an
 * `agent` actor (Lane A authenticates as a `service` actor, see
 * middleware/auth.ts), so `req.actor.type === "agent"` already is the
 * full-run check, with no separate adapter-type lookup needed.
 *
 * A session belongs to exactly the agent that opened it; the service layer
 * (browser-service.ts) enforces that and every cap (1 session per agent, 2
 * per instance, 20 min / 5 min idle / 300 actions). This file only wires
 * HTTP <-> service calls and shapes the response.
 */
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  openBrowserSessionSchema,
  browserNavigateSchema,
  browserClickSchema,
  browserTypeSchema,
  browserSelectSchema,
  browserCheckSchema,
  browserPressKeySchema,
  browserWaitSchema,
  browserHandOverSchema,
  browserRequestBookingSchema,
  browserConfirmFinalStepSchema,
  browserRequestPurchaseSchema,
  browserFillPaymentDetailsSchema,
  browserWaitForOutcomeSchema,
  browserReportOutcomeSchema,
} from "@paperclipai/shared/validators/browser";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { browserService, type BrowserServiceDeps } from "../services/browser-service.js";

function requireAgentActor(req: Request): { agentId: string; companyId: string } {
  if (req.actor.type !== "agent") {
    throw forbidden("Only a full agent run may use the browser. Quick agents hand this work to a full-run agent.");
  }
  // Both middleware/auth.ts call sites that set `type: "agent"` always set
  // `agentId`/`companyId` in the same object literal, so this narrowing is
  // safe even though the Express.Request.actor type keeps them optional.
  return { agentId: req.actor.agentId!, companyId: req.actor.companyId! };
}

function sessionIdOf(req: Request): string {
  const value = req.params.sessionId;
  if (typeof value !== "string" || value.length === 0) throw notFound("Browser session not found");
  return value;
}

export function browserRoutes(rawDb: Db, deps: BrowserServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = browserService(db, deps);

  function agentScope() {
    return companyScope(rawDb, (req) => {
      const { companyId } = requireAgentActor(req);
      return companyId;
    });
  }

  router.post("/browser/sessions", agentScope(), validate(openBrowserSessionSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    const result = await svc.open(agentId, req.body);
    res.status(201).json(result);
  });

  router.post("/browser/sessions/:sessionId/navigate", agentScope(), validate(browserNavigateSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ snapshot: await svc.navigate(agentId, sessionIdOf(req), req.body.url) });
  });

  router.post("/browser/sessions/:sessionId/snapshot", agentScope(), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ snapshot: await svc.snapshot(agentId, sessionIdOf(req)) });
  });

  router.post("/browser/sessions/:sessionId/read-text", agentScope(), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ text: await svc.readText(agentId, sessionIdOf(req)) });
  });

  router.post("/browser/sessions/:sessionId/click", agentScope(), validate(browserClickSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json(await svc.click(agentId, sessionIdOf(req), req.body.ref, req.body.why));
  });

  router.post("/browser/sessions/:sessionId/type", agentScope(), validate(browserTypeSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json(await svc.type(agentId, sessionIdOf(req), req.body.ref, req.body.text));
  });

  router.post("/browser/sessions/:sessionId/select", agentScope(), validate(browserSelectSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ snapshot: await svc.select(agentId, sessionIdOf(req), req.body.ref, req.body.value) });
  });

  router.post("/browser/sessions/:sessionId/check", agentScope(), validate(browserCheckSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ snapshot: await svc.check(agentId, sessionIdOf(req), req.body.ref, req.body.checked) });
  });

  router.post("/browser/sessions/:sessionId/press-key", agentScope(), validate(browserPressKeySchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json(await svc.pressKey(agentId, sessionIdOf(req), req.body.key));
  });

  router.post("/browser/sessions/:sessionId/screenshot", agentScope(), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    const bytes = await svc.screenshot(agentId, sessionIdOf(req));
    res.json({ base64: Buffer.from(bytes).toString("base64") });
  });

  router.post("/browser/sessions/:sessionId/wait", agentScope(), validate(browserWaitSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    await svc.wait(agentId, sessionIdOf(req), req.body.ms);
    res.json({ ok: true });
  });

  router.post("/browser/sessions/:sessionId/back", agentScope(), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    res.json({ snapshot: await svc.back(agentId, sessionIdOf(req)) });
  });

  router.post("/browser/sessions/:sessionId/close", agentScope(), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    await svc.close(agentId, sessionIdOf(req));
    res.json({ ok: true });
  });

  router.post("/browser/sessions/:sessionId/hand-over", agentScope(), validate(browserHandOverSchema), async (req, res) => {
    const { agentId } = requireAgentActor(req);
    await svc.handOver(agentId, sessionIdOf(req), req.body.reason, req.body.whatFilipShouldDo);
    res.json({ ok: true });
  });

  // ── DUR-4037 (step 4): the booking gate. book_and_buy agents only -- the
  // service itself re-checks the agent's access level and the company kill
  // switch, this layer only wires HTTP <-> service, same as everything above.

  router.post(
    "/browser/sessions/:sessionId/request-booking",
    agentScope(),
    validate(browserRequestBookingSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.status(202).json(await svc.requestBooking(agentId, sessionIdOf(req), req.body.summary, req.body.ref));
    },
  );

  router.post(
    "/browser/sessions/:sessionId/confirm-final-step",
    agentScope(),
    validate(browserConfirmFinalStepSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.json({ snapshot: await svc.confirmFinalStep(agentId, sessionIdOf(req), req.body.ref) });
    },
  );

  // ── DUR-4046 (step 6): the purchase gate. book_and_buy agents only, same
  // access/kill-switch checks as booking, re-checked by the service itself --
  // this layer only wires HTTP <-> service, same as everything above.

  router.post(
    "/browser/sessions/:sessionId/request-purchase",
    agentScope(),
    validate(browserRequestPurchaseSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.status(202).json(await svc.requestPurchase(agentId, sessionIdOf(req), req.body.summary, req.body.ref, req.body.cardId));
    },
  );

  router.post(
    "/browser/sessions/:sessionId/fill-payment-details",
    agentScope(),
    validate(browserFillPaymentDetailsSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.json({ snapshot: await svc.fillPaymentDetails(agentId, sessionIdOf(req), req.body) });
    },
  );

  router.post(
    "/browser/sessions/:sessionId/wait-for-outcome",
    agentScope(),
    validate(browserWaitForOutcomeSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.json(await svc.waitForOutcome(agentId, sessionIdOf(req), req.body.ms));
    },
  );

  router.post(
    "/browser/sessions/:sessionId/report-outcome",
    agentScope(),
    validate(browserReportOutcomeSchema),
    async (req, res) => {
      const { agentId } = requireAgentActor(req);
      res.json(await svc.reportOutcome(agentId, sessionIdOf(req), req.body.agentNote));
    },
  );

  return router;
}
