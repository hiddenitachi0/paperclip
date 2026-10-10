import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
  OPERATOR_ACTION_TYPES,
  operatorActionEnvKeySchema,
  operatorActionRequestPayloadSchema,
  operatorActionTargetNameSchema,
  type OperatorActionRequestInput,
  type OperatorActionRequestPayload,
  type OperatorActionType,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/**
 * One-click privileged host actions ("operator actions").
 *
 * The real list of what may run lives ON THE BOX, in a root-owned file only
 * the on-box runner reads (scripts/operator-action-runner.py, default
 * /etc/paperclip/operator-actions.json). Each runner tick publishes a
 * cut-down copy of it -- names, plain-language labels, allowed actions and
 * the exact command each one runs, never secrets -- into the server's own
 * volume at OPERATOR_ACTIONS_CATALOG_PATH. This module reads that copy so the
 * server can refuse a bad request at filing time and stamp a card that says,
 * in plain words, exactly what will run.
 *
 * The published copy is a convenience, not the security boundary: anything
 * that can write the server's volume could edit it. The runner re-checks
 * every approved card against its OWN file, and refuses a card whose stamped
 * `willRun` is not exactly what it would run itself.
 */
export const OPERATOR_ACTIONS_CATALOG_PATH_DEFAULT = "/paperclip/operator-actions/catalog.json";

export function operatorActionsCatalogPath(): string {
  return process.env.PAPERCLIP_OPERATOR_ACTIONS_CATALOG_PATH?.trim() || OPERATOR_ACTIONS_CATALOG_PATH_DEFAULT;
}

export const OPERATOR_ACTION_KIND = "operator_action";

const MAX_CATALOG_BYTES = 1024 * 1024;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\r\n\0]/.test(value), "label must be one line");

const commandPreviewSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => !/[\r\n\0]/.test(value), "command preview must be one line");

const catalogServiceSchema = z.object({
  label: labelSchema,
  actions: z
    .record(z.string(), commandPreviewSchema)
    .refine(
      (actions) => Object.keys(actions).every((key) => key === "restart_service" || key === "recreate_container"),
      "services only take restart_service / recreate_container",
    ),
});

const catalogEnvFileSchema = z.object({
  label: labelSchema,
  path: z.string().min(1).max(500),
  keys: z.array(operatorActionEnvKeySchema).max(200),
});

const catalogCompanySchema = z.object({
  services: z.record(operatorActionTargetNameSchema, catalogServiceSchema).default({}),
  envFiles: z.record(operatorActionTargetNameSchema, catalogEnvFileSchema).default({}),
});

const catalogSchema = z.object({
  version: z.literal(1),
  companies: z.record(z.string().uuid(), catalogCompanySchema),
});

export type OperatorActionCatalog = z.infer<typeof catalogSchema>;
export type OperatorActionCompanyCatalog = z.infer<typeof catalogCompanySchema>;

/** Reads the runner-published catalogue. Missing, oversized or malformed -> null (nothing is offered). */
export function readOperatorActionCatalog(path = operatorActionsCatalogPath()): OperatorActionCatalog | null {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > MAX_CATALOG_BYTES) return null;
    const parsed = catalogSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function companyOperatorActionCatalog(
  catalog: OperatorActionCatalog | null,
  companyId: string,
): OperatorActionCompanyCatalog | null {
  if (!catalog) return null;
  return catalog.companies[companyId] ?? null;
}

/** What an agent sees when it asks "what host actions can I request?" -- names and plain words only. */
export function describeCompanyOperatorActions(catalog: OperatorActionCatalog | null, companyId: string) {
  const company = companyOperatorActionCatalog(catalog, companyId);
  return {
    configured: Boolean(company),
    services: Object.entries(company?.services ?? {}).map(([name, service]) => ({
      name,
      label: service.label,
      actions: Object.keys(service.actions).filter((action): action is OperatorActionType =>
        (OPERATOR_ACTION_TYPES as readonly string[]).includes(action),
      ),
      willRun: service.actions,
    })),
    envFiles: Object.entries(company?.envFiles ?? {}).map(([name, envFile]) => ({
      name,
      label: envFile.label,
      keys: envFile.keys,
    })),
  };
}

/**
 * The exact one-line description of a set_env_var write. The runner renders
 * the same string from its own config and refuses the card if they differ --
 * keep in step with render_will_run() in scripts/operator-action-runner.py.
 */
