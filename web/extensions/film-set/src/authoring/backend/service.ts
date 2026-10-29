import { readFilmSetGroupMarker, createFilmSetGroupMarker, migrateLegacyFilmSetToGroup, readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { canonicalFilmSetFields, filmSetAnimationsOf, filmSetClipHash, filmSetClipPatchCommand, filmSetClipPrecondition } from "@woohaa3/contracts";
import type { CanvasAuthority } from "@woohaa3/contracts";
import type { CanvasCommand, CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import { animationSnapshotHash, createFilmSetSnapshot, createModelSnapshot, decodeFilmSetNodeData, scriptModel3DNodeData, defaultInitialShotCamera, importModelSnapshot, COMPOSITE_ASSET_NODE_TYPE, FILM_SET_EXTENSION_ID, modelSourceHash, normalizeModelDefinition, isJsonObject, validateSelfContainedModel, type FilmSetNodeData, type AnimationTimeline, type InitialShotCamera, type ModelImportOrigin, type ModelPlacement, type SupportedModelScriptVersion } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type { FilmSetNodeOutcome, ReadFilmSetOutcome } from "@woohaa3/contracts";

/**
 * 三维模型 / 动画节点权威写入服务
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 2.1–2.4）。
 *
 * 独占「从模型创建动画 / 直接创建 / 导入模型快照 / 编辑本节点模型 / 确认适配 / 一次性保存」的
 * 权威写入路径。所有写入都经既有 `CanvasAuthority.submitDerived` 串行读改写与幂等回执，复用既有
 * `CanvasCommand` 集合（`node.add` / `nodeData.patch` / `edge.add`），不新增第二套命令类型。
 *
 * 来源连线只作说明：创建时可选地加一条 edge，但删除来源节点、连线都不影响动画数据；导入与
 * 编辑本节点模型都不修改来源或其他节点。
 */

/** 动画节点服务依赖。 */
export type FilmSetNodeServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  now?: () => string;
  actorId?: string;
};

export type { FilmSetNodeOutcome, ReadFilmSetOutcome };

/** 模型源码快照来源（直接给出，或从来源节点读取）。 */
export type ModelSourceInput = {
  modelScript: string;
  modelScriptVersion: SupportedModelScriptVersion;
  placement?: ModelPlacement;
};

export type CreateFilmSetInput = {
  canvasId: string;
  requestId: string;
  /** 稳定节点 ID（由调用方生成，保证幂等重试落到同一实体）。 */
  nodeId: string;
  position: { x: number; y: number };
  model: ModelSourceInput;
  title?: string;
  motionScript?: string;
  timeline?: AnimationTimeline;
  initialCamera?: InitialShotCamera;
  origin?: ModelImportOrigin;
};

export type CreateFilmSetFromNodeInput = Omit<CreateFilmSetInput, "model" | "origin"> & {
  sourceNodeId: string;
};

export type EditModelInput = {
  canvasId: string;
  requestId: string;
  nodeId: string;
  /** 目标 model item 的稳定 ID（items-only 下片场无顶层模型）。 */
  itemId: string;
  modelScript: string;
  modelScriptVersion: SupportedModelScriptVersion;
  placement?: ModelPlacement;
  /** 可选并发 precondition：当前模型源码哈希。 */
  expectedSourceHash?: string;
  title?: string;
};

export type ConfirmAdaptationInput = {
  canvasId: string;
  requestId: string;
  nodeId: string;
  /** 可选并发 precondition：当前 snapshotHash。 */
  expectedSnapshotHash?: string;
  /** 目标片段（D10 片段级确认）。 */
  clipId: string;
  /** 目标对象 binding 的稳定 itemId。 */
  itemId: string;
  /** 该 item 当前适配身份（`filmSetItemAdapterHash`）。 */
  expectedAdapterHash: string;
};

export type CommitFilmSetInput = {
  canvasId: string;
  requestId: string;
  nodeId: string;
  animation: FilmSetNodeData;
  /** 本节点当前 snapshotHash；不一致时拒绝，防止覆盖并发修改。 */
  expectedSnapshotHash?: string;
  clipId?: string;
  expectedClipHash?: string;
  title?: string;
};

/** 读取完整动画定义结果（生成层构造完整提交前读取权威当前定义）。 */

export class FilmSetNodeService {
  private readonly deps: FilmSetNodeServiceDependencies;
  private readonly actorId: string;

  constructor(deps: FilmSetNodeServiceDependencies) {
    this.deps = deps;
    this.actorId = deps.actorId ?? "canvas-model-mcp";
  }

  /** 从显式模型定义创建动画节点（直接创建，不建立来源连线）。 */
  async createFilmSet(input: CreateFilmSetInput): Promise<FilmSetNodeOutcome> {
    return this.applyDerived(input, (canvas) => {
      const animation = createFilmSetSnapshot({
        title: input.title ?? "动画",
        model: { ...input.model },
        motionScript: input.motionScript ?? "",
        timeline: input.timeline ?? { duration: 0, loop: false },
        ...(input.initialCamera ? { initialCamera: input.initialCamera } : {}),
        ...(input.origin ? { origin: input.origin } : {})
      });
      void canvas;
      return this.buildFilmSetAddCommands(canvas, input, animation);
    });
  }

  /** 从模型节点读取完整定义并复制为新的动画节点（design「创建和导入是复制快照」）。 */
  async createFilmSetFromNode(input: CreateFilmSetFromNodeInput): Promise<FilmSetNodeOutcome> {
    return this.applyDerived(input, (canvas) => {
      const source = resolveNodeModelSource(canvas, input.sourceNodeId);
      if (!source.ok) return source;
      const animation = createFilmSetSnapshot({
        title: input.title ?? "动画",
        model: source.value,
        motionScript: input.motionScript ?? "",
        timeline: input.timeline ?? { duration: 0, loop: false },
        ...(input.initialCamera ? { initialCamera: input.initialCamera } : {}),
        origin: {
          sourceNodeId: input.sourceNodeId,
          importedModelContentHash: createModelSnapshot({ ...source.value }).contentVersion.contentHash,
          importedAt: this.deps.now?.() ?? new Date().toISOString()
        }
      });
      return this.buildFilmSetAddCommands(canvas, input, animation);
    });
  }

  /**
   * 导入/替换**指定 model item** 的模型快照（items-only，D8）。
   *
   * 片场不再有顶层模型，故必须显式传入目标 `itemId`；保留该 item 的 binding 动作与旧适配版本。
   */
  async importModel(input: EditModelInput): Promise<FilmSetNodeOutcome> {
    return this.applyDerived(input, (canvas) => {
      const current = readFilmSet(canvas, input.nodeId);
      if (!current.ok) return current;
      if (!input.itemId) return { ok: false, code: "item-required", message: "片场模型导入必须指定 itemId" };
      const item = current.value.filmSetContent.items.find(entry => entry.id === input.itemId);
      if (!item || item.kind !== "model") return { ok: false, code: "unknown-item", message: `片场模型对象 ${input.itemId} 不存在` };
      if (input.expectedSourceHash && modelSourceHash(item.model.modelScript) !== input.expectedSourceHash) {
        return { ok: false, code: "stale-source", message: "模型源码已被并发修改" };
      }
      // 权威可执行性/静态性校验（任务 1.3）：非法模型或含旧动画声明的脚本整批拒绝。
      const validity = validateSelfContainedModel(input.modelScript, input.modelScriptVersion);
      if (!validity.ok) return validity;
      const next = importModelSnapshot(current.value, input.itemId, {
        modelScript: input.modelScript,
        modelScriptVersion: input.modelScriptVersion,
        ...(input.placement ? { placement: input.placement } : {})
      });
      return this.patchFilmSet(canvas, input, next, input.title);
    });
  }

  /** 编辑本节点模型（与导入同路径，语义上是用户显式编辑本地模型）。 */
  async editLocalModel(input: EditModelInput): Promise<FilmSetNodeOutcome> {
    return this.importModel(input);
  }

  /** 用户显式确认某片段中某对象的 motion 适配当前 item 模型版本。 */
  async confirmAdaptation(input: ConfirmAdaptationInput): Promise<FilmSetNodeOutcome> {
    return this.applyDerived(input, (canvas) => {
      const current = readFilmSet(canvas, input.nodeId);
      if (!current.ok) return current;
      if (input.expectedSnapshotHash && animationSnapshotHash(current.value) !== input.expectedSnapshotHash) {
        return { ok: false, code: "stale-snapshot", message: "动画节点已被并发修改" };
      }
      const collection = filmSetAnimationsOf(current.value);
      const op = { kind: "confirm-adaptation" as const, itemId: input.itemId, expectedAdapterHash: input.expectedAdapterHash };
      return {
        ok: true,
        commands: [filmSetClipPatchCommand({
          nodeId: input.nodeId,
          clipId: input.clipId,
          op,
          expectedHash: filmSetClipPrecondition(collection, input.clipId, op)
        })]
      };
    });
  }

  /** 读取本节点完整动画定义与 snapshotHash（生成层读取权威当前定义）。 */
  async readNodeFilmSet(input: { canvasId: string; nodeId: string }): Promise<ReadFilmSetOutcome> {
    const room = await this.resolve(input.canvasId);
    if (!room.ok) return { ok: false, code: room.code, message: room.message };
    const exported = room.room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const current = readFilmSet(exported.canvas, input.nodeId);
    if (!current.ok) return { ok: false, code: current.code, message: current.message };
    return { ok: true, animation: current.value };
  }

  /**
   * 一次性保存完整片场定义（items-only + 全部片段），带 snapshot/clip 并发检查。
   *
   * D9/D10：不写顶层模型；几何以 items 表达、对象动作以 binding 表达、镜头按片段独立。
   * 校验全部 model item 可执行且静态后整份原子写入；不隐式丢弃其他对象/片段。
   */
  async commitFilmSet(input: CommitFilmSetInput): Promise<FilmSetNodeOutcome> {
    return this.applyDerived(input, (canvas) => {
      const current = readFilmSet(canvas, input.nodeId);
      if (!current.ok) return current;
      if (input.expectedSnapshotHash && animationSnapshotHash(current.value) !== input.expectedSnapshotHash) {
        return { ok: false, code: "stale-snapshot", message: "动画节点已被并发修改" };
      }
      if (input.clipId) {
        const collection = filmSetAnimationsOf(current.value);
        const clip = collection.clips.find(candidate => candidate.id === input.clipId);
        if (!clip) return { ok: false, code: "unknown-clip", message: "生成目标片段已删除" };
        if (input.expectedClipHash && filmSetClipHash(clip) !== input.expectedClipHash) {
          return { ok: false, code: "stale-clip", message: "生成目标片段已修改" };
        }
      }
      // 新对象无需由助手编造版本/哈希；在权威串行边界按实际源码派生，旧对象按内容推进版本。
      const raw = input.animation;
      if (!isJsonObject(raw) || !isJsonObject(raw.filmSetContent) || !Array.isArray(raw.filmSetContent.items)) {
        return { ok: false, code: "invalid-film-set", message: "片场必须提供完整 filmSetContent.items" };
      }
      const items: unknown[] = [];
      for (const item of raw.filmSetContent.items) {
        if (!isJsonObject(item) || item.kind !== "model") { items.push(item); continue; }
        if (!isJsonObject(item.model)) return { ok: false, code: "invalid-model", message: "模型对象必须提供 model 定义" };
        const previous = current.value.filmSetContent.items.find(candidate => candidate.id === item.id);
        const model = normalizeModelDefinition({
          modelScript: item.model.modelScript, modelScriptLanguage: item.model.modelScriptLanguage,
          modelScriptVersion: item.model.modelScriptVersion, placement: item.model.placement,
          previous: previous?.kind === "model" ? previous.model.contentVersion : null
        });
        if (!model.ok) return { ok: false, code: "invalid-model", message: model.reason };
        items.push({ ...item, model: model.value });
      }
      // camera/timeline 是内部读模型的派生字段，实际持久化仍只接收规范片场字段。
      const { kind: _kind, camera: _camera, timeline: _timeline, ...fields } = raw;
      const decoded = decodeFilmSetNodeData({
        ...canonicalFilmSetFields(current.value), ...fields,
        filmSetContent: { ...raw.filmSetContent, items }
      });
      if (!decoded.ok) return { ok: false, code: "invalid-film-set", message: decoded.reason };
      // 完整提交校验全部 model item 可执行且静态（任务 1.3）。
      for (const item of decoded.value.filmSetContent.items) {
        if (item.kind !== "model") continue;
        const validity = validateSelfContainedModel(item.model.modelScript, item.model.modelScriptVersion);
        if (!validity.ok) return validity;
      }
      return this.patchFilmSet(canvas, input, decoded.value, input.title);
    });
  }

  private async applyDerived(
    input: { canvasId: string; requestId: string; nodeId: string },
    derive: (canvas: ServerCanvas) => { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string }
  ): Promise<FilmSetNodeOutcome> {
    const guard = guardRequest(input.canvasId, input.requestId, input.nodeId);
    if (guard) return { ok: false, code: guard.code, message: guard.message };
    const room = await this.resolve(input.canvasId);
    if (!room.ok) return room;
    const commandId = `animation-node:${input.canvasId}:${input.nodeId}:${input.requestId}`;
    const result = await room.room.submitDerived({
      commandId,
      derive: (canvas) => {
        const derived = derive(canvas);
        if (!derived.ok) return derived;
        return { ok: true, batch: buildBatch(input.canvasId, commandId, this.actorId, canvas.revision, derived.commands) };
      }
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const latest = room.room.exportCanvas();
    const animation = latest.ok ? readFilmSet(latest.canvas, input.nodeId) : { ok: false as const, code: "canvas-unavailable", message: "无法读取提交结果" };
    if (!animation.ok) return { ok: false, code: animation.code, message: animation.message };
    return {
      ok: true,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      commandId,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      animation: animation.value
    };
  }

  private buildFilmSetAddCommands(
    canvas: ServerCanvas,
    input: CreateFilmSetInput | CreateFilmSetFromNodeInput,
    animation: FilmSetNodeData
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    if (canvas.document.nodes.some((node) => node.id === input.nodeId)) {
      return { ok: false, code: "duplicate-node", message: `节点 ${input.nodeId} 已存在` };
    }
    if ("sourceNodeId" in input) {
      animation = { ...animation, filmSetContent: { ...animation.filmSetContent, items: animation.filmSetContent.items.map(item => item.kind === "model" ? { ...item, origin: { ...item.origin, importedAt: item.origin?.importedAt ?? this.deps.now?.() ?? new Date().toISOString(), sourceNodeId: input.sourceNodeId } } : item) } };
    }
    const staged = structuredClone(canvas);
    staged.document.nodes.push({ id: input.nodeId, type: COMPOSITE_ASSET_NODE_TYPE, position: { ...input.position } });
    staged.nodeData[input.nodeId] = { extensionId: FILM_SET_EXTENSION_ID, ...canonicalFilmSetFields(animation) } as CanvasNodeData;
    const migrated = migrateLegacyFilmSetToGroup(staged, input.nodeId, { commandId: input.requestId, groupId: input.nodeId });
    if (!migrated.ok) return { ok: false, code: "invalid-film-set", message: migrated.reason };
    const group = migrated.canvas.document.nodes.find(node => node.id === input.nodeId)!;
    const groupData = migrated.canvas.nodeData[input.nodeId];
    const commands: CanvasCommand[] = [{ type: "node.add", node: group, nodeData: { title: input.title ?? "片场", filmSetGroup: createFilmSetGroupMarker() } as CanvasNodeData }];
    const existing = new Map(canvas.document.nodes.map(node => [node.id, node]));
    for (const node of migrated.canvas.document.nodes) {
      if (node.id === input.nodeId) continue;
      const previous = existing.get(node.id);
      if (!previous) commands.push({ type: "node.add", node, nodeData: migrated.canvas.nodeData[node.id] });
      else if (previous.parentId !== node.parentId) {
        // Existing source cards remain live and are adopted by the new group.
        commands.push({ type: "node.update", nodeId: node.id, parentId: node.parentId });
      }
    }
    commands.push({ type: "nodeData.patch", nodeId: input.nodeId, value: groupData });
    return { ok: true, commands };
  }

  private patchFilmSet(
    canvas: ServerCanvas,
    input: { nodeId: string },
    animation: FilmSetNodeData,
    title?: string
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    const group = readFilmSetGroupMarker(canvas.nodeData[input.nodeId]);
    if (!group) return { ok: false, code: "migration-required", message: "旧片场只读，请先迁移为群组" };
    const marker = createFilmSetGroupMarker(group);
    const items = new Map(animation.filmSetContent.items.map(item => [item.id, item]));
    if (animation.filmSetContent.items.some(item => item.kind !== "ground" && !group.sceneBindings.some(binding => binding.bindingId === item.id))) return { ok: false, code: "source-required", message: "新对象必须从资源卡片导入" };
    const commands: CanvasCommand[] = [];
    marker.sceneBindings = marker.sceneBindings.filter(binding => items.has(binding.bindingId)).map(binding => {
      const item = items.get(binding.bindingId)!;
      const t = item.localTransform;
      if (item.kind === "model") {
        const previous = readFilmSetAnimationProjection(canvas, input.nodeId)?.filmSetContent.items.find(entry => entry.id === item.id);
        if (previous?.kind === "model" && JSON.stringify(previous.model) !== JSON.stringify(item.model)) {
          const { contentVersion, placement, ...fields } = item.model;
          commands.push({ type: "nodeData.patch", nodeId: binding.sourceNodeId, value: { ...fields, modelContentVersion: contentVersion, modelPlacement: placement } as CanvasNodeData });
        }
      }
      return { ...binding, transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale } };
    });
    marker.cameras = [];
    marker.clips = filmSetAnimationsOf(animation).clips.map(clip => {
      const cameraId = `camera:${clip.id}`;
      marker.cameras!.push({ id: cameraId, name: clip.name, ...clip.initialCamera });
      return { id: clip.id, name: clip.name, cameraId, duration: clip.timeline.duration, loop: clip.timeline.loop, cameraMotion: clip.cameraMotion, bindings: clip.bindings, ...(clip.backdrop ? { backdrop: clip.backdrop } : {}) };
    });
    marker.activeClip = filmSetAnimationsOf(animation).defaultClipId;
    commands.push({ type: "nodeData.patch", nodeId: input.nodeId, value: { filmSetGroup: marker, ...(title === undefined ? {} : { title }) } as CanvasNodeData });
    return { ok: true, commands };
  }

  private async resolve(
    canvasId: string
  ): Promise<
    | { ok: true; room: CanvasAuthority; revision: number }
    | { ok: false; code: string; message: string }
  > {
    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    return { ok: true, room, revision: exported.canvas.revision };
  }
}

/** 从自包含 3D 节点复制自身模型源码与摆放（片场取第一个 model item）。 */
export function resolveNodeModelSource(
  canvas: ServerCanvas,
  nodeId: string
): { ok: true; value: ModelSourceInput } | { ok: false; code: string; message: string } {
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `来源节点 ${nodeId} 不存在` };
  const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  if (node.type === "group" && readFilmSetGroupMarker(data)) {
    const projection = readFilmSetAnimationProjection(canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-model-node", message: "片场资源无法解析" };
    const item = projection.filmSetContent.items.find(entry => entry.kind === "model");
    if (!item || item.kind !== "model") {
      return { ok: false, code: "no-model-item", message: `片场节点 ${nodeId} 没有可复制的模型对象` };
    }
    return {
      ok: true,
      value: {
        modelScript: item.model.modelScript,
        modelScriptVersion: item.model.modelScriptVersion,
        placement: item.model.placement
      }
    };
  }
  if (node.type === "model3d") {
    const decoded = scriptModel3DNodeData(data);
    if (!decoded) return { ok: false, code: "model-source-glb", message: "文件模型不提供脚本内容" };
    return {
      ok: true,
      value: {
        modelScript: decoded.model.modelScript,
        modelScriptVersion: decoded.model.modelScriptVersion,
        placement: decoded.model.placement
      }
    };
  }
  return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点` };
}

export function readFilmSet(
  canvas: ServerCanvas,
  nodeId: string
): { ok: true; value: FilmSetNodeData } | { ok: false; code: string; message: string } {
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
  const animation = readFilmSetAnimationProjection(canvas, nodeId);
  if (!animation) return { ok: false, code: "invalid-animation-node", message: `节点 ${nodeId} 无法解析为片场` };
  return { ok: true, value: animation };
}

/** 默认镜头导出（供前端创建入口预填，不写规范状态）。 */
export function defaultCameraForCreate(): InitialShotCamera {
  return defaultInitialShotCamera(null);
}

/** 默认空运动脚本占位（创建时无运动）；仅常量，避免调用方散落字面量。 */
export const DEFAULT_MOTION_SCRIPT = "";

function buildBatch(
  canvasId: string,
  commandId: string,
  actorId: string,
  baseRevision: number,
  commands: CanvasCommand[]
): CanvasCommandBatch {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, baseRevision, actorId, commands };
}

function guardRequest(
  canvasId: string,
  requestId: string,
  nodeId: string
): { ok: false; code: string; message: string } | null {
  if (canvasId.trim() === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (requestId.trim() === "") return { ok: false, code: "malformed-request", message: "requestId 不能为空" };
  if (nodeId.trim() === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
  return null;
}
