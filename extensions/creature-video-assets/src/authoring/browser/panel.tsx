import { useSyncExternalStore } from "react";
import { Button, ExecutionPanel, ExecutionPanelShell, SelectInput, TextArea, projectModelConfig, type ExecutionPanelTaskKind } from "@woohaa3/frontend/extension-api";
import type { WorkflowController, WorkflowView } from "./controller-port.js";
import { STAGES, stageDefinition } from "../../state/shared/recipe.js";
import { DIRECTION_IDS } from "../../state/shared/creature/ids.js";
import type { StageInput, Status } from "../../state/shared/workflow.js";
import { productionPlan } from "../../state/shared/production-plan.js";
import { outputModel, outputPrompt } from "../../state/shared/stage-output.js";
const statusLabel: Record<Status, string> = { ready: "等待执行", running: "制作中", review: "等待验收", approved: "已验收", stale: "前序已变更", failed: "制作失败", blocked: "等待处理", submit_unknown: "待核对任务" };

const taskKind: Record<"language" | "image" | "video", ExecutionPanelTaskKind> = { language: "text-generation", image: "image-generation", video: "video-generation" };

function OutputExecutionPanel({ controller, writable }: { controller: WorkflowController; writable: boolean }) {
  const selected = controller.selectedOutput();
  const catalog = useSyncExternalStore(controller.ctx.taskCatalog.subscribe, controller.ctx.taskCatalog.getState, controller.ctx.taskCatalog.getState);
  if (!selected) return null;
  const { view, slot } = selected, input = controller.input(view), stage = controller.displayRun(view).stages[view.stageId];
  const outputBusy = selected.taskStatus === "pending" || selected.taskStatus === "processing";
  const locked = !writable || view.busy || stage.status === "running";
  if (view.stageId === "03_direction_plan") return <div className="creature-output-execution" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <ExecutionPanelShell ariaLabel="方向规划执行设置" className="creature-output-settings">
      <header><strong>{slot.title}</strong><span>执行设置</span></header>
      <div className="creature-output-settings__body">
        <div className="creature-directions">{DIRECTION_IDS.map(direction => <label key={direction}><input type="checkbox" disabled={locked} checked={input.directions.includes(direction)} onChange={event => controller.updateInput(view, { directions: event.target.checked ? [...input.directions, direction] : input.directions.filter(item => item !== direction) })} />{direction.replace("_", ":")}</label>)}</div>
        <SelectInput label="镜像策略" disabled={locked} value={input.mirrorDecision} onValueChange={value => controller.updateInput(view, { mirrorDecision: value as StageInput["mirrorDecision"] })} options={[{ value: "accepted_semantic_mirroring", label: "接受左右语义互换" }, { value: "promoted_all_to_master", label: "各方向独立制作" }]} />
        <div className="creature-output-settings__actions"><Button tone="primary" disabled={locked} onClick={() => void controller.execute(view,slot.key)}>{outputBusy ? "制作中…" : "执行"}</Button></div>
      </div>
    </ExecutionPanelShell>
  </div>;
  if (!slot.modelType) {
    const editable = view.stageId === "08_matting";
    return <div className="creature-output-execution" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}><ExecutionPanelShell ariaLabel={`${slot.title}执行设置`} className="creature-output-settings">
      <header><strong>{slot.title}</strong><span>{editable ? "执行设置" : "自动整理"}</span></header>
      <div className="creature-output-settings__body">{editable ? <TextArea disabled={locked} value={outputPrompt(input,slot)} onChange={event => controller.updateOutput(view,slot,{prompt:event.target.value})} /> : <p>该产物由本步其他结果自动整理，无需单独输入。</p>}<div className="creature-output-settings__actions"><Button tone="primary" disabled={locked} onClick={() => void controller.execute(view,slot.key)}>{outputBusy ? "制作中…" : "执行"}</Button></div></div>
    </ExecutionPanelShell></div>;
  }
  const models = catalog.status === "ready" ? catalog.catalog.models.filter(model => model.modelType === slot.modelType) : [];
  const selectedModel = outputModel(input,slot);
  const projected = projectModelConfig(models,selectedModel,models[0]?.modelKey ?? "");
  const modelConfig = { ...projected, parameterSchemaByModel: Object.fromEntries(models.map(model => [model.modelKey, []])), defaultsByModel: Object.fromEntries(models.map(model => [model.modelKey, {}])) };
  const status = selected.taskStatus === "pending" || selected.taskStatus === "processing" || selected.taskStatus === "successed" || selected.taskStatus === "failed"
    ? selected.taskStatus
    : "idle";
  const references = view.stageId === "01_brief" ? <div className="creature-references"><span>{input.referenceImages.length ? `${input.referenceImages.length} 张参考图` : "参考图可选"}</span>{input.referenceImages.map(ref => <Button size="sm" key={ref.assetId} disabled={locked} onClick={() => controller.updateInput(view,{referenceImages:input.referenceImages.filter(item=>item.assetId!==ref.assetId)})}>{ref.title} ×</Button>)}</div> : undefined;
  return <div className="creature-output-execution" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <ExecutionPanel className={view.stageId === "01_brief" ? "creature-output-panel" : "creature-output-panel creature-output-panel--no-header"} taskKind={taskKind[slot.modelType]} modelConfig={modelConfig} data={{ title: slot.title, panelPrompt: outputPrompt(input,slot), taskStatus: status, ...(selected.errorMessage ? { errorMessage: selected.errorMessage } : {}), parameters: { model: selectedModel } }} surface="canvas" readOnly={locked} runLabel="执行" pendingLabel="制作中…" showExpand={false} showPolish={false} showFormatToolbar={false} referencesSlot={references} onChange={patch => {
      const prompt = typeof patch.panelPrompt === "string" ? patch.panelPrompt : undefined;
      const modelKey = typeof patch.parameters?.model === "string" ? patch.parameters.model : undefined;
      if (prompt !== undefined || modelKey !== undefined) controller.updateOutput(view,slot,{...(prompt !== undefined ? {prompt}:{}),...(modelKey !== undefined ? {modelKey}: {})});
    }} onRun={() => void controller.execute(view,slot.key)} />
  </div>;
}
function outputSummary(controller: WorkflowController, view: WorkflowView): string {
  const stage = controller.displayRun(view).stages[view.stageId], slots = controller.outputSlots(view);
  const states = slots.map(slot => stage.outputs?.[slot.key]);
  if (!states.some(Boolean)) return "";
  const count = (...values: string[]) => states.filter(state => state && values.includes(state)).length;
  return [`完成 ${count("succeeded")}/${slots.length}`, count("running", "processing") ? `进行中 ${count("running", "processing")}` : "", count("waiting", "queued") ? `等待 ${count("waiting", "queued")}` : "", count("failed") ? `失败 ${count("failed")}` : "", count("blocked") ? `受阻 ${count("blocked")}` : ""].filter(Boolean).join(" · ");
}
function WorkflowPanel({ controller, view }: { controller: WorkflowController; view: WorkflowView }) {
  const run = controller.displayRun(view), definition = stageDefinition(view.stageId), state = run.stages[view.stageId];
  const currentIndex = STAGES.findIndex(stage => stage.id === view.stageId), reached = view.preview ? 7 : STAGES.findIndex(stage => stage.id === run.activeStage);
  const plan = productionPlan(run);
  const statusText = state.status === "running" && view.stageId === "05_direction_stills"
    ? `制作中 · 已完成 ${state.artifacts.filter(artifact => artifact.directionId).length}/${((run.stages["03_direction_plan"].structured?.generationDirections as unknown[] | undefined)?.length ?? 0)} 张`
    : `${statusLabel[state.status]}${view.stageId === "07_rgb_videos" ? state.gate === "pilot" ? " · 试片" : " · 批量" : ""}`;
  return <section className={`creature-panel${view.collapsed ? " creature-panel--collapsed" : ""}`} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <header className="creature-panel__header"><strong>{currentIndex + 1} / 8　{definition.title}</strong><span className="creature-status" data-status={state.status}>{statusText}</span><Button size="sm" onClick={() => controller.collapse(view)}>{view.collapsed ? "展开面板" : "暂时收起"}</Button></header>
    {!view.collapsed && <>
      <nav className="creature-steps">{STAGES.map((stage, index) => <Button size="sm" key={stage.id} disabled={index > reached || view.busy} data-current={stage.id === view.stageId} title={stage.title} onClick={() => controller.setStage(view, stage.id)}>{index + 1}<span className="creature-step-title">{stage.title}</span></Button>)}</nav>
      {view.error && <p className="creature-error">{view.error}<Button size="sm" onClick={() => void controller.refresh(view.run.nodeId)}>刷新记录</Button></p>}
      <div className="creature-panel__body"><div className="creature-review"><h3>验收要点</h3><p>查看画布右侧的{definition.kind === "text" ? "文本" : definition.kind === "image" ? "图片" : definition.kind === "video" ? "视频" : "运行候选"}节点。点击中心“下一步”即表示通过验收。</p>
        {plan && ["04_action_design", "07_rgb_videos"].includes(view.stageId) && <p>制作计划：母方向图 {plan.masterImages} 张，共享起手图 {plan.sharedStartImages} 张，视频 {plan.videoTasks} 条，GPU 任务 {plan.gpuTasks} 次。按所选模型实际计费，失败重做需另行确认。</p>}
        <ul className="creature-review-points">{definition.review.map(item => <li key={item}>{item}</li>)}</ul>
        {state.checks.notes.length > 0 && <details><summary>查看检查意见</summary><ul>{state.checks.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      </div></div>
    </>}
  </section>;
}
export function WorkflowOverlay({ controller, writable, hidden }: { controller: WorkflowController; writable: boolean; hidden?: boolean }) {
  useSyncExternalStore(controller.subscribe, controller.revision, controller.revision);
  const runtime = controller.ctx.canvasRuntime;
  useSyncExternalStore(runtime.subscribeViewport, runtime.viewportVersion, runtime.viewportVersion);
  if (hidden) return null;
  const selectedOutput = controller.selectedOutput();
  const selected = selectedOutput ? null : controller.selected(), selectedView = selected ? controller.get(selected) : null;
  return <div className="creature-overlay">
    {controller.outputStates().map(state => {
      const rect = runtime.nodeScreenRect(state.nodeId);
      return rect ? <span key={`state:${state.nodeId}`} className="creature-output-state" style={{left:rect.left+rect.width/2,top:rect.top+rect.height-30}}>{state.label}</span> : null;
    })}
    {controller.outputErrors().map(error => {
      const rect = runtime.nodeScreenRect(error.nodeId);
      if (!rect) return null;
      return <div key={`error:${error.nodeId}`} className="creature-output-error" data-kind={error.kind} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        <div className="creature-output-error__message"><strong>{error.kind === "blocked" ? "未执行" : "生成失败"}</strong><span>{error.message}</span></div>
      </div>;
    })}
    {controller.all().filter(view => view.stageId === "01_brief").map(view => {
      const nodeId = controller.referenceContainerNodeId(view), rect = nodeId ? runtime.nodeScreenRect(nodeId) : null;
      if (!rect) return null;
      const references = controller.input(view).referenceImages;
      return <div key={`reference:${view.run.nodeId}`} className="creature-reference-container" data-node-id={nodeId} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        <strong>参考图{references.length ? ` · ${references.length} 张` : "（可选）"}</strong>
        {references.length ? <div className="creature-reference-container__images">{references.map(ref => <img key={ref.assetId} src={controller.ctx.mediaRemote.urlFor(ref.storageKey)} alt={ref.title} />)}</div> : <span>拖入画布中的图片节点</span>}
        <small>{references.length ? "可继续拖入图片 · 最多 8 张" : "放开后引用图片，原图回到原位"}</small>
      </div>;
    })}
    {controller.all().map(view => {
      const rect = runtime.nodeScreenRect(view.run.nodeId);
      if (!rect) return null;
      const stage = controller.displayRun(view).stages[view.stageId], canApprove = stage.status === "review";
      const blocked = !writable || view.busy || stage.status === "running" || stage.status === "submit_unknown";
      const nextReason = !writable ? "画布当前为只读状态。" : view.busy ? "正在处理当前步骤。" : stage.status === "failed" || stage.status === "blocked" ? "请查看失败的产物节点，调整后重新执行。" : stage.status === "submit_unknown" ? "请先核对远端任务状态。" : "本轮产物尚未完成。";
      return <div className="creature-node-actions" key={view.run.nodeId} style={{ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 }} onPointerDown={event => event.stopPropagation()}>
        <Button size="sm" tone="ghost" className="creature-node-name" onClick={() => controller.select(view.run.nodeId)}>{stageDefinition(view.stageId).title}</Button>
        <div><Button size="sm" disabled={blocked} onClick={() => { controller.select(view.run.nodeId); void controller.execute(view); }}>{view.busy ? "处理中…" : stage.status === "running" ? "制作中…" : "执行全部"}</Button><Button size="sm" tone="primary" title={canApprove ? "" : nextReason} disabled={!writable || view.busy || !canApprove} onClick={() => void controller.next(view)}>下一步</Button></div>
        <span className="creature-progress">{outputSummary(controller,view)}</span>
        {!selectedView && view.error && <small>{view.error}</small>}
      </div>;
    })}
    <OutputExecutionPanel controller={controller} writable={writable} />
    {selectedView && <WorkflowPanel controller={controller} view={selectedView} />}
  </div>;
}
