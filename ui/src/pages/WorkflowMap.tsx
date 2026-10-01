import { useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Briefcase, GitFork, Repeat, ShieldCheck } from "lucide-react";
import type { RoutineListItem } from "@paperclipai/shared";
import { pipelinesApi, type PipelineListItem, type PipelineStage } from "../api/pipelines";
import { routinesApi } from "../api/routines";
import { approvalsApi } from "../api/approvals";
import { jobsApi, type Job } from "../api/jobs";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";

/**
 * Phase 0 (DUR-4209): read-only map of a company's automation. Positions are
 * computed with a simple deterministic column/row layout rather than a
 * layout library — there's nothing to edit yet, so a stable, predictable
 * placement beats a fancier auto-layout.
 */

const STAGE_WIDTH = 220;
const STAGE_GAP_X = 60;
const PIPELINE_ROW_HEIGHT = 150;
const CARD_WIDTH = 240;
const CARD_GAP_X = 32;
const CARD_GAP_Y = 24;
const CARDS_PER_ROW = 3;

const STAGE_KIND_LABEL: Record<string, string> = {
  working: "In progress",
  review: "Needs review",
  done: "Done",
  cancelled: "Cancelled",
};

const TRIGGER_KIND_LABEL: Record<string, string> = {
  schedule: "Runs on a schedule",
  webhook: "Starts from a webhook",
  api: "Started manually or by another system",
};

const APPROVAL_TYPE_LABEL: Record<string, string> = {
  hire_agent: "Hiring a new agent",
  approve_ceo_strategy: "CEO strategy",
  budget_override_required: "Budget override",
  request_board_approval: "Board approval request",
  credential_request: "Credential request",
};

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function stageAutomationRoutineId(config: Record<string, unknown> | null | undefined): string | null {
  const onEnter = config?.onEnter;
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) return null;
  const record = onEnter as Record<string, unknown>;
  return record.type === "run_routine" && typeof record.routineId === "string" ? record.routineId : null;
}

interface StageNodeData extends Record<string, unknown> {
  stage: PipelineStage;
  automationTitle: string | null;
}

function StageFlowNode({ data }: NodeProps<Node<StageNodeData>>) {
  const { stage, automationTitle } = data;
  return (
    <div className="w-[220px] rounded-lg border border-border bg-card p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-border" />
      <Handle type="source" position={Position.Right} className="!bg-border" />
      <div className="truncate text-sm font-medium">{stage.name}</div>
      <div className="mt-1.5">
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {STAGE_KIND_LABEL[stage.kind] ?? humanizeKey(stage.kind)}
        </span>
      </div>
      {automationTitle ? (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">Runs automatically: {automationTitle}</p>
      ) : null}
    </div>
  );
}

interface RoutineNodeData extends Record<string, unknown> {
  routine: RoutineListItem;
  isStageAutomation: boolean;
}

function RoutineFlowNode({ data }: NodeProps<Node<RoutineNodeData>>) {
  const { routine, isStageAutomation } = data;
  const triggerLabels = routine.triggers.length
    ? Array.from(new Set(routine.triggers.map((t) => TRIGGER_KIND_LABEL[t.kind] ?? humanizeKey(t.kind))))
    : ["Not started automatically"];
  return (
    <div className="w-[240px] rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-sm font-medium">{routine.title}</div>
        {routine.status !== "active" ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {humanizeKey(routine.status)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {triggerLabels.map((label) => (
          <span key={label} className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {label}
          </span>
        ))}
      </div>
      {isStageAutomation ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Attached to a pipeline stage</p>
      ) : null}
    </div>
  );
}

interface ApprovalNodeData extends Record<string, unknown> {
  type: string;
  pendingCount: number;
  totalCount: number;
}

function ApprovalFlowNode({ data }: NodeProps<Node<ApprovalNodeData>>) {
  return (
    <div className="w-[240px] rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="truncate text-sm font-medium">{APPROVAL_TYPE_LABEL[data.type] ?? humanizeKey(data.type)}</div>
      <div className="mt-1.5 flex items-center gap-2">
        {data.pendingCount > 0 ? <StatusBadge status="pending" /> : null}
        <span className="text-[11px] text-muted-foreground">
          {data.pendingCount > 0
            ? `${data.pendingCount} waiting for a decision`
            : `${data.totalCount} decided so far`}
        </span>
      </div>
    </div>
  );
}

interface JobNodeData extends Record<string, unknown> {
  job: Job;
}

function JobFlowNode({ data }: NodeProps<Node<JobNodeData>>) {
  const { job } = data;
  return (
    <div className="w-[240px] rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="truncate text-sm font-medium">{job.name}</div>
      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{job.description || "No description yet."}</p>
      {job.skillKeys.length > 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{job.skillKeys.length} skill{job.skillKeys.length === 1 ? "" : "s"}</p>
      ) : null}
    </div>
  );
}

