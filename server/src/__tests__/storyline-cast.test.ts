import { describe, expect, it } from "vitest";
import {
  assignVideoCastIds,
  detectVideoShotCast,
  mergeScriptCharactersIntoCast,
  readVideoStorylineCast,
  updateVideoStorylineCastSchema,
  videoShotCast,
  type VideoStorylineCastMember,
} from "@paperclipai/shared";
import { SOGNI_EDIT_MODELS } from "../../../packages/plugins/media-studio/src/sogni.js";
import { FAL_EDIT_MAX_REFERENCES } from "../../../packages/plugins/media-studio/src/anchors.js";
import { IDENTITY_DEFAULT_SOGNI_MODEL, IDENTITY_EXTRA_SLOT_SOGNI_MODEL } from "../../../packages/plugins/media-studio/src/identity.js";
import { detectShotCast as uiDetectShotCast, scriptCharacterSuggestions, shotCastLabels } from "../../../packages/plugins/media-studio/src/ui/storyline-cast.js";
import { sogniStorageFetch } from "../services/image-provider-clients.ts";
import {
  CAST_DEFAULT_FAL_MODEL,
  CAST_DEFAULT_SOGNI_MODEL,
  CAST_EXTRA_SLOT_SOGNI_MODEL,
  CAST_FAL_EDIT_SLOTS,
  CAST_SOGNI_EDIT_SLOTS,
  castPeople,
  castPictureRefusal,
  castPromptLine,
  castVideoPictures,
  dataUriSha256,
  normalizeCastIdentity,
  planCastStill,
  type CastIdentity,
  type CastPerson,
} from "../services/storyline-cast.ts";
import { FalVideoProvider, SogniVideoProvider, buildFalElements, falVideoModelTakesElements } from "../services/video-provider-clients.ts";

/**
 * Storyline Cast: the script's characters linked to saved Media Studio
 * identities. Pure rules here (no database, no paid call: every provider
 * call goes to a stub).
 */

function identity(over: Partial<CastIdentity> & { id: string; name: string }): CastIdentity {
  return {
    nickname: null,
    sheet: {},
    crops: [
      { role: "face", fileId: `${over.id}-face` },
      { role: "body", fileId: `${over.id}-body` },
    ],
    originalFileId: `${over.id}-original`,
    canonicalFileId: null,
    canonicalAsReference: false,
    preferredModels: { sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: null },
    loraBaseModel: null,
    trainedIdentities: [],
    ...over,
  };
}

function member(id: string, name: string, identityId: string | null, nickname: string | null = null): VideoStorylineCastMember {
  return { id, name, nickname, description: null, identityId };
}

function person(id: string, name: string, over: Partial<CastIdentity> = {}): CastPerson {
  return { member: member(`c-${id}`, name, id), identity: identity({ id, name, ...over }) };
}

const basePlan = { lookIds: [] as string[], lookRoles: [] as never[], extraIds: [] as string[], cap: 4, safeContentFilter: true, pickedModel: null };

describe("cast storage shape", () => {
  it("gives new members ids, keeps old ones, refuses a name twice", () => {
    const members = assignVideoCastIds([{ id: "c1", name: "Maja" }, { name: "Bo" }, { name: "Ada", identityId: " id-a " }]);
    expect(members.map((m) => [m.id, m.name, m.identityId])).toEqual([
      ["c1", "Maja", null],
      ["c2", "Bo", null],
      ["c3", "Ada", "id-a"],
    ]);
    expect(() => assignVideoCastIds([{ name: "Maja" }, { name: "maja" }])).toThrow(/in the cast twice/);
    expect(updateVideoStorylineCastSchema.safeParse({ members: [{ name: "X", extra: 1 }] }).success).toBe(false);
  });

  it("reads only what it understands; shot picks of unknown members are dropped", () => {
    const cast = readVideoStorylineCast({
      providerId: "sogni",
      cast: [{ id: "c1", name: "Maja", identityId: "i1" }, { id: "c1", name: "Dup" }, { name: "no id" }],
      shotCast: { s1: ["c1", "ghost"], s2: "nonsense" },
    });
    expect(cast.members).toEqual([member("c1", "Maja", "i1")]);
    expect(cast.shotCast).toEqual({ s1: ["c1"] });
    expect(readVideoStorylineCast(null)).toEqual({ members: [], shotCast: {} });
  });

  it("a script import adds its characters once, unlinked, after the existing cast", () => {
    const existing = [member("c1", "Maja", "i1", "Mum")];
    const merged = mergeScriptCharactersIntoCast(existing, [
      { name: "Maja", description: "already there" },
      { name: "mum", description: "nickname of Maja" },
      { name: "Bo", description: "a border collie" },
    ]);
    expect(merged.map((m) => [m.id, m.name, m.identityId, m.description])).toEqual([
      ["c1", "Maja", "i1", null],
      ["c2", "Bo", null, "a border collie"],
    ]);
  });
});

