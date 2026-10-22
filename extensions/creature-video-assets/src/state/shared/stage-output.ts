import { actionGraphSchema, type ActionState } from "./creature/action.js";
import { backgroundPromptLayer, creatureDesignSchema, identityPromptLayer } from "./creature/creature-design.js";
import { directionPlanSchema } from "./creature/direction.js";
import type { StageId } from "./creature/ids.js";
import { productionPlan } from "./production-plan.js";
import { stageDefinition } from "./recipe.js";
import type { Artifact, StageInput, WorkflowRun } from "./workflow.js";

export type StageOutputSlot = {
  key: string;
  title: string;
  kind: Artifact["kind"];
  prompt: string;
  legacyPrompt?: string;
  legacyPrompts?: string[];
  modelType: "language" | "image" | "video" | null;
  directionId?: string;
  actionId?: string;
};

function directionPrompt(id: string): string {
  return `头部朝向屏幕时钟 ${id.replace("_", ":")}（12:00 朝上，3:00 朝右，6:00 朝下，9:00 朝左），身体轴线与头部方向一致，禁止调换头尾。`;
}

export function compileRgbPrompt(run: WorkflowRun, directionId: string, state: ActionState): string {
  const design = creatureDesignSchema.parse(run.stages["01_brief"].structured);
  return [
    `保持首帧参考中的${design.displayName}外观、构图和相机。`,
    directionPrompt(directionId),
    `${state.displayName}：${state.description}`,
    `动作在 ${state.durationSeconds} 秒内完成，之后保持末态。`,
    backgroundPromptLayer(design.backgroundKind)
  ].join("\n");
}

function previousRgbPrompt(run: WorkflowRun, directionId: string, state: ActionState, connector: boolean): string {
  const design = creatureDesignSchema.parse(run.stages["01_brief"].structured);
  const toSeconds = (frame: number) => (frame / 24).toFixed(2);
  const body = [
    "单个完整生物的一条连续镜头，只表演本条指定动作。禁止拼图、分镜、帧序列表、复制主体、字幕和编号。",
    identityPromptLayer(design),
    run.productionProfile?.cameraSummary ?? "",
    directionPrompt(directionId),
    `${state.displayName}：${state.description}`,
    `总长 ${Math.max(5, Math.ceil(state.durationSeconds))} 秒，24 FPS；动作在 ${state.durationSeconds} 秒内完整演完，之后保持末态静止。`,
    ...state.motionContract.events.map(event => `第 ${toSeconds(event.frame)} 秒：${event.instruction}`),
    ...state.clipSegments.map(segment => `${toSeconds(segment.startFrame)}–${toSeconds(segment.endFrame)} 秒为${segment.role === "loop" ? "循环段，首尾闭合" : "收势段，末帧稳定静止"}`),
    ...state.clipGeneration.promptInvariants,
    backgroundPromptLayer(design.backgroundKind),
    "固定相机，无位移、缩放或镜头变化。"
  ].join("\n");
  return `${body}\n${connector
    ? `生成进入“${state.displayName}”的衔接动作，保持硬切边界和固定相机。`
    : `生成 ${directionId.replace("_", ":")} 方向的“${state.displayName}”动作；固定相机，单一主体，完整演完动作。`}`;
}

const MAIN_PROMPTS: Record<StageId, string> = {
  "01_brief": "设计生物的解剖、材质、识别特征、镜像安全性和动作候选，并保留原始需求。",
  "02_identity_board": "生成同一生物的正面、侧面和背面三视图身份板，固定相机与比例。",
  "03_direction_plan": "根据交付方向与镜像策略生成方向规划。",
  "04_action_design": "设计动作状态、转换、事件帧、循环和收势规则。",
  "05_direction_stills": "生成方向站定图。",
  "07_rgb_videos": "生成动作视频。",
  "08_matting": "完整保留主体、毛发和半透明边缘，生成稳定的逐帧 Alpha。",
  "09_publish": "生成并检查 G-buffer 与实际运行候选。"
};

