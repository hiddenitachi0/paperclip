import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Briefcase } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Job } from "../../api/jobs";

/**
 * Picker over a company's jobs. Only ever shows `name`/`description` —
 * never the server-derived slug/key (DUR-114/DUR-115 hard rule).
 */
export function JobPicker({
  jobs,
  value,
  onChange,
  disabled,
  placeholder = "No job",
}: {
  jobs: Job[];
  value: string | null;
  onChange: (jobId: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = jobs.find((job) => job.id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          disabled={disabled}
        >
          <Briefcase className="h-3 w-3 text-muted-foreground" />
          {selected ? selected.name : placeholder}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start">
        <button
          className={cn(
            "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
            value === null && "bg-accent",
          )}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          No job
        </button>
        {jobs.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No jobs set up for this company yet.
          </p>
        ) : (
          jobs.map((job) => (
            <button
              key={job.id}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                job.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(job.id);
                setOpen(false);
              }}
            >
              <span className="font-medium">{job.name}</span>
              {job.description ? (
                <span className="line-clamp-1 text-muted-foreground">{job.description}</span>
              ) : null}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
