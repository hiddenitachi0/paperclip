import { z } from "zod";

/** Shape of a `claude setup-token` token: one long line, no spaces. */
export const CLAUDE_OAUTH_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;

export const saveInstanceClaudeAuthTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, "Paste the token first.")
    .max(4096)
    .refine((value) => CLAUDE_OAUTH_TOKEN_PATTERN.test(value), {
      message:
        "That does not look like a Claude subscription token. It should start with sk-ant-oat01- and be one long line with no spaces.",
    }),
});

export const submitInstanceClaudeSignInCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Paste the code first.")
    .max(512)
    .refine((value) => !/[\s\x00-\x1f\x7f]/.test(value), {
      message: "Paste the whole code exactly as Claude shows it (one line, no spaces).",
    }),
});

export type SaveInstanceClaudeAuthTokenInput = z.infer<typeof saveInstanceClaudeAuthTokenSchema>;
export type SubmitInstanceClaudeSignInCodeInput = z.infer<typeof submitInstanceClaudeSignInCodeSchema>;
