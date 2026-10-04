import { useEffect, useState } from "react";
import { Info, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { usePresentationMode } from "../context/PresentationModeContext";

function TagListEditor({
  label,
  description,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  description: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const trimmed = draft.trim();
    if (!trimmed || values.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold">{label}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm">
          Add
        </Button>
      </form>
      {values.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {values.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs"
            >
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">None yet.</p>
      )}
    </section>
  );
}

export function PresentationModeSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    enabled,
    strict,
    keepList,
    extraMaskedNames,
    extraHiddenPages,
    setEnabled,
    setStrict,
    setKeepList,
    setExtraMaskedNames,
    setExtraHiddenPages,
  } = usePresentationMode();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Presentation mode" },
    ]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Presentation mode</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Mask money, names, emails, phone numbers, addresses and keys on screen while demoing or sharing this
          browser. Toggle it from here, from the account menu, or with Cmd/Ctrl+Shift+P.
        </p>
      </div>

      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-700 dark:text-blue-400" />
        <p className="text-muted-foreground">
          This is purely visual. It changes nothing about data storage or permissions, and agents are completely
          unaffected — they keep reading and writing real data exactly as before. The switch, keep list and other
          settings on this page live only in this browser's local storage and never reach the server.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Presentation mode</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Shows a red "● Presentation mode" badge while on.
            </p>
          </div>
          <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Toggle presentation mode" />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Strict level</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Also masks every large number and percentage, not just amounts next to money words or currency
              symbols.
            </p>
          </div>
          <ToggleSwitch checked={strict} onCheckedChange={setStrict} aria-label="Toggle strict masking" />
        </div>
      </section>

      <TagListEditor
        label="Keep list"
        description="Names that should never be masked, even if they match an extra masked name below — e.g. your own name or the company names you choose."
        placeholder="e.g. Filip, Nordstrand AS"
        values={keepList}
        onChange={setKeepList}
      />

      <TagListEditor
        label="Extra masked names"
        description="Additional person or company names to mask whenever they appear, on top of the built-in email/phone/money/key patterns."
        placeholder="e.g. Kari Nordmann"
        values={extraMaskedNames}
        onChange={setExtraMaskedNames}
      />

      <TagListEditor
        label="Extra hidden pages"
        description="Paths that should always show as fully hidden panels in presentation mode, in addition to the built-in finance, costs and mail surfaces."
        placeholder="e.g. /company/settings/connections"
        values={extraHiddenPages}
        onChange={setExtraHiddenPages}
      />
    </div>
  );
}
