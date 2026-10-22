import type { CanvasCommandsService, CanvasRuntimeService, MediaRemoteService, TaskCatalogService } from "@woohaa3/frontend/extension-api";
import type { StageId } from "../../state/shared/creature/ids.js";
import type { StageInput, Status, WorkflowRun } from "../../state/shared/workflow.js";
import type { StageOutputSlot } from "../../state/shared/stage-output.js";

export type WorkflowView = {
  run: WorkflowRun; stageId: StageId; collapsed: boolean; busy: boolean; error: string | null;
  drafts: Map<string, StageInput>;
  preview?: WorkflowRun; productionStage?: StageId;
};
export type WorkflowOutputError = { nodeId: string; title: string; message: string; kind: "failed" | "blocked" };
/** 面板只依赖编辑端口，画布/远程装配由 integration 实现。 */
export interface WorkflowController {
  ctx: { taskCatalog: TaskCatalogService; canvasRuntime: CanvasRuntimeService; canvasCommands: CanvasCommandsService; mediaRemote: MediaRemoteService };
  subscribe(listener: () => void): () => void;
  revision(): number;
  all(): WorkflowView[];
  get(nodeId: string): WorkflowView | undefined;
  selected(): string | null;
  select(nodeId: string): void;
  displayRun(view: WorkflowView): WorkflowRun;
  input(view: WorkflowView): StageInput;
  outputSlots(view: WorkflowView): StageOutputSlot[];
  outputErrors(): WorkflowOutputError[];
  outputStates(): {nodeId: string; label: string}[];
  selectedOutput(): { view: WorkflowView; nodeId: string; slot: StageOutputSlot; taskStatus?: "idle" | "pending" | "processing" | "successed" | "failed" | "cancelled"; errorMessage?: string | null } | null;
  updateOutput(view: WorkflowView, slot: StageOutputSlot, patch: { prompt?: string; modelKey?: string }): void;
  referenceContainerNodeId(view: WorkflowView): string | null;
  updateInput(view: WorkflowView, patch: Partial<StageInput>): void;
  setStage(view: WorkflowView, id: StageId): void;
  collapse(view: WorkflowView): void;
  refresh(nodeId: string): Promise<void>;
  execute(view: WorkflowView, outputKey?: string): Promise<void>;
  next(view: WorkflowView): Promise<void>;
  reconcile(view: WorkflowView): Promise<void>;
  preview(view: WorkflowView, stageId: StageId, status: Status): void;
  exitPreview(view: WorkflowView): void;
}
