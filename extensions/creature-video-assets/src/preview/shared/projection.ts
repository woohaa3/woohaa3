import type { CanvasCommand, CanvasNodeData, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { stageDefinition, EXTENSION_ID } from "../../state/shared/recipe.js";
import type { StageId } from "../../state/shared/creature/ids.js";
import { workflowInstance, type Artifact, type StageInput, type WorkflowRun } from "../../state/shared/workflow.js";
import { artifactForSlot, outputDependencies, outputModel, outputPrompt, stageOutputSlots } from "../../state/shared/stage-output.js";

export type CardOwner = { extensionId: string; nodeId: string; instanceId: string; role: "input" | "previous" | "output"; slot: string };
export function cardOwner(data: CanvasNodeData | undefined): CardOwner | null {
  const owner = data?.creatureWorkflow as unknown as CardOwner | undefined;
  return owner?.extensionId === EXTENSION_ID && typeof owner.nodeId === "string" && typeof owner.instanceId === "string" ? owner : null;
}
type Card = { id: string; role: CardOwner["role"]; slot: string; type: "text" | "image" | "video" | "composite-asset"; title: string; artifact?: Artifact; state?: import("../../state/shared/workflow.js").OutputState; issue?: { state: "failed" | "blocked"; message: string }; x: number; y: number; message: string };
const idPart = (value: string) => encodeURIComponent(value);
export function planOrphanCleanup(canvas: ServerCanvas): CanvasCommand[] {
  const ids = canvas.document.nodes.filter(node => {
    const owner = cardOwner(canvas.nodeData[node.id]);
    if (!owner || !node.id.startsWith(`creature:${idPart(owner.nodeId)}:${owner.instanceId}:`)) return false;
    return workflowInstance(canvas.nodeData[owner.nodeId]) !== owner.instanceId || !canvas.document.nodes.some(subject => subject.id === owner.nodeId && subject.type === "composite-asset");
  }).map(node => node.id);
  return ids.length ? [{ type: "node.remove", nodeIds: ids }] : [];
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** 每步独立投影；中心主体没有边。卡片和贝塞尔线均交给原画布。 */
export function planProjection(canvas: ServerCanvas, run: WorkflowRun, stageId: StageId, input: StageInput, urlFor: (key: string) => string): CanvasCommand[] {
  const anchor = canvas.document.nodes.find(node => node.id === run.nodeId);
  if (!anchor) return [];
  const definition = stageDefinition(stageId), stage = run.stages[stageId];
  const prefix = `creature:${idPart(run.nodeId)}:${run.instanceId}:`;
  const cards: Card[] = [];
  let row = 0;
  for (const previous of definition.visibleInputs) {
    const state = run.stages[previous];
    const artifacts = state.artifacts.length ? state.artifacts : [{ id: "pending", title: stageDefinition(previous).output, kind: "text" as const, text: "前序产物尚未批准。" }];
    for (const artifact of artifacts) cards.push({ id: `${prefix}previous:${previous}:${idPart(artifact.id)}`, role: "previous", slot: `${previous}:${artifact.id}`, type: artifact.kind === "web" ? "text" : artifact.kind, title: artifact.title, artifact, x: -390, y: row++ * 240, message: "" });
  }
  const references = input.referenceImages;
  if (stageId === "01_brief") cards.push({ id: `${prefix}input`, role: "input", slot: "reference", type: "composite-asset", title: references.length ? `参考图 · ${references.length} 张` : "参考图（可选）", x: -390, y: -260, message: "拖入图片节点，原图会回到原位。也可以直接描述需求。" });
  const slots = stageOutputSlots(run, stageId), used = new Set<string>();
  let dependencies: Record<string, string[]> = {};
  try { dependencies = outputDependencies(run, stageId); } catch { /* 未具备上游结构化产物时没有可投影的产物依赖。 */ }
  const slotsByKey = new Map(slots.map(slot => [slot.key, slot]));
  const resolved = slots.map(slot => ({ slot, artifact: artifactForSlot(slot, stage.artifacts, used) }));
  const failedStage = (stage.status === "failed" || stage.status === "blocked") && !!stage.error;
  const hasOutputIssues = Object.keys(stage.outputIssues ?? {}).length > 0;
  const missingExecutable = resolved.findIndex(item => !item.artifact && item.slot.modelType !== null);
  const legacyFailedIndex = failedStage && !hasOutputIssues && !Object.keys(stage.outputs ?? {}).length && slots.length === 1
    ? (missingExecutable >= 0 ? missingExecutable : resolved.findIndex(item => !item.artifact))
    : -1;
  resolved.forEach(({ slot, artifact }, index) => {
    const kind = artifact?.kind ?? slot.kind;
    const issue = !artifact ? stage.outputIssues?.[slot.key] ?? (index === legacyFailedIndex ? { state: "failed" as const, message: stage.error! } : undefined) : undefined;
    const state = stage.outputs?.[slot.key];
    const waitingFor = (dependencies[slot.key] ?? []).map(key => slotsByKey.get(key)?.title ?? key);
    const stateMessage = state === "waiting" ? waitingFor.length ? `等待：${waitingFor.join("、")}` : "等待调度"
      : state === "queued" ? "已排队" : state === "running" ? "正在生成" : state === "processing" ? "正在处理产物" : "等待执行";
    cards.push({ id: `${prefix}output:${stageId}:${idPart(slot.key)}`, role: "output", slot: `${stageId}:${slot.key}`, type: kind === "web" ? "text" : kind, title: artifact?.title ?? slot.title, artifact, issue, state, x: 340, y: index * 240, message: issue?.message ?? stateMessage });
  });
  const commands: CanvasCommand[] = [];
  const desired = new Set(cards.map(card => card.id));
  const owned = canvas.document.nodes.filter(node => { const owner = cardOwner(canvas.nodeData[node.id]); return node.id.startsWith(prefix) && owner?.nodeId === run.nodeId && owner.instanceId === run.instanceId; });
  const removed = owned.filter(node => !desired.has(node.id) || cards.some(card => card.id === node.id && card.type !== node.type));
  const removedIds = new Set(removed.map(node => node.id));
  // 只清理本实例拥有的节点，绝不删来源图片或其他工作流的卡片。
  if (removed.length) commands.push({ type: "node.remove", nodeIds: removed.map(node => node.id) });
  for (const card of cards) {
    const owner: CardOwner = { extensionId: EXTENSION_ID, nodeId: run.nodeId, instanceId: run.instanceId, role: card.role, slot: card.slot };
    // 占位卡片仍用媒体节点呈现，但没有真实媒体时不能写入媒体资产。
    const artifact = card.artifact, assetId = card.type !== "composite-asset" && artifact && (card.type === "text" || artifact.storageKey) ? `${card.id}:asset` : null;
    const outputSlot = card.role === "output" ? slots.find(slot => `${stageId}:${slot.key}` === card.slot) : undefined;
    const taskStatus = artifact ? "successed" : card.issue?.state === "failed" ? "failed" : card.state === "queued" ? "pending" : card.state === "running" || card.state === "processing" ? "processing" : "idle";
    const value: CanvasNodeData = { title: card.title, status: artifact ? "success" : card.issue?.state === "failed" ? "failed" : taskStatus === "processing" ? "running" : "idle", taskStatus, errorMessage: card.issue ? card.message : null, prompt: outputSlot ? outputPrompt(input, outputSlot) : artifact?.text ?? card.message, creatureWorkflow: owner as unknown as CanvasNodeData,
      ...(outputSlot && outputModel(input, outputSlot) ? { modelKey: outputModel(input, outputSlot), parameters: { model: outputModel(input, outputSlot) } } : {}),
      outputAssetId: assetId ?? "", ...(card.type !== "composite-asset" ? { result: { kind: card.type, ...((artifact?.text ?? card.message) ? { text: artifact?.text ?? card.message } : {}), ...(artifact?.storageKey ? { url: urlFor(artifact.storageKey) } : {}) } } : {}) };
    if (card.type === "composite-asset") Object.assign(value, { extensionId: EXTENSION_ID, compositeAssetRole: "reference-container", extensionContentRef: { schemaVersion: 1, instanceId: run.instanceId }, referenceImages: references });
    const existing = canvas.document.nodes.find(node => node.id === card.id);
    if (!existing || removedIds.has(card.id)) commands.push({ type: "node.add", node: { id: card.id, type: card.type, position: existing?.position ?? { x: anchor.position.x + card.x, y: anchor.position.y + card.y }, width: existing?.width ?? 280, height: existing?.height ?? 210 }, nodeData: value });
    else if (Object.keys(value).some(key => stableJson(canvas.nodeData[card.id]?.[key]) !== stableJson(value[key]))) commands.push({ type: "nodeData.patch", nodeId: card.id, value });
    if (artifact && assetId && card.type !== "composite-asset") {
      const old = canvas.assets.find(asset => asset.id === assetId);
      const asset: StoredAsset = { id: assetId, nodeId: card.id, title: artifact.title, mediaKind: card.type, source: "generated", status: "ready", createdAt: old?.createdAt ?? run.updatedAt,
        ...(artifact.text ? { text: artifact.text } : {}), ...(artifact.storageKey ? { url: urlFor(artifact.storageKey), metadata: { storageKey: artifact.storageKey, checksum: artifact.checksum ?? "", contentType: artifact.contentType ?? "", size: artifact.size ?? 0 } } : {}) };
      if (stableJson(old) !== stableJson(asset)) commands.push({ type: "asset.upsert", asset });
    }
  }
  const targets = cards.filter(card => card.role === "output");
  const outputByKey = new Map(targets.map(target => [target.slot.slice(stageId.length + 1), target]));
  const desiredEdges = new Map<string, { source: string; target: string }>();
  for (const source of cards.filter(card => card.role !== "output")) for (const target of targets) {
    const edgeId = `${prefix}edge:${idPart(source.id)}:${idPart(target.id)}`;
    desiredEdges.set(edgeId, { source: source.id, target: target.id });
  }
  for (const target of targets) for (const dependencyKey of dependencies[target.slot.slice(stageId.length + 1)] ?? []) {
    const source = outputByKey.get(dependencyKey);
    if (!source) continue;
    const edgeId = `${prefix}edge:${idPart(source.id)}:${idPart(target.id)}`;
    desiredEdges.set(edgeId, { source: source.id, target: target.id });
  }
  for (const edge of canvas.document.edges) if (edge.id.startsWith(`${prefix}edge:`) && !desiredEdges.has(edge.id) && !removedIds.has(edge.source) && !removedIds.has(edge.target)) commands.push({ type: "edge.remove", edgeId: edge.id });
  for (const [edgeId, edge] of desiredEdges) if (removedIds.has(edge.source) || removedIds.has(edge.target) || !canvas.document.edges.some(item => item.id === edgeId)) {
    commands.push({ type: "edge.add", edge: { id: edgeId, ...edge } });
  }
  return commands;
}
