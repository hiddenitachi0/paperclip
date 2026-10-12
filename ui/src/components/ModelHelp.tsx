import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small "?" next to a field in Settings > Models. Hovering shows the text
 * (title); clicking or tapping opens it below, so it also works on a phone
 * and with a keyboard. Plain words for anyone, not only whoever set it up.
 */
export function HelpTip({ text, topic, className }: { text: string; topic: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        className="inline-flex rounded text-muted-foreground/60 transition-colors hover:text-foreground"
        aria-label={`What is ${topic}?`}
        aria-expanded={open}
        title={text}
        onClick={(event) => {
          // Inside a <label>, do not also focus or toggle the labelled control.
          event.preventDefault();
          setOpen((current) => !current);
        }}
        data-testid={`help-${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[80vw] rounded-md border border-border bg-popover p-2 text-xs font-normal leading-relaxed text-popover-foreground shadow-md"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/** Help texts for Settings > Models, in one place so they read the same everywhere. */
export const MODEL_HELP = {
  gpu:
    "The memory of the graphics card in the computer that runs this company's local models. Paperclip only uses it to say which model sizes fit; it changes nothing else, and it is saved for this company only. " +
    "Where to find it: Windows: Task Manager > Performance > GPU > Dedicated GPU memory. Mac with Apple silicon: the graphics share the main memory, so enter about two thirds of the total memory (16 GB Mac: about 10). Linux: run nvidia-smi.",
  address:
    "The address of the computer that runs Ollama or another OpenAI-compatible model server, as Paperclip's server reaches it, e.g. http://192.168.1.20:11434/v1 or a Tailscale address. Not localhost - that is Paperclip's own server. " +
    "New local models and the ready-made local models use this address. Saved for this company only.",
  resync:
    "Asks the model server at this company's local addresses which models are installed, marks the saved local models installed or not installed, and offers to save installed models that are not in the list yet. Works with Ollama.",
  groupBy: "How the list is arranged: by maker and model (with sizes and ways to run each), by where it runs, by what it is for, or one flat list.",
  sort: "By name, or by the test scores saved on each model (best first).",
  bestFor: "Pick one of the score names used on your models (e.g. Tool calling) to sort by that score only.",
  where: "Local = on this company's own model server. The others are cloud services; their keys are set under Connections.",
  use: "Quick chat = quick agents (chat replies). Full runs = agents doing whole tasks. A label only; it does not limit which agents can use the model.",
  status: "Installed, downloading or planned is for local models (a resync updates it). Cloud = nothing to install.",
  archived: "Archived models are hidden from agent pickers. Agents already using one keep working.",
  name: "Any name that helps people here pick it, e.g. \"Qwen3 14B (local)\". Shown in agent pickers.",
  maker: "Who made the model, e.g. Meta, Google or Alibaba Qwen. Used to group the list.",
  family: "The model family without the size, e.g. Llama 3.2 or Qwen3. Used to group the list.",
  variant: "Which size or version of the model this is, e.g. 3B, 14B or 14B uncensored.",
  lane: "What the model is meant for. A label for the list only; it does not limit which agents can use it.",
  availability: "For a local model: is it installed on the model server yet? A resync fills this in. Cloud models need nothing installed.",
  tags: "Short words to filter by, separated by commas, e.g. vision, uncensored, coding.",
  favorite: "Favourites are listed first in their group.",
  provider: "Local = this company's own model server (Ollama or similar). The others are cloud services; their keys are set under Connections, never here.",
  modelId: "The exact model name the service or Ollama uses, e.g. qwen3:14b or mistralai/mistral-small-3.2-24b-instruct.",
  entryAddress:
    "The address of the model server for this model, as Paperclip's server reaches it, e.g. http://192.168.1.20:11434/v1. Starts from this company's model server address. Not localhost - that is Paperclip's own server.",
  hosts:
    "OpenRouter passes each request to one of several hosting companies (hosts) that run this model. The table shows each host's price, memory and what it supports for THIS model, read live from OpenRouter. Mark a host Use (only the hosts marked Use are used), Never, or leave it on Default (the company's OpenRouter host rules in Settings > Models decide; with none, OpenRouter picks). No host is recommended by Paperclip.",
  hostRules:
    "The company's own lists of OpenRouter hosts to prefer and to block. They fill in the Default choices of each OpenRouter model setup; a setup's own Use / Never choice always comes first.",
  thinking: "Whether the model thinks step by step before answering, when it supports that. Agents start from this and can change it.",
  creativity: "How varied the answers are, from 0 (steady, repeatable) to 2 (very loose). Empty = the model's own default.",
  maxTokens: "The longest answer the model may write, in tokens (about 3/4 of a word each). Empty = the model's own default.",
  ratings: "Your own scores from 0 to 10 for anything you test. They are only used to sort and compare models here.",
  params: "How big the model is, in parameters, e.g. 14B. Bigger is usually smarter but needs more memory.",
  quant: "How much the local file is shrunk, e.g. Q4_K_M. Smaller files fit smaller graphics cards but lose some quality.",
  sizeGb: "How much the model takes to download and roughly how much graphics memory it needs.",
  context: "How much text the model can keep in mind at once, in tokens.",
  fits: "Whether this model fits the graphics card of the computer that runs local models. Your own judgement; the list also works it out from the graphics card memory set at the top of the page.",
  tools: "Whether the model can call tools (look things up, take actions) reliably.",
  vision: "Whether the model can look at pictures.",
  thinkingSupport: "Whether the model can think step by step before it answers, and whether that can be switched off.",
  license: "The licence the model's weights are published under, e.g. Apache 2.0.",
  sourceUrl: "A link to the model's page, e.g. on Hugging Face or Ollama.",
  pullCommand: "The command that downloads the model, typed in a terminal on the computer that runs the model server, e.g. ollama pull qwen3:14b.",
  note: "Anything people here should know about this model: what it is good at, what to avoid, costs.",
  upgrade:
    "Bigger sizes of the same model. A local one is offered when it fits the graphics card memory set above; a cloud one when OpenRouter has hosts that support tool calling.",
  runOptions:
    "Ways this size can run that are not saved yet: on this company's own model server (local) or in the cloud. Adding one opens the form already filled in.",
} as const;
