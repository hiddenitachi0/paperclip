import { z } from "zod";

/**
 * DUR-3995: shape of an Anthropic API key (the one from console.anthropic.com,
 * not a `claude setup-token` subscription token). Deliberately loose about
 * what follows the prefix — Anthropic has changed the middle part before, and
 * a key Paperclip refuses for looking unfamiliar is worse than one Claude
 * itself rejects with a clear message when the operator presses Test.
 */
export const ANTHROPIC_API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * The field is called `apiKey`, not `key`: the HTTP logger redacts a body
 * field by name, and `key` was not on that list, so a failed save used to put
 * the pasted key in server.log in plain text (DUR-3995 review finding 1).
 */
export const saveInstanceServerAnthropicKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, "Paste the key first.")
    .max(4096)
    .refine((value) => ANTHROPIC_API_KEY_PATTERN.test(value), {
      message:
        "That does not look like a Claude API key. It should start with sk-ant- and be one long line with no spaces.",
    }),
});

export type SaveInstanceServerAnthropicKeyInput = z.infer<typeof saveInstanceServerAnthropicKeySchema>;
