import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  crossCompanyInstructions,
  issues,
  withCompanyScopeBypass,
} from "@paperclipai/db";
import {
  crossCompanyInstructionRequestPayloadSchema,
  type CrossCompanyInstruction,
  type CrossCompanyInstructionRequestPayload,
  type SendCrossCompanyInstruction,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";

/**
 * The receiving company's designated liaison is the ONE active agent whose
 * role is exactly this. Every company that wants to receive instructions
 * needs exactly one; with none (or more than one) nothing can be delivered
 * to it, which is the safe default.
 */
export const CROSS_COMPANY_LIAISON_ROLE = "tech_boss";

const ACTIVE_LIAISON_STATUSES = ["active", "idle"] as const;

export type CrossCompanyInstructionRow = typeof crossCompanyInstructions.$inferSelect;

export function isCrossCompanyInstructionApproval(
  approval: Pick<typeof approvals.$inferSelect, "type" | "payload">,
): boolean {
  return approval.type === "request_board_approval" && approval.payload?.kind === "cross_company_instruction";
}

export function toCrossCompanyInstruction(row: CrossCompanyInstructionRow): CrossCompanyInstruction {
  return {
    id: row.id,
    fromCompanyId: row.fromCompanyId,
    fromAgentId: row.fromAgentId,
    toCompanyId: row.toCompanyId,
    toAgentId: row.toAgentId,
    subject: row.subject,
    instruction: row.instruction,
    status: row.status as CrossCompanyInstruction["status"],
    approvalId: row.approvalId ?? null,
    deliveredIssueId: row.deliveredIssueId ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    decisionNote: row.decisionNote ?? null,
    decidedAt: row.decidedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CrossCompanyInstructionSender {
  actorType: "agent" | "user";
  actorId: string;
  /** The sending agent. A board user must name one of the sending company's agents. */
  fromAgentId: string;
}

export interface CrossCompanyInstructionDecider {
  userId: string;
  decisionNote?: string | null;
  /** Wakes the liaison after its issue exists; failures are logged, never thrown. */
  wakeLiaison?: (agentId: string, issueId: string) => Promise<unknown>;
}

/**
 * Cross-company instruction channel. `db` is the request-scoped instance
 * (scoped to whichever company the calling route resolved); `rawDb` is used
 * ONLY for the few writes that by definition land on the *other* company's
 * side of the wall (the receiving company's approval card and both
 * companies' activity-log entries), each wrapped in a logged bypass scope so
 * every such crossing shows up in cross_company_access_log.
 */
export function crossCompanyInstructionService(db: Db, deps: { rawDb: Db }) {
  const rawDb = deps.rawDb;
  const instanceSettings = instanceSettingsService(db);

  async function assertEnabled() {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableCrossCompanyInstructions) {
      throw forbidden("Sending instructions between companies is switched off for this Paperclip");
    }
  }

  async function bypass<T>(reason: string, actor: { actorType: string; actorId: string }, companyIds: string[], fn: (tx: Db) => Promise<T>) {
    return withCompanyScopeBypass(
      rawDb,
      { reason, actorType: actor.actorType, actorId: actor.actorId, route: "cross-company-instructions", companyIdsTouched: companyIds },
      // The transaction handle supports every query shape used below
      // (select/insert/update); the Db-typed helpers (logActivity) only use
      // those, so the cast is safe -- see access.ts for the same pattern.
      (scoped) => fn(scoped as unknown as Db),
    );
  }

  async function findLiaison(tx: Db, companyId: string) {
    const candidates = await tx
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, CROSS_COMPANY_LIAISON_ROLE),
          inArray(agents.status, [...ACTIVE_LIAISON_STATUSES]),
        ),
      );
    if (candidates.length === 0) {
      throw unprocessable(
        `The receiving company has no liaison agent (an active agent with the role "${CROSS_COMPANY_LIAISON_ROLE}"), so nothing can be sent to it`,
      );
    }
    if (candidates.length > 1) {
      throw unprocessable(
        `The receiving company has more than one liaison agent (role "${CROSS_COMPANY_LIAISON_ROLE}"); it must have exactly one before it can receive instructions`,
      );
    }
    return candidates[0]!;
  }

  function buildApprovalPayload(input: {
    instructionId: string;
    fromCompanyId: string;
    fromCompanyName: string;
    fromAgentId: string;
    fromAgentName: string;
    toAgentId: string;
    toAgentName: string;
    subject: string;
    instruction: string;
  }): CrossCompanyInstructionRequestPayload {
    return crossCompanyInstructionRequestPayloadSchema.parse({
      kind: "cross_company_instruction",
      instructionId: input.instructionId,
      fromCompanyId: input.fromCompanyId,
      fromCompanyName: input.fromCompanyName,
      fromAgentId: input.fromAgentId,
      fromAgentName: input.fromAgentName,
      toAgentId: input.toAgentId,
      toAgentName: input.toAgentName,
      subject: input.subject,
      instruction: input.instruction,
      title: `Instruction from ${input.fromCompanyName} for ${input.toAgentName}`,
      summary:
        `${input.fromAgentName} at ${input.fromCompanyName} asks ${input.toAgentName} to: ${input.subject}\n\n` +
        `${input.instruction}`,
      nextActionOnApproval:
        `${input.toAgentName} gets this instruction as a new task in this company and starts on it, ` +
        `following this company's own rules. Nothing else changes: no data, files, keys or access are shared ` +
        `with ${input.fromCompanyName}, and ${input.fromCompanyName} only learns that the instruction was approved.`,
      risks: [
        "Only the text above crosses between the two companies. Reject if it asks for anything that would share this company's data or access.",
        `If rejected, ${input.fromCompanyName} is told the request was declined and nothing happens here.`,
      ],
    });
  }

  return {
    /**
     * Files an instruction from `fromCompanyId` to the receiving company's
     * liaison. Writes the row, the receiving company's approval card, and an
     * activity-log line on both sides. Nothing is delivered until the
     * receiving company's board approves.
     */
    send: async (fromCompanyId: string, input: SendCrossCompanyInstruction, sender: CrossCompanyInstructionSender) => {
      await assertEnabled();
      if (input.toCompanyId === fromCompanyId) {
        throw unprocessable("An instruction can only be sent to a different company");
      }

      const fromCompany = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, fromCompanyId))
        .then((rows) => rows[0] ?? null);
      if (!fromCompany) throw notFound("Company not found");

      const fromAgent = await db
        .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
        .from(agents)
        .where(and(eq(agents.id, sender.fromAgentId), eq(agents.companyId, fromCompanyId)))
        .then((rows) => rows[0] ?? null);
      if (!fromAgent) throw unprocessable("The sending agent must belong to the sending company");

      const actor = { actorType: sender.actorType, actorId: sender.actorId };
      const created = await bypass(
        "cross_company_instruction.send",
        actor,
        [fromCompanyId, input.toCompanyId],
        async (tx) => {
          const toCompany = await tx
            .select({ id: companies.id, name: companies.name, status: companies.status })
            .from(companies)
            .where(eq(companies.id, input.toCompanyId))
            .then((rows) => rows[0] ?? null);
          // Deliberately the same wording whether the company is missing or
          // cannot receive: the sender must not be able to probe which
          // company ids exist.
          if (!toCompany || toCompany.status !== "active") {
            throw unprocessable("The receiving company cannot receive instructions");
          }
          const liaison = await findLiaison(tx, toCompany.id);

          const [row] = await tx
            .insert(crossCompanyInstructions)
            .values({
              fromCompanyId,
              fromAgentId: fromAgent.id,
              toCompanyId: toCompany.id,
              toAgentId: liaison.id,
              subject: input.subject,
              instruction: input.instruction,
              status: "pending_approval",
            })
            .returning();

          const payload = buildApprovalPayload({
            instructionId: row!.id,
            fromCompanyId,
            fromCompanyName: fromCompany.name,
            fromAgentId: fromAgent.id,
            fromAgentName: fromAgent.name,
            toAgentId: liaison.id,
            toAgentName: liaison.name,
            subject: input.subject,
            instruction: input.instruction,
          });
          // The card lives in the RECEIVING company. requestedByAgentId is
          // left empty on purpose: the asking agent is not one of that
          // company's agents, and the generic "wake the requester" path
          // must never reach across the wall. Who asked is in the payload.
          const [approval] = await tx
            .insert(approvals)
            .values({
              companyId: toCompany.id,
              type: "request_board_approval",
              requestedByAgentId: null,
              requestedByUserId: null,
              status: "pending",
              payload,
            })
            .returning();

          const [updated] = await tx
            .update(crossCompanyInstructions)
            .set({ approvalId: approval!.id, updatedAt: new Date() })
            .where(eq(crossCompanyInstructions.id, row!.id))
            .returning();

          await logActivity(tx, {
            companyId: fromCompanyId,
            actorType: sender.actorType,
            actorId: sender.actorId,
            action: "cross_company_instruction.sent",
            entityType: "cross_company_instruction",
            entityId: row!.id,
            agentId: fromAgent.id,
            details: {
              toCompanyId: toCompany.id,
              subject: input.subject,
              status: "pending_approval",
              note: "Waiting for the receiving company's board to approve. Only the instruction text was sent.",
            },
          });
          await logActivity(tx, {
            companyId: toCompany.id,
            actorType: "system",
            actorId: "cross-company-instructions",
            action: "cross_company_instruction.received",
            entityType: "cross_company_instruction",
            entityId: row!.id,
            agentId: liaison.id,
            details: {
              fromCompanyId,
              fromCompanyName: fromCompany.name,
              fromAgentName: fromAgent.name,
              subject: input.subject,
              approvalId: approval!.id,
              status: "pending_approval",
              note: "An instruction from another company is waiting for approval. Nothing is done until the board approves it.",
            },
          });

          return updated!;
        },
      );

      return toCrossCompanyInstruction(created);
    },

    /** Everything a company sent or received, newest first. */
    listForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(crossCompanyInstructions)
        .where(or(eq(crossCompanyInstructions.fromCompanyId, companyId), eq(crossCompanyInstructions.toCompanyId, companyId)))
        .orderBy(desc(crossCompanyInstructions.createdAt));
      return rows.map(toCrossCompanyInstruction);
    },

    getByApprovalId: async (approvalId: string) => {
      const row = await db
        .select()
        .from(crossCompanyInstructions)
        .where(eq(crossCompanyInstructions.approvalId, approvalId))
        .then((rows) => rows[0] ?? null);
      return row ? toCrossCompanyInstruction(row) : null;
    },

    /**
     * Called ONLY from the receiving company's approve route after the card
     * was approved. Creates the liaison's issue in the receiving company,
     * marks the instruction delivered, logs both sides and wakes the liaison.
     */
    deliverApproved: async (approval: typeof approvals.$inferSelect, decider: CrossCompanyInstructionDecider) => {
      const payload = crossCompanyInstructionRequestPayloadSchema.parse(approval.payload);
      const row = await db
        .select()
        .from(crossCompanyInstructions)
        .where(and(eq(crossCompanyInstructions.id, payload.instructionId), eq(crossCompanyInstructions.toCompanyId, approval.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Instruction not found");
      if (row.status !== "pending_approval") return toCrossCompanyInstruction(row);

      const liaison = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, row.toAgentId), eq(agents.companyId, approval.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!liaison || liaison.status === "terminated") {
        throw unprocessable("The liaison agent this instruction was addressed to is no longer available");
      }

      const issue = await issueService(db).create(approval.companyId, {
        title: `Instruction from ${payload.fromCompanyName}: ${payload.subject}`,
        description:
          `${payload.fromAgentName} at ${payload.fromCompanyName} sent this instruction through the guarded ` +
          `cross-company channel. The board approved it on ${new Date().toISOString().slice(0, 10)}.\n\n` +
          `Carry it out inside this company, under this company's own rules. Do not share this company's data, ` +
          `files, keys or access with ${payload.fromCompanyName}; if the instruction would need that, stop and ask the board.\n\n` +
          `---\n\n${payload.instruction}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: liaison.id,
        originFingerprint: `cross-company-instruction:${row.id}`,
      } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
      if (!issue) throw unprocessable("Could not create the liaison's task");

      const now = new Date();
      const [updated] = await db
        .update(crossCompanyInstructions)
        .set({
          status: "delivered",
          deliveredIssueId: issue.id,
          decidedByUserId: decider.userId,
          decisionNote: decider.decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(crossCompanyInstructions.id, row.id))
        .returning();

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decider.userId,
        action: "cross_company_instruction.delivered",
        entityType: "cross_company_instruction",
        entityId: row.id,
        agentId: liaison.id,
        details: {
          approvalId: approval.id,
          issueId: issue.id,
          fromCompanyId: row.fromCompanyId,
          subject: row.subject,
          note: `Approved. ${liaison.name} got the instruction as task ${issue.identifier}.`,
        },
      });
      // The sending company's log line is the one write that crosses back
      // over the wall; it carries only the outcome, never anything from the
      // receiving company.
      await bypass(
        "cross_company_instruction.notify_sender",
        { actorType: "user", actorId: decider.userId },
        [row.fromCompanyId, row.toCompanyId],
        (tx) =>
          logActivity(tx, {
            companyId: row.fromCompanyId,
            actorType: "system",
            actorId: "cross-company-instructions",
            action: "cross_company_instruction.approved",
            entityType: "cross_company_instruction",
            entityId: row.id,
            agentId: row.fromAgentId,
            details: {
              toCompanyId: row.toCompanyId,
              subject: row.subject,
              status: "delivered",
              note: "The receiving company approved the instruction and its liaison has it as a task.",
            },
          }),
      );

      if (decider.wakeLiaison) {
        try {
          await decider.wakeLiaison(liaison.id, issue.id);
        } catch (err) {
          logger.warn({ err, instructionId: row.id, liaisonAgentId: liaison.id }, "failed to wake the liaison after a cross-company instruction was approved");
        }
      }

      return toCrossCompanyInstruction(updated!);
    },

    /** Called ONLY from the receiving company's reject route. Logs both sides; nothing is delivered. */
    markRejected: async (approval: typeof approvals.$inferSelect, decider: CrossCompanyInstructionDecider) => {
      const payload = crossCompanyInstructionRequestPayloadSchema.parse(approval.payload);
      const row = await db
        .select()
        .from(crossCompanyInstructions)
        .where(and(eq(crossCompanyInstructions.id, payload.instructionId), eq(crossCompanyInstructions.toCompanyId, approval.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Instruction not found");
      if (row.status !== "pending_approval") return toCrossCompanyInstruction(row);

      const now = new Date();
      const [updated] = await db
        .update(crossCompanyInstructions)
        .set({
          status: "rejected",
          decidedByUserId: decider.userId,
          decisionNote: decider.decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(crossCompanyInstructions.id, row.id))
        .returning();

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decider.userId,
        action: "cross_company_instruction.rejected",
        entityType: "cross_company_instruction",
        entityId: row.id,
        agentId: row.toAgentId,
        details: { approvalId: approval.id, fromCompanyId: row.fromCompanyId, subject: row.subject, note: "Rejected. Nothing was done." },
      });
      await bypass(
        "cross_company_instruction.notify_sender",
        { actorType: "user", actorId: decider.userId },
        [row.fromCompanyId, row.toCompanyId],
        (tx) =>
          logActivity(tx, {
            companyId: row.fromCompanyId,
            actorType: "system",
            actorId: "cross-company-instructions",
            action: "cross_company_instruction.rejected",
            entityType: "cross_company_instruction",
            entityId: row.id,
            agentId: row.fromAgentId,
            details: {
              toCompanyId: row.toCompanyId,
              subject: row.subject,
              status: "rejected",
              note: "The receiving company declined the instruction. Nothing happened there.",
            },
          }),
      );

      return toCrossCompanyInstruction(updated!);
    },
  };
}

export type CrossCompanyInstructionService = ReturnType<typeof crossCompanyInstructionService>;

/** Exported for the delivery issue lookup in tests / dashboards. */
export const crossCompanyInstructionIssueTable = issues;
