/**
 * DUR-4302 (paperless-ngx Phase 1 plumbing): the feature flag that keeps
 * reading documents off by default, same "no row or missing key means off"
 * shape as DUR-4127's video-storylines flag
 * (server/src/services/video-storyline-settings.ts,
 * VIDEO_STORYLINES_SETTINGS_KEY). A company's `paperless_ngx` connection can
 * be configured and Test'ed while this flag is off; only reads (once a
 * "documents" plugin and its agent tools exist -- a separate, later slice)
 * stay refused until a board owner/admin explicitly turns it on.
 *
 * Unlike media-studio, no "documents" plugin is installed in this fork yet --
 * see server/src/services/documents-settings.ts's doc comment.
 */
export const DOCUMENTS_PLUGIN_KEY = "paperclip.documents";

export const DOCUMENTS_SETTINGS_KEY = "documentsEnabled";
