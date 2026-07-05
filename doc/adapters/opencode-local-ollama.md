# `opencode_local` adapter → local Ollama endpoint

How to point an agent on the `opencode_local` adapter at a self-hosted
[Ollama](https://ollama.com) model instead of a hosted provider (Anthropic/OpenAI/etc).
No core edits — this is config only, using the adapter's existing env-driven gateway
routing (`PAPERCLIP_OPENCODE_PROVIDERS` / `PAPERCLIP_OPENCODE_SMALL_MODEL`,
`packages/adapters/opencode-local/src/server/runtime-config.ts`), the same mechanism used
for LiteLLM/OpenRouter/Portkey/corporate-proxy gateways.

## Why this works

OpenCode only resolves `--model provider/model` when that model is registered under a
provider's `models` map, and `OPENCODE_ALLOW_ALL_MODELS` does not bypass that lookup. Ollama
exposes an OpenAI-compatible endpoint (`/v1/chat/completions`) out of the box, so it can be
registered as a custom OpenCode provider via the `@ai-sdk/openai-compatible` npm provider,
pointed at Ollama's local base URL.

## 1. Install Ollama and pull a model

```bash
curl -fsSL https://ollama.com/install.sh | sh   # installs the ollama binary + systemd service
ollama pull qwen2.5:0.5b                        # or any model you've pulled locally
```

Confirm the OpenAI-compatible endpoint responds:

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"say PONG"}]}'
```

## 2. Configure the agent's `opencode_local` adapter env

Set these on the agent (or adapter config `env` block — same keys the adapter already reads
from the run env or `process.env`):

| Env var | Value | Purpose |
|---|---|---|
| `PAPERCLIP_OPENCODE_PROVIDERS` | JSON object (below) | Registers `ollama` as a custom OpenCode provider pointed at the local Ollama server |
| `PAPERCLIP_OPENCODE_SMALL_MODEL` | `ollama/qwen2.5:0.5b` | Pins OpenCode's auxiliary/title-gen model to the same local model, so it doesn't fall back to a hosted default (e.g. `claude-haiku-*`) the local box can't serve |
| `OPENCODE_ALLOW_ALL_MODELS` | `true` | Skips the adapter's `opencode models` availability probe — needed because a custom provider's models aren't returned by the discovery probe the same way built-in provider models are |

`PAPERCLIP_OPENCODE_PROVIDERS` value:

```json
{
  "ollama": {
    "npm": "@ai-sdk/openai-compatible",
    "options": {
      "baseURL": "http://127.0.0.1:11434/v1",
      "apiKey": "ollama"
    },
    "models": {
      "qwen2.5:0.5b": {}
    }
  }
}
```

(`apiKey` can be any non-empty string — Ollama doesn't check it. Add more entries under
`models` for every local model you want selectable. If Ollama runs on another host/port,
change `baseURL` accordingly — e.g. a Tailscale address for a shared GPU box.)

## 3. Set the agent's model

In the agent's `opencode_local` adapter config, set:

```json
{ "model": "ollama/qwen2.5:0.5b" }
```

`provider/model` must match a key you registered under `PAPERCLIP_OPENCODE_PROVIDERS.ollama.models`.

## Verification performed

Ran the actual `opencode` CLI (the same binary + `run --format json --model <id>` invocation
`packages/adapters/opencode-local/src/server/execute.ts` builds) against a real local Ollama
server (v0.31.1, model `qwen2.5:0.5b`) using an `opencode.json` with the exact shape
`prepareOpenCodeRuntimeConfig` (in `runtime-config.ts`) produces from the env vars above:

```json
{
  "permission": { "external_directory": "allow" },
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "ollama" },
      "models": { "qwen2.5:0.5b": {} }
    }
  },
  "small_model": "ollama/qwen2.5:0.5b"
}
```

Result: `exitCode: 0`, real token usage reported, real completion text returned (asked for
`PONG`, got `PONG!`/`PONG` back across repeat runs) — confirming an agent on this adapter
config can complete a run entirely against a self-hosted Ollama model, no hosted-provider
keys involved.