describe("who is in a shot", () => {
  const members = [member("c1", "Maja", "i-maja", "Mum"), member("c2", "Bo", null), member("c3", "Al", null)];
  const names = { "i-maja": { name: "Maja Berg", nickname: "MB" } };

  it("finds names, nicknames and the linked person's name, as whole words in any case", () => {
    expect(detectVideoShotCast("Mum hugs bo by the door", members, names)).toEqual(["c1", "c2"]);
    expect(detectVideoShotCast("MAJA BERG walks in", members, names)).toEqual(["c1"]);
    expect(detectVideoShotCast("Bonnie and Albert", members, names)).toEqual([]);
    // Two-letter names still count as whole words; one-letter names never do.
    expect(detectVideoShotCast("Al waves", members, names)).toEqual(["c3"]);
  });

  it("a person's own pick wins over the description; camera notes count too", () => {
    const cast = { members, shotCast: { s1: ["c2"] } };
    expect(videoShotCast({ id: "s1", prompt: "Maja alone" }, cast, names)).toEqual({ castIds: ["c2"], picked: true });
    expect(videoShotCast({ id: "s2", prompt: "A wide shot", cameraNotes: "slow push in on Bo" }, cast, names)).toEqual({ castIds: ["c2"], picked: false });
  });

  it("the page's copy finds the same people as the server", () => {
    const identities = [{ id: "i-maja", name: "Maja Berg", nickname: "MB" }];
    for (const text of ["Mum hugs bo", "MAJA BERG walks in", "mb and Al", "nobody here", "Bo-Bo runs"]) {
      expect(uiDetectShotCast(text, members, identities)).toEqual(detectVideoShotCast(text, members, names));
    }
    expect(shotCastLabels([{ id: "s1", orderIndex: 0, prompt: "Maja and Bo", cameraNotes: null }], { members, shotCast: {} }, identities)).toEqual({
      s1: ["Maja (saved person)", "Bo"],
    });
  });

  it("suggests characters from an imported script's character list that are not in the cast", () => {
    const notes = ["Characters:\n- Ada: a woman in her 60s\n- Bo: a collie\n\nRainy coast", null];
    expect(scriptCharacterSuggestions(notes, [member("c1", "ada", null)])).toEqual([{ name: "Bo", description: "a collie" }]);
  });
});

