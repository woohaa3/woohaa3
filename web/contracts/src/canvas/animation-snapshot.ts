/**
 * 三维模型快照的创建、导入与版本推进
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 2.1–2.4；
 *  change: remove-canvas-groups-and-film-set —— 片场/动画快照删除，只保留模型节点快照）。
 *
 * 创建时**复制快照**：读取来源模型版本，把源码、语言、API 版本与摆放复制到新节点。
 * 保存后播放/截图/历史/导出都只读取节点自身数据。
 *
 * 本模块纯函数、JSON-only：不写 Store / Y.Doc / nodeData；实际提交由调用方经语义命令完成。
 */
import {
  GLB_MODEL_SOURCE_KIND,
  DEFAULT_MODEL_PLACEMENT,
  deriveModelContentVersion,
  clonePlacement,
  modelSourceHash,
  type ModelContentVersion,
  type ModelPlacement
} from "./model-definition.js";
import {
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  basedOnModel,
  hashMotionScript,
  type MotionDefinition
} from "./motion-script.js";
import {
  decodeModel3DNodeData,
  type Model3DNodeData
} from "./canvas-node-model.js";
import { MODEL_SCRIPT_LANGUAGE, type SupportedModelScriptVersion } from "./model-script.js";

/** 模型源码来源（模型节点或动画节点复制时读取的完整定义）。 */
export type ModelSnapshotInput = {
  modelScript: string;
  modelScriptLanguage?: typeof MODEL_SCRIPT_LANGUAGE;
  modelScriptVersion: SupportedModelScriptVersion;
  placement?: ModelPlacement;
};

export type ModelSnapshot = {
  modelScript: string;
  modelScriptLanguage: typeof MODEL_SCRIPT_LANGUAGE;
  modelScriptVersion: SupportedModelScriptVersion;
  contentVersion: ModelContentVersion;
  placement: ModelPlacement;
};

/**
 * 由源码、语言、版本与摆放派生**新模型快照**。
 *
 * `revision` 由调用方给出（新建副本从 1 开始）；这里只派生 sourceHash / contentHash。
 */
export function createModelSnapshot(input: ModelSnapshotInput & { revision?: number }): ModelSnapshot {
  const placement = input.placement ? clonePlacement(input.placement) : clonePlacement(DEFAULT_MODEL_PLACEMENT);
  const contentVersion = deriveModelContentVersion({
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion,
    placement,
    revision: input.revision ?? 1
  });
  return {
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion,
    contentVersion,
    placement
  };
}

/**
 * 内容变更时推进本地模型 revision：内容标识不变则保持原 revision（同请求重试/无净变化不推进）。
 */
export function advanceModelRevision(
  previous: ModelContentVersion | null,
  nextContentHash: string
): number {
  if (previous && previous.contentHash === nextContentHash) return previous.revision;
  return (previous?.revision ?? 0) + 1;
}

/** 运动快照创建输入。 */
export type MotionSnapshotInput = {
  motionScript: string;
  /** 本节点模型内容版本（作为适配版本）；省略时以零值占位，调用方须随后设置。 */
  basedOnModelVersion: ModelContentVersion;
  revision?: number;
};

/** 由运动源码派生新的 `MotionDefinition`。 */
export function createMotionSnapshot(input: MotionSnapshotInput): MotionDefinition {
  return {
    motionScript: input.motionScript,
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: input.revision ?? 1,
    sourceHash: hashMotionScript(input.motionScript),
    basedOnModelVersion: basedOnModel(input.basedOnModelVersion)
  };
}

/** 运动源码变化时推进 revision；相同源码不推进。 */
export function advanceMotionRevision(previous: MotionDefinition | null, nextSource: string): number {
  const nextHash = hashMotionScript(nextSource);
  if (previous && previous.sourceHash === nextHash) return previous.revision;
  return (previous?.revision ?? 0) + 1;
}

/** 直接创建自包含模型节点数据（不建立来源连线）。 */
export function createModel3DNodeData(input: {
  title: string;
  model: ModelSnapshotInput;
  revision?: number;
}): Model3DNodeData {
  return {
    kind: "model3d",
    title: input.title,
    source: "script",
    model: createModelSnapshot({ ...input.model, revision: input.revision ?? 1 })
  };
}

/** 把结构化模型节点数据序列化为 flat nodeData 字段。 */
export function model3DNodeDataFields(model: Model3DNodeData): Record<string, unknown> {
  if (model.source === "glb") {
    return {
      title: model.title,
      modelSourceKind: GLB_MODEL_SOURCE_KIND,
      modelAssetId: model.file.assetId,
      modelContentVersion: model.file.contentVersion,
      modelPlacement: model.file.placement
    };
  }
  return {
    title: model.title,
    modelScript: model.model.modelScript,
    modelScriptLanguage: model.model.modelScriptLanguage,
    modelScriptVersion: model.model.modelScriptVersion,
    modelContentVersion: model.model.contentVersion,
    modelPlacement: model.model.placement
  };
}

/** 从已保存的 flat nodeData 读取模型节点（不完整时返回 null）。 */
export function readStoredModel(nodeData: unknown): Model3DNodeData | null {
  const decoded = decodeModel3DNodeData(nodeData);
  return decoded.ok ? decoded.value : null;
}

/** 模型源码内容标识（供调用方做并发 precondition）。 */
export function modelSnapshotSourceHash(model: ModelSnapshot): string {
  return modelSourceHash(model.modelScript);
}
