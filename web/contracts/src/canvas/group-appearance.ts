/**
 * 普通组可选的自身展示模型。
 *
 * 这是组节点自身的子资源，不是成员、输出或 parentId 的替代物。缺失时只在读取层
 * 使用确定的默认模型，不把默认值写回 canonical 文档。
 *
 * 片场不使用该字段：片场节点的自身模型是 `filmSetContent.items` 组合。旧文档中残留的
 * 片场 `groupAppearance` 仅原样保留，不参与组合、执行身份或取景。
 */
import {
  decodeModelDefinition,
  deriveModelContentVersion,
  DEFAULT_MODEL_PLACEMENT,
  type ModelDefinition,
  type ModelPlacement,
} from "./model-definition.js";
import { MODEL_SCRIPT_V2_VERSION } from "./model-script.js";
import { isJsonObject } from "../validation.js";

export const GROUP_APPEARANCE_SCHEMA_VERSION = 1 as const;
/**
 * 默认组形象：一个打开的文件夹。
 *
 * 标签页与后板表达「容器」，略向前倾的前袋和夹在两层之间露出的浅色纸张表达「装着内容」。
 * 全部由 box 组成、固定配色、无动画。组形象不额外旋转：与等距网格共用世界轴。
 */
export const DEFAULT_GROUP_APPEARANCE_SCRIPT = `scene.group({ id: "group-root" });
scene.material({ id: "group-folder-shell", baseColor: "#65b7c6", roughness: 0.55, metallic: 0.08 });
scene.material({ id: "group-folder-inner", baseColor: "#4f93a3", roughness: 0.62, metallic: 0.04 });
scene.material({ id: "group-folder-paper", baseColor: "#e0edf5", roughness: 0.7 });
scene.box({ id: "group-folder-back", parent: "group-root", position: [0, 0.58, -0.09], size: [2.4, 1.16, 0.18], material: "group-folder-inner" });
scene.box({ id: "group-folder-tab", parent: "group-root", position: [-0.72, 1.28, -0.09], size: [0.96, 0.24, 0.18], material: "group-folder-inner" });
scene.box({ id: "group-folder-paper-back", parent: "group-root", position: [0.03, 0.55, 0.03], size: [1.9, 1.0, 0.06], material: "group-folder-paper" });
scene.box({ id: "group-folder-paper-front", parent: "group-root", position: [-0.05, 0.47, 0.1], size: [1.72, 0.88, 0.06], material: "group-folder-paper" });
scene.box({ id: "group-folder-pocket", parent: "group-root", position: [0, 0.35, 0.27], rotation: [-6, 0, 0], size: [2.52, 0.66, 0.16], material: "group-folder-shell" });`;

export type GroupAppearance = {
  schemaVersion: typeof GROUP_APPEARANCE_SCHEMA_VERSION;
  model: ModelDefinition;
};

export type GroupAppearanceDecodeResult =
  | { ok: true; value: GroupAppearance }
  | { ok: false; reason: string };

export type GroupAppearanceReadResult = {
  value: GroupAppearance;
  source: "default" | "custom" | "unsupported";
  diagnostic?: string;
};

function modelFromScript(modelScript: string, revision = 1): ModelDefinition {
  const normalized = deriveModelContentVersion({
    modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
    placement: DEFAULT_MODEL_PLACEMENT,
    revision,
  });
  return {
    modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
    contentVersion: normalized,
    placement: { ...DEFAULT_MODEL_PLACEMENT, offset: { ...DEFAULT_MODEL_PLACEMENT.offset } },
  };
}

let cachedDefault: GroupAppearance | undefined;

/** 每次返回独立值，调用方不能污染后续默认读取。 */
export function defaultGroupAppearance(): GroupAppearance {
  cachedDefault ??= { schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION, model: modelFromScript(DEFAULT_GROUP_APPEARANCE_SCRIPT) };
  const model = cachedDefault.model;
  return {
    schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION,
    model: {
      ...model,
      contentVersion: { ...model.contentVersion },
      placement: { ...model.placement, offset: { ...model.placement.offset } },
    },
  };
}

export function decodeGroupAppearance(input: unknown): GroupAppearanceDecodeResult {
  if (!isJsonObject(input)) return { ok: false, reason: "groupAppearance 必须是对象" };
  if (input.schemaVersion !== GROUP_APPEARANCE_SCHEMA_VERSION) {
    return { ok: false, reason: "不支持的 groupAppearance.schemaVersion" };
  }
  if (!isJsonObject(input.model)) return { ok: false, reason: "groupAppearance.model 必须是对象" };
  const allowedModelKeys = new Set(["modelScript", "modelScriptLanguage", "modelScriptVersion", "contentVersion", "placement"]);
  if (Object.keys(input.model).some((key) => !allowedModelKeys.has(key))) {
    return { ok: false, reason: "groupAppearance.model 不得包含外部资源或运行时字段" };
  }
  const decoded = decodeModelDefinition({
    ...input.model,
    modelContentVersion: input.model.contentVersion,
    modelPlacement: input.model.placement,
  });
  if (!decoded.ok) return { ok: false, reason: `groupAppearance.model：${decoded.reason}` };
  return { ok: true, value: { schemaVersion: GROUP_APPEARANCE_SCHEMA_VERSION, model: decoded.value } };
}

/**
 * 读取节点展示模型。缺失字段只返回默认值；未知版本/非法内容保留原字段并给出诊断，
 * 渲染侧仍可显示默认占位。
 */
export function readGroupAppearanceForNode(
  data: { groupAppearance?: unknown } | undefined,
): GroupAppearanceReadResult {
  const raw = data?.groupAppearance;
  if (raw === undefined) return { value: defaultGroupAppearance(), source: "default" };
  const decoded = decodeGroupAppearance(raw);
  if (!decoded.ok) return { value: defaultGroupAppearance(), source: "unsupported", diagnostic: decoded.reason };
  return { value: decoded.value, source: "custom" };
}

export function groupAppearanceModel(data: { groupAppearance?: unknown } | undefined): ModelDefinition {
  return readGroupAppearanceForNode(data).value.model;
}

export function cloneGroupAppearance(value: GroupAppearance): GroupAppearance {
  return {
    schemaVersion: value.schemaVersion,
    model: {
      ...value.model,
      contentVersion: { ...value.model.contentVersion },
      placement: { ...value.model.placement, offset: { ...value.model.placement.offset } },
    },
  };
}

export function groupAppearancePlacement(value: GroupAppearance): ModelPlacement {
  return { ...value.model.placement, offset: { ...value.model.placement.offset } };
}
