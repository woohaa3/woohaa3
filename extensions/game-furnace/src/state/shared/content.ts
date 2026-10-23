/**
 * 游戏炼丹炉共享契约：内容身份（hash）、references 与状态校验
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.1–1.5 / design D5/D7）。
 *
 * 纯函数叶子：不 import 宿主 store、Provider、数据库、DOM 或 Node API。
 */
import { fnv1a64Hex, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { GAME_POLICY_VERSION, MAX_BUILDS, MAX_BUILD_DEPENDENCIES, MAX_DESCRIPTION_LENGTH, MAX_GENERATIONS, MAX_NAME_LENGTH, MAX_RESOURCES, type GameBuild, type GameFurnaceState, type GameGeneration, type GameResource, type GameResourceInput } from "./types.js";
import { normalizeResource } from "./resources.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// ---------------------------------------------------------------------------
// 内容身份（hash）：排除位置、hover、选择、任务进度、GPU 与试玩状态
// ---------------------------------------------------------------------------

/** 确定性 canonical JSON（对象键排序），供 hash 使用。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });
}

/** 单个素材的内容身份（参与生成输入快照）。 */
export function resourceContentHash(resource: GameResource): string {
  return fnv1a64Hex(
    canonical({
      kind: resource.kind,
      category: resource.category,
      description: resource.description,
      payload: resource.payload,
      metadata: resource.metadata ?? null
    })
  );
}

/** build/source 内容身份。 */
export function buildContentHash(input: {
  inputHash: string;
  sourceHash: string;
  policyVersion: string;
  dependencyAssetIds: readonly string[];
}): string {
  return fnv1a64Hex(
    canonical({
      inputHash: input.inputHash,
      sourceHash: input.sourceHash,
      policyVersion: input.policyVersion,
      dependencyAssetIds: [...input.dependencyAssetIds].sort()
    })
  );
}

/**
 * 生成输入身份（inputHash）；参与生成的分类/描述/需求/模型/策略/素材内容与稳定依赖都使
 * 其变化（任务 1.4）。**不包含**位置、hover、选择、任务进度、GPU 或试玩状态。
 */
export function computeInputHash(state: GameFurnaceState): string {
  return fnv1a64Hex(
    canonical({
      policyVersion: GAME_POLICY_VERSION,
      requirements: {
        name: state.requirements.name,
        description: state.requirements.description,
        gameplay: state.requirements.gameplay ?? "",
        modelKey: state.requirements.modelKey ?? ""
      },
      resources: [...state.resources]
        .map((resource) => ({
          resourceId: resource.resourceId,
          kind: resource.kind,
          category: resource.category,
          description: resource.description,
          contentHash: resourceContentHash(resource),
          assetIds: [...resource.payload.assetIds].sort()
        }))
        .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))
    })
  );
}

/**
 * projectId 与来源无关的稳定身份：同一 canvasId/nodeId 始终得到同一 projectId，使跨画布
 * 导入与刷新恢复不改变项目事实源（任务 1.4）。
 */
export function projectIdFor(canvasId: string, nodeId: string): string {
  return `gf-${fnv1a64Hex(`${canvasId}\0${nodeId}`)}`;
}

// ---------------------------------------------------------------------------
// references（供扩展内容原子派生 assetReferences）
// ---------------------------------------------------------------------------