function main(stageId: StageId): StageOutputSlot[] {
  const definition = stageDefinition(stageId);
  const modelType = definition.kind === "text" ? "language" : definition.kind === "image" ? "image" : definition.kind === "video" ? "video" : null;
  return [{ key: "main", title: definition.output, kind: definition.kind, prompt: MAIN_PROMPTS[stageId], modelType }];
}

export function stageOutputSlots(run: WorkflowRun, stageId: StageId): StageOutputSlot[] {
  if (stageId === "04_action_design") return [
    { key: "main", title: "动作状态、转换与事件帧", kind: "text", prompt: MAIN_PROMPTS[stageId], modelType: "language" },
    { key: "production-plan", title: "制作数量与费用范围", kind: "text", prompt: "根据已批准的动作与方向自动统计制作任务。", modelType: null }
  ];
  if (stageId === "05_direction_stills") {
    const plan = directionPlanSchema.safeParse(run.stages["03_direction_plan"].structured);
    if (!plan.success) return main(stageId);
    const generated = new Set(plan.data.generationDirections);
    return [
      ...plan.data.selectedDirections.map(directionId => ({
        key: `direction:${directionId}`,
        title: `站定图 ${directionId.replace("_", ":")}`,
        kind: "image" as const,
        prompt: `生成 ${directionId.replace("_", ":")} 方向的 Idle 站定图；单一完整主体，身份、比例、脚底线和留白与身份板一致。`,
        modelType: generated.has(directionId) ? "image" as const : null,
        directionId
      })),
      { key: "contact", title: "方向对照", kind: "image", prompt: "将全部方向站定图整理为方向对照图。", modelType: null }
    ];
  }
  if (stageId === "07_rgb_videos") {
    const plan = productionPlan(run), graph = actionGraphSchema.safeParse(run.stages["04_action_design"].structured);
    const directions = directionPlanSchema.safeParse(run.stages["03_direction_plan"].structured);
    if (!plan || !graph.success || !directions.success) return main(stageId);
    const allowed = run.stages[stageId].gate === "pilot"
      ? new Set([directions.data.generationDirections.includes("6_00") ? "6_00" : directions.data.generationDirections[0]])
      : new Set(directions.data.generationDirections);
    const states = new Map(graph.data.states.map(state => [state.stateId, state]));
    const clips: StageOutputSlot[] = plan.clips.filter(clip => allowed.has(clip.directionId)).map(clip => ({
      key: `${clip.directionId}|${clip.actionId}|state`,
      title: `${states.get(clip.actionId)?.displayName ?? clip.actionId} · ${clip.directionId.replace("_", ":")}`,
      kind: "video",
      prompt: compileRgbPrompt(run, clip.directionId, states.get(clip.actionId)!),
      legacyPrompt: `生成 ${clip.directionId.replace("_", ":")} 方向的“${states.get(clip.actionId)?.displayName ?? clip.actionId}”动作；固定相机，单一主体，完整演完动作。`,
      legacyPrompts: [previousRgbPrompt(run, clip.directionId, states.get(clip.actionId)!, false)],
      modelType: "video",
      directionId: clip.directionId,
      actionId: clip.actionId
    }));
    if (run.stages[stageId].gate === "batch") for (const connector of plan.connectors.filter(item => allowed.has(item.directionId))) clips.push({
      key: `${connector.directionId}|${connector.actionId}|${connector.transitionId}`,
      title: `衔接 · ${states.get(connector.actionId)?.displayName ?? connector.actionId} · ${connector.directionId.replace("_", ":")}`,
      kind: "video",
      prompt: compileRgbPrompt(run, connector.directionId, states.get(connector.actionId)!),
      legacyPrompt: `生成进入“${states.get(connector.actionId)?.displayName ?? connector.actionId}”的衔接动作，保持硬切边界和固定相机。`,
      legacyPrompts: [previousRgbPrompt(run, connector.directionId, states.get(connector.actionId)!, true)],
      modelType: "video",
      directionId: connector.directionId,
      actionId: connector.actionId
    });
    return [...clips, { key: "events", title: "动作首帧对照", kind: "image", prompt: "将动作首帧整理为验收对照图。", modelType: null }];
  }
  if (stageId === "08_matting") {
    const clips = run.stages["07_rgb_videos"].structured?.clips;
    if (!Array.isArray(clips) || !clips.length) return main(stageId);
    return clips.flatMap((raw): StageOutputSlot[] => {
      if (!raw || typeof raw !== "object") return [];
      const clip = raw as { key?: unknown; directionId?: unknown; actionId?: unknown };
      if (typeof clip.key !== "string" || typeof clip.directionId !== "string" || typeof clip.actionId !== "string") return [];
      return [{ key: clip.key, title: `透明底对照 · ${clip.actionId} · ${clip.directionId.replace("_", ":")}`, kind: "video", prompt: MAIN_PROMPTS[stageId], modelType: null, directionId: clip.directionId, actionId: clip.actionId }];
    });
  }
  return main(stageId);
}

