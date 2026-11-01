/**
 * `model3d` 自包含节点数据契约
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.1 / 1.2 / 1.3；
 *  change: remove-canvas-groups-and-film-set —— 片场节点与动画节点契约一并删除）。
 *
 * 节点保存**完整本地 ModelDefinition**，不通过来源节点 ID 取得运行数据。为与仓库既有
 * 约定一致（`modelScript` / `modelCameras` 等均为 flat nodeData 字段），这里也使用 flat 字段，
 * 再由本模块的 decoder 组装成结构化 `Model3DNodeData`。
 *
 * `origin` 仅为可选来源说明，不参与加载或运行（design「创建和导入是复制快照」）。
 */
import { bevyNodeSize } from "./render-scene.js";
import {
  decodeGlbModelReference,
  decodeModelDefinition,
  isGlbModelNodeData,
  type GlbModelReference,
  type ModelDefinition
} from "./model-definition.js";
import { isJsonObject } from "../validation.js";

/** canonical 节点类型：自包含三维模型节点。 */
export const MODEL3D_NODE_TYPE = "model3d" as const;

/** 可选来源说明。缺失、来源节点不可访问或被删除都不影响运行；不用于加载或运行。 */
export type ModelImportOrigin = {
  sourceNodeId?: string;
  sourceCanvasId?: string;
  importedModelContentHash: string;
  importedAt: string;
};

/**
 * 三维模型节点的结构化 nodeData。
 *
 * 两种权威来源互斥（change: 2026-10-28-support-glb-model-nodes）：
 * - `script`：既有 JavaScript 模型脚本；
 * - `glb`：画布作用域 GLB 资产引用。
 */
export type Model3DNodeData =
  | {
      kind: typeof MODEL3D_NODE_TYPE;
      title: string;
      source: "script";
      model: ModelDefinition;
      file?: undefined;
    }
  | {
      kind: typeof MODEL3D_NODE_TYPE;
      title: string;
      source: "glb";
      file: GlbModelReference;
      model?: undefined;
    };

/** 模型节点默认尺寸（与 Bevy 节点尺寸同源）。延迟求值避免模块循环依赖。 */
export function model3DNodeSize(): { width: number; height: number } {
  return bevyNodeSize("model");
}

/** 判断节点类型是否为自包含 3D 节点。 */
export function isSelfContained3DNodeType(type: string): boolean {
  return type === MODEL3D_NODE_TYPE;
}

export type Model3DNodeDataDecodeResult =
  | { ok: true; value: Model3DNodeData }
  | { ok: false; reason: string };

/** 从 flat nodeData 读取模型节点完整定义。 */
export function decodeModel3DNodeData(nodeData: unknown): Model3DNodeDataDecodeResult {
  if (!isJsonObject(nodeData)) return { ok: false, reason: "nodeData 必须是对象" };
  const title = typeof nodeData.title === "string" && nodeData.title.trim() ? nodeData.title.trim() : "模型";
  if (isGlbModelNodeData(nodeData)) {
    const file = decodeGlbModelReference(nodeData);
    if (!file.ok) return file;
    return { ok: true, value: { kind: MODEL3D_NODE_TYPE, title, source: "glb", file: file.value } };
  }
  // 未知来源标记不得被当作脚本模型静默接受：来源判别是权威内容的一部分。
  if (nodeData.modelSourceKind !== undefined) {
    return { ok: false, reason: `未知模型来源 ${String(nodeData.modelSourceKind)}` };
  }
  // 只写 `modelAssetId` 会形成「有资产引用但没有来源判别」的歧义内容，不得被当作脚本模型接受。
  if (nodeData.modelAssetId !== undefined) {
    return { ok: false, reason: '模型资产引用必须与 modelSourceKind = "glb" 同时出现' };
  }
  const model = decodeModelDefinition(nodeData);
  if (!model.ok) return model;
  return { ok: true, value: { kind: MODEL3D_NODE_TYPE, title, source: "script", model: model.value } };
}

/**
 * 只读取脚本模型；文件模型与非法内容一律返回 null。
 *
 * 运动、历史等依赖脚本求值的能力用它显式拒绝文件模型，而不是把 GLB 当成空脚本。
 */
export function scriptModel3DNodeData(nodeData: unknown): { title: string; model: ModelDefinition } | null {
  const decoded = decodeModel3DNodeData(nodeData);
  return decoded.ok && decoded.value.source === "script"
    ? { title: decoded.value.title, model: decoded.value.model }
    : null;
}
