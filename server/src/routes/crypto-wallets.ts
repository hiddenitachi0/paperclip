import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  addCryptoWalletDestinationSchema,
  createCryptoWalletSchema,
  cryptoAgentLimitsSchema,
  cryptoQuoteRequestSchema,
  cryptoSendRequestSchema,
  hyperliquidOrderRequestSchema,
  setCryptoWalletFrozenSchema,
  updateCompanyCryptoSettingsSchema,
  updateCryptoWalletSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyOwnerAdminOrInstanceAdmin } from "./authz.js";
import { cryptoWalletService, type CryptoWalletServiceDeps } from "../services/crypto-wallets.js";

/**
 * Crypto wallets for agents. Two surfaces:
 *
 *   /companies/:companyId/crypto/...  -- the owner/admin "Wallets" screens.
 *     Every route, reading included, is owner/admin (or instance admin)
 *     only: these screens move money. Turning real money ON is owner-only
 *     (checked in the service, with the confirm phrase).
 *
 *   /agent-wallets/...  -- what an agent's tools call. Agent actor only,
 *     identity and company from the agent's own run token, never from the
 *     request; an agent only ever sees and uses wallets assigned to it.
 *
 * No route returns key material. Wallet responses never include the secret
 * id either. The import route's body carries a private key: the field is
 * named `privateKey`, which the HTTP logger always redacts, and nothing
 * here logs or echoes it.
 */

function requireAgentActor(req: Request): { agentId: string; companyId: string } {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
    throw forbidden("Only an agent's own run can use its crypto wallet tools.");
  }
  return { agentId: req.actor.agentId, companyId: req.actor.companyId };
}

function isOwner(req: Request, companyId: string): boolean {
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
  return membership?.status === "active" && membership.membershipRole === "owner";
}

function userIdOf(req: Request): string {
  return req.actor.userId ?? "board";
}

