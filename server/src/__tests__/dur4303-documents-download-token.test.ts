import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentDownloadToken, verifyDocumentDownloadToken } from "../services/documents-download-token.js";

/**
 * DUR-4303: the short-lived token get_document's download link carries. It
 * names only companyId + documentId + an expiry -- never a connectionId,
 * host or credential -- so the proxy route (documents-download.ts) always
 * re-resolves the container from the token's own companyId, fresh, rather
 * than trusting anything else the token could claim.
 */

const COMPANY_A = "a0000000-0000-4000-8000-000000000001";
const COMPANY_B = "b0000000-0000-4000-8000-000000000002";

describe("DUR-4303 documents download token", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-master-secret-not-real";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  it("round-trips companyId, documentId and a future expiry", () => {
    const token = createDocumentDownloadToken(COMPANY_A, 42, 300);
    expect(token).not.toBeNull();
    const claims = verifyDocumentDownloadToken(token!);
    expect(claims).toMatchObject({ companyId: COMPANY_A, documentId: 42 });
  });

  it("refuses a token whose companyId was swapped without re-signing", () => {
    const token = createDocumentDownloadToken(COMPANY_A, 42, 300)!;
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    const tampered = Buffer.from(JSON.stringify({ ...claims, companyId: COMPANY_B }), "utf8").toString("base64url");
    expect(verifyDocumentDownloadToken(`${tampered}.${signature}`)).toBeNull();
  });

  it("refuses a token with any altered signature", () => {
    const token = createDocumentDownloadToken(COMPANY_A, 42, 300)!;
    const [payload, signature] = token.split(".");
    const flipped = signature!.slice(0, -1) + (signature!.at(-1) === "A" ? "B" : "A");
    expect(verifyDocumentDownloadToken(`${payload}.${flipped}`)).toBeNull();
  });

  it("refuses an expired token", async () => {
    // The minter floors ttl at 1 second; wait it out rather than reaching
    // into the module's unexported signing internals to fake one.
    const token = createDocumentDownloadToken(COMPANY_A, 42, 1)!;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(verifyDocumentDownloadToken(token)).toBeNull();
  });

  it("refuses a malformed token", () => {
    expect(verifyDocumentDownloadToken("not-a-token")).toBeNull();
    expect(verifyDocumentDownloadToken("")).toBeNull();
  });

  it("mints nothing when no signing secret is configured", () => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    expect(createDocumentDownloadToken(COMPANY_A, 42, 300)).toBeNull();
  });

  it("never verifies against the wrong company's derived key, even with a correctly-shaped forgery", () => {
    const tokenA = createDocumentDownloadToken(COMPANY_A, 1, 300)!;
    const tokenB = createDocumentDownloadToken(COMPANY_B, 1, 300)!;
    expect(tokenA).not.toBe(tokenB);
    const [, sigA] = tokenA.split(".");
    const [payloadB] = tokenB.split(".");
    // Company B's payload with company A's signature: must not verify as B.
    expect(verifyDocumentDownloadToken(`${payloadB}.${sigA}`)).toBeNull();
  });
});
