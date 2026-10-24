import { filmSetCompiledBudget } from "../film-set-clip-compilation.js";
/**
 * 命令 reducer 的 nodeData 字段校验与自包含 3D 内容归一化。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。按字段 owner 分离：视频编辑意图、镜头集合、图片编辑、自包含模型/动画节点与片场内容。
 * 校验通过时就地写回**归一化**值，失败时返回稳定拒绝（整批命令失败）。
 */
import { normalizeVideoEditIntents } from "../../video/video-edit.js";
import { decodeModelCameras } from "../model-cameras.js";
import { decodeImageEditDocument } from "../image-edit.js";
import { decodeFilmSetNodeData, decodeModel3DNodeData, type FilmSetNodeData } from "../canvas-node-model.js";
import { filmSetObjectOwnershipOf } from "../film-set-object-container.js";
import { CREATURE_VIDEO_ASSETS_EXTENSION_ID, GAME_FURNACE_EXTENSION_ID, isCompositeAssetNodeType, isFilmSetNode, readCompositeAssetExtensionId } from "../domain/core/composite-asset-identity.js";
import { decodeModelContentVersion, modelSourceHash, normalizeModelDefinition } from "../model-definition.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import { decodeFilmSetLocalTransform } from "../film-set-content.js";
import { readFilmSetContent } from "../film-set-content.js";
import { isFilmSetModelItem } from "../film-set-content.js";
import type { CanvasNodeData } from "../domain/index.js";
import { reject, type CommandApplyResult, type WorkingState } from "./types.js";

/** 片场首个 model item 的模型脚本（items-only 下片场不再有顶层模型；无 model item 返回 null）。 */
function filmSetFirstModelScript(animation: FilmSetNodeData): string | null {
  const item = animation.filmSetContent.items.find(isFilmSetModelItem);
  return item ? item.model.modelScript : null;
}

/**
 * 在命令应用器的 canonical 边界校验 `videoEditIntents`
 * （change: port-video-editing-dialogs，design D6）。
 *
 * 非法/危险 intent（data URL、object URL、临时签名 URL、Blob、越界时间、超限等）使整批命令
 * 以稳定错误失败，而不是被静默丢弃后执行语义不同的任务。校验通过后写回归一化（稳定排序）值。
 */
export function validateVideoEditIntentsPatch(value: CanvasNodeData): CommandApplyResult | null {
  if (value.videoEditIntents === undefined) return null;
  const normalized = normalizeVideoEditIntents(value.videoEditIntents);
  if (!normalized.ok) {
    return reject("invalid-video-edit-intent", normalized.error);
  }
  // 写回稳定排序与安全剥离后的值（未知字段不进入规范状态）。
  value.videoEditIntents = normalized.value;
  return null;
}

/**
 * 在命令应用器的 canonical 边界校验 `modelCameras`
 * （change: add-model-editor-gizmo-shot-capture，design D2）。
 *
 * 重复 ID、非法类型、非有限数值、非正 distance、超限等使整批命令以稳定错误失败，而不是被
 * 静默丢弃后执行语义不同的写入。校验通过后写回归一化（稳定排序）值。
 */
export function validateModelCamerasPatch(value: CanvasNodeData): CommandApplyResult | null {
  if (value.modelCameras === undefined) return null;
  const normalized = decodeModelCameras(value.modelCameras);
  if (!normalized.ok) {
    return reject("invalid-model-cameras", normalized.reason);
  }
  value.modelCameras = normalized.value;
  return null;
}

/**
 * 在命令应用器的 canonical 边界校验 `imageEdit`
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D4）。
 *
 * 非法工具/颜色/线宽/坐标、超限点集或未知版本使整批命令以稳定错误失败，而不是被静默丢弃
 * 后保存语义不同的编辑。`null` 显式清除（恢复纯媒体版本时）。校验通过后写回归一化值。
 */
export function validateImageEditPatch(value: CanvasNodeData): CommandApplyResult | null {
  if (value.imageEdit === undefined) return null;
  if (value.imageEdit === null) return null;
  const normalized = decodeImageEditDocument(value.imageEdit);
  if (!normalized.ok) return reject("invalid-image-edit", normalized.error);
  value.imageEdit = normalized.value;
  return null;
}

