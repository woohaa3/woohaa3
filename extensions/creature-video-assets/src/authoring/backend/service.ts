import type { StageId } from "../../state/shared/creature/ids.js";
import { artifactForSlot, outputDependencies, stageOutputSlots } from "../../state/shared/stage-output.js";
import { STAGES } from "../../state/shared/recipe.js";
import { WorkflowRepository } from "../../state/backend/repository.js";
import { approveStage, prepareStage, WorkflowError, type Artifact, type Checks, type Gate, type StageInput, type WorkflowRun } from "../../state/shared/workflow.js";

export type StageResult = { artifacts: Artifact[]; structured: Record<string, unknown> | null; checks: Checks };
export type ExecutionContext = { run: WorkflowRun; stageId: StageId; outputKey?: string; checkpoint(): Promise<void>; assertCurrent(): Promise<void>; isStopped(): boolean };
export type StageExecutor = (context: ExecutionContext) => Promise<StageResult>;

/** 业务编排只依赖扩展自己的持久记录与执行端口，不注册新的 Canvas run 类型。 */
export class WorkflowService {
  private stopped = false;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  constructor(readonly repository: WorkflowRepository, private readonly executor: StageExecutor, private readonly lifecycle: { assertCurrent?(run: WorkflowRun): Promise<void>; settled?(run: WorkflowRun, state: "succeeded" | "failed" | "cancelled"): void; log?(event: Record<string, unknown>): void } = {}) {}
  stop(): void { this.stopped = true; }
  async start(run: WorkflowRun, stageId: StageId, input: StageInput, outputKey?: string): Promise<WorkflowRun> {
    const key = `${run.canvasId}:${run.nodeId}:${run.instanceId}`;
    if (this.pending.has(key)) {
      if (Object.values(run.stages).some(s=>s.status === "running")) throw new WorkflowError("busy","已有步骤正在制作。");
      await this.pending.get(key);
    }
    this.cancelled.delete(key);
    const stage = run.stages[stageId], slots = stageOutputSlots(run, stageId);
    if (outputKey && !slots.some(slot => slot.key === outputKey)) throw new WorkflowError("invalid-output", "产物已改变，请刷新。");
    const multi = ["05_direction_stills", "07_rgb_videos", "08_matting"].includes(stageId);
    const retain = stage.status !== "stale" && (!!outputKey || multi || stage.status === "failed" || stage.status === "blocked");
    const used = new Set<string>();
    const existing = new Map(slots.map(slot => [slot.key, artifactForSlot(slot, stage.artifacts, used)]));
    const targets = new Set(outputKey ? [outputKey] : slots.filter(slot => !existing.get(slot.key)).map(slot => slot.key));
    const deps = outputDependencies(run, stageId);
    // Rebuild cheap derived views after a selected result changes; dependent generation waits for execute-all.
    const invalid = new Set(targets);
    let changed = true;
    while (changed) { changed = false; for (const [key, parents] of Object.entries(deps)) if (!invalid.has(key) && parents.some(parent => invalid.has(parent))) { invalid.add(key); changed = true; } }
    if (retain && outputKey && existing.get(outputKey)) {
      const {history, ...previous} = stage;
      history.push(structuredClone(previous)); stage.revision += 1;
      stage.approvals = {};
    }
    prepareStage(run, stageId, input, retain);
    stage.targetOutputs = outputKey ? [...new Set([outputKey, ...slots.filter(slot => ["contact", "events", "production-plan"].includes(slot.key)).map(slot => slot.key)])] : undefined;
    if (retain) {
      stage.outputAttempts ??= {};
      for (const key of invalid) { stage.outputAttempts[key] = (stage.outputAttempts[key] ?? 0) + 1; delete stage.outputs?.[key]; delete stage.outputIssues[key]; }
      stage.artifacts = slots.flatMap(slot => !invalid.has(slot.key) && existing.get(slot.key) ? [{...existing.get(slot.key)!, outputKey:slot.key}] : []);
      stage.outputs ??= {};
      for (const slot of slots) if (!invalid.has(slot.key) && existing.get(slot.key)) stage.outputs[slot.key] = "succeeded";
      if (Array.isArray(stage.structured?.clips)) stage.structured.clips = stage.structured.clips.filter((clip: {key:string}) => !invalid.has(clip.key));
      if (outputKey) for (const key of invalid) if (!stage.targetOutputs!.includes(key)) { stage.outputs ??= {}; stage.outputs[key] = "blocked"; stage.outputIssues[key] = {state:"blocked",code:"input-changed",message:"前序产物已重做，请执行本产物或点击执行全部。"}; }
    }
    await this.repository.save(run);
    this.launch(run, stageId);
    return structuredClone(run);
  }
  async cancel(run: WorkflowRun): Promise<WorkflowRun> {
    const key = `${run.canvasId}:${run.nodeId}:${run.instanceId}`;
    if (!this.pending.has(key)) throw new WorkflowError("not-running","当前没有本机正在执行的步骤。");
    this.cancelled.add(key);await this.pending.get(key);
    return this.repository.read(run.canvasId,run.nodeId,run.instanceId);
  }
  async approve(run: WorkflowRun, input: { stageId: StageId; revision: number; gate: Gate; accepted: boolean[]; actor: string }): Promise<WorkflowRun> {
    approveStage(run, input.stageId, input.revision, input.gate, input.accepted, input.actor, STAGES.find(stage => stage.id === input.stageId)!.review.length);
    if (input.stageId === "09_publish") {
      const candidate = run.stages[input.stageId].structured?.candidate as NonNullable<WorkflowRun["publication"]>["current"] | undefined;
      if (!candidate || candidate.revision !== input.revision || !candidate.bundle.storageKey || !candidate.files["manifest.json"] || !candidate.files["index.html"]) throw new WorkflowError("invalid-candidate","运行候选不完整，尚未发布。");
      run.publication = { current: structuredClone(candidate), ...(run.publication ? {previous:run.publication.current} : {}) };
    }
    await this.repository.save(run);
    return run;
  }
  async rollback(run: WorkflowRun): Promise<WorkflowRun> {
    if (Object.values(run.stages).some(s=>s.status === "running")) throw new WorkflowError("busy","请等待当前制作完成。");
    if (!run.publication?.previous) throw new WorkflowError("no-previous-release","没有可回滚的发布。");
    run.publication = {current:run.publication.previous,previous:run.publication.current};
    await this.repository.save(run);return run;
  }
  async recover(): Promise<void> {
    for (const run of await this.repository.pending()) {
      const id = STAGES.find(stage => run.stages[stage.id].status === "running")?.id;
      if (id) this.launch(run, id);
    }
  }
  async settled(): Promise<void> { await Promise.all(this.pending.values()); }
  async reconcile(run: WorkflowRun): Promise<WorkflowRun> {
    const stageId = STAGES.find(item => run.stages[item.id].status === "submit_unknown")?.id;
    if (!stageId) throw new WorkflowError("not-unknown", "当前没有待核对的任务。");
    const key = `${run.canvasId}:${run.nodeId}:${run.instanceId}`;
    await this.pending.get(key);
    this.cancelled.delete(key);
    run.stages[stageId].status = "running";
    await this.repository.save(run); this.launch(run, stageId); return structuredClone(run);
  }
  private launch(run: WorkflowRun, stageId: StageId): void {
    const key = `${run.canvasId}:${run.nodeId}:${run.instanceId}`;
    if (this.pending.has(key) || this.stopped) return;
    const stage = run.stages[stageId];
    let writes: Promise<void> = Promise.resolve();
    const work = (async () => {
      try {
        const assertCurrent = async () => { if (this.stopped || this.cancelled.has(key)) throw new WorkflowError("executor-stopped", "制作已停止，已有产物已保留。"); await this.lifecycle.assertCurrent?.(run); };
        await assertCurrent();
        const result = await this.executor({ run, stageId, assertCurrent, checkpoint: () => { const next = writes.then(async () => { await assertCurrent(); await this.repository.save(run); }); writes = next; return next; }, isStopped: () => this.stopped || this.cancelled.has(key) });
        if (this.stopped) return;
        await assertCurrent();
        // 制作检查是验收提示，不替用户做最终决定。只要执行器返回了完整结果，
        // 就进入 review；用户点击“下一步”即表示接受本轮产物。
        Object.assign(stage, result, { status: "review", error: null });
      } catch (error) {
        if (this.stopped) return;
        stage.status = error instanceof WorkflowError && error.code === "submit-unknown" ? "submit_unknown"
          : error instanceof WorkflowError && /unavailable|not-configured|qa-required/.test(error.code) ? "blocked" : "failed";
        stage.error = error instanceof WorkflowError ? error.message : "制作失败，已有任务和产物已保留。";
        if (this.cancelled.has(key) && stage.operations.some(op=>op.state === "submitted" || op.state === "unknown")) {
          stage.status = "submit_unknown";stage.error = "本机处理已停止，远端任务状态待核对。";
        }
      }
      await writes.catch(() => {});
      await this.repository.save(run);
      if (stage.status !== "submit_unknown") this.lifecycle.settled?.(run, stage.status === "review" ? "succeeded" : "failed");
    })().catch(error => { this.lifecycle.log?.({ event: "workflow-write-failed", code: error instanceof WorkflowError ? error.code : "storage-failed" }); this.lifecycle.settled?.(run, "cancelled"); }).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
  }
}
