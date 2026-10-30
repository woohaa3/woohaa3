import { decodeMediaContentRef } from "../media-content.js";
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
import { decodeModel3DNodeData } from "../canvas-node-model.js";
import { filmSetObjectOwnershipOf } from "../film-set-object-container.js";
import { isCompositeAssetNodeType, readCompositeAssetExtensionId } from "../domain/core/composite-asset-identity.js";
import { isFilmSetNode } from "../film-set-legacy-identity.js";
import { decodeModelContentVersion, GLB_MODEL_SOURCE_KIND, isGlbModelNodeData, normalizeGlbModelReference, normalizeModelDefinition } from "../model-definition.js";
import { decideContentWrite, EMPTY_CONTENT_RESOLVER, type ContentContributionResolver } from "../content-contribution.js";
import { decodeGroupAppearance, readGroupAppearanceForNode } from "../group-appearance.js";
import type { CanvasNodeData } from "../domain/index.js";
import { reject, type CommandApplyResult, type WorkingState } from "./types.js";

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
 * 普通组自身展示模型的严格边界；缺失字段不写回，非法字段整批拒绝。
 *
 * `groupAppearance` 只属于普通组。片场节点的自身模型是整场 items，不读取该字段；
 * 旧文档中已存在的片场外观仅原样保留，不允许新增或修改。
 */
export function validateGroupAppearancePatch(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData,
): CommandApplyResult | null {
  if (value.groupAppearance === undefined) return null;
  const node = work.nodes.find((entry) => entry.id === nodeId);
  const merged = { ...(work.nodeData[nodeId] ?? {}), ...value } as CanvasNodeData;
  if (node?.type !== "group") {
    const preservedFilmSetAppearance = isFilmSetNode(node?.type, merged)
      && JSON.stringify(value.groupAppearance) === JSON.stringify(work.nodeData[nodeId]?.groupAppearance);
    if (preservedFilmSetAppearance) return null;
    return reject("invalid-group-appearance", "groupAppearance 只属于普通组节点");
  }
  const decoded = decodeGroupAppearance(value.groupAppearance);
  if (!decoded.ok) {
    // A whole group rewrite must retain an unsupported saved appearance verbatim.
    if (JSON.stringify(value.groupAppearance) === JSON.stringify(work.nodeData[nodeId]?.groupAppearance)) return null;
    return reject("invalid-group-appearance", decoded.reason);
  }
  const normalized = normalizeModelDefinition({ ...decoded.value.model,
    placement: decoded.value.model.placement,
    previous: readGroupAppearanceForNode(work.nodeData[nodeId]).value.model.contentVersion });
  if (!normalized.ok) return reject("invalid-group-appearance", normalized.reason);
  value.groupAppearance = { schemaVersion: 1, model: normalized.value };
  return null;
}

/**
 * 在命令应用器的 canonical 边界校验 `model3d` / `composite-asset` 节点数据。
 *
 * 复合资产的身份只做语法校验，是否可信由内容注册表中已激活的 owner 决定：
 * - 已注册 owner：调用其 `validatePatch`，失败整批拒绝；
 * - 未注册/已停用 owner：保留原数据只读，拒绝本次业务写入（`content-owner-unavailable`）；
 * - 旧 `composite-asset` 片场：只允许迁移读取，不允许新写入。
 *
 * 普通 `model3d` 必须含完整本地模型定义。结构非法时整批命令以稳定错误失败，绝不写入部分定义。
 */
export function validateSelfContained3DNodePatch(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData,
  content: ContentContributionResolver | undefined = EMPTY_CONTENT_RESOLVER
): CommandApplyResult | null {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const mergedData = { ...(work.nodeData[nodeId] ?? {}), ...value } as CanvasNodeData;
  if (filmSetObjectOwnershipOf(mergedData)) return null; // full ownership/field validation runs once per batch
  if (isFilmSetNode(node.type, mergedData)) {
    return reject("invalid-self-contained-node", "旧 composite 片场只允许迁移读取，请编辑 film-set group");
  }
  if (isCompositeAssetNodeType(node.type)) {
    const extensionId = readCompositeAssetExtensionId(mergedData);
    if (extensionId === null) {
      return reject("invalid-self-contained-node", "复合资产节点缺少合法 extensionId，拒绝业务写入");
    }
    const decision = decideContentWrite(extensionId, work.nodeData[nodeId] ?? {}, value, content, {
      nodeId,
      nodeType: node.type,
      canvas: { ...work, assets: work.assets } as unknown as never
    });
    if (!decision.ok) {
      const code = decision.code === "content-owner-unavailable" || decision.code === "content-codec-failed"
        ? decision.code
        : "content-patch-rejected";
      return reject(code, decision.code);
    }
    // Owner 可以拥有节点级模型字段（例如带自包含模型的复合内容）；只做通用模型结构校验，
    // 不猜测任何业务字段名。
    if (mergedData.modelScript !== undefined || mergedData.modelScriptLanguage !== undefined || mergedData.modelScriptVersion !== undefined) {
      const decoded = decodeModel3DNodeData(mergedData);
      if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
      if (decoded.value.source === "glb") {
        return reject("invalid-self-contained-node", "文件模型只属于普通 model3d 节点");
      }
      return null;
    }
    return null;
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
  merged: CanvasNodeData,
  content: ContentContributionResolver | undefined = EMPTY_CONTENT_RESOLVER
): CommandApplyResult | null {
  const targetNode = work.nodes.find((entry) => entry.id === nodeId);
  if (filmSetObjectOwnershipOf(merged)) return null;
  if (isFilmSetNode(targetNode?.type, merged)) return null; // legacy composite is read-only
  if (isCompositeAssetNodeType(targetNode?.type)) {
    const extensionId = readCompositeAssetExtensionId(merged);
    const codec = extensionId ? content?.resolve(extensionId)?.nodeData : null;
    if (codec) {
      try {
        const normalized = codec.normalize(merged, { nodeId, nodeType: targetNode?.type, canvas: { ...work, assets: work.assets } as unknown as never });
        if (typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
          // 写回规范值：先清掉本次 patch 覆盖的业务键，再写入 owner 的规范结果。
          for (const key of Object.keys(value)) delete (value as Record<string, unknown>)[key];
          Object.assign(value, normalized as Record<string, unknown>);
        }
      } catch {
        return reject("content-codec-failed", "content-codec-failed");
      }
    }
    // 节点级模型定义是通用字段（不是业务身份）：复合资产同样按 model3d 规则推进内容身份。
    const current = { ...merged, ...value } as CanvasNodeData;
    if (current.modelScript !== undefined || current.modelScriptLanguage !== undefined || current.modelScriptVersion !== undefined) {
      const previous = readPreviousModelContentVersion(work, nodeId);
      const normalizedModel = normalizeModelDefinition({
        modelScript: current.modelScript,
        modelScriptLanguage: current.modelScriptLanguage,
        modelScriptVersion: current.modelScriptVersion,
        placement: current.modelPlacement,
        previous
      });
      if (!normalizedModel.ok) return reject("invalid-self-contained-node", normalizedModel.reason);
      value.modelContentVersion = normalizedModel.value.contentVersion;
      value.modelPlacement = normalizedModel.value.placement;
      value.modelScript = normalizedModel.value.modelScript;
      value.modelScriptLanguage = normalizedModel.value.modelScriptLanguage;
      value.modelScriptVersion = normalizedModel.value.modelScriptVersion;
    }
    return null;
  }
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