interface SectionLabelNodeData extends Record<string, unknown> {
  label: string;
  hint?: string;
}

function SectionLabelNode({ data }: NodeProps<Node<SectionLabelNodeData>>) {
  return (
    <div className="w-fit">
      <div className="text-sm font-semibold text-foreground">{data.label}</div>
      {data.hint ? <div className="text-xs text-muted-foreground">{data.hint}</div> : null}
    </div>
  );
}

const nodeTypes = {
  stage: StageFlowNode,
  routine: RoutineFlowNode,
  approval: ApprovalFlowNode,
  job: JobFlowNode,
  sectionLabel: SectionLabelNode,
};

function gridPosition(index: number, originX: number, originY: number) {
  const col = index % CARDS_PER_ROW;
  const row = Math.floor(index / CARDS_PER_ROW);
  return {
    x: originX + col * (CARD_WIDTH + CARD_GAP_X),
    y: originY + row * (120 + CARD_GAP_Y),
  };
}

export function WorkflowMap() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflow Map" }]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const pipelinesEnabled = experimentalQuery.data?.enablePipelines === true;

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "__none__"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && pipelinesEnabled && experimentalQuery.isFetched,
  });
  const pipelines = pipelinesQuery.data ?? [];

  const transitionsQueries = useQueries({
    queries: pipelines.map((pipeline: PipelineListItem) => ({
      queryKey: queryKeys.pipelines.detail(pipeline.id),
      queryFn: () => pipelinesApi.get(pipeline.id),
      enabled: pipelinesEnabled,
    })),
  });

  const routinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.routines.list(selectedCompanyId) : ["routines", "__none__"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const routines = routinesQuery.data ?? [];

  const approvalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId) : ["approvals", "__none__"],
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const approvals = approvalsQuery.data ?? [];

  const jobsQuery = useQuery({
    queryKey: selectedCompanyId ? ["jobs", selectedCompanyId] : ["jobs", "__none__"],
    queryFn: () => jobsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const jobs = jobsQuery.data ?? [];

  const isLoading =
    !experimentalQuery.isFetched ||
    (pipelinesEnabled && pipelinesQuery.isLoading) ||
    routinesQuery.isLoading ||
    approvalsQuery.isLoading ||
    jobsQuery.isLoading;

  const routineIdsUsedByStages = useMemo(() => {
    const ids = new Set<string>();
    for (const pipeline of pipelines) {
      for (const stage of pipeline.stages ?? []) {
        const routineId = stageAutomationRoutineId(stage.config);
        if (routineId) ids.add(routineId);
      }
    }
    return ids;
  }, [pipelines]);

  const { nodes, edges } = useMemo(() => {
    const builtNodes: Node[] = [];
    const builtEdges: Edge[] = [];
    let sectionTop = 0;

    // ── Pipelines: stage chains connected by transitions ──
    if (pipelinesEnabled && pipelines.length > 0) {
      builtNodes.push({
        id: "section:pipelines",
        type: "sectionLabel",
        position: { x: 0, y: sectionTop },
        data: { label: "Pipelines", hint: "Stages a piece of work moves through" },
        draggable: false,
        selectable: false,
      });
      sectionTop += 50;

      const routineById = new Map(routines.map((r) => [r.id, r]));

      pipelines.forEach((pipeline, pipelineIndex) => {
        const rowY = sectionTop + pipelineIndex * PIPELINE_ROW_HEIGHT;
        builtNodes.push({
          id: `pipeline-label:${pipeline.id}`,
          type: "sectionLabel",
          position: { x: 0, y: rowY },
          data: { label: pipeline.name },
          draggable: false,
          selectable: false,
        });

        const stages = [...(pipeline.stages ?? [])].sort((a, b) => a.position - b.position);
        stages.forEach((stage, stageIndex) => {
          const routineId = stageAutomationRoutineId(stage.config);
          const automationTitle = routineId ? routineById.get(routineId)?.title ?? null : null;
          builtNodes.push({
            id: `stage:${stage.id}`,
            type: "stage",
            position: { x: stageIndex * (STAGE_WIDTH + STAGE_GAP_X), y: rowY + 28 },
            data: { stage, automationTitle },
            draggable: false,
          });
        });

        const detail = transitionsQueries[pipelineIndex]?.data;
        for (const transition of detail?.transitions ?? []) {
          builtEdges.push({
            id: `transition:${pipeline.id}:${transition.fromStageId}:${transition.toStageId}`,
            source: `stage:${transition.fromStageId}`,
            target: `stage:${transition.toStageId}`,
            label: transition.label ?? undefined,
            type: "smoothstep",
          });
        }
      });

      sectionTop += pipelines.length * PIPELINE_ROW_HEIGHT + 60;
    } else if (pipelinesEnabled) {
      builtNodes.push({
        id: "section:pipelines-empty",
        type: "sectionLabel",
        position: { x: 0, y: sectionTop },
        data: { label: "Pipelines", hint: "No pipelines set up yet" },
        draggable: false,
        selectable: false,
      });
      sectionTop += 90;
    }

    // ── Routines & triggers ──
    builtNodes.push({
      id: "section:routines",
      type: "sectionLabel",
      position: { x: 0, y: sectionTop },
      data: { label: "Jobs", hint: "Automations and what starts them" },
      draggable: false,
      selectable: false,
    });
    sectionTop += 50;
    routines.forEach((routine, index) => {
      const pos = gridPosition(index, 0, sectionTop);
      builtNodes.push({
        id: `routine:${routine.id}`,
        type: "routine",
        position: pos,
        data: { routine, isStageAutomation: routineIdsUsedByStages.has(routine.id) },
        draggable: false,
      });
    });
    sectionTop += Math.ceil(routines.length / CARDS_PER_ROW) * (120 + CARD_GAP_Y) + 60;

    // ── Approvals, grouped by type ──
    const approvalGroups = new Map<string, { pending: number; total: number }>();
    for (const approval of approvals) {
      const group = approvalGroups.get(approval.type) ?? { pending: 0, total: 0 };
      group.total += 1;
      if (approval.status === "pending") group.pending += 1;
      approvalGroups.set(approval.type, group);
    }
    builtNodes.push({
      id: "section:approvals",
      type: "sectionLabel",
      position: { x: 0, y: sectionTop },
      data: { label: "Approvals", hint: "Decisions that need a person before an agent can continue" },
      draggable: false,
      selectable: false,
    });
    sectionTop += 50;
    Array.from(approvalGroups.entries()).forEach(([type, counts], index) => {
      const pos = gridPosition(index, 0, sectionTop);
      builtNodes.push({
        id: `approval:${type}`,
        type: "approval",
        position: pos,
        data: { type, pendingCount: counts.pending, totalCount: counts.total },
        draggable: false,
      });
    });
    sectionTop += Math.ceil(approvalGroups.size / CARDS_PER_ROW) * (120 + CARD_GAP_Y) + 60;

    // ── Jobs (position templates) ──
    builtNodes.push({
      id: "section:jobs",
      type: "sectionLabel",
      position: { x: 0, y: sectionTop },
      data: { label: "Positions", hint: "Position templates agents can be hired into" },
      draggable: false,
      selectable: false,
    });
    sectionTop += 50;
    jobs.forEach((job, index) => {
      const pos = gridPosition(index, 0, sectionTop);
      builtNodes.push({
        id: `job:${job.id}`,
        type: "job",
        position: pos,
        data: { job },
        draggable: false,
      });
    });

    return { nodes: builtNodes, edges: builtEdges };
  }, [pipelines, pipelinesEnabled, routines, approvals, jobs, routineIdsUsedByStages, transitionsQueries]);

  const isEmpty =
    !isLoading &&
    pipelines.length === 0 &&
    routines.length === 0 &&
    approvals.length === 0 &&
    jobs.length === 0;

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Workflow Map</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A read-only picture of how work moves through this company — pipelines and their stages, the automations
            that run them, the approvals they wait on, and the job positions behind them. Zoom and pan to explore;
            nothing here can be changed from this page.
          </p>
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="org-chart" />
      ) : isEmpty ? (
        <EmptyState
          icon={GitFork}
          message="Nothing to map yet. Set up a routine, pipeline, or job position and it will show up here."
        />
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/20">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable
            panOnScroll
            zoomOnScroll={false}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <GitFork className="h-3.5 w-3.5" /> Pipelines &amp; stages
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Repeat className="h-3.5 w-3.5" /> Jobs &amp; triggers
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Approvals
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5" /> Jobs
        </span>
      </div>
    </div>
  );
}
