import { decodeMediaContentRef } from "../media-content.js";
import { isCanvasReferencePolicy } from "../../task/reference-policy.js";
import { CREATURE_VIDEO_ASSETS_EXTENSION_ID, isCompositeAssetNodeType, readCompositeAssetExtensionId } from "../domain/core/composite-asset-identity.js";
/**
 * 命令 reducer 的 nodeData 字段校验与自包含 3D 内容归一化。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。按字段 owner 分离：视频编辑意图、镜头集合、图片编辑与自包含模型节点。
 * 校验通过时就地写回**归一化**值，失败时返回稳定拒绝（整批命令失败）。
 */
import { normalizeVideoEditIntents } from "../../video/video-edit.js";
import { decodeModel3DNodeData } from "../canvas-node-model.js";
import { decodeModelCameras } from "../model-cameras.js";
import { decodeImageEditDocument } from "../image-edit.js";
import { decodeModelContentVersion, GLB_MODEL_SOURCE_KIND, isGlbModelNodeData, normalizeGlbModelReference, normalizeModelDefinition } from "../model-definition.js";
import type { CanvasNodeData } from "../domain/index.js";
import { reject, type CommandApplyResult, type WorkingState } from "./types.js";

/**
 * 在命令应用器的 canonical 边界校验 `videoEditIntents`
 * （change: port-video-editing-dialogs，design D6）。
 *
 * 非法/危险 intent（data URL、object URL、临时签名 URL、Blob、越界时间、超限等）使整批命令
 * 以稳定错误失败，而不是被静默丢弃后执行语义不同的任务。校验通过后写回归一化（稳定排序）值。
 */
/**
 * 身份参考策略只接受两个稳定值；非法值让整批命令失败，而不是静默回落成 optional。
 */
export function validateReferencePolicyPatch(value: CanvasNodeData): CommandApplyResult | null {
  if (value.referencePolicy === undefined) return null;
  if (!isCanvasReferencePolicy(value.referencePolicy)) {
    return reject("invalid-reference-policy", "referencePolicy 只允许 optional 或 identity-required");
  }
  return null;
}

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
 * - 生物视频资产（`extensionId="creature-video-assets"`）只保存内容引用；
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
    return reject("invalid-self-contained-node", `复合资产业务 ${extensionId} 不支持节点级写入`);
  }
  if (node.type === "model3d") {
    const decoded = decodeModel3DNodeData(mergedData);
    if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
    // 权威来源互斥：脚本字段与 GLB 资产字段不得同时出现（含空串脚本）。
    if (decoded.value.source === "glb") {
      const assetId = decoded.value.file.assetId;
      const asset = work.assets.find((entry) => entry.id === assetId);
      if (!asset) return reject("asset-in-use", "文件模型引用的资产尚未保存");
      if (asset.mediaKind !== "file") {
        return reject("invalid-self-contained-node", "文件模型必须引用文件类型的画布资产");
      }
    }
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
  if (isCompositeAssetNodeType(targetNode?.type) && readCompositeAssetExtensionId(merged) === CREATURE_VIDEO_ASSETS_EXTENSION_ID) return null;
  const previous = readPreviousModelContentVersion(work, nodeId);
  if (isGlbModelNodeData(merged)) {
    // 文件模型：只归一化资产引用与 placement；不得写回任何脚本字段。
    const normalized = normalizeGlbModelReference({
      assetId: merged.modelAssetId,
      placement: merged.modelPlacement,
      previous
    });
    if (!normalized.ok) return reject("invalid-self-contained-node", normalized.reason);
    value.modelSourceKind = GLB_MODEL_SOURCE_KIND;
    value.modelAssetId = normalized.value.assetId;
    value.modelContentVersion = normalized.value.contentVersion;
    value.modelPlacement = normalized.value.placement;
    return null;
  }
  const previousRig = work.nodeData[nodeId]?.modelRig;
  if (previousRig != null && (merged.modelRig == null)) {
    return reject("rig-removed", "不能移除已有骨架");
  }
  const normalized = normalizeModelDefinition({
    modelScript: merged.modelScript,
    modelScriptLanguage: merged.modelScriptLanguage,
    modelScriptVersion: merged.modelScriptVersion,
    placement: merged.modelPlacement,
    rig: merged.modelRig,
    previous
  });
  if (!normalized.ok) return reject("invalid-self-contained-node", normalized.reason);
  value.modelContentVersion = normalized.value.contentVersion;
  value.modelPlacement = normalized.value.placement;
  value.modelScript = normalized.value.modelScript;
  value.modelScriptLanguage = normalized.value.modelScriptLanguage;
  value.modelScriptVersion = normalized.value.modelScriptVersion;
  if (normalized.value.rig) value.modelRig = normalized.value.rig;
  return null;
}

/** 读取本节点当前模型内容版本（用于 revision 推进判定）。 */
export function readPreviousModelContentVersion(work: WorkingState, nodeId: string) {
  const decoded = decodeModelContentVersion(work.nodeData[nodeId]?.modelContentVersion);
  return decoded.ok ? decoded.value : null;
}

/** Unknown provider references survive reads; explicit writes validate only the open envelope. */
export function validateMediaContentPatch(work: WorkingState, nodeId: string, value: CanvasNodeData): CommandApplyResult | null {
  if (value.mediaContent === undefined) return null;
  const node = work.nodes.find(n => n.id === nodeId);
  if (!node || (node.type !== "image" && node.type !== "video")) return reject("invalid-command", "mediaContent 只允许图片/视频节点");
  const decoded = decodeMediaContentRef(value.mediaContent);
  if (!decoded.ok) return reject("invalid-command", decoded.reason);
  value.mediaContent = decoded.value;
  return null;
}