/** 提取项目所有仍保留版本的稳定资产引用（不 stringify 字符串匹配）。 */
export function gameFurnaceReferences(state: GameFurnaceState): readonly string[] {
  const refs = new Set<string>();
  for (const resource of state.resources) {
    for (const id of resource.payload.assetIds) refs.add(id);
    if (resource.metadata?.previewAssetId) refs.add(resource.metadata.previewAssetId);
  }
  for (const generation of state.generations) {
    if (generation.inputManifestAssetId) refs.add(generation.inputManifestAssetId);
  }
  for (const build of state.builds) {
    refs.add(build.manifestAssetId);
    refs.add(build.sourceAssetId);
    for (const id of build.dependencyAssetIds) refs.add(id);
  }
  return [...refs].sort();
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export function validateGameFurnaceState(state: Woohaa3CanvasJsonObject): void {
  if (!isObject(state)) throw new Error("游戏炼丹炉内容必须是对象");
  if (typeof state.projectId !== "string" || state.projectId.length === 0) throw new Error("缺少 projectId");
  if (state.projectOwner !== undefined && (!isObject(state.projectOwner) || typeof state.projectOwner.canvasId !== "string" ||
    !state.projectOwner.canvasId || typeof state.projectOwner.nodeId !== "string" || !state.projectOwner.nodeId)) throw new Error("projectOwner 非法");
  if (!Array.isArray(state.resources)) throw new Error("resources 必须是数组");
  if (state.resources.length > MAX_RESOURCES) throw new Error("素材数量超限");
  const ids = new Set<string>();
  for (const resource of state.resources as unknown[]) {
    const normalized = normalizeResource(resource as GameResourceInput);
    if (ids.has(normalized.resourceId)) throw new Error(`素材 ID 重复：${normalized.resourceId}`);
    ids.add(normalized.resourceId);
  }
  const requirements = state.requirements as unknown;
  if (!isObject(requirements)) throw new Error("requirements 必须是对象");
  validateRequirements(requirements);
  if (!Array.isArray(state.generations) || state.generations.length > MAX_GENERATIONS) throw new Error("generations 非法或超限");
  for (const generation of state.generations as unknown[]) validateGeneration(generation);
  if (!Array.isArray(state.builds) || state.builds.length > MAX_BUILDS) throw new Error("builds 非法或超限");
  const buildIds = new Set<string>();
  for (const build of state.builds as unknown[]) {
    const normalized = validateBuild(build);
    if (buildIds.has(normalized.buildId)) throw new Error(`build ID 重复：${normalized.buildId}`);
    buildIds.add(normalized.buildId);
  }
  if (state.activeBuildId !== undefined && !buildIds.has(String(state.activeBuildId))) {
    throw new Error("activeBuildId 指向不存在的 build");
  }
  if (state.latestGenerationId !== undefined) {
    const genIds = new Set((state.generations as GameGeneration[]).map((g) => g.generationId));
    if (!genIds.has(String(state.latestGenerationId))) throw new Error("latestGenerationId 指向不存在的 generation");
  }
}

function validateRequirements(value: Record<string, unknown>): void {
  if (typeof value.name !== "string" || value.name.length > MAX_NAME_LENGTH) throw new Error("游戏名称非法");
  if (typeof value.description !== "string" || value.description.length > MAX_DESCRIPTION_LENGTH) throw new Error("游戏描述非法");
  if (value.gameplay !== undefined && (typeof value.gameplay !== "string" || value.gameplay.length > MAX_DESCRIPTION_LENGTH)) {
    throw new Error("玩法描述非法");
  }
  if (value.modelKey !== undefined && (typeof value.modelKey !== "string" || value.modelKey.length > 200)) throw new Error("模型选择非法");
}

export function validateGeneration(value: unknown): GameGeneration {
  if (!isObject(value) || !isId(value.generationId) || typeof value.workerTaskKey !== "string" || typeof value.inputHash !== "string") {
    throw new Error("generation 记录非法");
  }
  if (value.origin !== undefined && value.origin !== "agent" && value.origin !== "model") throw new Error("generation.origin 非法");
  if (value.executionDetached !== undefined && value.executionDetached !== true) throw new Error("generation.executionDetached 非法");
  if (typeof value.admittedAt !== "string") throw new Error("generation.admittedAt 非法");
  if (value.disposition !== undefined && !["candidate", "active", "discarded", "failed", "cancelled"].includes(String(value.disposition))) {
    throw new Error("generation.disposition 非法");
  }
  return structuredClone(value) as unknown as GameGeneration;
}

export function validateBuild(value: unknown): GameBuild {
  if (
    !isObject(value) ||
    !isId(value.buildId) ||
    typeof value.generationId !== "string" ||
    typeof value.inputHash !== "string" ||
    typeof value.manifestAssetId !== "string" ||
    typeof value.sourceAssetId !== "string" ||
    typeof value.sourceHash !== "string" ||
    typeof value.policyVersion !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.title !== "string" ||
    typeof value.controlsSummary !== "string"
  ) {
    throw new Error("build 记录非法");
  }
  if (!Array.isArray(value.dependencyAssetIds) || value.dependencyAssetIds.length > MAX_BUILD_DEPENDENCIES) {
    throw new Error("build 依赖超限或非法");
  }
  if (!Array.isArray(value.resources)) throw new Error("build.resources 非法");
  return structuredClone(value) as unknown as GameBuild;
}
