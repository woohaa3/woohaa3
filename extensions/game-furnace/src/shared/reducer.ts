/**
 * 游戏炼丹炉共享契约：操作、纯 reducer、逆操作、复制与默认项目
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.3 / design D2/D4）。
 *
 * 纯函数叶子：不 import 宿主 store、Provider、数据库、DOM 或 Node API。
 */
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import {
  MAX_BUILDS,
  MAX_CATEGORY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_GENERATIONS,
  MAX_NAME_LENGTH,
  MAX_RESOURCES,
  type GameBuild,
  type GameFurnaceState,
  type GameGeneration,
  type GameRequirements,
  type GameResource,
  type GameResourceInput
} from "./types.js";
import { normalizeResource } from "./resources.js";
import { boundedString, isId, isObject } from "./util.js";
import { validateGameFurnaceState, validateGeneration, validateBuild } from "./content.js";

export type GameFurnaceOperation =
  | { type: "project.init"; projectId: string }
  | { type: "resources.add"; resources: GameResourceInput[] }
  | { type: "resources.remove"; resourceIds: string[] }
  | {
      type: "resources.update";
      updates: { resourceId: string; name?: string; category?: string; description?: string }[];
    }
  | { type: "requirements.patch"; patch: Partial<GameRequirements> }
  | { type: "generation.link"; generation: GameGeneration }
  | { type: "generation.disposition"; generationId: string; disposition: GameGeneration["disposition"]; candidateBuildId?: string; diagnostic?: string; latest?: boolean }
  | { type: "build.register"; build: GameBuild }
  | { type: "build.remove"; buildId: string }
  | { type: "build.activate"; buildId: string };

function cloneState(state: Woohaa3CanvasJsonObject): GameFurnaceState {
  return structuredClone(state) as GameFurnaceState;
}

/**
 * 纯 reducer。**整批原子**：任一操作非法则抛错，调用方不发布任何部分状态（任务 1.3）。
 */
export function reduceGameFurnace(state: Woohaa3CanvasJsonObject, operations: readonly Woohaa3CanvasJsonObject[]): Woohaa3CanvasJsonObject {
  let next = cloneState(state);
  for (const operation of operations as unknown as GameFurnaceOperation[]) {
    next = applyOperation(next, operation);
  }
  return next;
}

