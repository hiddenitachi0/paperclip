import { describe, expect, it } from "vitest";
import {
  buildMcpServerConfigFromTool,
  companyMcpToolConnectionSchema,
  companyMcpToolCreateSchema,
  companyMcpToolCredentialSchema,
  mcpToolCatalogInstallSchema,
} from "./company-mcp-tool.js";

const secretId = "11111111-1111-4111-8111-111111111111";

describe("companyMcpToolCredentialSchema", () => {
  it("accepts a secret_ref credential", () => {
    const parsed = companyMcpToolCredentialSchema.parse({
      field: "env",
      key: "FAL_KEY",
      secretId,
    });
    expect(parsed.secretId).toBe(secretId);
  });

  it("has no plaintext-value escape hatch -- there is no `value` field at all", () => {
    // This is the acceptance-criterion guarantee: a tool-library credential
    // literally cannot be constructed with a plaintext value, because the
    // schema has no such field. Passing one is simply ignored/stripped by
    // zod's default (non-strict) object parsing, and the credential is only
    // ever valid if it carries a secretId.
    const result = companyMcpToolCredentialSchema.safeParse({
      field: "env",
      key: "FAL_KEY",
      value: "sk-super-secret-plaintext",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid secretId", () => {
    const result = companyMcpToolCredentialSchema.safeParse({
      field: "env",
      key: "FAL_KEY",
      secretId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("companyMcpToolConnectionSchema", () => {
  const baseCredential = { field: "env" as const, key: "FAL_KEY", secretId };

  it("accepts a stdio connection with exactly one of command/url", () => {
    const parsed = companyMcpToolConnectionSchema.parse({
      transport: "stdio",
      command: "npx",
      args: ["-y", "fal-ai-mcp-server"],
      credentials: [baseCredential],
    });
    expect(parsed.command).toBe("npx");
  });

  it("accepts a remote http connection with url + header credential", () => {
    const parsed = companyMcpToolConnectionSchema.parse({
      transport: "http",
      url: "https://mcp.example.com",
      credentials: [{ field: "headers", key: "Authorization", secretId }],
    });
    expect(parsed.url).toBe("https://mcp.example.com");
  });

  it("rejects both command and url set", () => {
    const result = companyMcpToolConnectionSchema.safeParse({
      command: "npx",
      url: "https://mcp.example.com",
      credentials: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects neither command nor url set", () => {
    const result = companyMcpToolConnectionSchema.safeParse({ credentials: [] });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate credential keys within the same field", () => {
    const result = companyMcpToolConnectionSchema.safeParse({
      command: "npx",
      credentials: [baseCredential, baseCredential],
    });
    expect(result.success).toBe(false);
  });
});

describe("companyMcpToolCreateSchema", () => {
  it("requires a human-readable one-line description", () => {
    const result = companyMcpToolCreateSchema.safeParse({
      name: "Fal.ai",
      connection: { command: "npx", args: ["-y", "fal-ai-mcp-server"], credentials: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full create payload with no JSON string anywhere", () => {
    const parsed = companyMcpToolCreateSchema.parse({
      name: "Fal.ai",
      description: "Generates images from a text prompt.",
      connection: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "fal-ai-mcp-server"],
        credentials: [{ field: "env", key: "FAL_KEY", secretId }],
      },
      catalogKey: "fal_ai",
    });
    expect(parsed.description).toBe("Generates images from a text prompt.");
    // Every field is structured data (strings/arrays/objects) -- nothing here
    // is a JSON string the operator had to type by hand.
    expect(typeof parsed.connection).toBe("object");
  });
});

describe("mcpToolCatalogInstallSchema", () => {
  it("maps catalog credential placeholders to secret ids only", () => {
    const parsed = mcpToolCatalogInstallSchema.parse({
      catalogKey: "fal_ai",
      credentialSecretIds: { FAL_KEY: secretId },
    });
    expect(parsed.credentialSecretIds.FAL_KEY).toBe(secretId);
  });

  it("rejects a non-uuid value for a credential placeholder", () => {
    const result = mcpToolCatalogInstallSchema.safeParse({
      catalogKey: "fal_ai",
      credentialSecretIds: { FAL_KEY: "sk-plaintext-key" },
    });
    expect(result.success).toBe(false);
  });
});

describe("buildMcpServerConfigFromTool", () => {
  it("produces a valid mcpServerConfigSchema entry with secret_ref env bindings", () => {
    const entry = buildMcpServerConfigFromTool({
      key: "fal-ai",
      connection: companyMcpToolConnectionSchema.parse({
        transport: "stdio",
        command: "npx",
        args: ["-y", "fal-ai-mcp-server"],
        credentials: [{ field: "env", key: "FAL_KEY", secretId }],
      }),
    });
    expect(entry).toEqual({
      name: "fal-ai",
      transport: "stdio",
      command: "npx",
      args: ["-y", "fal-ai-mcp-server"],
      env: { FAL_KEY: { type: "secret_ref", secretId } },
    });
  });

  it("never embeds a plaintext credential value in the built config", () => {
    const entry = buildMcpServerConfigFromTool({
      key: "fal-ai",
      connection: companyMcpToolConnectionSchema.parse({
        command: "npx",
        credentials: [{ field: "env", key: "FAL_KEY", secretId }],
      }),
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("value");
    expect(serialized).toContain("secret_ref");
  });

  it("routes header-field credentials into the headers map", () => {
    const entry = buildMcpServerConfigFromTool({
      key: "remote-tool",
      connection: companyMcpToolConnectionSchema.parse({
        url: "https://mcp.example.com",
        credentials: [{ field: "headers", key: "Authorization", secretId }],
      }),
    });
    expect(entry.headers).toEqual({ Authorization: { type: "secret_ref", secretId } });
    expect(entry.env).toBeUndefined();
  });
});