/**
 * 在命令应用器的 canonical 边界校验 `model3d` / `composite-asset` 节点数据
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 2.3；
 *  change: 2026-10-11-extract-film-set-extension D1/D11/D12）。
 *
 * 复合资产节点必须按 `(type, extensionId)` **完整判别**：
 * - 片场业务（`extensionId="film-set"`）按 items-only 片场契约严格校验；
 * - 已知其它业务（如炉体 `extensionId="game-furnace"`）保留其自身合法节点级模型定义；
 * - 缺失/未知 `extensionId` 的复合资产**不授予任何业务写权限**：静态展示不等于授权，一律拒绝。
 *
 * 普通 `model3d` 必须含完整本地模型定义。结构非法时整批命令以稳定错误失败，绝不写入部分定义。
 */
export function validateSelfContained3DNodePatch(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData
): CommandApplyResult | null {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const mergedData = { ...(work.nodeData[nodeId] ?? {}), ...value } as CanvasNodeData;
  if (filmSetObjectOwnershipOf(mergedData)) return null; // full ownership/field validation runs once per batch
  if (isFilmSetNode(node.type, mergedData)) {
    const previous = work.nodeData[nodeId] ?? {};
    const decoded = decodeFilmSetNodeData(mergedData);
    if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
    if (decoded.value.filmSetAnimations && value.filmSetAnimations) {
      const budget = filmSetCompiledBudget(decoded.value);
      if (budget) return reject("invalid-self-contained-node", budget);
    }
    const importRejection = validateFilmSetContentPatch(work, nodeId, previous, decoded.value);
    if (importRejection) return importRejection;
    return null;
  }
  if (isCompositeAssetNodeType(node.type)) {
    // 缺失/未知业务身份：静态展示可保留数据，但不得执行任何业务写入（D5/D11/D12）。
    const extensionId = readCompositeAssetExtensionId(mergedData);
    if (extensionId === null) {
      return reject("invalid-self-contained-node", "复合资产节点缺少受信任的业务 extensionId，拒绝业务写入");
    }
    // 非模型复合资产仅保存扩展内容引用；业务正文与校验由其拥有者负责。
    // 保持已知业务白名单，且禁止以引用绕过既有模型定义校验。
    const ref = mergedData.extensionContentRef;
    if (extensionId === CREATURE_VIDEO_ASSETS_EXTENSION_ID && ref && typeof ref === "object" && !Array.isArray(ref)
      && ref.schemaVersion === 1 && typeof ref.instanceId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/.test(ref.instanceId)
      && !mergedData.modelScript && !mergedData.modelScriptLanguage && !mergedData.modelScriptVersion) return null;
    // 已知其它业务（炉体）保留其真实节点级 V2 模型定义；片场 items-only 不适用于此。
    if (extensionId === GAME_FURNACE_EXTENSION_ID) {
      const root = decodeFilmSetLocalTransform(mergedData.scenePlacement);
      if (!root.ok) return reject("invalid-self-contained-node", root.reason);
      const decoded = decodeModel3DNodeData(mergedData);
      if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
      return null;
    }
    return reject("invalid-self-contained-node", `复合资产业务 ${extensionId} 不支持节点级模型写入`);
  }
  if (node.type === "model3d") {
    const decoded = decodeModel3DNodeData(mergedData);
    if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
    return null;
  }
  return null;
}

/**
 * 依据实际保存内容重写 `modelContentVersion`（模型）与 `snapshotHash`（动画）。
 *
 * 返回非 null 表示整批命令应被拒绝（内容非法）。归一化后的值写回 `value`，使后续 patch 合并
 * 与最终 canonical 状态都携带按实际内容派生的身份。
 */
