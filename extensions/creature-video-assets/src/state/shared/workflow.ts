import { BRANCHES_FOR_STAGE, EXTRA_DEPENDENTS, STAGE_IDS, type DirectionId, type StageId } from "./creature/ids.js";
import { EXTENSION_ID, WORKFLOW_VERSION } from "./recipe.js";

export type Gate = "stage-output" | "pilot" | "batch";
export type Status = "ready" | "running" | "review" | "approved" | "stale" | "failed" | "blocked" | "submit_unknown";
export type Artifact = {
  id: string; title: string; kind: "text" | "image" | "video" | "web";
  storageKey?: string; contentType?: string; checksum?: string; size?: number; text?: string;
  directionId?: string; actionId?: string; previewUrl?: string; role?: string; outputKey?: string;
};
export type Reference = { sourceNodeId: string; assetId: string; storageKey: string; checksum: string; contentType: string; size: number; title: string };
export type StageInput = {
  prompt: string; modelKey: string; reviewModelKey: string; directions: DirectionId[]; mirrorDecision: "accepted_semantic_mirroring" | "promoted_all_to_master";
  referenceImages: Reference[]; outputPrompts: Record<string, string>; outputModels: Record<string, string>;
};
export type Checks = { hardPassed: boolean; agent: "pending" | "pass" | "fail"; notes: string[] };
export type OutputState = "waiting" | "queued" | "running" | "processing" | "succeeded" | "failed" | "blocked" | "unknown";
export type OutputIssue = { state: "failed" | "blocked"; code: string; message: string };
export type Operation = { key: string; modelKey: string; state: "prepared" | "submitted" | "succeeded" | "failed" | "unknown"; artifact?: Artifact;
  outputKey?: string; attempt?: number; executorVersion?: string; inputDigest?: string; remoteRef?: string; remoteArtifacts?: {name:string;url:string;media_type?:string}[] };
