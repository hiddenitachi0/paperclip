import { z } from "zod";

/**
 * The shape of a `site_login` secret's value (DUR-4019 added the kind;
 * DUR-4037 is the first and only reader). Stored the same way a
 * `payment_card_single_use` secret is: one encrypted JSON blob, never a plain
 * string, so `domain` -- the field the server checks a page's registrable
 * domain against before filling anything -- travels with the credential it
 * gates rather than living in some separate, editable metadata column that
 * could drift out of sync with it.
 */
export const siteLoginSecretValueSchema = z
  .object({
    domain: z.string().trim().min(1).max(253),
    username: z.string().trim().min(1).max(500),
    password: z.string().min(1).max(2000),
  })
  .strict();

export type SiteLoginSecretValue = z.infer<typeof siteLoginSecretValueSchema>;