export function cryptoWalletRoutes(rawDb: Db, deps: CryptoWalletServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = cryptoWalletService(db, rawDb, deps);

  function ownerAdminScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "crypto wallets");
    });
  }

  function agentScope() {
    return companyScope(rawDb, (req) => requireAgentActor(req).companyId);
  }

  const companyIdOf = (req: Request) => req.params.companyId as string;
  const walletIdOf = (req: Request) => req.params.walletId as string;

  // ─── Owner/admin ─────────────────────────────────────────────────────

  router.get("/companies/:companyId/crypto/settings", ownerAdminScope(), async (req, res) => {
    res.json(await svc.getSettings(companyIdOf(req)));
  });

  router.patch("/companies/:companyId/crypto/settings", validate(updateCompanyCryptoSettingsSchema), ownerAdminScope(), async (req, res) => {
    const companyId = companyIdOf(req);
    const result = await svc.updateSettings(companyId, req.body, { userId: userIdOf(req), isOwner: isOwner(req, companyId) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userIdOf(req),
      action: "crypto.settings_changed",
      entityType: "company",
      entityId: companyId,
      details: {
        mainnetEnabled: req.body.mainnetEnabled ?? null,
        allWalletsFrozen: req.body.allWalletsFrozen ?? null,
        endpointsChanged: req.body.rpcEndpoints ? Object.keys(req.body.rpcEndpoints) : [],
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/crypto/wallets", ownerAdminScope(), async (req, res) => {
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    res.json(await svc.listWallets(companyIdOf(req), { agentId }));
  });

  router.post("/companies/:companyId/crypto/wallets", validate(createCryptoWalletSchema), ownerAdminScope(), async (req, res) => {
    const companyId = companyIdOf(req);
    const wallet = await svc.createWallet(companyId, req.body, { userId: userIdOf(req) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userIdOf(req),
      action: wallet.keyOrigin === "imported" ? "crypto.wallet_imported" : "crypto.wallet_created",
      entityType: "agent",
      entityId: wallet.agentId ?? companyId,
      agentId: wallet.agentId,
      details: { walletId: wallet.id, chain: wallet.chain, network: wallet.network, address: wallet.address },
    });
    res.status(201).json(wallet);
  });

  router.get("/companies/:companyId/crypto/wallets/:walletId", ownerAdminScope(), async (req, res) => {
    res.json(await svc.getWallet(companyIdOf(req), walletIdOf(req)));
  });

  router.patch("/companies/:companyId/crypto/wallets/:walletId", validate(updateCryptoWalletSchema), ownerAdminScope(), async (req, res) => {
    res.json(await svc.updateWallet(companyIdOf(req), walletIdOf(req), req.body, { userId: userIdOf(req) }));
  });

  /** The per-wallet kill switch. */
  router.post("/companies/:companyId/crypto/wallets/:walletId/freeze", validate(setCryptoWalletFrozenSchema), ownerAdminScope(), async (req, res) => {
    const companyId = companyIdOf(req);
    const wallet = await svc.setFrozen(companyId, walletIdOf(req), req.body.frozen, req.body.reason, { actorType: "user", actorId: userIdOf(req) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userIdOf(req),
      action: req.body.frozen ? "crypto.wallet_frozen" : "crypto.wallet_unfrozen",
      entityType: "company",
      entityId: companyId,
      agentId: wallet.agentId,
      details: { walletId: wallet.id },
    });
    res.json(wallet);
  });

  router.post("/companies/:companyId/crypto/wallets/:walletId/archive", ownerAdminScope(), async (req, res) => {
    res.json(await svc.archiveWallet(companyIdOf(req), walletIdOf(req), { userId: userIdOf(req) }));
  });

  router.get("/companies/:companyId/crypto/wallets/:walletId/balance", ownerAdminScope(), async (req, res) => {
    res.json(await svc.refreshBalance(companyIdOf(req), walletIdOf(req)));
  });

  router.get("/companies/:companyId/crypto/wallets/:walletId/destinations", ownerAdminScope(), async (req, res) => {
    res.json(await svc.listDestinations(companyIdOf(req), walletIdOf(req)));
  });

  router.post("/companies/:companyId/crypto/wallets/:walletId/destinations", validate(addCryptoWalletDestinationSchema), ownerAdminScope(), async (req, res) => {
    res.status(201).json(await svc.addDestination(companyIdOf(req), walletIdOf(req), req.body, { userId: userIdOf(req) }));
  });

  router.delete("/companies/:companyId/crypto/wallets/:walletId/destinations/:destinationId", ownerAdminScope(), async (req, res) => {
    await svc.removeDestination(companyIdOf(req), walletIdOf(req), req.params.destinationId as string, { userId: userIdOf(req) });
    res.status(204).end();
  });

  router.get("/companies/:companyId/crypto/wallets/:walletId/transactions", ownerAdminScope(), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await svc.listTransactions(companyIdOf(req), walletIdOf(req), limit));
  });

  router.get("/companies/:companyId/crypto/wallets/:walletId/ledger", ownerAdminScope(), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(await svc.listLedger(companyIdOf(req), walletIdOf(req), limit));
  });

  /** Owner/admin sends coins out (to an allowed address) -- how funds come back out, since the key is never shown. */
  router.post("/companies/:companyId/crypto/wallets/:walletId/send", validate(cryptoSendRequestSchema), ownerAdminScope(), async (req, res) => {
    const companyId = companyIdOf(req);
    const tx = await svc.ownerSend(companyId, walletIdOf(req), req.body, { userId: userIdOf(req) });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userIdOf(req),
      action: "crypto.owner_send",
      entityType: "company",
      entityId: companyId,
      details: { walletId: tx.walletId, transactionId: tx.id, status: tx.status, destination: tx.destination, amount: tx.amount },
    });
    res.status(201).json(tx);
  });

  router.get("/companies/:companyId/crypto/agents/:agentId/limits", ownerAdminScope(), async (req, res) => {
    res.json(await svc.getAgentLimits(companyIdOf(req), req.params.agentId as string));
  });

  router.put("/companies/:companyId/crypto/agents/:agentId/limits", validate(cryptoAgentLimitsSchema), ownerAdminScope(), async (req, res) => {
    res.json(await svc.setAgentLimits(companyIdOf(req), req.params.agentId as string, req.body, { userId: userIdOf(req) }));
  });

  // ─── Agent tools ─────────────────────────────────────────────────────

  router.get("/agent-wallets", agentScope(), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    res.json(await svc.agentListWallets(companyId, agentId));
  });

  router.get("/agent-wallets/:walletId/balance", agentScope(), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    res.json(await svc.agentBalance(companyId, agentId, walletIdOf(req)));
  });

  router.get("/agent-wallets/:walletId/destinations", agentScope(), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    res.json(await svc.agentDestinations(companyId, agentId, walletIdOf(req)));
  });

  router.post("/agent-wallets/:walletId/quote", agentScope(), validate(cryptoQuoteRequestSchema), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    res.json(await svc.agentQuote(companyId, agentId, walletIdOf(req), req.body));
  });

  router.post("/agent-wallets/:walletId/send", agentScope(), validate(cryptoSendRequestSchema), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    const tx = await svc.agentSend(companyId, agentId, walletIdOf(req), req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "crypto.agent_send_requested",
      entityType: "agent",
      entityId: agentId,
      details: { walletId: tx.walletId, transactionId: tx.id, status: tx.status, destination: tx.destination, amount: tx.amount, purpose: tx.purpose },
    });
    res.status(202).json(tx);
  });

  router.post("/agent-wallets/:walletId/hyperliquid-order", agentScope(), validate(hyperliquidOrderRequestSchema), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    const tx = await svc.agentHyperliquidOrder(companyId, agentId, walletIdOf(req), req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "crypto.agent_order_requested",
      entityType: "agent",
      entityId: agentId,
      details: { walletId: tx.walletId, transactionId: tx.id, status: tx.status, order: tx.orderDetail },
    });
    res.status(202).json(tx);
  });

  router.get("/agent-wallets/transactions/:transactionId", agentScope(), async (req, res) => {
    const { agentId, companyId } = requireAgentActor(req);
    res.json(await svc.agentGetTransaction(companyId, agentId, req.params.transactionId as string));
  });

  return router;
}