export function renderSetEnvVarWillRun(envKey: string, envFilePath: string): string {
  return `write ${envKey}=<secret value> into ${envFilePath}`;
}

const NOT_SET_UP =
  "No host actions are set up for this company on this Paperclip server. Ask the instance admin to add the service to the host actions list on the server (see doc/operator-actions.md).";

/**
 * Builds the stored card from the filer's input and the published catalogue.
 * Every human-facing word on the card comes from here, never from the filer,
 * except the filer's own `reason`, which is shown as "Why" and never used to
 * decide what runs.
 */
export function buildOperatorActionCard(input: {
  companyId: string;
  request: OperatorActionRequestInput;
  catalog: OperatorActionCatalog | null;
  secretName?: string | null;
}): OperatorActionRequestPayload {
  const { request } = input;
  const company = companyOperatorActionCatalog(input.catalog, input.companyId);
  if (!company) throw unprocessable(NOT_SET_UP, { code: "operator_actions_not_configured" });

  const why = `Why: ${request.reason.trim()}`;
  const base = {
    kind: "operator_action" as const,
    action: request.action,
    target: request.target,
    reason: request.reason.trim(),
    ...(request.acknowledgedDuplicateOfApprovalId
      ? { acknowledgedDuplicateOfApprovalId: request.acknowledgedDuplicateOfApprovalId }
      : {}),
  };

  if (request.action === "set_env_var") {
    const envFile = company.envFiles[request.target];
    if (!envFile) {
      throw unprocessable(
        `"${request.target}" is not a settings file on this company's host actions list. Ask for one of: ${Object.keys(company.envFiles).join(", ") || "(none configured)"}.`,
        { code: "operator_action_unknown_target" },
      );
    }
    const envKey = request.envKey!;
    if (!envFile.keys.includes(envKey)) {
      throw unprocessable(
        `${envKey} is not one of the settings that may be changed in ${envFile.label}. Allowed: ${envFile.keys.join(", ") || "(none)"}.`,
        { code: "operator_action_key_not_allowed" },
      );
    }
    const secretName = input.secretName?.trim();
    if (!secretName) {
      throw unprocessable("The secret named on the card does not exist in this company.", {
        code: "operator_action_secret_not_found",
      });
    }
    const title = `Change the setting ${envKey} in ${envFile.label}`;
    return operatorActionRequestPayloadSchema.parse({
      ...base,
      envKey,
      secretId: request.secretId,
      secretName,
      title,
      summary: why,
      targetLabel: envFile.label,
      willRun: renderSetEnvVarWillRun(envKey, envFile.path),
      nextActionOnApproval:
        `When you approve, the server writes the value saved in the company secret "${secretName}" into ${envKey} in ${envFile.label}. ` +
        "The value itself is never shown on this card. It is used the next time that app is recreated. The result is posted back on the task.",
    });
  }

  const service = company.services[request.target];
  if (!service) {
    throw unprocessable(
      `"${request.target}" is not a service on this company's host actions list. Ask for one of: ${Object.keys(company.services).join(", ") || "(none configured)"}.`,
      { code: "operator_action_unknown_target" },
    );
  }
  const willRun = service.actions[request.action];
  if (!willRun) {
    const allowed = Object.keys(service.actions).join(", ") || "(none)";
    throw unprocessable(`${service.label} cannot be asked to ${request.action}. Allowed for it: ${allowed}.`, {
      code: "operator_action_not_allowed_for_target",
    });
  }
  if (request.action === "restart_service") {
    return operatorActionRequestPayloadSchema.parse({
      ...base,
      title: `Restart ${service.label}`,
      summary: why,
      targetLabel: service.label,
      willRun,
      nextActionOnApproval: `When you approve, the server restarts ${service.label}. Nothing else is changed. The result is posted back on the task.`,
    });
  }
  return operatorActionRequestPayloadSchema.parse({
    ...base,
    title: `Recreate ${service.label}`,
    summary: why,
    targetLabel: service.label,
    willRun,
    nextActionOnApproval:
      `When you approve, ${service.label} is stopped and started again with its current image and settings, so a changed settings file takes effect. ` +
      "Stored data is kept. The result is posted back on the task.",
  });
}

export function isOperatorActionApproval(type: unknown, payload: unknown): boolean {
  return (
    type === "request_board_approval" &&
    !!payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).kind === OPERATOR_ACTION_KIND
  );
}
