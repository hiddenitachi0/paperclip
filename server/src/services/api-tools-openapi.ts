import {
  API_TOOL_ACTION_NAME_RE,
  API_TOOL_MAX_ACTIONS,
  API_TOOL_MAX_INPUTS_PER_ACTION,
  apiToolActionSchema,
  normalizeApiToolBaseUrl,
  type ApiToolAction,
  type ApiToolActionInput,
  type ApiToolInputType,
} from "@paperclipai/shared/validators/api-tool";
import { unprocessable } from "../errors.js";
import { createSafeOutboundFetch, SafeOutboundFetchError, type SafeOutboundFetchDeps } from "./safe-outbound-fetch.js";
import { createApiToolOutboundPolicy } from "./api-tools.js";

/**
 * DUR-4004: "Import from OpenAPI address". Fetches a JSON OpenAPI document
 * through the same guard every tool call uses (public https only, that host
 * only, no redirects, 30 s, 2 MB) and turns its operations into the simple
 * action list the Tools form edits. Nothing is saved here: the form shows the
 * result with a checkbox per action and the operator saves what they keep.
 *
 * Bounded on purpose: at most API_TOOL_MAX_ACTIONS actions, at most
 * API_TOOL_MAX_INPUTS_PER_ACTION inputs each, one level of local `$ref`
 * resolution, JSON only (YAML documents get a plain sentence saying so).
 */

export interface OpenApiImportResult {
  title: string | null;
  /** The document's first https server address, when it passes the base-address rules. */
  baseUrl: string | null;
  actions: ApiToolAction[];
  /** Operations that were skipped (too many, or not expressible as a simple action). */
  skipped: number;
}

