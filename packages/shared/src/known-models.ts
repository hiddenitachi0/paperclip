/**
 * Catalogue v2 (8 Oct 2026): a built-in list of known open models, so
 * Settings > Models can show Maker -> Model -> Size -> ways to run it, say
 * whether a size fits the graphics card the company entered (Settings >
 * Models; nothing is assumed when it is not set), give the `ollama pull`
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
  /** One plain sentence for whoever reads the catalogue. */
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


// ---------------------------------------------------------------------------
// Catalogue data
// ---------------------------------------------------------------------------

/** Date the OpenRouter hosts, prices and Ollama tags below were checked live. */
export const KNOWN_MODELS_CHECKED_ON = "2026-10-08";
const CHECKED = KNOWN_MODELS_CHECKED_ON;

/**
 * Graphics memory estimate for one Ollama download: the file size plus room
 * for an 8k context and working buffers (at least 1.5 GB, or 10% of the file
 * for big files), rounded up to the next half GB. An estimate, not a
 * measurement.
 */
function estimateVramGb(sizeGb: number): number {
  return Math.ceil((sizeGb + Math.max(1.5, sizeGb * 0.1)) * 2) / 2;
}

type VariantInput = Omit<KnownModelVariant, "minVramGb" | "ollama" | "openrouter" | "huggingface"> & {
  ollama?: KnownOllamaTag[];
  openrouter?: KnownOpenRouterOption[];
  huggingface?: KnownHuggingFaceOption[];
  /** Set to override the estimate from the smallest Ollama tag. */
  minVramGb?: number | null;
};

/** Fills the list fields and, unless given, minVramGb from the smallest listed Ollama tag (null when none). */
function v(input: VariantInput): KnownModelVariant {
  const ollama = input.ollama ?? [];
  const smallest = ollama.length > 0 ? Math.min(...ollama.map((t) => t.sizeGb)) : null;
  return {
    ...input,
    minVramGb: input.minVramGb !== undefined ? input.minVramGb : smallest === null ? null : estimateVramGb(smallest),
    ollama,
    openrouter: input.openrouter ?? [],
    huggingface: input.huggingface ?? [],
  };
}