function applyOperation(state: GameFurnaceState, operation: GameFurnaceOperation): GameFurnaceState {
  if (!isObject(operation) || typeof (operation as { type?: unknown }).type !== "string") {
    throw new Error("游戏炼丹炉操作非法");
  }
  switch (operation.type) {
    case "project.init": {
      if (!isId(operation.projectId)) throw new Error("projectId 非法");
      return { ...state, projectId: operation.projectId };
    }
    case "resources.add": {
      if (!Array.isArray(operation.resources) || operation.resources.length === 0) throw new Error("没有可添加的素材");
      const existing = new Set(state.resources.map((resource) => resource.resourceId));
      const added: GameResource[] = [];
      for (const input of operation.resources) {
        const normalized = normalizeResource(input);
        // 同 operationId 重试幂等：已存在同 ID 直接跳过（不重复添加）。
        if (existing.has(normalized.resourceId)) continue;
        existing.add(normalized.resourceId);
        added.push(normalized);
      }
      if (state.resources.length + added.length > MAX_RESOURCES) throw new Error("素材数量超限");
      if (added.length === 0) return state;
      return { ...state, resources: [...state.resources, ...added] };
    }
    case "resources.remove": {
      if (!Array.isArray(operation.resourceIds)) throw new Error("resourceIds 非法");
      const remove = new Set(operation.resourceIds);
      const resources = state.resources.filter((resource) => !remove.has(resource.resourceId));
      if (resources.length === state.resources.length) return state;
      return { ...state, resources };
    }
    case "resources.update": {
      if (!Array.isArray(operation.updates)) throw new Error("updates 非法");
      const updates = operation.updates;
      const resources = state.resources.map((resource) => {
        const patch = updates.find((candidate) => candidate.resourceId === resource.resourceId);
        if (!patch) return resource;
        const name = patch.name !== undefined ? boundedString(patch.name, MAX_NAME_LENGTH) : resource.name;
        if (name === null || name.trim() === "") throw new Error("素材名称非法");
        const category = patch.category !== undefined ? boundedString(patch.category, MAX_CATEGORY_LENGTH) : resource.category;
        if (category === null) throw new Error("素材分类超长");
        const description = patch.description !== undefined ? boundedString(patch.description, MAX_DESCRIPTION_LENGTH) : resource.description;
        if (description === null) throw new Error("素材描述超长");
        return { ...resource, name: name.trim(), category: category.trim() || resource.category, description };
      });
      return { ...state, resources };
    }
    case "requirements.patch": {
      const requirements: GameRequirements = { ...state.requirements };
      const patch = operation.patch as Record<string, unknown>;
      if (patch.name !== undefined) {
        const name = boundedString(patch.name, MAX_NAME_LENGTH);
        if (name === null) throw new Error("游戏名称超长");
        requirements.name = name;
      }
      if (patch.description !== undefined) {
        const description = boundedString(patch.description, MAX_DESCRIPTION_LENGTH);
        if (description === null) throw new Error("游戏描述超长");
        requirements.description = description;
      }
      if (patch.gameplay !== undefined) {
        const gameplay = boundedString(patch.gameplay, MAX_DESCRIPTION_LENGTH);
        if (gameplay === null) throw new Error("玩法描述超长");
        if (gameplay === "") delete requirements.gameplay;
        else requirements.gameplay = gameplay;
      }
      if (patch.modelKey !== undefined) {
        const modelKey = boundedString(patch.modelKey, 200);
        if (modelKey === null) throw new Error("模型选择超长");
        if (modelKey === "") delete requirements.modelKey;
        else requirements.modelKey = modelKey;
      }
      return { ...state, requirements };
    }
    case "generation.link": {
      const generation = validateGeneration(operation.generation);
      const generations = state.generations.filter((candidate) => candidate.generationId !== generation.generationId);
      generations.push(generation);
      // 有界保留：丢最旧记录（保留策略由后端/宿主配置，UI 不无限增长）。
      const trimmed = generations.length > MAX_GENERATIONS ? generations.slice(generations.length - MAX_GENERATIONS) : generations;
      return { ...state, generations: trimmed, latestGenerationId: generation.generationId };
    }
    case "generation.disposition": {
      const generation = state.generations.find((candidate) => candidate.generationId === operation.generationId);
      if (!generation) throw new Error("generation 不存在");
      const next = state.generations.map((candidate) =>
        candidate.generationId === operation.generationId
          ? {
              ...candidate,
              ...(operation.disposition ? { disposition: operation.disposition } : {}),
              ...(operation.candidateBuildId ? { candidateBuildId: operation.candidateBuildId } : {}),
              ...(operation.diagnostic !== undefined ? { lastSafeDiagnostic: operation.diagnostic } : {})
            }
          : candidate
      );
      return { ...state, generations: next, ...(operation.latest ? { latestGenerationId: operation.generationId } : {}) };
    }
    case "build.register": {
      const build = validateBuild(operation.build);
      const builds = state.builds.filter((candidate) => candidate.buildId !== build.buildId);
      builds.push(build);
      const trimmed = builds.length > MAX_BUILDS ? builds.slice(builds.length - MAX_BUILDS) : builds;
      return { ...state, builds: trimmed };
    }
    case "build.remove": {
      const builds = state.builds.filter((candidate) => candidate.buildId !== operation.buildId);
      if (builds.length === state.builds.length) return state;
      const next: GameFurnaceState = { ...state, builds };
      if (next.activeBuildId === operation.buildId) delete next.activeBuildId;
      return next;
    }
    case "build.activate": {
      if (!state.builds.some((build) => build.buildId === operation.buildId)) throw new Error("build 不存在");
      return { ...state, activeBuildId: operation.buildId };
    }
    default:
      throw new Error(`未知的游戏炼丹炉操作：${(operation as { type: string }).type}`);
  }
}

