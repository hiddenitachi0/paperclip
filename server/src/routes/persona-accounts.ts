// DUR-134: persona publishing routes. Account setup/kill-switch/feed are
// board-only (operator decisions, mirroring personas.ts); enqueueing a post
// is the one action the persona's own agent may take for itself, and the
// publish-token resolve is instance-admin-only, mirroring deploy-github-token
// in secrets.ts. Not yet in the public OpenAPI document -- see the
// personas.ts precedent in openapi-routes.test.ts's exclusion list, which
// this file's entry follows.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb, personas } from "@paperclipai/db";
import {
  createPersonaAccountSchema,
  updatePersonaAccountSchema,
  connectPersonaAccountCredentialSchema,
  enqueuePersonaPostSchema,
  updatePersonaPublishingCompanySettingsSchema,
} from "@paperclipai/shared/validators/persona-account";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { notFound, forbidden } from "../errors.js";
import {
  personaAccountsService,
  PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH,
} from "../services/persona-accounts.js";
import { personaPublisherService } from "../services/persona-publisher.js";
import { personaPublishingSettingsService } from "../services/persona-publishing-settings.js";
import { secretService } from "../services/secrets.js";

export function personaAccountRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const accounts = personaAccountsService(db);
  const publisher = personaPublisherService(db);
  const publishingSettings = personaPublishingSettingsService(db);
  const secrets = secretService(db);

  function scopeFromCompanyIdParam(checkAccess: (req: import("express").Request, companyId: string) => void = assertBoard) {
    return companyScope(rawDb, (req) => {
      checkAccess(req, req.params.companyId as string);
      assertCompanyAccess(req, req.params.companyId as string);
      return req.params.companyId as string;
    });
  }

  function scopeFromAccountIdParam(accountIdParam: string, checkAccess?: (req: import("express").Request, companyId: string) => void | Promise<void>) {
    return companyScope(rawDb, async (req) => {
      const account = await personaAccountsService(rawDb).getAccountById(req.params[accountIdParam] as string);
      if (!account) throw notFound("Persona account not found");
      if (checkAccess) {
        await checkAccess(req, account.companyId);
      } else {
        assertBoard(req);
      }
      assertCompanyAccess(req, account.companyId);
      return account.companyId;
    });
  }

  // Board-only, resolved from a persona_posts row rather than a route param
  // -- companyId isn't known until the post is looked up (same
  // lookup-then-scope shape as scopeFromAccountIdParam above).
  function scopeFromPostIdParam(postIdParam: string) {
    return companyScope(rawDb, async (req) => {
      const post = await personaPublisherService(rawDb).getPostById(req.params[postIdParam] as string);
      if (!post) throw notFound("Persona post not found");
      assertBoard(req);
      assertCompanyAccess(req, post.companyId);
      return post.companyId;
    });
  }

  // The one non-board caller: a persona's own agent enqueueing its own
  // content. Board (an operator/CEO acting on the persona's behalf) may
  // always do this too. No other agent may enqueue for a persona it doesn't
  // own -- this is the "one persona, one set of accounts" scope isolation
  // from item 5.
  async function assertOwningAgentOrBoard(req: import("express").Request, companyId: string, personaId: string) {
    assertBoardOrAgent(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent") return;
    const [persona] = await rawDb.select({ agentId: personas.agentId }).from(personas).where(eq(personas.id, personaId));
    if (!persona || persona.agentId !== req.actor.agentId) {
      throw forbidden("Agent may only publish for its own persona");
    }
  }

  router.post(
    "/personas/:personaId/persona-accounts",
    companyScope(rawDb, async (req) => {
      assertBoard(req);
      const [persona] = await rawDb.select().from(personas).where(eq(personas.id, req.params.personaId as string));
      if (!persona) throw notFound("Persona not found");
      assertCompanyAccess(req, persona.companyId);
      return persona.companyId;
    }),
    validate(createPersonaAccountSchema),
    async (req, res) => {
      const [persona] = await rawDb.select().from(personas).where(eq(personas.id, req.params.personaId as string));
      if (!persona) {
        res.status(404).json({ error: "Persona not found" });
        return;
      }
      const account = await accounts.createAccount(persona.companyId, persona.id, req.body);
      res.status(201).json(account);
    },
  );

  router.get("/personas/:personaId/persona-accounts", scopeFromCompanyIdParam(), async (req, res) => {
    res.json(await accounts.listAccountsForPersona(req.params.personaId as string));
  });

  router.get("/companies/:companyId/persona-accounts", scopeFromCompanyIdParam(), async (req, res) => {
    res.json(await accounts.listAccountsForCompany(req.params.companyId as string));
  });

  router.get("/persona-accounts/:accountId", scopeFromAccountIdParam("accountId"), async (req, res) => {
    const account = await accounts.getAccountById(req.params.accountId as string);
    if (!account) {
      res.status(404).json({ error: "Persona account not found" });
      return;
    }
    res.json(account);
  });

  router.patch(
    "/persona-accounts/:accountId",
    scopeFromAccountIdParam("accountId"),
    validate(updatePersonaAccountSchema),
    async (req, res) => {
      res.json(await accounts.updateAccount(req.params.accountId as string, req.body));
    },
  );

  router.delete("/persona-accounts/:accountId", scopeFromAccountIdParam("accountId"), async (req, res) => {
    await accounts.deleteAccount(req.params.accountId as string);
    res.status(204).end();
  });

  // Item 2: bind the operator-supplied secret to this account's publish
  // credential slot. Board-only, same as everything else that touches which
  // secret backs an account -- distinct from the instance-admin-only resolve
  // route below, which is the ONLY path that ever reads the value back out.
  router.post(
    "/persona-accounts/:accountId/credential",
    scopeFromAccountIdParam("accountId"),
    validate(connectPersonaAccountCredentialSchema),
    async (req, res) => {
      const account = await accounts.getAccountById(req.params.accountId as string);
      if (!account) {
        res.status(404).json({ error: "Persona account not found" });
        return;
      }
      await secrets.createBinding({
        companyId: account.companyId,
        secretId: req.body.secretId,
        targetType: "persona_account",
        targetId: account.id,
        configPath: PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH,
        versionSelector: req.body.versionSelector,
      });
      res.status(204).end();
    },
  );

  // Item 2: the narrowly-scoped publish-token endpoint, modelled on
  // deploy-github-token. Instance-admin-only -- the persona's own agent
  // never calls this; only system-level publishing code (or, in future, an
  // out-of-band publisher process analogous to deploy-runner.sh) does.
  router.get(
    "/companies/:companyId/persona-accounts/:accountId/publish-token",
    companyScopeFromParam(rawDb, (req) => assertInstanceAdmin(req)),
    async (req, res) => {
      // Only a board actor ever reaches here (assertInstanceAdmin implies
      // assertBoard), so req.actor.userId is always defined in practice;
      // the fallback only guards the type.
      const actorId = req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
      const token = await accounts.resolvePublishToken(
        req.params.companyId as string,
        req.params.accountId as string,
        { actorType: "user", actorId },
      );
      res.json({ token });
    },
  );

  router.post(
    "/persona-accounts/:accountId/posts",
    companyScope(rawDb, async (req) => {
      const account = await personaAccountsService(rawDb).getAccountById(req.params.accountId as string);
      if (!account) throw notFound("Persona account not found");
      await assertOwningAgentOrBoard(req, account.companyId, account.personaId);
      return account.companyId;
    }),
    validate(enqueuePersonaPostSchema),
    async (req, res) => {
      const account = await accounts.getAccountById(req.params.accountId as string);
      if (!account) {
        res.status(404).json({ error: "Persona account not found" });
        return;
      }
      const post = await publisher.enqueuePost(account.companyId, account.id, req.body);
      res.status(201).json(post);
    },
  );

  router.get("/companies/:companyId/persona-posts", scopeFromCompanyIdParam(), async (req, res) => {
    res.json(await publisher.listFeedForCompany(req.params.companyId as string));
  });

  router.get("/persona-posts/:postId", scopeFromPostIdParam("postId"), async (req, res) => {
    const post = await publisher.getPostById(req.params.postId as string);
    if (!post) {
      res.status(404).json({ error: "Persona post not found" });
      return;
    }
    res.json(post);
  });

  // Manual/system trigger for one publish attempt. Item 4's routine-driven
  // schedule is not wired yet (see the PR description) -- this is the
  // interim way to actually run attemptPublish's safety gates end to end
  // (ops testing, and a stand-in for the scheduler until that lands).
  router.post("/persona-posts/:postId/attempt-publish", scopeFromPostIdParam("postId"), async (req, res) => {
    res.json(await publisher.attemptPublish(req.params.postId as string));
  });

  router.get(
    "/companies/:companyId/persona-publishing-settings",
    scopeFromCompanyIdParam(),
    async (req, res) => {
      const settings = await publishingSettings.getSettings(req.params.companyId as string);
      res.json(settings ?? { companyId: req.params.companyId, publishingPaused: false });
    },
  );

  router.patch(
    "/companies/:companyId/persona-publishing-settings",
    scopeFromCompanyIdParam(),
    validate(updatePersonaPublishingCompanySettingsSchema),
    async (req, res) => {
      const userId = req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
      res.json(
        await publishingSettings.setPublishingPaused(
          req.params.companyId as string,
          req.body.publishingPaused,
          userId,
        ),
      );
    },
  );

  return router;
}
