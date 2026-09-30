export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";

// DUR-4127: the video provider HTTP clients, exported for server/src's
// video-storyline render service. These are plain, ctx-free classes (a
// secret string + an injected fetch) -- reusing them directly avoids
// re-implementing the same Fal/Sogni request shapes server-side, without
// pulling any plugin-worker/ctx surface into the trusted server process. See
// the DUR-4127 PR description for why this is a deliberate first-party
// reuse, not a plugin-sandbox bypass: this package is trusted, in-repo code
// reviewed the same way server/src is, and these classes have zero ctx
// dependency.
export { FalVideoProvider, SogniVideoProvider, FAL_DEFAULT_IMAGE_TO_VIDEO_MODEL, FAL_DEFAULT_VIDEO_MODEL } from "./video.js";
export type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaJobResult, MediaPollOutcome } from "./media-jobs-types.js";
export type { FetchImpl } from "./providers.js";