/**
 * 逆操作：返回把 `state`（reduce **之前**的状态）恢复所需的操作（按需逆序执行）。
 * 调用方用它支持一次 undo（任务 1.3）。
 */
export function invertGameFurnace(stateBefore: Woohaa3CanvasJsonObject, operations: readonly Woohaa3CanvasJsonObject[]): Woohaa3CanvasJsonObject[] {
  const inverse: Woohaa3CanvasJsonObject[] = [];
  let current = cloneState(stateBefore);
  for (const operation of operations as unknown as GameFurnaceOperation[]) {
    // 依据**执行前**的状态推导逆操作，再前进一步。
    switch (operation.type) {
      case "resources.add": {
        const existing = new Set(current.resources.map((resource) => resource.resourceId));
        const addedIds = operation.resources
          .map((input) => input.resourceId)
          .filter((id) => !existing.has(id));
        if (addedIds.length > 0) inverse.unshift({ type: "resources.remove", resourceIds: addedIds });
        break;
      }
      case "resources.remove": {
        const removed = operation.resourceIds
          .map((id) => current.resources.find((resource) => resource.resourceId === id))
          .filter((resource): resource is GameResource => !!resource)
          .map((resource) => structuredClone(resource) as unknown as GameResourceInput);
        if (removed.length > 0) inverse.unshift({ type: "resources.add", resources: removed });
        break;
      }
      case "resources.update": {
        const previous = operation.updates
          .map((patch) => {
            const resource = current.resources.find((candidate) => candidate.resourceId === patch.resourceId);
            return resource ? { resourceId: resource.resourceId, name: resource.name, category: resource.category, description: resource.description } : null;
          })
          .filter((entry): entry is { resourceId: string; name: string; category: string; description: string } => !!entry);
        if (previous.length > 0) inverse.unshift({ type: "resources.update", updates: previous });
        break;
      }
      case "requirements.patch": {
        const previous: Partial<GameRequirements> = {};
        const requirements = current.requirements;
        const patch = operation.patch as Record<string, unknown>;
        for (const key of ["name", "description", "gameplay", "modelKey"] as const) {
          if (patch[key] !== undefined) {
            const value = requirements[key];
            previous[key] = value === undefined ? "" : (value as never);
          }
        }
        inverse.unshift({ type: "requirements.patch", patch: previous });
        break;
      }
      case "generation.link": {
        const existed = current.generations.some((candidate) => candidate.generationId === operation.generation.generationId);
        if (!existed) {
          inverse.unshift({ type: "generation.disposition", generationId: operation.generation.generationId, disposition: "discarded" });
        }
        break;
      }
      case "generation.disposition": {
        const generation = current.generations.find((candidate) => candidate.generationId === operation.generationId);
        if (generation) {
          inverse.unshift({
            type: "generation.disposition",
            generationId: operation.generationId,
            disposition: generation.disposition ?? "candidate",
            ...(generation.candidateBuildId ? { candidateBuildId: generation.candidateBuildId } : {}),
            ...(generation.lastSafeDiagnostic !== undefined ? { diagnostic: generation.lastSafeDiagnostic } : {})
          });
        }
        break;
      }
      case "build.register": {
        const existed = current.builds.some((candidate) => candidate.buildId === operation.build.buildId);
        if (!existed) inverse.unshift({ type: "build.remove", buildId: operation.build.buildId });
        break;
      }
      case "build.activate": {
        if (current.activeBuildId !== undefined) {
          inverse.unshift({ type: "build.activate", buildId: current.activeBuildId });
        }
        break;
      }
      case "project.init":
        // 新建项目不可逆（由更外层 duplicate/restore 处理）。
        break;
      default:
        break;
    }
    current = applyOperation(current, operation);
  }
  return inverse;
}

