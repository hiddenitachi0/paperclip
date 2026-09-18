import { describe, expect, it } from "vitest";
import {
  confirmationQuestionText,
  deployDecisionRefusalMessage,
  detectDeployDecisionAsk,
} from "./confirmation-deploy-decision.js";

function card(prompt: string, acceptLabel?: string) {
  return { version: 1 as const, prompt, ...(acceptLabel ? { acceptLabel } : {}) };
}

describe("detectDeployDecisionAsk", () => {
  it("refuses the card that started this: the NOR-1485 wording", () => {
    expect(
      detectDeployDecisionAsk(card("Approve deployment of NOR-1485 fix (commit 0ce2e87) to production?")),
    ).toBe("deploy_wording");
  });

  it("refuses the other ways an agent asks for the same thing", () => {
    const asks = [
      "Can I deploy this to production now?",
      "Shall I ship the pricing fix today?",
      "Approve the release of version 2.4?",
      "Should I merge this into main?",
      "OK to roll out the new checkout flow?",
      "Requesting permission to go live with the banner.",
      "Please sign off so I can redeploy the dashboard.",
      "Approve rolling out the change?",
    ];
    for (const ask of asks) {
      expect(detectDeployDecisionAsk(card(ask)), ask).toBe("deploy_wording");
    }
  });

  it("refuses the Norwegian wording the operator's own agents use", () => {
    const asks = [
      "Vil du godkjenne denne deployen?",
      "Kan jeg publisere de nye prisene nå?",
      "Skal jeg rulle ut endringen til produksjon?",
      "Godkjenner du lanseringen av den nye forsiden?",
      "Er det greit at jeg setter dette i produksjon?",
    ];
    for (const ask of asks) {
      expect(detectDeployDecisionAsk(card(ask)), ask).toBe("deploy_wording");
    }
  });

  it("allows Norwegian that reports a deploy already done, or asks about something else", () => {
    const allowed = [
      "Jeg deployet fiksen i morges — ser tallene riktige ut for deg?",
      "De nye prisene er publisert. Skal jeg oppdatere hjelpeartikkelen også?",
      "Kan jeg sende e-post til leverandøren om den forsinkede ordren?",
      "Godkjenner du den nye produktteksten?",
    ];
    for (const prompt of allowed) {
      expect(detectDeployDecisionAsk(card(prompt)), prompt).toBeNull();
    }
  });

  it("refuses an approval asked for a bare commit, with no deploy word anywhere (DUR-3990 item 4)", () => {
    expect(detectDeployDecisionAsk(card("Approve commit 0ce2e87?"))).toBe("approve_a_commit");
    expect(
      detectDeployDecisionAsk(card("Can I go ahead with 153a43e03e570da323b74067a1a4066545772ece?")),
    ).toBe("approve_a_commit");
  });

  it("reads the accept button too, so the question above it cannot carry the ask alone", () => {
    expect(detectDeployDecisionAsk(card("Ready when you are.", "Deploy to production"))).toBeNull();
    expect(detectDeployDecisionAsk(card("Approve?", "Deploy to production"))).toBe("deploy_wording");
  });

  it("allows a card that merely mentions a deploy that already happened (DUR-3990 item 3)", () => {
    const allowed = [
      "I deployed the fix this morning — do the numbers on the dashboard look right to you?",
      "The pricing change shipped yesterday. Should I also update the help article?",
      "We released 2.3 last week; approve the wording of the changelog entry?",
      "This was merged on Tuesday. Approve the follow-up copy?",
      "The rollout finished. Is the new layout what you wanted?",
    ];
    for (const prompt of allowed) {
      expect(detectDeployDecisionAsk(card(prompt)), prompt).toBeNull();
    }
  });

  it("allows an ordinary question that asks for information rather than permission", () => {
    expect(detectDeployDecisionAsk(card("Which supplier should the September order go to?"))).toBeNull();
    expect(detectDeployDecisionAsk(card("Does this draft read well enough to send?"))).toBeNull();
  });

  it("allows a permission ask that has nothing to do with deploying", () => {
    expect(detectDeployDecisionAsk(card("Can I email the supplier about the delayed order?"))).toBeNull();
    expect(detectDeployDecisionAsk(card("Approve the new opening hours on the website copy?"))).toBeNull();
  });

  it("does not read the details body, where a passing mention of a deploy usually lives", () => {
    const payload = {
      version: 1 as const,
      prompt: "Which of these two product photos should go first?",
      detailsMarkdown: "For context, I deployed the gallery fix earlier and would deploy this too once you pick.",
    };
    expect(detectDeployDecisionAsk(payload)).toBeNull();
  });

  it("returns null for a payload with no question at all", () => {
    expect(detectDeployDecisionAsk(null)).toBeNull();
    expect(detectDeployDecisionAsk({})).toBeNull();
    expect(detectDeployDecisionAsk("not an object")).toBeNull();
    expect(detectDeployDecisionAsk({ version: 1, prompt: 42 })).toBeNull();
  });
});

describe("confirmationQuestionText", () => {
  it("joins the prompt and the accept label, and ignores everything else", () => {
    expect(
      confirmationQuestionText({ version: 1, prompt: "Ship it?", acceptLabel: "Yes", detailsMarkdown: "ignored" }),
    ).toBe("Ship it?\nYes");
  });
});

describe("deployDecisionRefusalMessage", () => {
  it("names the mechanism that actually deploys and leaves a way to rephrase", () => {
    const message = deployDecisionRefusalMessage("deploy_wording");
    expect(message).toContain("cannot deploy or merge anything");
    expect(message).toContain("deploy approval");
    expect(message).toContain("rewrite the question");
  });

  it("says which shape it saw for the bare-commit case", () => {
    expect(deployDecisionRefusalMessage("approve_a_commit")).toContain("approve a specific commit");
  });
});