export const KNOWN_MODEL_FAMILIES: readonly KnownModelFamily[] = [
  // ----- Meta --------------------------------------------------------------
  {
    id: "meta-llama-3.2",
    maker: "Meta",
    family: "Llama 3.2",
    license: "Llama 3.2 Community License",
    variants: [
      v({
        variant: "1B",
        paramsB: 1.24,
        ollama: [{ tag: "llama3.2:1b", quant: "Q8_0", sizeGb: 1.3, aliases: ["llama3.2:1b-instruct-q8_0"] }],
        openrouter: [{ id: "meta-llama/llama-3.2-1b-instruct", toolHosts: [], contextTokens: 60000, checkedOn: CHECKED }],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Very small and fast, but weak: Meta's own tool-use score is low (BFCL 25.7).",
      }),
      v({
        variant: "3B",
        paramsB: 3.21,
        ollama: [
          { tag: "llama3.2:3b", quant: "Q4_K_M", sizeGb: 2.0, aliases: ["llama3.2:latest", "llama3.2:3b-instruct-q4_K_M"] },
          { tag: "llama3.2:3b-instruct-q8_0", quant: "Q8_0", sizeGb: 3.4 },
        ],
        openrouter: [{ id: "meta-llama/llama-3.2-3b-instruct", toolHosts: [], contextTokens: 131072, checkedOn: CHECKED }],
        huggingface: [{ model: "meta-llama/Llama-3.2-3B-Instruct:featherless-ai", note: "Tool calling on Featherless is unverified." }],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Tiny and quick. Fine as a backup or a simple router, but it gets facts wrong and its Norwegian is weak. No cloud host supports tools for it.",
      }),
    ],
  },
  {
    id: "meta-llama-3.1",
    maker: "Meta",
    family: "Llama 3.1",
    license: "Llama 3.1 Community License",
    variants: [
      v({
        variant: "8B",
        paramsB: 8.03,
        ollama: [
          { tag: "llama3.1:8b", quant: "Q4_K_M", sizeGb: 4.9, aliases: ["llama3.1:latest", "llama3.1:8b-instruct-q4_K_M"] },
          { tag: "llama3.1:8b-instruct-q8_0", quant: "Q8_0", sizeGb: 8.5 },
        ],
        openrouter: [
          {
            id: "meta-llama/llama-3.1-8b-instruct",
            toolHosts: ["groq", "coreweave"],
            priceIn: 0.05,
            priceOut: 0.08,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "meta-llama/Llama-3.1-8B-Instruct:deepinfra" }],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Norwegian is not an officially supported language for Llama 3.x.",
      }),
      v({
        variant: "70B",
        paramsB: 70.6,
        ollama: [{ tag: "llama3.1:70b", quant: "Q4_K_M", sizeGb: 43, aliases: ["llama3.1:70b-instruct-q4_K_M"] }],
        openrouter: [
          {
            id: "meta-llama/llama-3.1-70b-instruct",
            toolHosts: ["deepinfra"],
            priceIn: 0.4,
            priceOut: 0.4,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Too big for a home graphics card. Llama 3.3 70B is the newer, cheaper cloud choice.",
      }),
      v({
        variant: "405B",
        paramsB: 405,
        ollama: [{ tag: "llama3.1:405b", quant: "Q4_K_M", sizeGb: 243, aliases: ["llama3.1:405b-instruct-q4_K_M"] }],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Huge; not on OpenRouter any more.",
      }),
    ],
  },
  {
    id: "meta-llama-3.3",
    maker: "Meta",
    family: "Llama 3.3",
    license: "Llama 3.3 Community License",
    variants: [
      v({
        variant: "70B",
        paramsB: 70.6,
        ollama: [{ tag: "llama3.3:70b", quant: "Q4_K_M", sizeGb: 43, aliases: ["llama3.3:latest", "llama3.3:70b-instruct-q4_K_M"] }],
        openrouter: [
          {
            id: "meta-llama/llama-3.3-70b-instruct",
            toolHosts: ["deepinfra", "novita", "akashml", "groq", "coreweave", "google-vertex", "together"],
            priceIn: 0.1,
            priceOut: 0.32,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "meta-llama/Llama-3.3-70B-Instruct:ovhcloud" }],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "The usual cloud step up from a small Llama. Novita only allows a short (12k) memory.",
      }),
    ],
  },
  {
    id: "meta-llama-4",
    maker: "Meta",
    family: "Llama 4",
    license: "Llama 4 Community License",
    variants: [
      v({
        variant: "Scout (109B MoE)",
        paramsB: 109,
        ollama: [
          {
            tag: "llama4:scout",
            quant: "Q4_K_M",
            sizeGb: 67,
            aliases: ["llama4:latest", "llama4:16x17b", "llama4:17b-scout-16e-instruct-q4_K_M"],
          },
        ],
        openrouter: [
          {
            id: "meta-llama/llama-4-scout",
            toolHosts: ["google-vertex"],
            priceIn: 0.25,
            priceOut: 0.7,
            contextTokens: 1310720,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra" }],
        tools: "yes",
        vision: true,
        thinking: "no",
        contextTokens: 10000000,
        note: "Far too big for a home graphics card (67 GB). On OpenRouter only Google Vertex supports tools for it.",
      }),
      v({
        variant: "Maverick (400B MoE)",
        paramsB: 400,
        ollama: [
          {
            tag: "llama4:maverick",
            quant: "Q4_K_M",
            sizeGb: 245,
            aliases: ["llama4:128x17b", "llama4:17b-maverick-128e-instruct-q4_K_M"],
          },
        ],
        openrouter: [
          {
            id: "meta-llama/llama-4-maverick",
            toolHosts: ["digitalocean", "parasail", "google-vertex"],
            priceIn: 0.1875,
            priceOut: 0.6525,
            contextTokens: 128000,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: true,
        thinking: "no",
        contextTokens: 1048576,
        note: "Cheap cloud model that reads images and is fine for single tool calls, but weak at long multi-step tasks and Norwegian.",
      }),
    ],
  },
  // ----- Alibaba Qwen ------------------------------------------------------
  {
    id: "alibaba-qwen3",
    maker: "Alibaba",
    family: "Qwen3",
    license: "Apache-2.0",
    variants: [
      v({
        variant: "4B",
        paramsB: 4.02,
        ollama: [
          {
            tag: "qwen3:4b",
            quant: "Q4_K_M",
            sizeGb: 2.5,
            aliases: ["qwen3:4b-thinking", "qwen3:4b-thinking-2507-q4_K_M"],
          },
          { tag: "qwen3:4b-instruct", quant: "Q4_K_M", sizeGb: 2.5, aliases: ["qwen3:4b-instruct-2507-q4_K_M"] },
        ],
        tools: "yes",
        vision: false,
        thinking: "yes",
        contextTokens: 262144,
        note: "qwen3:4b now gives the 2507 version that always thinks first; qwen3:4b-instruct is the same size without thinking.",
      }),
      v({
        variant: "8B",
        paramsB: 8.19,
        ollama: [{ tag: "qwen3:8b", quant: "Q4_K_M", sizeGb: 5.2, aliases: ["qwen3:latest", "qwen3:8b-q4_K_M"] }],
        openrouter: [
          {
            id: "qwen/qwen3-8b",
            toolHosts: ["alibaba"],
            priceIn: 0.117,
            priceOut: 0.455,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
      }),
      v({
        variant: "14B",
        paramsB: 14.8,
        ollama: [{ tag: "qwen3:14b", quant: "Q4_K_M", sizeGb: 9.3, aliases: ["qwen3:14b-q4_K_M"] }],
        openrouter: [
          {
            id: "qwen/qwen3-14b",
            toolHosts: ["deepinfra", "alibaba"],
            priceIn: 0.12,
            priceOut: 0.24,
            contextTokens: 40960,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "Qwen/Qwen3-14B:deepinfra" }],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
        note: "Best local tool user that fits a 12 GB graphics card; a good default for a private assistant.",
      }),
      v({
        variant: "30B A3B (MoE)",
        paramsB: 30.5,
        ollama: [
          {
            tag: "qwen3:30b",
            quant: "Q4_K_M",
            sizeGb: 19,
            aliases: ["qwen3:30b-a3b", "qwen3:30b-thinking", "qwen3:30b-a3b-thinking-2507-q4_K_M"],
          },
          { tag: "qwen3:30b-instruct", quant: "Q4_K_M", sizeGb: 19, aliases: ["qwen3:30b-a3b-instruct-2507-q4_K_M"] },
        ],
        openrouter: [
          {
            id: "qwen/qwen3-30b-a3b",
            toolHosts: ["deepinfra", "alibaba"],
            priceIn: 0.12,
            priceOut: 0.5,
            contextTokens: 40960,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
        note: "Only about 3B of its 30B are used per word, so it is fast, but the whole model must still fit in memory.",
      }),
      v({
        variant: "32B",
        paramsB: 32.8,
        ollama: [{ tag: "qwen3:32b", quant: "Q4_K_M", sizeGb: 20, aliases: ["qwen3:32b-q4_K_M"] }],
        openrouter: [
          {
            id: "qwen/qwen3-32b",
            toolHosts: ["deepinfra", "siliconflow"],
            priceIn: 0.08,
            priceOut: 0.28,
            contextTokens: 40960,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "Qwen/Qwen3-32B" }],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
      }),
      v({
        variant: "235B A22B (MoE)",
        paramsB: 235,
        ollama: [
          {
            tag: "qwen3:235b",
            quant: "Q4_K_M",
            sizeGb: 142,
            aliases: ["qwen3:235b-a22b", "qwen3:235b-thinking", "qwen3:235b-a22b-thinking-2507-q4_K_M"],
          },
        ],
        openrouter: [
          {
            id: "qwen/qwen3-235b-a22b",
            toolHosts: ["alibaba"],
            priceIn: 0.455,
            priceOut: 1.82,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 131072,
      }),
    ],
  },
  {
    id: "alibaba-qwen3.6",
    maker: "Alibaba",
    family: "Qwen3.6",
    license: "Apache-2.0",
    variants: [
      v({
        variant: "27B",
        paramsB: 27,
        ollama: [
          { tag: "qwen3.6:27b", quant: "Q4_K_M", sizeGb: 19 },
          { tag: "qwen3.6:27b-q4_K_M", quant: "Q4_K_M", sizeGb: 17 },
        ],
        openrouter: [
          {
            id: "qwen/qwen3.6-27b",
            toolHosts: ["chutes", "alibaba", "siliconflow", "deepinfra", "phala", "venice"],
            priceIn: 0.3,
            priceOut: 2,
            contextTokens: 262144,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "Qwen/Qwen3.6-27B:deepinfra" }],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "The small 7.8 GB 'Ternary Bonsai' copy of this model does not load in Ollama.",
      }),
    ],
  },
  {
    id: "alibaba-qwen3.8",
    maker: "Alibaba",
    family: "Qwen3.8",
    license: "Apache-2.0 (27B)",
    variants: [
      v({
        variant: "27B",
        paramsB: 27.8,
        ollama: [
          { tag: "qwen3.8:27b", quant: "Q4_K_M", sizeGb: 18, aliases: ["qwen3.8:latest"] },
          { tag: "qwen3.8:27b-q4_K_M", quant: "Q4_K_M", sizeGb: 18 },
        ],
        openrouter: [
          {
            id: "qwen/qwen3.8-27b",
            toolHosts: [
              "phala",
              "deepinfra",
              "reka",
              "akashml",
              "darkbloom",
              "ionstream",
              "chutes",
              "parasail",
              "mancer",
              "alibaba",
              "dekallm",
              "coreweave",
              "novita",
              "cloudflare",
              "venice",
              "wafer",
              "modelrun",
            ],
            priceIn: 0.15,
            priceOut: 1.875,
            contextTokens: 1000000,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "Qwen/Qwen3.8-27B:deepinfra" }],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Strong all-rounder with reliable tools in the cloud. Cerebras is the one OpenRouter host without tools.",
      }),
      v({
        variant: "Flash (180B MoE)",
        paramsB: 180,
        openrouter: [
          {
            id: "qwen/qwen3.8-flash",
            toolHosts: ["alibaba"],
            priceIn: 0.15,
            priceOut: 0.47,
            contextTokens: 1000000,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "Qwen/Qwen3.8-Flash-Next:featherless-ai", note: "Tool calling on Featherless is unverified." }],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Very cheap and fast cloud model with a huge memory (1M on OpenRouter). Only one host (Alibaba), so give agents a backup model. Far too big for an ordinary computer at home. Its weights use the qwen-community-1.0 licence, not Apache-2.0.",
      }),
    ],
  },
  // ----- Google ------------------------------------------------------------
  {
    id: "google-gemma-3",
    maker: "Google",
    family: "Gemma 3",
    license: "Gemma Terms of Use",
    variants: [
      v({
        variant: "4B",
        paramsB: 4.3,
        ollama: [{ tag: "gemma3:4b", quant: "Q4_K_M", sizeGb: 3.3, aliases: ["gemma3:latest", "gemma3:4b-it-q4_K_M"] }],
        openrouter: [{ id: "google/gemma-3-4b-it", toolHosts: [], contextTokens: 131072, checkedOn: CHECKED }],
        tools: "no",
        vision: true,
        thinking: "no",
        contextTokens: 131072,
        note: "Cannot use tools, so it fails as a Quick-lane agent model. Gemma 4 replaces it.",
      }),
      v({
        variant: "12B",
        paramsB: 12.2,
        ollama: [
          { tag: "gemma3:12b", quant: "Q4_K_M", sizeGb: 8.1, aliases: ["gemma3:12b-it-q4_K_M"] },
          { tag: "gemma3:12b-it-qat", quant: "Q4_0 (QAT)", sizeGb: 8.9 },
        ],
        openrouter: [
          {
            id: "google/gemma-3-12b-it",
            toolHosts: ["deepinfra"],
            priceIn: 0.05,
            priceOut: 0.15,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "google/gemma-3-12b-it:deepinfra" }],
        tools: "partial",
        vision: true,
        thinking: "no",
        contextTokens: 131072,
        note: "Ollama refuses tool calls for Gemma 3, so locally every Quick-lane call fails. Use Gemma 4 12B instead.",
      }),
      v({
        variant: "27B",
        paramsB: 27.4,
        ollama: [{ tag: "gemma3:27b", quant: "Q4_K_M", sizeGb: 17, aliases: ["gemma3:27b-it-q4_K_M"] }],
        openrouter: [
          {
            id: "google/gemma-3-27b-it",
            toolHosts: ["deepinfra"],
            priceIn: 0.08,
            priceOut: 0.16,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        tools: "partial",
        vision: true,
        thinking: "no",
        contextTokens: 131072,
        note: "Weak at tool use (Tau2 16%); Gemma 4 is much better.",
      }),
    ],
  },
  {
    id: "google-gemma-4",
    maker: "Google",
    family: "Gemma 4",
    license: "Apache-2.0",
    variants: [
      v({
        variant: "E2B",
        paramsB: 5.1,
        ollama: [
          { tag: "gemma4:e2b", quant: "Q4_K_M", sizeGb: 4.6 },
          { tag: "gemma4:e2b-it-qat", quant: "Q4_0 (QAT)", sizeGb: 4.3 },
        ],
        tools: "partial",
        vision: true,
        thinking: "toggle",
        contextTokens: 131072,
        note: "Smallest Gemma 4 (about 2B in use); poor at tools (Tau2 24.5%). Reads pictures and audio.",
      }),
      v({
        variant: "E4B",
        paramsB: 8,
        ollama: [
          { tag: "gemma4:e4b", quant: "Q4_K_M", sizeGb: 6.6, aliases: ["gemma4:latest"] },
          { tag: "gemma4:e4b-it-qat", quant: "Q4_0 (QAT)", sizeGb: 6.1 },
        ],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 131072,
        note: "What 'ollama pull gemma4' gives you: small and fast, reads pictures and audio. Fine for one simple tool call, weak at more (Tau2 42%). Needs Ollama 0.30.9 or newer.",
      }),
      v({
        variant: "12B",
        paramsB: 11.96,
        ollama: [
          { tag: "gemma4:12b", quant: "Q4_K_M", sizeGb: 8 },
          { tag: "gemma4:12b-it-qat", quant: "Q4_0 (QAT)", sizeGb: 7.2 },
        ],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Good tools (Tau2 69%), reads pictures, decent Norwegian, and fits a 12 GB graphics card. Not offered in the cloud. Needs Ollama 0.30.9 or newer.",
      }),
      v({
        variant: "26B A4B (MoE)",
        paramsB: 25.2,
        ollama: [{ tag: "gemma4:26b", quant: "Q4_K_M", sizeGb: 18, aliases: ["gemma4:26b-a4b"] }],
        openrouter: [
          {
            id: "google/gemma-4-26b-a4b-it",
            toolHosts: [
              "darkbloom",
              "io-net",
              "dekallm",
              "nextbit",
              "cloudflare",
              "makora",
              "deepinfra",
              "novita",
              "venice",
              "google-vertex",
            ],
            priceIn: 0.042,
            priceOut: 0.22,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "google/gemma-4-26B-A4B-it:deepinfra" }],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Very cheap, fast cloud model. Three OpenRouter hosts (CoreWeave, Parasail, SiliconFlow) do not support tools, so pin a tool host.",
      }),
      v({
        variant: "31B",
        paramsB: 30.7,
        ollama: [{ tag: "gemma4:31b", quant: "Q4_K_M", sizeGb: 20 }],
        openrouter: [
          {
            id: "google/gemma-4-31b-it",
            toolHosts: [
              "deepinfra",
              "coreweave",
              "venice",
              "chutes",
              "crusoe",
              "friendli",
              "novita",
              "parasail",
              "io-net",
              "sambanova",
              "modelrun",
              "siliconflow",
            ],
            priceIn: 0.09,
            priceOut: 0.34,
            contextTokens: 262144,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "google/gemma-4-31B-it:novita" }],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Best Norwegian writer of the open models, and cheap. Every OpenRouter host supports tools.",
      }),
    ],
  },
  // ----- Mistral -----------------------------------------------------------
  {
    id: "mistralai-mistral-small-3.2",
    maker: "Mistral AI",
    family: "Mistral Small 3.2",
    license: "Apache-2.0",
    variants: [
      v({
        variant: "24B",
        paramsB: 24,
        ollama: [
          {
            tag: "mistral-small3.2:24b",
            quant: "Q4_K_M",
            sizeGb: 15,
            aliases: ["mistral-small3.2:latest", "mistral-small3.2:24b-instruct-2506-q4_K_M"],
          },
        ],
        openrouter: [
          {
            id: "mistralai/mistral-small-3.2-24b-instruct",
            toolHosts: ["deepinfra", "venice", "mistral"],
            priceIn: 0.075,
            priceOut: 0.2,
            contextTokens: 128000,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: true,
        thinking: "no",
        contextTokens: 131072,
      }),
    ],
  },
  {
    id: "mistralai-mistral-nemo",
    maker: "Mistral AI",
    family: "Mistral Nemo",
    license: "Apache-2.0",
    variants: [
      v({
        variant: "12B",
        paramsB: 12.2,
        ollama: [
          {
            tag: "mistral-nemo:12b",
            quant: "Q4_0",
            sizeGb: 7.1,
            aliases: ["mistral-nemo:latest", "mistral-nemo:12b-instruct-2407-q4_0"],
          },
          { tag: "mistral-nemo:12b-instruct-2407-q4_K_M", quant: "Q4_K_M", sizeGb: 7.5 },
        ],
        openrouter: [
          {
            id: "mistralai/mistral-nemo",
            toolHosts: ["deepinfra", "io-net", "mistral"],
            priceIn: 0.019,
            priceOut: 0.03,
            contextTokens: 131072,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Extremely cheap in the cloud.",
      }),
    ],
  },
  // ----- DeepSeek ----------------------------------------------------------
  {
    id: "deepseek",
    maker: "DeepSeek",
    family: "DeepSeek",
    license: "MIT",
    variants: [
      v({
        variant: "R1 0528 Qwen3 8B (distill)",
        paramsB: 8.19,
        ollama: [
          {
            tag: "deepseek-r1:8b",
            quant: "Q4_K_M",
            sizeGb: 5.2,
            aliases: ["deepseek-r1:latest", "deepseek-r1:8b-0528-qwen3-q4_K_M"],
          },
        ],
        tools: "no",
        vision: false,
        thinking: "yes",
        contextTokens: 131072,
        note: "Always thinks first and cannot use tools, so it fails as an agent model. DeepSeek V4 Flash in the cloud replaces it.",
      }),
      v({
        variant: "V4 Flash (284B MoE)",
        paramsB: 284,
        openrouter: [
          {
            id: "deepseek/deepseek-v4-flash",
            toolHosts: [
              "wafer",
              "streamlake",
              "deepinfra",
              "gmicloud",
              "venice",
              "digitalocean",
              "open-inference",
              "alibaba",
              "siliconflow",
              "atlas-cloud",
              "baidu",
              "novita",
              "parasail",
              "mancer",
              "azure",
              "relace",
              "cloudflare",
            ],
            priceIn: 0.063,
            priceOut: 0.17,
            contextTokens: 1048576,
            checkedOn: CHECKED,
          },
        ],
        huggingface: [{ model: "deepseek-ai/DeepSeek-V4-Flash:deepinfra" }],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 1048576,
        note: "Cheap, strong all-rounder with tools on every host; a good cheap Full-task worker. Cloud only.",
      }),
      v({
        variant: "R1 0528 (671B MoE)",
        paramsB: 671,
        ollama: [{ tag: "deepseek-r1:671b", quant: "Q4_K_M", sizeGb: 404, aliases: ["deepseek-r1:671b-0528-q4_K_M"] }],
        openrouter: [
          {
            id: "deepseek/deepseek-r1-0528",
            toolHosts: ["siliconflow", "novita"],
            priceIn: 0.5,
            priceOut: 2.18,
            contextTokens: 163840,
            checkedOn: CHECKED,
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "yes",
        contextTokens: 163840,
        note: "The full model the 8B was distilled from. Older and dearer than V4 Flash.",
      }),
    ],
  },
  // ----- Microsoft ---------------------------------------------------------
  {
    id: "microsoft-phi-4",
    maker: "Microsoft",
    family: "Phi-4",
    license: "MIT",
    variants: [
      v({
        variant: "14B",
        paramsB: 14.7,
        ollama: [{ tag: "phi4:14b", quant: "Q4_K_M", sizeGb: 9.1, aliases: ["phi4:latest", "phi4:14b-q4_K_M"] }],
        openrouter: [{ id: "microsoft/phi-4", toolHosts: [], contextTokens: 16384, checkedOn: CHECKED }],
        tools: "no",
        vision: false,
        thinking: "no",
        contextTokens: 16384,
        note: "Cannot use tools and has a short memory (16k), so it does not work as a Quick-lane agent model.",
      }),
    ],
  },
  // ----- Fine-tunes and uncensored lines ----------------------------------
  {
    id: "nous-hermes-3",
    maker: "Nous Research",
    family: "Hermes 3",
    derivedFrom: "meta-llama-3.1",
    license: "Llama 3 Community License",
    variants: [
      v({
        variant: "8B",
        paramsB: 8.03,
        ollama: [
          { tag: "hermes3:8b", quant: "Q4_0", sizeGb: 4.7, aliases: ["hermes3:latest", "hermes3:8b-llama3.1-q4_0"] },
          { tag: "hermes3:8b-llama3.1-q6_K", quant: "Q6_K", sizeGb: 6.6 },
        ],
        huggingface: [{ model: "NousResearch/Hermes-3-Llama-3.1-8B:featherless-ai", note: "Tool calling on Featherless is unverified." }],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Good at staying in character. Tool calls can break when many tools are offered, so test first. Weak Norwegian. The q6_K copy is better quality and still fits.",
      }),
      v({
        variant: "70B",
        paramsB: 70.6,
        ollama: [{ tag: "hermes3:70b", quant: "Q4_0", sizeGb: 40, aliases: ["hermes3:70b-llama3.1-q4_0"] }],
        openrouter: [
          { id: "nousresearch/hermes-3-llama-3.1-70b", toolHosts: [], contextTokens: 131072, checkedOn: CHECKED },
        ],
        huggingface: [
          { model: "NousResearch/Hermes-3-Llama-3.1-70B:featherless-ai", note: "Tool calling on Featherless is unverified." },
        ],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "No OpenRouter host supports tools for it.",
      }),
      v({
        variant: "405B",
        paramsB: 405,
        ollama: [{ tag: "hermes3:405b", quant: "Q4_0", sizeGb: 229, aliases: ["hermes3:405b-llama3.1-q4_0"] }],
        openrouter: [
          { id: "nousresearch/hermes-3-llama-3.1-405b", toolHosts: [], contextTokens: 131072, checkedOn: CHECKED },
        ],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "No OpenRouter host supports tools for it.",
      }),
    ],
  },
  {
    id: "huihui-qwen3-abliterated",
    maker: "huihui-ai",
    family: "Qwen3 abliterated",
    derivedFrom: "alibaba-qwen3",
    uncensored: true,
    license: "Apache-2.0",
    variants: [
      v({
        variant: "8B",
        paramsB: 8.19,
        ollama: [
          {
            tag: "huihui_ai/qwen3-abliterated:8b-v2",
            quant: "Q4_K_M",
            sizeGb: 5,
            aliases: [
              "huihui_ai/qwen3-abliterated:latest",
              "huihui_ai/qwen3-abliterated:8b",
              "huihui_ai/qwen3-abliterated:8b-v2-q4_K_M",
            ],
          },
          { tag: "huihui_ai/qwen3-abliterated:8b-v2-q8_0", quant: "Q8_0", sizeGb: 8.7 },
        ],
        huggingface: [
          {
            model: "huihui-ai/Huihui-Qwen3-8B-abliterated-v2:featherless-ai",
            note: "Same weights in the cloud; tool calling unverified.",
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
        note: "Qwen3 8B with refusals removed. Only for a separate private persona, never on agents that touch company data. Test tools once first.",
      }),
      v({
        variant: "14B",
        paramsB: 14.8,
        ollama: [
          {
            tag: "huihui_ai/qwen3-abliterated:14b",
            quant: "Q4_K_M",
            sizeGb: 9,
            aliases: ["huihui_ai/qwen3-abliterated:14b-v2", "huihui_ai/qwen3-abliterated:14b-v2-q4_K_M"],
          },
        ],
        huggingface: [
          {
            model: "huihui-ai/Huihui-Qwen3-14B-abliterated-v2:featherless-ai",
            note: "Cloud copy for when your own computer is off; about $0.48 in / $0.96 out per million tokens, 32k memory; tool calling unverified.",
          },
        ],
        tools: "yes",
        vision: false,
        thinking: "toggle",
        contextTokens: 40960,
        note: "Qwen3 14B with refusals removed. Only for a separate private persona, never on agents that touch company data. Test tools once first.",
      }),
    ],
  },
  {
    id: "huihui-gemma-4-abliterated",
    maker: "huihui-ai",
    family: "Gemma 4 abliterated",
    derivedFrom: "google-gemma-4",
    uncensored: true,
    license: "Apache-2.0",
    variants: [
      v({
        variant: "12B",
        paramsB: 11.9,
        ollama: [
          { tag: "huihui_ai/gemma-4-abliterated:12b-qat", quant: "Q4_K_M (from QAT weights)", sizeGb: 7.6 },
          {
            tag: "huihui_ai/gemma-4-abliterated:12b",
            quant: "Q4_K_M",
            sizeGb: 7.6,
            aliases: ["huihui_ai/gemma-4-abliterated:12b-q4_K"],
          },
        ],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Uncensored Gemma 4 12B that reads pictures. Prefer the :12b-qat tag (same size, likely better quality). Separate private persona only.",
      }),
    ],
  },
  {
    id: "orcarouter-qwen3.8-uncensored",
    maker: "orcarouter",
    family: "Qwen3.8 Uncensored",
    derivedFrom: "alibaba-qwen3.8",
    uncensored: true,
    license: "Apache-2.0",
    variants: [
      v({
        variant: "27B",
        paramsB: 27.8,
        ollama: [
          { tag: "orcarouter/Qwen3.8-27B-Uncensored:iq2_xxs", quant: "IQ2_XXS", sizeGb: 9.8 },
          { tag: "orcarouter/Qwen3.8-27B-Uncensored:iq2_m", quant: "IQ2_M", sizeGb: 11 },
          {
            tag: "orcarouter/Qwen3.8-27B-Uncensored:q4_K_M",
            quant: "Q4_K_M",
            sizeGb: 18,
            aliases: ["orcarouter/Qwen3.8-27B-Uncensored:latest"],
          },
        ],
        huggingface: [
          {
            model: "darkc0de/Qwen3.8-27B-heretic:featherless-ai",
            note: "A different uncensored build of the same model, in the cloud. Pricey (about $1.60 in / $12 out per million tokens), 32k memory, tools untested.",
          },
        ],
        tools: "yes",
        vision: true,
        thinking: "toggle",
        contextTokens: 262144,
        note: "Strongest uncensored model that fits a 12 GB graphics card, but only the heavily shrunk 2-bit copy fits, with a short (8k) memory. Separate private persona only. Needs Ollama 0.32.12 or newer.",
      }),
    ],
  },
  {
    id: "dolphin-3",
    maker: "Cognitive Computations",
    family: "Dolphin 3.0",
    derivedFrom: "meta-llama-3.1",
    uncensored: true,
    license: "Llama 3.1 Community License",
    variants: [
      v({
        variant: "8B",
        paramsB: 8.03,
        ollama: [
          { tag: "dolphin3:8b", quant: "Q4_K_M", sizeGb: 4.9, aliases: ["dolphin3:latest", "dolphin3:8b-llama3.1-q4_K_M"] },
          { tag: "hf.co/cognitivecomputations/Dolphin3.0-Llama3.1-8B-GGUF:Q4_0", quant: "Q4_0", sizeGb: 4.7 },
          { tag: "huihui_ai/dolphin3-abliterated:8b", quant: "Q4_K_M", sizeGb: 4.9 },
        ],
        tools: "no",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Cannot use tools, so every Quick-lane call fails. All three downloads are the same Dolphin 3 model.",
      }),
    ],
  },
  {
    id: "llama-3.1-abliterated",
    maker: "mlabonne",
    family: "Llama 3.1 abliterated",
    derivedFrom: "meta-llama-3.1",
    uncensored: true,
    license: "Llama 3.1 Community License",
    variants: [
      v({
        variant: "8B",
        paramsB: 8.03,
        ollama: [
          { tag: "mannix/llama3.1-8b-abliterated:tools-q6_k", quant: "Q6_K", sizeGb: 6.6 },
          {
            tag: "mannix/llama3.1-8b-abliterated:q4_0",
            quant: "Q4_0",
            sizeGb: 4.7,
            aliases: ["mannix/llama3.1-8b-abliterated:latest"],
          },
          { tag: "hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q8_0", quant: "Q8_0", sizeGb: 8.5 },
        ],
        huggingface: [
          { model: "mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated:featherless-ai", note: "Tool calling unverified." },
        ],
        tools: "partial",
        vision: false,
        thinking: "no",
        contextTokens: 131072,
        note: "Llama 3.1 8B with refusals removed. Only the ':tools-' copies can call tools; the bartowski copy cannot. Separate private persona only.",
      }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export interface KnownVariantMatch {
  family: KnownModelFamily;
  variant: KnownModelVariant;
}

export function findKnownFamily(id: string): KnownModelFamily | null {
  const wanted = id.trim().toLowerCase();
  return KNOWN_MODEL_FAMILIES.find((f) => f.id.toLowerCase() === wanted) ?? null;
}

/** Ollama name as compared: lower-case, no "registry.ollama.ai/library/" prefix, ":latest" added when no tag is given. */
function normalizeOllamaTag(tag: string): string {
  let t = tag.trim().toLowerCase();
  t = t.replace(/^registry\.ollama\.ai\//, "").replace(/^library\//, "");
  // A ":" inside the last path segment marks the tag; "hf.co/org/repo" without one means :latest.
  const lastSegment = t.slice(t.lastIndexOf("/") + 1);
  if (!lastSegment.includes(":")) t = `${t}:latest`;
  return t;
}

/** OpenRouter id as compared: lower-case, without a routing suffix such as ":free" or ":nitro". */
function normalizeOpenRouterId(id: string): string {
  const t = id.trim().toLowerCase();
  const colon = t.indexOf(":");
  return colon === -1 ? t : t.slice(0, colon);
}

/** Hugging Face model as compared: lower-case, without the ":provider" suffix. */
function normalizeHuggingFaceModel(model: string): string {
  const t = model.trim().toLowerCase();
  const colon = t.indexOf(":");
  return colon === -1 ? t : t.slice(0, colon);
}

/**
 * Finds the catalogue entry for a model a company has saved. `provider` is the
 * model directory's provider: "local" (or "ollama") matches Ollama tags and
 * their aliases ("llama3.2" equals "llama3.2:latest"); "openrouter" matches the
 * OpenRouter id, ignoring a ":free"/":nitro" style suffix; "huggingface"
 * matches the model with or without its ":provider" suffix. Case-insensitive.
 */
export function findKnownVariant(provider: string, model: string): KnownVariantMatch | null {
  const p = provider.trim().toLowerCase();
  if (!model.trim()) return null;
  if (p === "local" || p === "ollama") {
    const wanted = normalizeOllamaTag(model);
    for (const family of KNOWN_MODEL_FAMILIES) {
      for (const variant of family.variants) {
        for (const tag of variant.ollama) {
          const names = [tag.tag, ...(tag.aliases ?? [])].map(normalizeOllamaTag);
          if (names.includes(wanted)) return { family, variant };
        }
      }
    }
    return null;
  }
  if (p === "openrouter") {
    const wanted = normalizeOpenRouterId(model);
    for (const family of KNOWN_MODEL_FAMILIES) {
      for (const variant of family.variants) {
        if (variant.openrouter.some((o) => normalizeOpenRouterId(o.id) === wanted)) return { family, variant };
      }
    }
    return null;
  }
  if (p === "huggingface" || p === "hf") {
    const wanted = normalizeHuggingFaceModel(model);
    for (const family of KNOWN_MODEL_FAMILIES) {
      for (const variant of family.variants) {
        if (variant.huggingface.some((h) => normalizeHuggingFaceModel(h.model) === wanted)) return { family, variant };
      }
    }
    return null;
  }
  return null;
}

/** Share of the card's memory a model may use and still count as a comfortable fit. */
export const GPU_FIT_HEADROOM = 0.85;

/**
 * Whether a variant fits a graphics card with `vramGb` of memory:
 * - "yes"   when minVramGb <= 85% of the card (room left for longer chats and the desktop),
 * - "tight" when minVramGb <= the card's full memory (runs, but only with a short context),
 * - "no"    otherwise,
 * - null    when the card's memory or the variant's need is unknown.
 */
export function variantFitsGpu(
  variant: KnownModelVariant,
  vramGb: number | null | undefined,
): "yes" | "tight" | "no" | null {
  if (vramGb === null || vramGb === undefined || !Number.isFinite(vramGb) || vramGb <= 0) return null;
  if (variant.minVramGb === null) return null;
  if (variant.minVramGb <= vramGb * GPU_FIT_HEADROOM) return "yes";
  if (variant.minVramGb <= vramGb) return "tight";
  return "no";
}

export interface KnownUpgradeOption {
  family: KnownModelFamily;
  variant: KnownModelVariant;
  via: "openrouter" | "local";
}

/**
 * Bigger versions of a model worth offering as an upgrade: variants with more
 * parameters in the same family and in the family it derives from, that
 * either fit the company's card ("yes" or "tight", offered as "local") or have an
 * OpenRouter option with at least one tool-capable host ("openrouter").
 * Local wins when both apply. Sorted by size, smallest first.
 */
export function upgradeOptions(
  family: KnownModelFamily,
  variant: KnownModelVariant,
  opts?: { vramGb?: number | null },
): KnownUpgradeOption[] {
  const families: KnownModelFamily[] = [family];
  if (family.derivedFrom) {
    const parent = findKnownFamily(family.derivedFrom);
    if (parent && parent.id !== family.id) families.push(parent);
  }
  const out: KnownUpgradeOption[] = [];
  const seen = new Set<KnownModelVariant>();
  for (const f of families) {
    for (const candidate of f.variants) {
      if (candidate === variant || seen.has(candidate)) continue;
      if (!(candidate.paramsB > variant.paramsB)) continue;
      const fit = variantFitsGpu(candidate, opts?.vramGb);
      const local = (fit === "yes" || fit === "tight") && candidate.ollama.length > 0;
      const cloud = candidate.openrouter.some((o) => o.toolHosts.length > 0);
      if (!local && !cloud) continue;
      seen.add(candidate);
      out.push({ family: f, variant: candidate, via: local ? "local" : "openrouter" });
    }
  }
  return out.sort((a, b) => a.variant.paramsB - b.variant.paramsB);
}
