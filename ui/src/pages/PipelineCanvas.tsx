import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, GitFork, Pencil, Plus, Save, Settings, Trash2 } from "lucide-react";
import type { Agent, RoutineListItem } from "@paperclipai/shared";
import {
  pipelinesApi,
  type PipelineStage,
  type PipelineTransitionEdge,
} from "../api/pipelines";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Phase 1 (DUR-4210): edit a single pipeline's stages and transitions directly
 * on an xyflow canvas. Full stage configuration (secrets, workspace routing,
 * breakdown rules, …) stays on the Pipeline Settings form — this canvas covers
 * the day-to-day shape of the pipeline: add/rename/remove stages, draw/remove
 * transitions, and the handful of properties that make a stage runnable
 * (automation + approver). Triggers (schedule/webhook/API/email) live on the
 * routine itself, so the panel links out to the routine's own page to edit them.
 */

const STAGE_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "working", label: "In progress" },
  { value: "review", label: "Needs review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

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

const STAGE_NODE_WIDTH = 220;
const STAGE_NODE_GAP_X = 90;

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Mirrors PipelineSettings' stageKeyFromName so new stage keys stay consistent across both editors. */
function stageKeyFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug || "stage";
}

function stageAutomation(stage: PipelineStage | null | undefined) {
  const automation = stage?.config?.automation as
    | { routineId?: string | null; assigneeAgentId?: string | null }
    | undefined;
  return {
    routineId: typeof automation?.routineId === "string" ? automation.routineId : null,
    assigneeAgentId: typeof automation?.assigneeAgentId === "string" ? automation.assigneeAgentId : null,
  };
}

function stageApprover(stage: PipelineStage | null | undefined) {
  const approver = stage?.config?.approver as { kind?: string; id?: string } | undefined;
  if (approver && (approver.kind === "agent" || approver.kind === "user") && approver.id) {
    return `${approver.kind}:${approver.id}`;
  }
  return "";
}

function stageCanvasPosition(stage: PipelineStage, fallbackIndex: number): { x: number; y: number } {
  const stored = stage.config?.canvasPosition as { x?: number; y?: number } | undefined;
  if (stored && typeof stored.x === "number" && typeof stored.y === "number") {
    return { x: stored.x, y: stored.y };
  }
  return { x: fallbackIndex * (STAGE_NODE_WIDTH + STAGE_NODE_GAP_X), y: 80 };
}

/** Mirrors PipelineSettings' defaultReviewTarget: first stage of `kind`, else any other stage. */
function defaultReviewTarget(stages: PipelineStage[], selectedStageId: string | null, kind: string) {
  const match = stages.find((stage) => stage.kind === kind && stage.id !== selectedStageId);
  if (match) return match.key;
  const fallback = stages.find((stage) => stage.id !== selectedStageId);
  return fallback?.key ?? "";
}

interface StageNodeData extends Record<string, unknown> {
  stage: PipelineStage;
  automationTitle: string | null;
  onEdit: (stageId: string) => void;
  onDelete: (stageId: string) => void;
}

