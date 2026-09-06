import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { notFound } from "../errors.js";

export function secretRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; the
  // raw `rawDb` stays unwrapped for the pre-scope lookups the (b)-category
  // routes below need before their companyId (and therefore their scope) is
  // known. See middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const svc = secretService(db, rawDb);
  const rawSvc = secretService(rawDb);
  const defaultProvider = getConfiguredSecretProvider();

  // Instance-admin-only: resolves the company's GITHUB_TOKEN/GH_TOKEN secret
  // value by name convention (see resolveGitHubToken), never by arbitrary
  // secret id. Used exclusively by the on-box deploy runner (DUR-9) to
  // authenticate `git fetch` against private deploy targets; deliberately not
  // a general secret-value-reveal endpoint.
  router.get(
    "/companies/:companyId/deploy-github-token",
    companyScopeFromParam(rawDb, (req) => assertInstanceAdmin(req)),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const token = await svc.resolveGitHubToken(companyId, {
        consumerType: "system",
        consumerId: "deploy-runner",
      });
      res.json({ token });
    },
  );

  router.get(
    "/companies/:companyId/secret-providers",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    (req, res) => {
      res.json(svc.listProviders());
    },
  );

  router.get(
    "/companies/:companyId/secret-providers/health",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const checks = await svc.checkProviders();
      res.json({ providers: checks });
    },
  );

  router.get(
    "/companies/:companyId/secret-provider-configs",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.json(await svc.listProviderConfigs(companyId));
    },
  );

  router.post(
    "/companies/:companyId/secret-provider-configs/discovery/preview",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    validate(secretProviderConfigDiscoveryPreviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;

      const preview = await svc.previewProviderConfigDiscovery(companyId, {
        provider: req.body.provider,
        config: req.body.config,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret_provider_config.discovery_previewed",
        entityType: "secret_provider_config_discovery",
        entityId: companyId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          sampledSecretCount: preview.sampledSecretCount,
          warningCount: preview.warnings.length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secret-provider-configs",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    validate(createSecretProviderConfigSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;

    const created = await svc.createProviderConfig(
      companyId,
      {
        provider: req.body.provider,
        displayName: req.body.displayName,
        status: req.body.status,
        isDefault: req.body.isDefault,
        config: req.body.config,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.created",
      entityType: "secret_provider_config",
      entityId: created.id,
      details: {
        provider: created.provider,
        displayName: created.displayName,
        status: created.status,
        isDefault: created.isDefault,
      },
    });

    res.status(201).json(created);
    },
  );

  function scopeFromProviderConfig() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const existing = await rawSvc.getProviderConfigById(req.params.id as string);
      if (!existing) throw notFound("Provider vault not found");
      assertCompanyAccess(req, existing.companyId);
      return existing.companyId;
    });
  }

  router.get("/secret-provider-configs/:id", scopeFromProviderConfig(), async (req, res) => {
    const existing = await svc.getProviderConfigById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }
    res.json(existing);
  });

  router.patch(
    "/secret-provider-configs/:id",
    validate(updateSecretProviderConfigSchema),
    scopeFromProviderConfig(),
    async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    const updated = await svc.updateProviderConfig(id, {
      displayName: req.body.displayName,
      status: req.body.status,
      isDefault: req.body.isDefault,
      config: req.body.config,
    });
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.updated",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        status: updated.status,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
    },
  );

  router.delete("/secret-provider-configs/:id", scopeFromProviderConfig(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    const removed = await svc.removeProviderConfig(id);
    if (!removed) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.removed",
      entityType: "secret_provider_config",
      entityId: removed.id,
      details: {
        provider: removed.provider,
        displayName: removed.displayName,
        remoteDeleted: false,
      },
    });

    res.json(removed);
  });

  router.post("/secret-provider-configs/:id/default", scopeFromProviderConfig(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    const updated = await svc.setDefaultProviderConfig(id);
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.default_set",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.post("/secret-provider-configs/:id/health", scopeFromProviderConfig(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProviderConfigById(id);
    if (!existing) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    const health = await svc.checkProviderConfigHealth(id);
    if (!health) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.health_checked",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: {
        provider: existing.provider,
        status: health.status,
        code: health.details.code,
      },
    });

    res.json(health);
  });

  router.get(
    "/companies/:companyId/secrets",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const secrets = await svc.list(companyId);
      res.json(secrets);
    },
  );

  router.post(
    "/companies/:companyId/secrets",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    validate(createSecretSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        key: req.body.key,
        provider: req.body.provider ?? defaultProvider,
        providerConfigId: req.body.providerConfigId,
        managedMode: req.body.managedMode,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerMetadata: req.body.providerMetadata,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import/preview",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    validate(remoteSecretImportPreviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;

      const preview = await svc.previewRemoteImport(companyId, {
        providerConfigId: req.body.providerConfigId,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.previewed",
        entityType: "secret_provider_config",
        entityId: preview.providerConfigId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          readyCount: preview.candidates.filter((candidate) => candidate.status === "ready").length,
          duplicateCount: preview.candidates.filter((candidate) => candidate.status === "duplicate").length,
          conflictCount: preview.candidates.filter((candidate) => candidate.status === "conflict").length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    validate(remoteSecretImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;

      const result = await svc.importRemoteSecrets(
        companyId,
        {
          providerConfigId: req.body.providerConfigId,
          secrets: req.body.secrets,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.completed",
        entityType: "secret_provider_config",
        entityId: result.providerConfigId,
        details: {
          provider: result.provider,
          importedCount: result.importedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount,
        },
      });

      res.json(result);
    },
  );

  function scopeFromSecret() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const existing = await rawSvc.getById(req.params.id as string);
      if (!existing) throw notFound("Secret not found");
      assertCompanyAccess(req, existing.companyId);
      return existing.companyId;
    });
  }

  router.post(
    "/secrets/:id/rotate",
    validate(rotateSecretSchema),
    scopeFromSecret(),
    async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerConfigId: req.body.providerConfigId,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
    },
  );

  router.patch(
    "/secrets/:id",
    validate(updateSecretSchema),
    scopeFromSecret(),
    async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const updated = await svc.update(id, {
      name: req.body.name,
      key: req.body.key,
      status: req.body.status,
      providerConfigId: req.body.providerConfigId,
      description: req.body.description,
      externalRef: req.body.externalRef,
      providerMetadata: req.body.providerMetadata,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
    },
  );

  router.get("/secrets/:id/usage", scopeFromSecret(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    const bindings = await svc.listBindingReferences(existing.companyId, existing.id);
    res.json({ secretId: existing.id, bindings });
  });

  router.get("/secrets/:id/access-events", scopeFromSecret(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    const events = await svc.listAccessEvents(existing.companyId, existing.id);
    res.json(events);
  });

  router.delete("/secrets/:id", scopeFromSecret(), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
