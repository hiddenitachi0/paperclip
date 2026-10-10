import { describe, expect, it } from "vitest";
import {
  carryableSecretInputs,
  describeScopedSecretKey,
  envInputScopedKey,
  passphraseStrength,
  secretsFileName,
} from "./company-migration";
import { carrySecretsBlocker } from "../components/company-migration/CarrySecretsPanel";
import { importSecretsBlocker } from "../components/company-migration/ImportSecretsFields";

describe("passphraseStrength", () => {
  it("refuses empty and short passphrases", () => {
    expect(passphraseStrength("").acceptable).toBe(false);
    expect(passphraseStrength("short1!").level).toBe("too_short");
    expect(passphraseStrength("short1!").acceptable).toBe(false);
  });

  it("flags easy-to-guess ones as weak but allows them", () => {
    expect(passphraseStrength("password1234").level).toBe("weak");
    expect(passphraseStrength("aaaaaaaaaaaaaaa").level).toBe("weak");
    expect(passphraseStrength("password1234").acceptable).toBe(true);
  });

  it("likes a few unrelated words", () => {
    expect(passphraseStrength("blue tractor singing lamp").level).toBe("strong");
    expect(passphraseStrength("Fjord7-Kettle!").level).toBe("ok");
  });
});

describe("secret labels", () => {
  it("names the owner of a scoped key, without any value", () => {
    const names = { agents: { ceo: "Chief" }, projects: { shop: "Webshop" } };
    expect(describeScopedSecretKey("agent:ceo:SHOP_TOKEN", names)).toEqual({ key: "SHOP_TOKEN", owner: "agent Chief" });
    expect(describeScopedSecretKey("project:shop:API_KEY", names)).toEqual({ key: "API_KEY", owner: "project Webshop" });
    expect(describeScopedSecretKey("GLOBAL_KEY")).toEqual({ key: "GLOBAL_KEY", owner: "the whole company" });
    expect(describeScopedSecretKey("agent:unknown:X")).toEqual({ key: "X", owner: "agent unknown" });
  });

  it("offers only secret settings to carry, keyed the way the server expects", () => {
    const base = { description: null, requirement: "optional", defaultValue: null, portability: "portable" } as const;
    const inputs = carryableSecretInputs({
      envInputs: [
        { ...base, key: "SHOP_TOKEN", agentSlug: "ceo", projectSlug: null, kind: "secret" },
        { ...base, key: "MODE", agentSlug: "ceo", projectSlug: null, kind: "plain" },
        { ...base, key: "API_KEY", agentSlug: null, projectSlug: "shop", kind: "secret" },
      ],
    });
    expect(inputs.map(envInputScopedKey)).toEqual(["agent:ceo:SHOP_TOKEN", "project:shop:API_KEY"]);
    expect(secretsFileName("nordlys")).toBe("nordlys.secrets.enc");
  });
});

describe("blockers", () => {
  it("export with secrets needs a good passphrase typed twice; without secrets nothing is needed", () => {
    expect(carrySecretsBlocker({ selected: new Set(), passphrase: "", confirm: "" })).toBeNull();
    const selected = new Set(["agent:ceo:SHOP_TOKEN"]);
    expect(carrySecretsBlocker({ selected, passphrase: "short", confirm: "short" })).toContain("Too short");
    expect(carrySecretsBlocker({ selected, passphrase: "blue tractor singing lamp", confirm: "blue tractor" })).toContain(
      "not the same",
    );
    expect(
      carrySecretsBlocker({ selected, passphrase: "blue tractor singing lamp", confirm: "blue tractor singing lamp" }),
    ).toBeNull();
  });

  it("import with a secrets file needs its passphrase", () => {
    expect(importSecretsBlocker({ file: null, passphrase: "" })).toBeNull();
    expect(importSecretsBlocker({ file: { name: "x.secrets.enc", content: "blob" }, passphrase: "" })).toContain(
      "passphrase",
    );
    expect(importSecretsBlocker({ file: { name: "x.secrets.enc", content: "blob" }, passphrase: "p" })).toBeNull();
  });
});