function StageNode({ data }: NodeProps<Node<StageNodeData>>) {
  const { stage, automationTitle, onEdit, onDelete } = data;
  return (
    <div className="group w-[220px] rounded-lg border border-border bg-card p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-border" />
      <Handle type="source" position={Position.Right} className="!bg-border" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-medium">{stage.name}</div>
        <div className="nodrag flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
          <button
            type="button"
            aria-label={`Edit ${stage.name}`}
            title="Edit stage"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onEdit(stage.id)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${stage.name}`}
            title="Delete stage"
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(stage.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
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

const nodeTypes = { stage: StageNode };

export function PipelineCanvas() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "__none__"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: Boolean(pipelineId),
  });
  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(
    () => [...(pipeline?.stages ?? [])].sort((a, b) => a.position - b.position),
    [pipeline],
  );

  const routinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.routines.list(selectedCompanyId) : ["routines", "__none__"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const routines = routinesQuery.data ?? [];
  const routineById = useMemo(() => new Map(routines.map((r) => [r.id, r])), [routines]);

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? ["agents", selectedCompanyId] : ["agents", "__none__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const agents = agentsQuery.data ?? [];
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline?.name ?? "Pipeline", href: pipelineId ? `/pipelines/${pipelineId}` : undefined },
      { label: "Canvas" },
    ]);
  }, [pipeline, pipelineId, setBreadcrumbs]);

  const [nodes, setNodes] = useState<Node<StageNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const savedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [layoutDirty, setLayoutDirty] = useState(false);

  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [deleteStageId, setDeleteStageId] = useState<string | null>(null);
  const [deleteMoveTargetStageId, setDeleteMoveTargetStageId] = useState("");
  const [addStageOpen, setAddStageOpen] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [newStageKind, setNewStageKind] = useState("working");
  const [addStageError, setAddStageError] = useState<string | null>(null);

  const handleEdit = useCallback((stageId: string) => setSelectedStageId(stageId), []);
  const handleDelete = useCallback((stageId: string) => {
    setDeleteStageId(stageId);
    setDeleteMoveTargetStageId("");
  }, []);

  // Rebuild nodes/edges whenever the pipeline reloads. Node positions are
  // seeded from config.canvasPosition so a saved layout survives a refresh;
  // unsaved in-canvas drags are intentionally dropped on refetch.
  useEffect(() => {
    if (!pipeline) return;
    const positions = new Map<string, { x: number; y: number }>();
    const nextNodes: Node<StageNodeData>[] = stages.map((stage, index) => {
      const position = stageCanvasPosition(stage, index);
      positions.set(stage.id, position);
      const automation = stageAutomation(stage);
      const automationTitle = automation.routineId ? routineById.get(automation.routineId)?.title ?? null : null;
      return {
        id: stage.id,
        type: "stage",
        position,
        data: { stage, automationTitle, onEdit: handleEdit, onDelete: handleDelete },
      };
    });
    savedPositionsRef.current = positions;
    setNodes(nextNodes);
    setLayoutDirty(false);

    const stageById = new Map(stages.map((s) => [s.id, s]));
    const nextEdges: Edge[] = (pipeline.transitions ?? [])
      .filter((t) => stageById.has(t.fromStageId) && stageById.has(t.toStageId))
      .map((t) => ({
        id: `${t.fromStageId}->${t.toStageId}`,
        source: t.fromStageId,
        target: t.toStageId,
        label: t.label ?? undefined,
        type: "smoothstep",
      }));
    setEdges(nextEdges);
    // routineById is derived from routines and only used to label nodes; it
    // intentionally doesn't retrigger this reset when it refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline, stages, handleEdit, handleDelete]);

  const onNodesChange: OnNodesChange<Node<StageNodeData>> = useCallback((changes: NodeChange<Node<StageNodeData>>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((change) => change.type === "position")) {
      setLayoutDirty(true);
    }
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const setTransitions = useMutation({
    mutationFn: async (nextEdges: Edge[]) => {
      if (!pipelineId || !pipeline) return null;
      const stageById = new Map(stages.map((s) => [s.id, s]));
      const transitions: PipelineTransitionEdge[] = nextEdges
        .map((edge) => {
          const from = stageById.get(edge.source);
          const to = stageById.get(edge.target);
          if (!from || !to) return undefined;
          const transition: PipelineTransitionEdge = { fromStageKey: from.key, toStageKey: to.key };
          if (typeof edge.label === "string") transition.label = edge.label;
          return transition;
        })
        .filter((edge): edge is PipelineTransitionEdge => edge !== undefined);
      return pipelinesApi.setTransitions(pipelineId, { transitions, enforceTransitions: pipeline.enforceTransitions });
    },
    onSuccess: async () => {
      if (pipelineId) await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    },
    onError: (error) => {
      pushToast({
        title: "Could not update the connection",
        body: error instanceof Error ? error.message : "Paperclip could not save that change.",
        tone: "error",
      });
      if (pipeline) {
        // Roll back to the last known-good transitions on failure.
        const stageById = new Map(stages.map((s) => [s.id, s]));
        setEdges(
          (pipeline.transitions ?? [])
            .filter((t) => stageById.has(t.fromStageId) && stageById.has(t.toStageId))
            .map((t) => ({
              id: `${t.fromStageId}->${t.toStageId}`,
              source: t.fromStageId,
              target: t.toStageId,
              label: t.label ?? undefined,
              type: "smoothstep",
            })),
        );
      }
    },
  });

  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const exists = edges.some((edge) => edge.source === connection.source && edge.target === connection.target);
      if (exists) return;
      const nextEdges: Edge[] = [
        ...edges,
        {
          id: `${connection.source}->${connection.target}`,
          source: connection.source,
          target: connection.target,
          type: "smoothstep",
        },
      ];
      setEdges(nextEdges);
      setTransitions.mutate(nextEdges);
    },
    [edges, setTransitions],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (deleted.length === 0) return;
      const deletedIds = new Set(deleted.map((e) => e.id));
      const nextEdges = edges.filter((edge) => !deletedIds.has(edge.id));
      setTransitions.mutate(nextEdges);
    },
    [edges, setTransitions],
  );

  const saveLayout = useMutation({
    mutationFn: async () => {
      if (!pipelineId) return null;
      const changed = nodes.filter((node) => {
        const saved = savedPositionsRef.current.get(node.id);
        return !saved || saved.x !== node.position.x || saved.y !== node.position.y;
      });
      await Promise.all(
        changed.map((node) =>
          pipelinesApi.updateStage(pipelineId, node.id, {
            config: { ...node.data.stage.config, canvasPosition: { x: node.position.x, y: node.position.y } },
          }),
        ),
      );
    },
    onSuccess: async () => {
      if (pipelineId) await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
      pushToast({ title: "Layout saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not save the layout",
        body: error instanceof Error ? error.message : "Paperclip could not save the stage positions.",
        tone: "error",
      });
    },
  });

  const existingKeys = useMemo(() => new Set(stages.map((s) => s.key)), [stages]);
  const existingNames = useMemo(() => new Set(stages.map((s) => s.name.trim().toLowerCase())), [stages]);

  const addStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId) return null;
      const trimmedName = newStageName.trim();
      if (!trimmedName) throw new Error("Give the stage a name.");
      if (existingNames.has(trimmedName.toLowerCase())) {
        throw new Error("A stage with this name already exists.");
      }
      const base = stageKeyFromName(trimmedName);
      const key = existingKeys.has(base) ? `${base}_${Date.now().toString(36)}` : base;
      const lastStage = stages[stages.length - 1] ?? null;
      return pipelinesApi.createStage(pipelineId, {
        key,
        name: trimmedName,
        kind: newStageKind,
        position: lastStage ? lastStage.position + 100 : 100,
      });
    },
    onSuccess: async (created) => {
      if (!created || !pipelineId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
      setAddStageOpen(false);
      setNewStageName("");
      setNewStageKind("working");
      setAddStageError(null);
      pushToast({ title: "Stage added", tone: "success" });
    },
    onError: (error) => {
      setAddStageError(error instanceof Error ? error.message : "Paperclip could not add that stage.");
    },
  });

  const deleteStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !deleteStageId) return null;
      return pipelinesApi.deleteStage(pipelineId, deleteStageId, {
        moveCasesToStageId: deleteMoveTargetStageId || null,
      });
    },
    onSuccess: async () => {
      if (pipelineId) await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
      setDeleteStageId(null);
      if (selectedStageId === deleteStageId) setSelectedStageId(null);
      pushToast({ title: "Stage deleted", tone: "success" });
    },
    onError: () => {
      // Surfaced inline in the dialog via deleteStage.error below.
    },
  });

  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;

  const isLoading = pipelineQuery.isLoading;
  const isEmpty = !isLoading && stages.length === 0;

  if (!pipelineId) return null;

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[480px] flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/pipelines/${pipelineId}`)} aria-label="Back to pipeline">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="truncate text-lg font-semibold">{pipeline?.name ?? "Pipeline"} — Canvas</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag stages to arrange them, drag from one stage's edge to another to connect them, and select a connection
            and press Delete to remove it. For secrets, workspace routing, and advanced rules, use{" "}
            <Link to={`/pipelines/${pipelineId}/settings`} className="underline underline-offset-2 hover:text-foreground">
              Pipeline settings
            </Link>
            .
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {layoutDirty ? (
            <span className="text-xs text-muted-foreground">Unsaved layout changes</span>
          ) : null}
          <Button variant="outline" size="sm" disabled={!layoutDirty || saveLayout.isPending} onClick={() => saveLayout.mutate()}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save layout
          </Button>
          <Button size="sm" onClick={() => setAddStageOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add stage
          </Button>
          <Button variant="outline" size="icon" asChild>
            <Link to={`/pipelines/${pipelineId}/settings`} aria-label="Pipeline settings" title="Pipeline settings">
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {isLoading ? (
          <PageSkeleton variant="org-chart" />
        ) : isEmpty ? (
          <EmptyState
            icon={GitFork}
            message="No stages yet. Add the first stage to start shaping this pipeline."
            action="Add stage"
            onAction={() => setAddStageOpen(true)}
          />
        ) : (
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/20">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgesDelete={onEdgesDelete}
              fitView
              nodesDraggable
              nodesConnectable
              elementsSelectable
              deleteKeyCode={["Delete", "Backspace"]}
              minZoom={0.2}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )}

        {selectedStage ? (
          <StagePropertiesPanel
            key={selectedStage.id}
            pipelineId={pipelineId}
            stage={selectedStage}
            stages={stages}
            routines={routines}
            agents={agents}
            agentById={agentById}
            onClose={() => setSelectedStageId(null)}
            onSaved={async () => {
              await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
            }}
          />
        ) : null}
      </div>

      <Dialog open={addStageOpen} onOpenChange={(open) => { setAddStageOpen(open); if (!open) setAddStageError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add stage</DialogTitle>
            <DialogDescription>Add a new stage to the end of this pipeline. You can rename, reconfigure, and connect it afterward.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input
                autoFocus
                value={newStageName}
                onChange={(event) => setNewStageName(event.target.value)}
                placeholder="e.g. Needs review"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Kind</span>
              <select
                aria-label="Stage kind"
                value={newStageKind}
                onChange={(event) => setNewStageKind(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {STAGE_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {addStageError ? <p className="text-sm text-destructive">{addStageError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddStageOpen(false)} disabled={addStage.isPending}>
              Cancel
            </Button>
            <Button type="button" disabled={addStage.isPending} onClick={() => addStage.mutate()}>
              Add stage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteStageId)} onOpenChange={(open) => { if (!open) setDeleteStageId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete stage</DialogTitle>
            <DialogDescription>
              Delete {stages.find((s) => s.id === deleteStageId)?.name ?? "this stage"} from this pipeline. Connected
              transitions are removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {stages.length > 1 ? (
              <label className="block space-y-1.5 text-sm font-medium">
                <span>Move existing items to</span>
                <select
                  aria-label="Move existing items to"
                  value={deleteMoveTargetStageId}
                  onChange={(event) => setDeleteMoveTargetStageId(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {stages
                    .filter((stage) => stage.id !== deleteStageId)
                    .map((stage) => (
                      <option key={stage.id} value={stage.id}>{stage.name}</option>
                    ))}
                </select>
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">This is the only stage. Deletion succeeds only if it has no items.</p>
            )}
            {deleteStage.error ? (
              <p className="text-sm text-destructive">
                {deleteStage.error instanceof Error ? deleteStage.error.message : "Paperclip could not delete this stage."}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteStageId(null)} disabled={deleteStage.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteStage.isPending || (stages.length > 1 && !deleteMoveTargetStageId)}
              onClick={() => deleteStage.mutate()}
            >
              Delete stage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface StagePropertiesPanelProps {
  pipelineId: string;
  stage: PipelineStage;
  stages: PipelineStage[];
  routines: RoutineListItem[];
  agents: Agent[];
  agentById: Map<string, Agent>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function StagePropertiesPanel({
  pipelineId,
  stage,
  stages,
  routines,
  agents,
  agentById,
  onClose,
  onSaved,
}: StagePropertiesPanelProps) {
  const { pushToast } = useToastActions();
  const [name, setName] = useState(stage.name);
  const [kind, setKind] = useState(stage.kind);
  const initialAutomation = stageAutomation(stage);
  const [routineId, setRoutineId] = useState(initialAutomation.routineId ?? "");
  const [assigneeAgentId, setAssigneeAgentId] = useState(initialAutomation.assigneeAgentId ?? "");
  const [approver, setApprover] = useState(stageApprover(stage));
  const [error, setError] = useState<string | null>(null);

  const selectedRoutine = routineId ? routines.find((r) => r.id === routineId) ?? null : null;

  const routineOptions: InlineEntityOption[] = useMemo(
    () => routines.map((routine) => ({ id: routine.id, label: routine.title, searchText: routine.title })),
    [routines],
  );
  const agentOptions: InlineEntityOption[] = useMemo(
    () => agents.map((agent) => ({ id: agent.id, label: agent.name, searchText: agent.name })),
    [agents],
  );
  const approverOptions: InlineEntityOption[] = useMemo(
    () => agents.map((agent) => ({ id: `agent:${agent.id}`, label: agent.name, searchText: agent.name })),
    [agents],
  );

  const save = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Give the stage a name.");
      const duplicateName = stages.some(
        (other) => other.id !== stage.id && other.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicateName) throw new Error("A stage with this name already exists.");

      const nextConfig: Record<string, unknown> = { ...stage.config };
      if (routineId && assigneeAgentId) {
        nextConfig.automation = { ...(nextConfig.automation as Record<string, unknown>), routineId, assigneeAgentId };
        nextConfig.onEnter = { type: "run_routine", routineId };
      } else {
        delete nextConfig.automation;
        delete nextConfig.onEnter;
      }

      const requireApproval = kind === "review";
      nextConfig.requireApproval = requireApproval;
      if (requireApproval) {
        const [approverKind, approverAgentId] = approver ? approver.split(":") : ["any_human", undefined];
        nextConfig.approver = approverAgentId ? { kind: approverKind, id: approverAgentId } : { kind: "any_human" };
        nextConfig.approveToStageKey =
          typeof nextConfig.approveToStageKey === "string" && nextConfig.approveToStageKey
            ? nextConfig.approveToStageKey
            : defaultReviewTarget(stages, stage.id, "done");
        nextConfig.rejectToStageKey =
          typeof nextConfig.rejectToStageKey === "string" && nextConfig.rejectToStageKey
            ? nextConfig.rejectToStageKey
            : defaultReviewTarget(stages, stage.id, "working");
      } else {
        delete nextConfig.approver;
        delete nextConfig.approveToStageKey;
        delete nextConfig.rejectToStageKey;
        delete nextConfig.requestChangesToStageKey;
      }

      await pipelinesApi.updateStage(pipelineId, stage.id, { name: trimmedName, kind, config: nextConfig });
    },
    onSuccess: async () => {
      await onSaved();
      pushToast({ title: "Stage saved", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Paperclip could not save this stage.");
    },
  });

  return (
    <div className="flex w-80 shrink-0 flex-col overflow-y-auto rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Stage properties</h2>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </div>

      <div className="space-y-4">
        <label className="block space-y-1.5 text-sm font-medium">
          <span>Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        <label className="block space-y-1.5 text-sm font-medium">
          <span>Kind</span>
          <select
            aria-label="Stage kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {STAGE_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Runs automatically</span>
          <InlineEntitySelector
            value={routineId}
            options={routineOptions}
            placeholder="Routine"
            noneLabel="No automation"
            searchPlaceholder="Search routines..."
            emptyMessage="No routines found."
            onChange={(value) => {
              setRoutineId(value);
              if (!value) setAssigneeAgentId("");
            }}
          />
        </div>

        {routineId ? (
          <>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Assigned to</span>
              <InlineEntitySelector
                value={assigneeAgentId}
                options={agentOptions}
                placeholder="Agent"
                noneLabel="Nobody yet"
                searchPlaceholder="Search agents..."
                emptyMessage="No agents found."
                onChange={setAssigneeAgentId}
              />
              {!assigneeAgentId ? (
                <p className="text-xs text-muted-foreground">Pick an agent so this stage can actually run the routine.</p>
              ) : null}
            </div>
            {selectedRoutine ? (
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Triggers</span>
                <div className="flex flex-wrap gap-1">
                  {selectedRoutine.triggers.length > 0 ? (
                    Array.from(new Set(selectedRoutine.triggers.map((t) => TRIGGER_KIND_LABEL[t.kind] ?? humanizeKey(t.kind)))).map(
                      (label) => (
                        <span key={label} className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {label}
                        </span>
                      ),
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">Not started automatically on its own</span>
                  )}
                </div>
                <Link
                  to={`/routines/${selectedRoutine.id}`}
                  className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Edit this routine's triggers →
                </Link>
              </div>
            ) : null}
          </>
        ) : null}

        {kind === "review" ? (
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Approver</span>
            <InlineEntitySelector
              value={approver}
              options={approverOptions}
              placeholder="Approver"
              noneLabel="Any human"
              searchPlaceholder="Search approvers..."
              emptyMessage="No approvers found."
              onChange={setApprover}
              renderTriggerValue={(option) => {
                if (!option) return <span className="text-muted-foreground">Any human</span>;
                const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
                return <span className="truncate">{agent?.name ?? option.label}</span>;
              }}
            />
            <p className="text-xs text-muted-foreground">
              Approved items move to the stage this links to in{" "}
              <Link to={`/pipelines/${pipelineId}/settings?stage=${stage.id}`} className="underline underline-offset-2 hover:text-foreground">
                Pipeline settings
              </Link>
              , where you can also set rejection and request-changes targets.
            </p>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </div>
  );
}