describe("saved people: consent, age check, links", () => {
  it("never reads an identity without both confirmations", () => {
    const raw = { id: "i1", name: "Maja", crops: [{ role: "face", fileId: "f" }] };
    expect(normalizeCastIdentity({ ...raw, consent: { likeness: true, adult: false } })).toBeNull();
    expect(normalizeCastIdentity({ ...raw, consent: { likeness: true } })).toBeNull();
    expect(normalizeCastIdentity({ ...raw, consent: { likeness: true, adult: true } })?.crops).toEqual([{ role: "face", fileId: "f" }]);
  });

  it("refuses a picture the age check flagged, by file or by its bytes", () => {
    const uri = `data:image/png;base64,${Buffer.from("maja-face").toString("base64")}`;
    const hash = dataUriSha256(uri)!;
    expect(castPictureRefusal([{ fileId: "f1", dataUri: uri, personName: "Maja" }], { fileIds: new Set(), hashes: new Set() })).toBeNull();
    expect(castPictureRefusal([{ fileId: "f1", dataUri: uri, personName: "Maja" }], { fileIds: new Set(["f1"]), hashes: new Set() })).toMatch(/Maja's pictures did not pass/);
    expect(castPictureRefusal([{ fileId: "f2", dataUri: uri, personName: "Maja" }], { fileIds: new Set(), hashes: new Set([hash]) })).toMatch(/age check/);
  });

  it("a member linked to a person who is gone is made from the description, with a plain note", () => {
    const { people, notes } = castPeople(["c1", "c2"], [member("c1", "Maja", "gone"), member("c2", "Bo", null)], []);
    expect(people).toEqual([]);
    expect(notes[0]).toMatch(/Maja is linked to a saved person who no longer exists/);
  });
});

describe("storyboard pictures with cast", () => {
  it("keeps the slot tables in step with the plugin", () => {
    expect(CAST_SOGNI_EDIT_SLOTS).toEqual(SOGNI_EDIT_MODELS);
    expect(CAST_FAL_EDIT_SLOTS).toEqual(FAL_EDIT_MAX_REFERENCES);
    expect(CAST_DEFAULT_SOGNI_MODEL).toBe(IDENTITY_DEFAULT_SOGNI_MODEL);
    expect(CAST_EXTRA_SLOT_SOGNI_MODEL).toBe(IDENTITY_EXTRA_SLOT_SOGNI_MODEL);
  });

  it("Sogni, one person: krea-identity-edit, face as picture 1 and body as picture 2; the look's face left out, its other pictures do not fit", () => {
    const plan = planCastStill({ ...basePlan, people: [person("maja", "Maja")], service: "sogni", lookIds: ["look-face", "look-bg"], lookRoles: ["face", "background"] });
    expect(plan.model).toBe("krea-identity-edit");
    expect(plan.ids).toEqual(["maja-face", "maja-body"]);
    expect(plan.roles).toEqual(["face", "body"]);
    expect(plan.notes.join(" ")).toMatch(/look's face picture was left out/);
    expect(plan.notes.join(" ")).toMatch(/1 other picture was left out/);
  });

  it("Sogni with a picked 3-slot model: face, body, then the look's picture after the identity's", () => {
    const plan = planCastStill({ ...basePlan, people: [person("maja", "Maja")], service: "sogni", pickedModel: "qwen", lookIds: ["look-bg"], lookRoles: ["background"], extraIds: ["storyline-pic"] });
    expect(plan.model).toBe("qwen");
    expect(plan.ids).toEqual(["maja-face", "maja-body", "look-bg"]);
    expect(plan.owners).toEqual(["Maja", "Maja", null]);
  });

  it("a picked model that cannot use pictures is replaced by the identity's model, with a note", () => {
    const plan = planCastStill({ ...basePlan, people: [person("maja", "Maja")], service: "sogni", pickedModel: "z-turbo" });
    expect(plan.model).toBe("krea-identity-edit");
    expect(plan.notes.join(" ")).toMatch(/cannot make a picture from reference pictures/);
  });

  it("two people: both faces first; nothing pinned moves to the extra-slot model; a plain warning", () => {
    const plan = planCastStill({ ...basePlan, people: [person("maja", "Maja"), person("bo", "Bo")], service: "sogni" });
    expect(plan.model).toBe("qwen");
    expect(plan.ids).toEqual(["maja-face", "bo-face", "maja-body"]);
    expect(plan.roles).toEqual(["face", "face", "body"]);
    expect(plan.notes.join(" ")).toMatch(/2 people are in this shot/);
    expect(castPromptLine(plan, "sogni")).toBe("Maja is the person in picture 1; Bo is the person in picture 2. Keep each person's own face; never mix their faces up.");
  });

  it("three people on a pinned 2-slot model: two faces fit, the third is named in a plain note", () => {
    const plan = planCastStill({ ...basePlan, people: [person("a", "Ada"), person("b", "Bo"), person("c", "Cy")], service: "sogni", pickedModel: "krea-identity-edit" });
    expect(plan.ids).toEqual(["a-face", "b-face"]);
    expect(plan.notes.join(" ")).toMatch(/only Ada and Bo were sent as a face picture; Cy was made from the description only/);
  });

  it("Fal.ai: the identity's preferred editing model, else FLUX.2 pro edit; the storyboard's cap of 4", () => {
    const plain = planCastStill({ ...basePlan, people: [person("maja", "Maja")], service: "fal", lookIds: ["l1", "l2", "l3"], lookRoles: ["background", "style", "outfit"] });
    expect(plain.model).toBe(CAST_DEFAULT_FAL_MODEL);
    expect(plain.ids).toEqual(["maja-face", "maja-body", "l1", "l2"]);
    const preferred = planCastStill({ ...basePlan, people: [person("maja", "Maja", { preferredModels: { sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: "fal-ai/nano-banana-2/edit" } })], service: "fal" });
    expect(preferred.model).toBe("fal-ai/nano-banana-2/edit");
    expect(castPromptLine(preferred, "fal")).toBe("Maja is the person in image 1.");
  });

  it("the canonical picture goes after the body when the identity asks for it", () => {
    const plan = planCastStill({ ...basePlan, people: [person("maja", "Maja", { canonicalFileId: "maja-canon", canonicalAsReference: true })], service: "fal" });
    expect(plan.ids).toEqual(["maja-face", "maja-body", "maja-canon"]);
  });

  it("the identity's Sogni LoRA only with the filter off (a look an owner saved), on a Krea 2 model, for one person", () => {
    const trained = [{ id: "t1", provider: "sogni-lora" as const, ref: "personal-maja", triggerWord: "majaberg_person", strength: 0.7, status: "ready" }];
    const maja = person("maja", "Maja", { trainedIdentities: trained, loraBaseModel: "krea-2" });
    expect(planCastStill({ ...basePlan, people: [maja], service: "sogni" }).lora).toBeNull();
    expect(planCastStill({ ...basePlan, people: [maja], service: "sogni" }).notes.join(" ")).toMatch(/content filter off/);
    expect(planCastStill({ ...basePlan, people: [maja], service: "sogni", safeContentFilter: false }).lora).toEqual({ id: "personal-maja", strength: 0.7, triggerWord: "majaberg_person" });
    expect(planCastStill({ ...basePlan, people: [maja], service: "sogni", safeContentFilter: false, pickedModel: "qwen" }).notes.join(" ")).toMatch(/made for Krea 2 models/);
    expect(planCastStill({ ...basePlan, people: [maja, person("bo", "Bo")], service: "sogni", safeContentFilter: false, pickedModel: "gpt-image-2" }).lora).toBeNull();
  });
});

describe("video clips with cast", () => {
  const face = (n: string) => `data:image/png;base64,${Buffer.from(`${n}-face`).toString("base64")}`;
  const canon = (n: string) => `data:image/png;base64,${Buffer.from(`${n}-canon`).toString("base64")}`;

  it("each person's face crop first, then the canonical render, then the body", () => {
    expect(castVideoPictures([person("maja", "Maja", { canonicalFileId: "maja-canon" }), person("bo", "Bo")])).toEqual([
      { name: "Maja", fileIds: ["maja-face", "maja-canon", "maja-body"] },
      { name: "Bo", fileIds: ["bo-face", "bo-body"] },
    ]);
  });

  it("Fal Kling v3: one element per person, then one for the other pictures", () => {
    const elements = buildFalElements({
      characters: [{ name: "Maja", images: [face("maja"), canon("maja")] }, { name: "Bo", images: [face("bo")] }],
      referenceImages: [face("maja"), face("bo"), canon("maja"), "data:image/png;base64,bG9vaw=="],
    });
    expect(elements).toEqual([
      { frontal_image_url: face("maja"), reference_image_urls: [canon("maja")] },
      { frontal_image_url: face("bo"), reference_image_urls: [face("bo")] },
      { frontal_image_url: "data:image/png;base64,bG9vaw==", reference_image_urls: ["data:image/png;base64,bG9vaw=="] },
    ]);
    expect(falVideoModelTakesElements("fal-ai/kling-video/v3/pro/image-to-video")).toBe(true);
    expect(falVideoModelTakesElements("fal-ai/kling-video/v1.6/standard/image-to-video")).toBe(false);
  });

  async function falStart(model: string | undefined) {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ request_id: "r1" }), { status: 200 });
    };
    await new FalVideoProvider("k", fetch).start({
      kind: "video",
      prompt: "Maja meets Bo",
      model,
      startImage: "data:image/png;base64,c3RpbGw=",
      referenceImages: [face("maja"), face("bo")],
      characters: [{ name: "Maja", images: [face("maja")] }, { name: "Bo", images: [face("bo")] }],
    });
    return sent[0]!;
  }

  it("Fal: the approved picture stays the start frame; references go as elements on Kling v3 (default or pinned), never on a model without them", async () => {
    const auto = await falStart(undefined);
    expect(auto.url).toContain("kling-video/v3/pro/image-to-video");
    expect(auto.body.start_image_url).toBe("data:image/png;base64,c3RpbGw=");
    expect((auto.body.elements as unknown[]).length).toBe(2);
    const pinnedV3 = await falStart("fal-ai/kling-video/v3/standard/image-to-video");
    expect(pinnedV3.body.start_image_url).toBe("data:image/png;base64,c3RpbGw=");
    expect((pinnedV3.body.elements as unknown[]).length).toBe(2);
    const old = await falStart("fal-ai/kling-video/v1.6/standard/image-to-video");
    expect(old.body.image_url).toBe("data:image/png;base64,c3RpbGw=");
    expect(old.body.elements).toBeUndefined();
  });

  function sogniStub() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let uploads = 0;
    const apiFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/v2/image/uploadUrl")) {
        uploads += 1;
        return new Response(JSON.stringify({ data: { url: `https://bucket.s3-accelerate.amazonaws.com/up-${uploads}`, fields: { key: `k-${uploads}` } } }));
      }
      if (url.includes("/v2/image/downloadUrl")) return new Response(JSON.stringify({ data: { downloadUrl: `https://bucket.s3-accelerate.amazonaws.com/ref-${uploads}.png` } }));
      if (url.endsWith("/v1/creative-agent/workflows")) return new Response(JSON.stringify({ data: { workflow: { workflowId: "wf" } } }), { status: 201 });
      return new Response("{}", { status: 404 });
    };
    const uploaded: Buffer[] = [];
    const transfer = sogniStorageFetch(async (_url, init) => {
      if (init?.method === "POST") uploaded.push(Buffer.from(init.body as Buffer));
      return new Response(null, { status: 204 });
    });
    const step = () => JSON.parse(String(calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows"))!.init!.body)).input.steps[0];
    return { apiFetch, transfer, step, uploaded };
  }

  it("Sogni: an image-to-video model gets only the start frame; a reference-to-video model gets the start frame then each face", async () => {
    const input = {
      kind: "video" as const,
      prompt: "Maja meets Bo",
      startImage: face("still"),
      referenceImages: [face("maja"), face("bo")],
      characters: [{ name: "Maja", images: [face("maja")] }, { name: "Bo", images: [face("bo")] }],
      durationSeconds: 5,
    };
    const i2v = sogniStub();
    await new SogniVideoProvider({ apiKey: "k", apiFetch: i2v.apiFetch, transferFetch: i2v.transfer }).start({ ...input, model: "ltx23" });
    expect(i2v.step()).toMatchObject({ toolName: "animate_photo", arguments: { sourceImageIndex: -1 } });
    expect(i2v.uploaded).toHaveLength(1);
    expect(i2v.uploaded[0]!.includes(Buffer.from("still-face"))).toBe(true);

    const r2v = sogniStub();
    await new SogniVideoProvider({ apiKey: "k", apiFetch: r2v.apiFetch, transferFetch: r2v.transfer }).start({ ...input, model: "seedance-2-0-fast" });
    expect(r2v.step()).toMatchObject({ toolName: "generate_video", arguments: { referenceImageIndices: [-1, -2, -3] } });
    expect(r2v.uploaded.map((b) => ["still-face", "maja-face", "bo-face"].find((n) => b.includes(Buffer.from(n))))).toEqual(["still-face", "maja-face", "bo-face"]);
  });
});