/**
 * 复制项目：重写局部身份（project/resource/generation/build），不复制活动执行。
 *
 * 所有跨记录引用都必须指向**重写后**的身份（任务 7.9）：generation 的 `candidateBuildId`
 * 与 build 的 `generationId` 都要重映射，否则复制项会留下指向旧身份的悬空引用。先分配全部
 * build 身份，再据此重映射 generation，避免复制后出现已不存在的 build 引用。
 */
export function duplicateGameFurnace(state: Woohaa3CanvasJsonObject, newId: () => string): Woohaa3CanvasJsonObject {
  const source = cloneState(state);
  const resourceIdMap = new Map<string, string>();
  const resources = source.resources.map((resource) => {
    const resourceId = newId();
    resourceIdMap.set(resource.resourceId, resourceId);
    return { ...resource, resourceId };
  });
  // 历史版本可引用已移除的素材；其内部身份也必须重写。
  for (const build of source.builds) for (const resource of build.resources) {
    if (!resourceIdMap.has(resource.resourceId)) resourceIdMap.set(resource.resourceId, newId());
  }
  // 先分配全部 build 身份，使 generation.candidateBuildId 可以重映射到新 build。
  const buildIdMap = new Map<string, string>();
  for (const build of source.builds) buildIdMap.set(build.buildId, newId());
  const generationIdMap = new Map<string, string>();
  const generations = source.generations.map((generation) => {
    const generationId = newId();
    generationIdMap.set(generation.generationId, generationId);
    const rest = { ...generation } as GameGeneration & { workId?: string };
    delete rest.workId;
    delete rest.pluginConfigVersion;
    delete rest.candidateBuildId;
    const candidateBuildId = generation.candidateBuildId ? buildIdMap.get(generation.candidateBuildId) : undefined;
    return {
      ...rest,
      generationId,
      workerTaskKey: `detached-${generationId}`,
      executionDetached: true as const,
      disposition: candidateBuildId ? "candidate" as const : "discarded" as const,
      // 只保留指向**新** build 的候选引用；悬空候选被丢弃，不复制失效身份。
      ...(candidateBuildId ? { candidateBuildId } : {})
    };
  });
  const buildGenerationId = (generationId: string): string => {
    const existing = generationIdMap.get(generationId);
    if (existing) return existing;
    const allocated = newId();
    generationIdMap.set(generationId, allocated);
    return allocated;
  };
  const builds = source.builds.map((build) => ({
    ...build,
    buildId: buildIdMap.get(build.buildId)!,
    generationId: buildGenerationId(build.generationId),
    resources: build.resources.map((entry) => ({ ...entry, resourceId: resourceIdMap.get(entry.resourceId) ?? entry.resourceId }))
  }));
  const next: GameFurnaceState = {
    ...source,
    projectId: newId(),
    resources,
    generations,
    builds
  };
  // 保留已保存游戏，重写 activeBuild；不保留当前执行/原节点所有权。
  if (source.activeBuildId && buildIdMap.has(source.activeBuildId)) next.activeBuildId = buildIdMap.get(source.activeBuildId);
  else delete next.activeBuildId;
  delete next.latestGenerationId;
  delete next.projectOwner;
  return next as unknown as Woohaa3CanvasJsonObject;
}

/** 新建项目默认内容。 */
export function createGameFurnaceState(projectId: string): Woohaa3CanvasJsonObject {
  const state: GameFurnaceState = {
    projectId,
    resources: [],
    requirements: { name: "", description: "" },
    generations: [],
    builds: []
  };
  return state as unknown as Woohaa3CanvasJsonObject;
}

/** 校验入口再导出（避免重复实现）。 */
export { validateGameFurnaceState };