export type StageSnapshot = {
  revision: number; gate: Gate; status: Status; input: StageInput; artifacts: Artifact[];
  structured: Record<string, unknown> | null; checks: Checks; operations: Operation[];
  outputIssues: Record<string, OutputIssue>;
  outputs?: Record<string, OutputState>; targetOutputs?: string[]; outputAttempts?: Record<string, number>;
  inputVersions: Partial<Record<StageId, number>>; approvals: Partial<Record<Gate, { revision: number; by: string; at: string }>>;
  error: string | null;
};
export type StageState = StageSnapshot & { history: StageSnapshot[] };
export type WorkflowRun = {
  schemaVersion: 1; instanceId: string; canvasId: string; nodeId: string; version: number;
  activeStage: StageId; stages: Record<StageId, StageState>; updatedAt: string;
  execution?: { subject: string; workId: string };
  productionProfile?: { cameraSummary: string; cameraHash: string; identityAspectRatio: number; identityParameters: Record<string, unknown> };
  publication?: { current: {revision:number;bundle:Artifact;files:Record<string,Artifact>}; previous?: {revision:number;bundle:Artifact;files:Record<string,Artifact>} };
};
export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkflowError"; }
}
export function initialInput(): StageInput {
  return { prompt: "", modelKey: "", reviewModelKey: "", directions: ["6_00", "7_30", "9_00", "10_30", "12_00", "1_30", "3_00", "4_30"], mirrorDecision: "accepted_semantic_mirroring", referenceImages: [], outputPrompts: {}, outputModels: {} };
}
export function createRun(canvasId: string, nodeId: string, instanceId: string): WorkflowRun {
  const stages = Object.fromEntries(STAGE_IDS.map(id => [id, {
    revision: 1, gate: id === "07_rgb_videos" ? "pilot" : "stage-output", status: "ready", input: initialInput(), artifacts: [],
    structured: null, checks: { hardPassed: false, agent: "pending", notes: [] }, operations: [], outputIssues: {}, inputVersions: {}, approvals: {}, history: [], error: null
  }])) as unknown as WorkflowRun["stages"];
  return { schemaVersion: WORKFLOW_VERSION, instanceId, canvasId, nodeId, version: 0, activeStage: "01_brief", stages, updatedAt: new Date().toISOString() };
}
export function dependencies(id: StageId): StageId[] {
  return [...new Set([...BRANCHES_FOR_STAGE[id], ...STAGE_IDS.filter(source => EXTRA_DEPENDENTS[source].includes(id))])];
}
export function assertExecutable(run: WorkflowRun, id: StageId): void {
  if (Object.values(run.stages).some(stage => stage.status === "submit_unknown")) throw new WorkflowError("submit-unknown", "存在提交结果未知的任务，先对账，不能重新提交。");
  if (Object.values(run.stages).some(stage => stage.status === "running")) throw new WorkflowError("busy", "已有步骤正在制作。");
  for (const dependency of dependencies(id)) if (run.stages[dependency].status !== "approved") throw new WorkflowError("dependency-not-approved", "前序产物尚未批准或已待更新。");
  const index = STAGE_IDS.indexOf(id);
  if (index > STAGE_IDS.indexOf(run.activeStage)) throw new WorkflowError("stage-not-reached", "请先完成当前步骤。");
}
function snapshot(state: StageState): StageSnapshot {
  const { history: _history, ...value } = state;
  return structuredClone(value);
}
export function prepareStage(run: WorkflowRun, id: StageId, input: StageInput, retain = false): void {
  assertExecutable(run, id);
  const stage = run.stages[id];
  const firstBatch = id === "07_rgb_videos" && stage.gate === "batch" && stage.status === "ready" && !!stage.approvals.pilot;
  if (id !== "01_brief" && input.referenceImages.length) throw new WorkflowError("unexpected-reference", "只有第一步接收外部参考图，后续自动沿用已批准产物。");
  if (!input.prompt.trim() && id === "01_brief") throw new WorkflowError("input-required", "请先描述要制作的生物。");
  if (!firstBatch && !retain && (stage.artifacts.length || stage.operations.length || stage.status === "approved")) {
    stage.history.push(snapshot(stage));
    stage.revision += 1;
  }
  if (firstBatch && !retain && JSON.stringify(input) !== JSON.stringify(stage.input)) throw new WorkflowError("pilot-input-conflict", "批量制作须沿用已批准试片的参数；修改参数需要重新制作试片。");
  Object.assign(stage, { input: structuredClone(input), status: "running", artifacts: firstBatch || retain ? stage.artifacts : [], structured: firstBatch || retain ? stage.structured : null,
    checks: { hardPassed: false, agent: "pending", notes: [] }, operations: firstBatch || retain ? stage.operations : [], outputIssues: firstBatch || retain ? stage.outputIssues : {}, outputs: firstBatch || retain ? stage.outputs ?? {} : {}, error: null,
    inputVersions: Object.fromEntries(dependencies(id).map(dep => [dep, run.stages[dep].revision])) });
  // activeStage 是刷新后恢复面板位置的权威游标；开始重做旧步骤时也要回到该步骤。
  run.activeStage = id;
  if (!firstBatch && !retain) stage.approvals = {};
  if (id === "07_rgb_videos" && !firstBatch && !retain) stage.gate = "pilot";
  markDependentsStale(run, id);
}
export function markDependentsStale(run: WorkflowRun, source: StageId): void {
  const affected = new Set<StageId>([source]);
  for (const id of STAGE_IDS) {
    if (id === source || !dependencies(id).some(dependency => affected.has(dependency))) continue;
    affected.add(id);
    const stage = run.stages[id];
    if (stage.artifacts.length || stage.status === "approved") { stage.status = "stale"; stage.approvals = {}; }
  }
}
export function approveStage(run: WorkflowRun, id: StageId, revision: number, gate: Gate, _accepted: readonly boolean[], actor: string, _required: number): void {
  const stage = run.stages[id];
  if (stage.revision !== revision || stage.gate !== gate) throw new WorkflowError("revision-conflict", "产物版本已改变，请重新查看并验收。");
  if (stage.status !== "review") throw new WorkflowError("review-not-ready", "本轮产物尚未完成。");
  for (const dependency of dependencies(id)) if (run.stages[dependency].status !== "approved" || stage.inputVersions[dependency] !== run.stages[dependency].revision) throw new WorkflowError("stale-input", "前序版本已改变，需要重新制作。");
  stage.approvals[gate] = { revision, by: actor, at: new Date().toISOString() };
  if (id === "07_rgb_videos" && gate === "pilot") { stage.gate = "batch"; stage.status = "ready"; return; }
  stage.status = "approved";
  const next = STAGE_IDS[STAGE_IDS.indexOf(id) + 1];
  if (next) run.activeStage = next;
}
export function isWorkflowNode(data: unknown): data is Record<string, unknown> {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).extensionId === EXTENSION_ID;
}
export function workflowInstance(data: unknown): string | null {
  if (!isWorkflowNode(data)) return null;
  const attachment = data.creatureWorkflow as { extensionId?: unknown } | undefined;
  if (attachment?.extensionId === EXTENSION_ID) return null;
  const ref = data.extensionContentRef as { instanceId?: unknown } | undefined;
  return typeof ref?.instanceId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(ref.instanceId) ? ref.instanceId : null;
}
