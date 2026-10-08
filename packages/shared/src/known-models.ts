/**
 * Catalogue v2 (8 Oct 2026): a built-in list of known open models, so
 * Settings > Models can show Maker -> Model -> Size -> ways to run it, say
 * whether a size fits the owner's graphics card, give the `ollama pull`
 * command for a size that is not installed, and offer the bigger cloud
 * version (OpenRouter, with the hosts that support tool calling) as an
 * "upgrade". Facts come from the 8 Oct model research (Ollama library, Hugging
 * Face, OpenRouter's live endpoints list); keep them dated when updating.
 *
 * Informational only: nothing here is sent to a model or decides what an
 * agent may do.
 */

export interface KnownOllamaTag {
  /** Exact tag, e.g. "llama3.2:3b". */
  tag: string;
  quant: string;
  sizeGb: number;
  /** Other names Ollama shows for the same file, e.g. "llama3.2:latest". */
  aliases?: string[];
}

export interface KnownOpenRouterOption {
  /** OpenRouter model id, e.g. "meta-llama/llama-3.2-3b-instruct". */
  id: string;
  /** Host slugs that support tool calling (checked live on the date in `checkedOn`). */
  toolHosts: string[];
  /** Price per million tokens in USD, input / output, cheapest tool host. */
  priceIn?: number;
  priceOut?: number;
  contextTokens?: number;
  checkedOn: string;
}

export interface KnownHuggingFaceOption {
  /** Model id as the Hugging Face router takes it, e.g. "Qwen/Qwen3-14B:featherless-ai". */
  model: string;
  note?: string;
}

export interface KnownModelVariant {
  /** Size or variant label, e.g. "3B", "14B", "26B A4B (MoE)". */
  variant: string;
  /** Parameter count in billions (total), for sorting and fit. */
  paramsB: number;
  /** Approximate graphics memory needed at the smallest listed quant with an 8k context, in GB. */
  minVramGb: number | null;
  ollama: KnownOllamaTag[];
  openrouter: KnownOpenRouterOption[];
  huggingface: KnownHuggingFaceOption[];
  tools: "yes" | "partial" | "no";
  vision: boolean;
  thinking: "yes" | "no" | "toggle";
  contextTokens: number | null;
  /** One plain sentence for the owner. */
  note?: string;
}

export interface KnownModelFamily {
  /** Stable slug, e.g. "meta-llama-3.2". */
  id: string;
  /** Original maker, e.g. "Meta". */
  maker: string;
  /** Family name, e.g. "Llama 3.2". */
  family: string;
  /** Set for a fine-tune / uncensored line, pointing at the official family id it derives from. */
  derivedFrom?: string;
  uncensored?: boolean;
  license?: string;
  variants: KnownModelVariant[];
}

/** Filled by the catalogue data (see KNOWN_MODEL_FAMILIES below). */
export const KNOWN_MODEL_FAMILIES: readonly KnownModelFamily[] = [];
