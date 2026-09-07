import { useQuery } from "@tanstack/react-query";
import { DEFAULT_MAX_TURNS_PER_RUN } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { queryKeys } from "../../lib/queryKeys";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import { McpServersJsonField } from "../mcp-servers-field";

// DUR-3943 item 4: the per-agent turn cap is optional. "" (blank) means the
// agent follows the instance-wide setting and the key is dropped from
// adapterConfig (buildAgentUpdatePatch omits undefined entries); 0 is
// treated the same as blank because 0 turns is never a real limit.
export function formatOptionalTurns(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.floor(parsed)) : "";
}

export function parseOptionalTurns(raw: string): number | undefined | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
      <McpServersJsonField isCreate={isCreate} values={values} set={set} config={config} mark={mark} />
    </>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  // Same general-settings query the rest of the UI uses; only read here for
  // the "Instance default: N turns" placeholder.
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      {/* DUR-3943 item 4: blank = the instance-wide "Max turns per run"
          (Settings > Instance settings > General). A number here wins for
          this agent only; clearing the field puts the agent back on the
          instance setting. */}
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            min={0}
            step={1}
            className={inputClass}
            value={values!.maxTurnsPerRun > 0 ? values!.maxTurnsPerRun : ""}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) || 0 })}
            placeholder={`Instance default: ${generalSettings?.maxTurnsPerRun ?? DEFAULT_MAX_TURNS_PER_RUN} turns`}
          />
        ) : (
          <DraftInput
            data-testid="agent-max-turns-per-run"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={formatOptionalTurns(eff("adapterConfig", "maxTurnsPerRun", config.maxTurnsPerRun))}
            onCommit={(v) => {
              const parsed = parseOptionalTurns(v);
              if (parsed !== "invalid") mark("adapterConfig", "maxTurnsPerRun", parsed);
            }}
            className={inputClass}
            placeholder={`Instance default: ${generalSettings?.maxTurnsPerRun ?? DEFAULT_MAX_TURNS_PER_RUN} turns`}
          />
        )}
      </Field>
    </>
  );
}
