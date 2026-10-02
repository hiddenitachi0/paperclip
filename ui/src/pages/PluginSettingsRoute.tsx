import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "@/lib/router";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSettings } from "./PluginSettings";

/** Media Studio's settings now live in a Settings tab on its own page. */
const MEDIA_STUDIO_PLUGIN_KEY = "paperclip.media-studio";

/**
 * The per-plugin settings route. Media Studio is sent to its own page so its
 * settings exist in one place; every other plugin keeps the generic page.
 * The plugin list links here by internal id, so look the plugin up first.
 */
export function PluginSettingsRoute() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const isKey = pluginId === MEDIA_STUDIO_PLUGIN_KEY;
  const { data: plugin, isLoading } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId!),
    queryFn: () => pluginsApi.get(pluginId!),
    enabled: !!pluginId && !isKey,
  });

  if (isKey || plugin?.pluginKey === MEDIA_STUDIO_PLUGIN_KEY) {
    return <Navigate to="/media-studio?tab=settings" replace />;
  }
  if (isLoading) return null;
  return <PluginSettings />;
}
