import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  JsonSchemaForm,
  validateJsonSchemaForm,
  getDefaultValues,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";

// ---------------------------------------------------------------------------
// PluginConfigForm — auto-generated form for instanceConfigSchema
// ---------------------------------------------------------------------------

export interface PluginConfigFormProps {
  pluginId: string;
  schema: JsonSchemaNode;
  initialValues?: Record<string, unknown>;
  isLoading?: boolean;
  /** Current plugin lifecycle status — "Test Configuration" only available when `ready`. */
  pluginStatus?: string;
  /** Whether the plugin worker implements `validateConfig`. */
  supportsConfigTest?: boolean;
}

/**
 * Inner component that manages form state, validation, save, and "Test Configuration"
 * for the auto-generated plugin config form.
 *
 * Separated from PluginSettings to isolate re-render scope — only the form
 * re-renders on field changes, not the entire page.
 */
export function PluginConfigForm({ pluginId, schema, initialValues, isLoading, pluginStatus, supportsConfigTest }: PluginConfigFormProps) {
  const queryClient = useQueryClient();

  // Form values: start with saved values, fall back to schema defaults
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  }));

  // Sync when saved config loads asynchronously — only on first load so we
  // don't overwrite in-progress user edits if the query refetches (e.g. on
  // window focus).
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    if (initialValues && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      setValues({
        ...getDefaultValues(schema),
        ...initialValues,
      });
    }
  }, [initialValues, schema]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Dirty tracking: compare against initial values
  const isDirty = JSON.stringify(values) !== JSON.stringify({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.saveConfig(pluginId, configJson),
    onSuccess: () => {
      setSaveMessage({ type: "success", text: "Configuration saved." });
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config(pluginId) });
      // Clear success message after 3s
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message || "Failed to save configuration." });
    },
  });

  // Test configuration mutation
  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.testConfig(pluginId, configJson),
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", text: "Configuration test passed." });
      } else {
        setTestResult({ type: "error", text: result.message || "Configuration test failed." });
      }
    },
    onError: (err: Error) => {
      setTestResult({ type: "error", text: err.message || "Configuration test failed." });
    },
  });

  const handleChange = useCallback((newValues: Record<string, unknown>) => {
    setValues(newValues);
    // Clear field-level errors as the user types
    setErrors({});
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(() => {
    // Validate before saving
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    saveMutation.mutate(values);
  }, [schema, values, saveMutation]);

  const handleTestConnection = useCallback(() => {
    // Validate before testing
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setTestResult(null);
    testMutation.mutate(values);
  }, [schema, values, testMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <JsonSchemaForm
        schema={schema}
        values={values}
        onChange={handleChange}
        errors={errors}
        disabled={saveMutation.isPending}
      />

      {/* Status messages */}
      {saveMessage && (
        <div
          className={`text-sm p-2 rounded border ${
            saveMessage.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {saveMessage.text}
        </div>
      )}

      {testResult && (
        <div
          className={`text-sm p-2 rounded border ${
            testResult.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {testResult.text}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          size="sm"
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Configuration"
          )}
        </Button>
        {pluginStatus === "ready" && supportsConfigTest && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Configuration"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Self-loading version of the settings form for plugins that show their own
 * settings inside their own page (offered to plugin UIs as `PluginConfigForm`).
 * Loads the plugin and its saved values, then renders the same form the
 * Plugins settings page uses -- one form, no second copy.
 */
export function PluginConfigPanel({ pluginId }: { pluginId: string }) {
  const { data: plugin, isLoading: pluginLoading } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId),
    queryFn: () => pluginsApi.get(pluginId),
  });
  const schema = plugin?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  const hasSchema = !!schema?.properties && Object.keys(schema.properties).length > 0;
  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId),
    queryFn: () => pluginsApi.getConfig(pluginId),
    enabled: hasSchema,
  });

  if (pluginLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings...
      </div>
    );
  }
  if (!plugin || !hasSchema) {
    return <p className="text-sm text-muted-foreground">There are no settings to change here.</p>;
  }
  return (
    <PluginConfigForm
      pluginId={pluginId}
      schema={schema!}
      initialValues={configData?.configJson}
      isLoading={configLoading}
      pluginStatus={plugin.status}
      supportsConfigTest={(plugin as unknown as { supportsConfigTest?: boolean }).supportsConfigTest === true}
    />
  );
}
