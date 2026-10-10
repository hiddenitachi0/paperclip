import type { Db } from "@paperclipai/db";
import { helperService, type CompanyModelCallResult, type HelperServiceOptions } from "./helper.js";
import type { LaneAImage } from "./lane-a-providers.js";
import type { VideoStorylineActor } from "./video-storylines.js";

/**
 * Storyline Phase 0 (design 2.11): the AI director and the transition writer
 * run on the company's OWN model -- the helper's default saved model
 * (Company settings → General → Helper) with the company's own key -- never
 * on the server-wide Anthropic key. A company without a usable model gets a
 * plain sentence saying so (HttpError 503), which the editor shows as is.
 */

export const STORYLINE_WRITER_NO_MODEL_MESSAGE =
  "The AI director writes with this company's own AI model, and none is set up yet. A company owner or admin can pick one under Company settings → General → Helper (the helper's default model is used). Paperclip's own key is never used for this.";

export const STORYLINE_DIRECTOR_BILLING_CODE = "video_storyline_director";
export const STORYLINE_TRANSITION_BILLING_CODE = "video_storyline_transition_writer";

export interface StorylineWriteInput {
  system: string;
  user: string;
  maxTokens: number;
  images?: LaneAImage[];
  billingCode?: string;
  /** A specific saved model (and its key), e.g. Media Studio's picture-reading model. */
  entryId?: string | null;
  keySecretId?: string | null;
  keyConsumerId?: string | null;
  purpose?: string;
  noModelMessage?: string;
}

export function storylineCompanyModel(db: Db, options: HelperServiceOptions = {}) {
  const helper = helperService(db, options);

  async function write(companyId: string, actor: Pick<VideoStorylineActor, "actorType" | "actorId"> | null, input: StorylineWriteInput): Promise<CompanyModelCallResult> {
    return helper.callCompanyModel({
      companyId,
      purpose: input.purpose ?? "The AI director",
      noModelMessage: input.noModelMessage ?? STORYLINE_WRITER_NO_MODEL_MESSAGE,
      billingCode: input.billingCode ?? STORYLINE_DIRECTOR_BILLING_CODE,
      system: input.system,
      user: input.user,
      images: input.images,
      maxTokens: input.maxTokens,
      actorUserId: actor?.actorType === "user" ? actor.actorId : null,
      entryId: input.entryId ?? null,
      keySecretId: input.keySecretId ?? null,
      keyConsumerId: input.keyConsumerId ?? null,
    });
  }

  return {
    write,
    /** Just the text (the director's existing parsers take a string). */
    async writeText(companyId: string, actor: Pick<VideoStorylineActor, "actorType" | "actorId"> | null, input: StorylineWriteInput): Promise<string> {
      return (await write(companyId, actor, input)).text;
    },
    resolveEntry: helper.resolveCompanyModelEntry,
    canSeePictures: helper.companyModelCanSeePictures,
  };
}