export function outputPrompt(input: StageInput, slot: StageOutputSlot): string {
  const saved = input.outputPrompts?.[slot.key];
  if (saved !== undefined && saved !== slot.legacyPrompt && !slot.legacyPrompts?.includes(saved)) return saved;
  return slot.key === "main" && input.prompt ? input.prompt : slot.prompt;
}

export function outputModel(input: StageInput, slot: StageOutputSlot): string {
  return input.outputModels?.[slot.key] ?? input.modelKey ?? "";
}

/** Only actual media dependencies invalidate another output. */
export function outputDependencies(run: WorkflowRun, stageId: StageId): Record<string, string[]> {
  const slots = stageOutputSlots(run, stageId);
  const result = Object.fromEntries(slots.map(slot => [slot.key, [] as string[]]));
  if (stageId === "04_action_design") result["production-plan"] = ["main"];
  if (stageId === "05_direction_stills") {
    const plan = directionPlanSchema.parse(run.stages["03_direction_plan"].structured);
    for (const mirror of plan.mirrors) result[`direction:${mirror.direction}`] = [`direction:${mirror.source}`];
    result.contact = slots.filter(slot => slot.key !== "contact").map(slot => slot.key);
  }
  if (stageId === "07_rgb_videos") {
    const graph = actionGraphSchema.parse(run.stages["04_action_design"].structured);
    for (const slot of slots.filter(slot => slot.actionId)) {
      const [direction, action, connector] = slot.key.split("|");
      const state = graph.states.find(state => state.stateId === action)!;
      const source = graph.transitions.find(transition => transition.transitionId === connector);
      result[slot.key] = source ? [`${direction}|${source.fromStateId}|state`] : [
        ...(state.clipGeneration.sharedStartImage || state.phase === "idle" || state.phase === "loop" ? [] : [state.clipGeneration.startFrameFromStateId]),
        state.clipGeneration.endFrameFromStateId
      ].filter((id): id is string => !!id).map(id => `${direction}|${id}|state`);
    }
    result.events = slots.filter(slot => slot.key !== "events").map(slot => slot.key);
  }
  return result;
}

export function artifactForSlot(slot: StageOutputSlot, artifacts: readonly Artifact[], used: Set<string>): Artifact | undefined {
  const owned = artifacts.find(artifact => artifact.outputKey === slot.key);
  artifacts = artifacts.filter(artifact => !artifact.outputKey || artifact.outputKey === slot.key);
  const titled = artifacts.find(artifact => !used.has(artifact.id) && artifact.title === slot.title);
  const exact = artifacts.find(artifact => !used.has(artifact.id) && artifact.directionId === slot.directionId && artifact.actionId === slot.actionId);
  const direction = artifacts.find(artifact => !used.has(artifact.id) && artifact.directionId === slot.directionId && slot.actionId === undefined);
  const fallback = slot.key === "main" || slot.key === "contact" || slot.key === "events" ? artifacts.find(artifact => !used.has(artifact.id)) : undefined;
  const found = owned ?? titled ?? exact ?? direction ?? fallback;
  if (found) used.add(found.id);
  return found;
}