export function normalizeSelfContained3D(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData,
  merged: CanvasNodeData
): CommandApplyResult | null {
  const targetNode = work.nodes.find((entry) => entry.id === nodeId);
  if (filmSetObjectOwnershipOf(merged)) return null;
  if (isCompositeAssetNodeType(targetNode?.type) && readCompositeAssetExtensionId(merged) === CREATURE_VIDEO_ASSETS_EXTENSION_ID) return null;
  if (isFilmSetNode(targetNode?.type, merged)) {
    // items-only 片场：不得归一化/写入任何顶层 authored 模型字段（D8）。
    // 完整内容标识只覆盖独立根 + items + 全部片段（不含顶层模型）。
    const animation = decodeFilmSetNodeData(merged);
    if (!animation.ok) return reject("invalid-self-contained-node", animation.reason);
    value.filmSetContent = animation.value.filmSetContent;
    value.scenePlacement = animation.value.scenePlacement;
    value.sceneCamera = animation.value.sceneCamera;
    if (animation.value.filmSetAnimations) value.filmSetAnimations = animation.value.filmSetAnimations;
    value.animationSnapshotHash = animationSnapshotHash(animation.value);
    return null;
  }
  const previous = readPreviousModelContentVersion(work, nodeId);
  const normalized = normalizeModelDefinition({
    modelScript: merged.modelScript,
    modelScriptLanguage: merged.modelScriptLanguage,
    modelScriptVersion: merged.modelScriptVersion,
    placement: merged.modelPlacement,
    previous
  });
  if (!normalized.ok) return reject("invalid-self-contained-node", normalized.reason);
  value.modelContentVersion = normalized.value.contentVersion;
  value.modelPlacement = normalized.value.placement;
  value.modelScript = normalized.value.modelScript;
  value.modelScriptLanguage = normalized.value.modelScriptLanguage;
  value.modelScriptVersion = normalized.value.modelScriptVersion;
  return null;
}

/** 读取本节点当前模型内容版本（用于 revision 推进判定）。 */
export function readPreviousModelContentVersion(work: WorkingState, nodeId: string) {
  const decoded = decodeModelContentVersion(work.nodeData[nodeId]?.modelContentVersion);
  return decoded.ok ? decoded.value : null;
}

/**
 * 校验片场内部内容 patch（change: 2026-10-08-make-film-set-model-only，任务 1.4/2.3）。
 *
 * - 新增媒体对象必须引用当前画布中 **ready 且种类匹配** 的稳定资产；
 * - 新增对象若携带 `origin.sourceNodeId` 且来源节点仍存在，则来源必须与内容身份一致
 *   （复制导入的权威 precondition）：模型源码哈希 / 媒体 outputAssetId 不得已被并发改写；
 * - 来源节点已删除时跳过（删除来源后内容仍可恢复，符合 spec）。
 *
 * 仅校验**本次新增**的对象（ID 不在旧集合中的），因此后续编辑片场不会因来源变化被误拒。
 */
export function validateFilmSetContentPatch(
  work: WorkingState,
  nodeId: string,
  previous: CanvasNodeData,
  next: FilmSetNodeData
): CommandApplyResult | null {
  void nodeId;
  const previousIds = new Set(readFilmSetContent(previous).items.map((item) => item.id));
  for (const item of next.filmSetContent.items) {
    if (item.kind === "ground") continue;
    if (item.kind === "image" || item.kind === "video") {
      const asset = work.assets.find((candidate) => candidate.id === item.assetId);
      if (!asset) return reject("asset-in-use", `片场媒体资产 ${item.assetId} 尚未保存`);
      if (asset.status !== "ready") return reject("invalid-self-contained-node", `片场媒体资产 ${item.assetId} 未就绪`);
      if (asset.mediaKind !== item.kind) {
        return reject("invalid-self-contained-node", `片场媒体资产 ${item.assetId} 类型不匹配`);
      }
    }
    // 仅校验本次**新增**对象；编辑既有片场不因来源变化被误拒。
    if (previousIds.has(item.id)) continue;
    const sourceNodeId = item.origin?.sourceNodeId;
    if (!sourceNodeId) continue;
    const source = work.nodes.find((entry) => entry.id === sourceNodeId);
    if (!source) continue;
    if (item.kind === "model") {
      const sourceData = work.nodeData[sourceNodeId];
      const sourceModel = source.type === "model3d"
        ? decodeModel3DNodeData(sourceData)
        : isFilmSetNode(source.type, sourceData) ? decodeFilmSetNodeData(sourceData) : null;
      const sourceModelScript = sourceModel && sourceModel.ok
        ? (sourceModel.value.kind === "model3d" ? sourceModel.value.model.modelScript : filmSetFirstModelScript(sourceModel.value))
        : null;
      if (sourceModelScript === null || modelSourceHash(sourceModelScript) !== modelSourceHash(item.model.modelScript)) {
        return reject("invalid-self-contained-node", "来源模型已变化，请重新导入");
      }
      continue;
    }
    const sourceData = work.nodeData[sourceNodeId];
    if (sourceData?.outputAssetId !== item.assetId) {
      return reject("invalid-self-contained-node", "来源资产已变化，请重新导入");
    }
  }
  return null;
}
