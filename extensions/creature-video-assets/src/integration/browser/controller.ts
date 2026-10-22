import type { ServerCanvas } from "@woohaa3/contracts";
import type { WorkflowContext } from "./context.js";
import { workflowRemote } from "./remote.js";
import { cardOwner, planOrphanCleanup, planProjection } from "../../preview/shared/projection.js";
import { previewRun } from "../../preview/shared/debug.js";
import { STAGES, stageDefinition } from "../../state/shared/recipe.js";
import type { StageId } from "../../state/shared/creature/ids.js";
import { createRun, initialInput, workflowInstance, type StageInput, type Status, type WorkflowRun } from "../../state/shared/workflow.js";
import type { WorkflowOutputError, WorkflowView } from "../../authoring/browser/controller-port.js";
import { outputDependencies, outputModel, outputPrompt, stageOutputSlots, type StageOutputSlot } from "../../state/shared/stage-output.js";

/** 页面内观察与草稿；权威步骤和批准始终来自扩展后端。 */
export class WorkflowController {
  private version = 0;
  private alive = true;
  private projectionDrain: Promise<void> | null = null;
  private readonly projectionQueue = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly loading = new Set<string>();
  private readonly views = new Map<string, WorkflowView>();
  private readonly remote;
  private readonly disposers: (() => void)[] = [];
  constructor(readonly ctx: WorkflowContext) {
    this.remote = workflowRemote(ctx.applicationRemote);
    this.disposers.push(ctx.canvasState.subscribe(() => { this.sync(); this.emit(); }), ctx.selection.subscribe(() => {
      const selected = this.selected();
      if (selected) queueMicrotask(() => { if (this.alive && this.selected() === selected) ctx.canvasNavigation.closePanel("node-execution"); });
      this.emit();
    }));
    const timer = setInterval(() => { for (const view of this.views.values()) if (Object.values(view.run.stages).some(stage => stage.status === "running")) void this.refresh(view.run.nodeId); }, 2000);
    this.disposers.push(() => clearInterval(timer));
    this.sync();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  revision = () => this.version;
  private emit = () => { if (!this.alive) return; this.version++; for (const listener of this.listeners) listener(); };
  all(): WorkflowView[] { return [...this.views.values()]; }
  referenceContainerNodeId(view: WorkflowView): string | null {
    const canvas = this.ctx.canvasState.getCanvas();
    return canvas?.document.nodes.find(node => {
      const owner = cardOwner(canvas.nodeData[node.id]);
      return node.type === "composite-asset" && owner?.nodeId === view.run.nodeId && owner.instanceId === view.run.instanceId && owner.role === "input";
    })?.id ?? null;
  }
  get(nodeId: string): WorkflowView | undefined { return this.views.get(nodeId); }
  displayRun(view: WorkflowView): WorkflowRun { return view.preview ?? view.run; }
  preview(view: WorkflowView, stageId: StageId, status: Status): void {
    if (!view.preview) view.productionStage = view.stageId;
    view.preview = previewRun(view.run, stageId, status); view.stageId = stageId; this.emit(); void this.project(view);
  }
  exitPreview(view: WorkflowView): void { view.preview = undefined; view.stageId = view.productionStage ?? view.run.activeStage; view.productionStage = undefined; this.emit(); void this.project(view); }
  selected(): string | null {
    const canvas = this.ctx.canvasState.getCanvas(), selection = this.ctx.selection.getSnapshot();
    if (!canvas || !selection.nodeIds.length) return null;
    const owners = selection.nodeIds.map(selected => {
      if (workflowInstance(canvas.nodeData[selected]) && canvas.document.nodes.some(node => node.id === selected && node.type === "composite-asset")) return selected;
      const owner = cardOwner(canvas.nodeData[selected]);
      return owner && workflowInstance(canvas.nodeData[owner.nodeId]) === owner.instanceId ? owner.nodeId : null;
    });
    return owners[0] && owners.every(owner => owner === owners[0]) ? owners[0] : null;
  }
  select(nodeId: string): void {
    const canvas = this.ctx.canvasState.getCanvas();
    if (canvas) this.ctx.selection.setFromRuntime({ nodeIds: [nodeId], primaryNodeId: nodeId, editingFocus: false }, new Set(canvas.document.nodes.map(node => node.id)));
    this.ctx.canvasNavigation.closePanel("node-execution");
  }
  input(view: WorkflowView): StageInput {
    if (view.preview) return view.preview.stages[view.stageId].input;
    const state = view.run.stages[view.stageId], key = `${view.stageId}:${state.revision}:${state.gate}`;
    let draft = view.drafts.get(key);
    if (!draft) {
      const first = view.run.stages["01_brief"].input;
      draft = structuredClone(state.revision === 1 && !state.operations.length && state.status === "ready" && view.stageId !== "01_brief" ? { ...initialInput(), directions: view.run.stages["03_direction_plan"].input.directions, reviewModelKey: first.reviewModelKey || first.modelKey } : state.input);
      try { const saved = localStorage.getItem(this.draftKey(view, key)); if (saved) draft = { ...draft, ...JSON.parse(saved) } as StageInput; } catch { /* 私密浏览和损坏草稿不阻断制作。 */ }
      draft.outputPrompts = { ...(draft.outputPrompts ?? {}) };
      draft.outputModels = { ...(draft.outputModels ?? {}) };
      for (const slot of stageOutputSlots(view.run, view.stageId)) if (draft.outputPrompts[slot.key] === undefined) draft.outputPrompts[slot.key] = slot.prompt;
      view.drafts.set(key, draft);
    }
    return draft;
  }
  outputSlots(view: WorkflowView): StageOutputSlot[] { return stageOutputSlots(this.displayRun(view), view.stageId); }
  outputStates(): {nodeId: string; label: string}[] {
    const canvas = this.ctx.canvasState.getCanvas();
    if (!canvas) return [];
    const labels: Record<string,string> = {queued:"已排队",running:"正在生成",processing:"正在处理产物",unknown:"待核对任务"};
    return canvas.document.nodes.flatMap(node => {
      const owner = cardOwner(canvas.nodeData[node.id]), view = owner?.role === "output" ? this.views.get(owner.nodeId) : undefined;
      if (!owner || !view || owner.instanceId !== view.run.instanceId || !owner.slot.startsWith(`${view.stageId}:`)) return [];
      const run = this.displayRun(view), key = owner.slot.slice(view.stageId.length + 1), state = run.stages[view.stageId].outputs?.[key];
      if (state === "waiting") {
        let dependencies: string[] = [];
        try { dependencies = outputDependencies(run, view.stageId)[key] ?? []; } catch { /* 上游尚未生成时等待调度器即可。 */ }
        const titles = new Map(stageOutputSlots(run, view.stageId).map(slot => [slot.key, slot.title]));
        const names = dependencies.map(dependency => titles.get(dependency) ?? dependency);
        return [{nodeId:node.id,label:names.length ? `等待：${names.join("、")}` : "等待调度"}];
      }
      return state && labels[state] ? [{nodeId:node.id,label:labels[state]!}] : [];
    });
  }
  outputErrors(): WorkflowOutputError[] {
    const canvas = this.ctx.canvasState.getCanvas();
    if (!canvas) return [];
    return canvas.document.nodes.flatMap(node => {
      const owner = cardOwner(canvas.nodeData[node.id]), view = owner?.role === "output" ? this.views.get(owner.nodeId) : undefined;
      const data = canvas.nodeData[node.id];
      if (!owner || !view || owner.instanceId !== view.run.instanceId || !owner.slot.startsWith(`${view.stageId}:`) || typeof data?.errorMessage !== "string" || !data.errorMessage.trim()) return [];
      const slotKey = owner.slot.slice(view.stageId.length + 1), kind = view.run.stages[view.stageId].outputIssues?.[slotKey]?.state ?? "failed";
      return [{ nodeId: node.id, title: typeof data.title === "string" && data.title.trim() ? data.title : "本轮产物", message: data.errorMessage, kind }];
    });
  }
  selectedOutput(): { view: WorkflowView; nodeId: string; slot: StageOutputSlot; taskStatus?: "idle" | "pending" | "processing" | "successed" | "failed" | "cancelled"; errorMessage?: string | null } | null {
    const canvas = this.ctx.canvasState.getCanvas(), selected = this.ctx.selection.getSnapshot().primaryNodeId;
    if (!canvas || !selected) return null;
    const owner = cardOwner(canvas.nodeData[selected]), view = owner?.role === "output" ? this.views.get(owner.nodeId) : undefined;
    if (!owner || !view || owner.instanceId !== view.run.instanceId) return null;
    const separator = owner.slot.indexOf(":");
    if (separator < 0 || owner.slot.slice(0, separator) !== view.stageId) return null;
    const key = owner.slot.slice(separator + 1), slot = this.outputSlots(view).find(item => item.key === key);
    const data = canvas.nodeData[selected];
    return slot ? { view, nodeId: selected, slot, ...(data?.taskStatus ? { taskStatus: data.taskStatus } : {}), ...(data?.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}) } : null;
  }
  updateOutput(view: WorkflowView, slot: StageOutputSlot, patch: { prompt?: string; modelKey?: string }): void {
    const input = this.input(view);
    this.updateInput(view, {
      ...(patch.prompt !== undefined ? { outputPrompts: { ...input.outputPrompts, [slot.key]: patch.prompt }, ...(slot.key === "main" ? { prompt: patch.prompt } : {}) } : {}),
      ...(patch.modelKey !== undefined ? { outputModels: { ...input.outputModels, [slot.key]: patch.modelKey }, ...(slot.key === "main" ? { modelKey: patch.modelKey } : {}) } : {})
    });
  }
  private draftKey(view: WorkflowView, key: string): string { return `creature-draft:${view.run.canvasId}:${view.run.nodeId}:${view.run.instanceId}:${key}`; }
  updateInput(view: WorkflowView, patch: Partial<StageInput>): void {
    if (view.preview) { Object.assign(view.preview.stages[view.stageId].input, patch); this.emit(); void this.project(view); return; }
    if (view.run.stages[view.stageId].status === "running") return;
    const input = { ...this.input(view), ...patch }, stage = view.run.stages[view.stageId], key = `${view.stageId}:${stage.revision}:${stage.gate}`;
    view.drafts.set(key, input);
    try { localStorage.setItem(this.draftKey(view, key), JSON.stringify(input)); } catch { /* 保留页面内草稿。 */ }
    this.emit(); void this.project(view);
  }
  setStage(view: WorkflowView, id: StageId): void { if (view.preview) { this.preview(view, id, "ready"); return; } if (STAGES.findIndex(item => item.id === id) <= STAGES.findIndex(item => item.id === view.run.activeStage)) { view.stageId = id; this.emit(); void this.project(view); } }
  collapse(view: WorkflowView): void { view.collapsed = !view.collapsed; this.emit(); }
  async refresh(nodeId: string): Promise<void> {
    const canvas = this.ctx.canvasState.getCanvas(), instanceId = workflowInstance(canvas?.nodeData[nodeId]);
    if (!canvas || !instanceId || this.loading.has(nodeId)) return;
    this.loading.add(nodeId);
    try {
      const run = await this.remote("status", { canvasId: canvas.id, nodeId, instanceId });
      if (!this.alive || !this.matches(canvas.id, nodeId, instanceId)) return;
      const old = this.views.get(nodeId);
      if (old && old.run.version > run.version) return;
      const isNewPageView = !old || old.run.instanceId !== instanceId || old.run.version === 0;
      const view: WorkflowView = old && old.run.instanceId === instanceId
        ? old
        : { run, stageId: run.activeStage, collapsed: false, busy: false, error: null, drafts: new Map() };
      // sync() 先创建 version=0 的本地占位；首次从宿主恢复时必须以权威
      // activeStage 定位，否则刷新页面会永远停在第一步。后续轮询保留用户
      // 正在查看的历史步骤，避免刷新任务状态时把面板强行跳走。
      if (isNewPageView && !view.preview) view.stageId = run.activeStage;
      view.run = run; view.error = null; this.views.set(nodeId, view); this.emit(); await this.project(view);
    } catch (error) { const view = this.views.get(nodeId); if (view) { view.error = error instanceof Error ? error.message : "暂时无法读取制作记录。"; this.emit(); } }
    finally { this.loading.delete(nodeId); }
  }
  private matches(canvasId: string, nodeId: string, instanceId: string): boolean { const canvas = this.ctx.canvasState.getCanvas(); return canvas?.id === canvasId && workflowInstance(canvas.nodeData[nodeId]) === instanceId && canvas.document.nodes.some(node => node.id === nodeId && node.type === "composite-asset"); }
  async execute(view: WorkflowView, outputKey?: string): Promise<void> {
    if (view.preview) { this.preview(view, view.stageId, "review"); return; }
    const current = this.input(view), catalog = this.ctx.taskCatalog.getState();
    const outputPrompts = { ...current.outputPrompts }, outputModels = { ...current.outputModels };
    for (const slot of this.outputSlots(view)) {
      outputPrompts[slot.key] ??= outputPrompt(current, slot);
      if (slot.modelType && !outputModel(current, slot)) {
        const fallback = catalog.status === "ready" ? catalog.catalog.models.find(model => model.modelType === slot.modelType)?.modelKey : undefined;
        if (fallback) outputModels[slot.key] = fallback;
      }
    }
    const firstModel = this.outputSlots(view).map(slot => outputModels[slot.key]).find(Boolean) ?? current.modelKey;
    const input = { ...current, prompt: outputPrompts.main ?? current.prompt, modelKey: firstModel, outputPrompts, outputModels };
    await this.mutate(view, "start", { stageId: view.stageId, input, ...(outputKey ? {outputKey} : {}) });
  }
  async next(view: WorkflowView): Promise<void> {
    if (view.preview) { const index = STAGES.findIndex(item => item.id === view.stageId); this.preview(view, STAGES[Math.min(index + 1, STAGES.length - 1)]!.id, "ready"); return; }
    const stage = view.run.stages[view.stageId];
    await this.mutate(view, "approve", { stageId: view.stageId, revision: stage.revision, gate: stage.gate, accepted: stageDefinition(view.stageId).review.map(() => true) });
  }
  async reconcile(view: WorkflowView): Promise<void> { await this.mutate(view, "reconcile", {}); }
  private async mutate(view: WorkflowView, route: string, body: Record<string, unknown>): Promise<void> {
    if (view.busy || !this.ctx.canvasCommands.isWritable()) return;
    view.busy = true; view.error = null; this.emit();
    const { canvasId, nodeId, instanceId } = view.run;
    try {
      const run = await this.remote(route, { canvasId, nodeId, instanceId }, { ...body, expectedVersion: view.run.version });
      if (!this.alive || !this.matches(canvasId, nodeId, instanceId)) return;
      view.run = run;
      if (route === "approve") view.stageId = run.activeStage;
      await this.project(view);
    } catch (error) { const message = error instanceof Error ? error.message : "操作暂未完成，请重试。"; await this.refresh(nodeId); view.error = message; }
    finally { view.busy = false; this.emit(); }
  }
  private sync(): void {
    const canvas = this.ctx.canvasState.getCanvas();
    if (!canvas) return;
    for (const [id, view] of this.views) if (!this.matches(view.run.canvasId, id, view.run.instanceId)) this.views.delete(id);
    for (const node of canvas.document.nodes) {
      const instanceId = node.type === "composite-asset" ? workflowInstance(canvas.nodeData[node.id]) : null;
      if (instanceId && !this.views.has(node.id)) {
        this.views.set(node.id, { run: createRun(canvas.id, node.id, instanceId), stageId: "01_brief", collapsed: false, busy: false, error: null, drafts: new Map() });
        void this.refresh(node.id);
      }
    }
    void this.project();
  }
  private project(view?: WorkflowView): Promise<void> {
    if (view) this.projectionQueue.add(view.run.nodeId);
    else for (const id of this.views.keys()) this.projectionQueue.add(id);
    if (!this.projectionDrain) this.projectionDrain = Promise.resolve().then(async () => {
      let clean = true;
      while (this.alive && this.ctx.canvasCommands.isWritable() && (clean || this.projectionQueue.size)) {
        const canvas = this.ctx.canvasState.getWorkingCanvas() ?? this.ctx.canvasState.getCanvas();
        if (!canvas) break;
        const id = this.projectionQueue.values().next().value as string | undefined;
        if (id) this.projectionQueue.delete(id);
        const current = id ? this.views.get(id) : undefined;
        const commands = clean ? planOrphanCleanup(canvas) : [];
        clean = false;
        if (current && this.matches(current.run.canvasId, current.run.nodeId, current.run.instanceId)) commands.push(...planProjection(canvas, this.displayRun(current), current.stageId, this.input(current), key => this.ctx.mediaRemote.urlFor(key)));
        if (!commands.length) continue;
        try {
          const receipt = this.ctx.canvasCommands.submit(commands, `creature-project:${crypto.randomUUID()}`);
          if (!receipt.ok) throw new Error(receipt.reason);
          const outcome = await receipt.handle.settled;
          if (outcome.state !== "committed") throw new Error(outcome.error ?? "画布展示同步失败。");
        } catch (error) {
          if (current) current.error = error instanceof Error ? error.message : "画布展示同步失败。";
          this.projectionQueue.clear(); this.emit(); break;
        }
      }
    }).finally(() => { this.projectionDrain = null; });
    return this.projectionDrain;
  }
  drop(canvas: ServerCanvas, targetId: string, sourceIds: readonly string[]): boolean {
    const owner = cardOwner(canvas.nodeData[targetId]);
    const view = owner ? this.views.get(owner.nodeId) : null;
    if (!owner || owner.role !== "input" || !view || owner.instanceId !== view.run.instanceId || view.stageId !== "01_brief" || view.busy || ["running", "submit_unknown"].includes(this.displayRun(view).stages[view.stageId].status) || !this.ctx.canvasCommands.isWritable()) return true;
    try {
      const refs = sourceIds.map(id => {
        const node = canvas.document.nodes.find(node => node.id === id), data = canvas.nodeData[id];
        const asset = canvas.assets.find(item => item.id === data?.outputAssetId);
        if (node?.type !== "image" || !asset || typeof asset.metadata?.storageKey !== "string" || typeof asset.metadata.checksum !== "string" || typeof asset.metadata.size !== "number" || typeof asset.metadata.contentType !== "string" || !asset.metadata.contentType.startsWith("image/")) throw new Error("请拖入已保存、具备稳定媒体引用的图片节点。");
        return { sourceNodeId: id, assetId: asset.id, storageKey: asset.metadata.storageKey, checksum: asset.metadata.checksum, contentType: asset.metadata.contentType, size: asset.metadata.size, title: asset.title };
      });
      const merged = [...this.input(view).referenceImages];
      for (const ref of refs) if (!merged.some(item => item.assetId === ref.assetId)) merged.push(ref);
      if (merged.length > 8) throw new Error("参考图最多 8 张，请先移除多余的参考图。");
      this.updateInput(view, { referenceImages: merged }); this.select(view.run.nodeId);
    } catch (error) { view.error = error instanceof Error ? error.message : "参考图无法读取。"; this.emit(); }
    return true; // 消费 drop，宿主恢复来源节点的位置。
  }
  dispose(): void { this.alive = false; for (const dispose of this.disposers.splice(0).reverse()) dispose(); this.listeners.clear(); }
}
