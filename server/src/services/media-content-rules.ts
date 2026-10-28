import { evaluateLora, evaluateModel, type LoraPolicyInput } from "@paperclipai/plugin-sdk/media";
import { mediaLoraRefForAgents, type MediaContentRules, type MediaLoraContentFloor, type MediaLoraRuleInput } from "@paperclipai/shared";

/**
 * The content rules for model setups and the LoRA library: the Media Studio
 * safety module's own (`evaluateLora` / `evaluateModel` in
 * @paperclipai/plugin-sdk/media), the same rules every film uses. The setup
 * checks in @paperclipai/shared take them as an argument because that package
 * cannot import the SDK; nothing else may decide what is refused or mature.
 *
 * How a verdict maps onto a LoRA's tag:
 *   - refused in "mature" mode (filter bypass in any spelling, age sliders):
 *     "refused". Such a LoRA is never saved, never used and never shown to an
 *     agent, whatever a person tagged it.
 *   - refused only in "sfw" mode (Sogni's flags, anatomy sliders, Mystic X,
 *     a Sogni catalog id that is not in the reviewed snapshot): "mature". A
 *     person cannot tag it safe for work.
 *   - The module's reviewed snapshot is Sogni's public catalog, so a Fal link
 *     is never on it. For a link, "not reviewed" is left to the owner's or
 *     admin's review in the library (an unreviewed one counts as mature); the
 *     other rules still apply to the link and its name.
 */

function loraPolicyInput(lora: MediaLoraRuleInput): LoraPolicyInput {
  return {
    id: lora.ref.trim(),
    // The module names the LoRA in its messages: never show a link's query string.
    name: lora.name?.trim() || mediaLoraRefForAgents(lora),
    nsfw: lora.providerNsfw === true,
    sexual: lora.providerSexual === true,
    // Honoured by the module only for ids that start with "personal-".
    personal: lora.provider === "sogni" && lora.source === "personal",
  };
}

export function mediaLoraFloor(lora: MediaLoraRuleInput): MediaLoraContentFloor | null {
  const input = loraPolicyInput(lora);
  const always = evaluateLora(input, "mature");
  if (!always.allowed) return { tag: "refused", reason: always.message ?? `The LoRA "${input.name}" is never allowed.` };
  const sfw = evaluateLora(input, "sfw");
  if (sfw.allowed) return null;
  if (sfw.reason === "unreviewed" && lora.source === "url") return null;
  return { tag: "mature", reason: sfw.message ?? `The LoRA "${input.name}" cannot be used in a safe-for-work film.` };
}

export function mediaModelMatureReason(modelId: string): string | null {
  const verdict = evaluateModel({ id: modelId }, "sfw");
  return verdict.allowed ? null : (verdict.message ?? `The model "${modelId}" cannot be used in a safe-for-work film.`);
}

export const mediaContentRules: MediaContentRules = {
  loraFloor: mediaLoraFloor,
  modelMatureReason: mediaModelMatureReason,
};