type JsonObject = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function resolveRef(document: JsonObject, value: unknown, depth = 0): JsonObject | null {
  const object = asObject(value);
  if (!object) return null;
  const ref = object.$ref;
  if (typeof ref !== "string" || depth > 2) return object;
  if (!ref.startsWith("#/")) return null;
  let current: unknown = document;
  for (const part of ref.slice(2).split("/")) {
    const step = asObject(current);
    if (!step) return null;
    current = step[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return resolveRef(document, current, depth + 1);
}

function inputType(schema: JsonObject | null): ApiToolInputType {
  const type = typeof schema?.type === "string" ? schema.type : Array.isArray(schema?.type) ? String(schema?.type[0]) : "";
  switch (type) {
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
    case "array":
      return "json";
    default:
      return schema && (schema.properties || schema.items) ? "json" : "string";
  }
}

function slug(value: string): string {
  return value
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function actionName(operation: JsonObject, method: string, path: string): string {
  const fromId = typeof operation.operationId === "string" ? slug(operation.operationId) : "";
  const candidate = fromId || slug(`${method}_${path}`) || method;
  const cleaned = (/^[a-z]/.test(candidate) ? candidate : `op_${candidate}`).slice(0, 64).replace(/_+$/, "");
  return API_TOOL_ACTION_NAME_RE.test(cleaned) ? cleaned : method;
}

function shortText(value: unknown, max = 280): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Turns one parsed OpenAPI document into actions. Exported so a fixture can be tested without a server. */
export function openApiToActions(document: JsonObject): OpenApiImportResult {
  const info = asObject(document.info);
  const title = shortText(info?.title, 100) || null;
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = asObject(servers[0]);
  let baseUrl: string | null = null;
  if (typeof firstServer?.url === "string") {
    const normalized = normalizeApiToolBaseUrl(firstServer.url);
    if (normalized.ok) baseUrl = normalized.url;
  }
  const paths = asObject(document.paths);
  if (!paths) {
    throw unprocessable("This does not look like an OpenAPI document: it has no \"paths\" section.", { code: "openapi_no_paths" });
  }
  const actions: ApiToolAction[] = [];
  const usedNames = new Set<string>();
  let skipped = 0;

  for (const path of Object.keys(paths).sort()) {
    const item = resolveRef(document, paths[path]);
    if (!item) continue;
    const sharedParameters = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const operation = asObject(item[method]);
      if (!operation) continue;
      if (actions.length >= API_TOOL_MAX_ACTIONS) {
        skipped += 1;
        continue;
      }
      const inputs: ApiToolActionInput[] = [];
      const seenInputs = new Set<string>();
      const addInput = (input: ApiToolActionInput) => {
        if (seenInputs.has(input.name) || inputs.length >= API_TOOL_MAX_INPUTS_PER_ACTION) return;
        seenInputs.add(input.name);
        inputs.push(input);
      };
      const parameters = [...sharedParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      for (const raw of parameters) {
        const parameter = resolveRef(document, raw);
        if (!parameter || typeof parameter.name !== "string") continue;
        const location = parameter.in;
        if (location !== "path" && location !== "query") continue;
        const schema = resolveRef(document, parameter.schema);
        addInput({
          name: parameter.name,
          type: inputType(schema),
          required: location === "path" || parameter.required === true,
          description: shortText(parameter.description) || undefined,
        });
      }
      const requestBody = resolveRef(document, operation.requestBody);
      const content = asObject(requestBody?.content);
      if (content) {
        const jsonKey = Object.keys(content).find((key) => key.includes("json"));
        const media = jsonKey ? asObject(content[jsonKey]) : null;
        const schema = resolveRef(document, media?.schema);
        const properties = asObject(schema?.properties);
        if (properties) {
          const required = new Set(Array.isArray(schema?.required) ? schema!.required.map(String) : []);
          for (const [name, rawProperty] of Object.entries(properties)) {
            const property = resolveRef(document, rawProperty);
            addInput({ name, type: inputType(property), required: required.has(name), description: shortText(property?.description) || undefined });
          }
        } else if (schema) {
          addInput({ name: "body", type: "json", required: requestBody?.required === true, description: "The request body as JSON." });
        }
      }
      // A placeholder without a declared parameter still needs an input.
      for (const placeholder of path.matchAll(/\{([^{}]+)\}/g)) {
        addInput({ name: placeholder[1]!, type: "string", required: true });
      }
      let name = actionName(operation, method, path);
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${name.slice(0, 60)}_${suffix}`;
        suffix += 1;
      }
      const candidate = {
        name,
        method: method.toUpperCase(),
        path,
        description: shortText(operation.summary) || shortText(operation.description),
        inputs,
      };
      const parsed = apiToolActionSchema.safeParse(candidate);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      usedNames.add(name);
      actions.push(parsed.data);
    }
  }
  return { title, baseUrl, actions, skipped };
}

/** Fetches the document through the guard and converts it. */
export async function importOpenApiActions(url: string, deps: SafeOutboundFetchDeps = {}): Promise<OpenApiImportResult> {
  const normalized = normalizeApiToolBaseUrl(url);
  if (!normalized.ok) throw unprocessable(normalized.message);
  const fetchImpl = createSafeOutboundFetch(createApiToolOutboundPolicy(url), deps);
  let response: Response;
  try {
    response = await fetchImpl(url.trim(), { method: "GET", headers: { accept: "application/json, application/yaml;q=0.5, */*;q=0.1", "user-agent": "Paperclip-api-tool/1.0" } });
  } catch (error) {
    const message = error instanceof SafeOutboundFetchError ? error.message : `Could not fetch the OpenAPI document from ${normalized.host}.`;
    throw unprocessable(message, { code: "openapi_fetch_failed" });
  }
  if (!response.ok) {
    throw unprocessable(`${normalized.host} answered ${response.status} for the OpenAPI address.`, { code: "openapi_fetch_failed" });
  }
  const text = await response.text();
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw unprocessable(
      "The OpenAPI document must be JSON. A YAML document is not supported yet; convert it to JSON (most services also publish a .json address) and try again.",
      { code: "openapi_not_json" },
    );
  }
  const object = asObject(document);
  if (!object) throw unprocessable("The OpenAPI document must be a JSON object.", { code: "openapi_not_json" });
  return openApiToActions(object);
}
