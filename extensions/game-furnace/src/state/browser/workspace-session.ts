/**
 * 游戏炼丹炉工作区纯会话模型
 * （change: 2026-10-10-add-game-furnace-extension，任务 5.5/5.6/5.7 / design D5）。
 *
 * 纯函数：不做 DOM、网络或宿主 store 访问。工作区组件把「权威项目状态 + 用户字段草稿」交给
 * 这里合并，得到可呈现视图与可提交判定；草稿按字段合并（`undefined` 表示未编辑），因此远端
 * 新增素材、任务消息或同字段冲突不会因一次渲染就清空草稿（任务 5.5）。
 */
import { validateGameFurnaceState, type GameBuild, type GameFurnaceState, type GameGeneration, type GameRequirements, type GameResource } from "../shared/index.js";
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { reduceGameFurnace } from "../shared/index.js";

/** 生成前置：名称/描述必填（与后端 `validateRequirements` 同语义，前端不导入后端实现）。 */
function requirementsComplete(requirements: GameRequirements): boolean {
  return requirements.name.trim() !== "" && requirements.description.trim() !== "";
}

/** 需求字段草稿（缺省键表示未编辑，保留权威值）。 */
export type RequirementsDraft = Partial<Pick<GameRequirements, "name" | "description" | "gameplay" | "modelKey">>;

/** 可呈现的工作区视图。 */
export type GameFurnaceWorkspaceView = {
  requirements: GameRequirements;
  resources: readonly GameResource[];
  builds: readonly GameBuild[];
  generations: readonly GameGeneration[];
  activeBuildId?: string;
  latestGenerationId?: string;
  /** 尚未保存的字段草稿（用于「保存状态可见」）。 */
  dirtyFields: readonly (keyof RequirementsDraft)[];
  /** 需求是否满足生成前置（名称/描述必填）。 */
  canGenerate: boolean;
  /** 当前输入是否已在服务端确认（有 storageKey + inputHash）。 */
  saved: boolean;
};

function asState(value: Woohaa3CanvasJsonObject | null | undefined): GameFurnaceState | null {
  if (!value) return null;
  try {
    validateGameFurnaceState(value);
    return value as unknown as GameFurnaceState;
  } catch {
    return null;
  }
}

/** 把权威状态与草稿合并为最终需求（草稿优先，空串表示显式清空可选字段）。 */
export function mergedRequirements(state: GameRequirements, draft: RequirementsDraft): GameRequirements {
  const merged: GameRequirements = { ...state };
  if (draft.name !== undefined) merged.name = draft.name;
  if (draft.description !== undefined) merged.description = draft.description;
  if (draft.gameplay !== undefined) {
    if (draft.gameplay === "") delete merged.gameplay;
    else merged.gameplay = draft.gameplay;
  }
  if (draft.modelKey !== undefined) {
    if (draft.modelKey === "") delete merged.modelKey;
    else merged.modelKey = draft.modelKey;
  }
  return merged;
}

/** 计算草稿中相对权威值确实变化的字段（用于 dirty 指示与保存提交）。 */
export function dirtyRequirementFields(state: GameRequirements, draft: RequirementsDraft): (keyof RequirementsDraft)[] {
  const dirty: (keyof RequirementsDraft)[] = [];
  const base: Record<string, string | undefined> = {
    name: state.name,
    description: state.description,
    gameplay: state.gameplay,
    modelKey: state.modelKey
  };
  for (const key of ["name", "description", "gameplay", "modelKey"] as const) {
    if (draft[key] === undefined) continue;
    const next = draft[key] === "" ? undefined : draft[key];
    if (next !== base[key]) dirty.push(key);
  }
  return dirty;
}

/**
 * 构造保存命令：把合并后的需求写入状态。无脏字段时返回 `null`（无操作，不产生空保存）。
 *
 * 生成前必须先保存，确保服务端锁定的输入与用户看到的一致（任务 5.6）。
 */
export function planSaveState(
  state: Woohaa3CanvasJsonObject | null,
  requirements: GameRequirements
): Woohaa3CanvasJsonObject | null {
  const current = asState(state);
  if (!current) return null;
  const operations = [{ type: "requirements.patch", patch: { ...requirements, gameplay: requirements.gameplay ?? "", modelKey: requirements.modelKey ?? "" } }];
  return reduceGameFurnace(current, operations as unknown as Woohaa3CanvasJsonObject[]);
}

/** 呈现视图。 */
export function workspaceView(input: {
  state: Woohaa3CanvasJsonObject | null;
  draft: RequirementsDraft;
  saved: boolean;
}): GameFurnaceWorkspaceView {
  const state = asState(input.state);
  if (!state) {
    return {
      requirements: mergedRequirements({ name: "", description: "" }, input.draft),
      resources: [],
      builds: [],
      generations: [],
      dirtyFields: dirtyRequirementFields({ name: "", description: "" }, input.draft),
      canGenerate: false,
      saved: false
    };
  }
  const requirements = mergedRequirements(state.requirements, input.draft);
  return {
    requirements,
    resources: state.resources,
    builds: state.builds,
    generations: state.generations,
    ...(state.activeBuildId ? { activeBuildId: state.activeBuildId } : {}),
    ...(state.latestGenerationId ? { latestGenerationId: state.latestGenerationId } : {}),
    dirtyFields: dirtyRequirementFields(state.requirements, input.draft),
    canGenerate: requirementsComplete(requirements),
    saved: input.saved && dirtyRequirementFields(state.requirements, input.draft).length === 0
  };
}

/** 生成中的安全摘要（阶段/错误），不把任务状态作为第二事实源。 */
export type GenerationPhase = "idle" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export function generationPhase(view: GameFurnaceWorkspaceView): GenerationPhase {
  if (!view.latestGenerationId) return "idle";
  const latest = view.generations.find((generation) => generation.generationId === view.latestGenerationId);
  if (!latest) return "idle";
  if (latest.disposition === "failed") return "failed";
  if (latest.disposition === "cancelled") return "cancelled";
  return latest.disposition === "active" || latest.candidateBuildId ? "succeeded" : "running";
}

/**
 * 真实阶段 label（任务 6.8）：接通 queued/running/validating/storing/succeeded/failed/cancelled
 * 与未知连接状态；未知/未映射值一律显示为「状态暂不可确认」，不编造进度。
 *
 * 输入是 Task/项目派生的安全阶段串（不暴露远端正文）；函数是纯映射。
 */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "idle": return "未生成";
    case "queued": return "排队中";
    case "running":
    case "executing": return "生成中";
    case "validating": return "校验结果中";
    case "storing": return "保存构建中";
    case "succeeded": return "已有可用版本";
    case "failed": return "生成失败";
    case "cancelled": return "已取消";
    default: return "状态暂不可确认";
  }
}

/** 正在处理（未到终态）的安全阶段，用于显示取消入口。 */
export function isPhaseInProgress(phase: string): boolean {
  return ["queued", "running", "executing", "validating", "storing", "unknown", "pending"].includes(phase);
}
