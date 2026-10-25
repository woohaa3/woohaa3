/**
 * 组/片场可选的自身展示模型。
 *
 * 这是节点自身的子资源，不是成员、输出或 parentId 的替代物。缺失时只在读取层
 * 使用确定的默认模型，不把默认值写回 canonical 文档。
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
export const DEFAULT_GROUP_APPEARANCE_SCRIPT = `scene.group({ id: "group-root" });
scene.material({ id: "group-frame", baseColor: "#526b83", roughness: 0.6, metallic: 0.12 });
scene.material({ id: "group-node", baseColor: "#a5bfd3", roughness: 0.5, metallic: 0.08 });
scene.material({ id: "group-face", baseColor: "#e0edf5", roughness: 0.65 });
scene.material({ id: "group-accent", baseColor: "#65b7c6", roughness: 0.55 });
scene.box({ id: "group-base", parent: "group-root", position: [0, 0.08, 0], size: [2.3, 0.16, 0.9], material: "group-frame" });
scene.box({ id: "group-rim-left", parent: "group-root", position: [-1.08, 0.24, 0], size: [0.14, 0.32, 0.9], material: "group-frame" });
scene.box({ id: "group-rim-right", parent: "group-root", position: [1.08, 0.24, 0], size: [0.14, 0.32, 0.9], material: "group-frame" });
scene.segment({ id: "group-link-left", parent: "group-root", from: [-0.66, 1.18, 0], to: [0, 0.55, 0.16], width: 0.11, depth: 0.11, shape: "box", material: "group-frame" });
scene.segment({ id: "group-link-right", parent: "group-root", from: [0.66, 1.18, 0], to: [0, 0.55, 0.16], width: 0.11, depth: 0.11, shape: "box", material: "group-frame" });
scene.box({ id: "group-node-left", parent: "group-root", position: [-0.66, 1.32, 0], size: [0.7, 0.54, 0.38], material: "group-node" });
scene.box({ id: "group-node-right", parent: "group-root", position: [0.66, 1.32, 0], size: [0.7, 0.54, 0.38], material: "group-node" });
scene.box({ id: "group-body", parent: "group-root", position: [0, 0.49, 0.16], size: [0.72, 0.54, 0.4], material: "group-accent" });
scene.box({ id: "group-face-left", parent: "group-root", position: [-0.66, 1.32, 0.2], size: [0.48, 0.3, 0.035], material: "group-face" });
scene.box({ id: "group-face-right", parent: "group-root", position: [0.66, 1.32, 0.2], size: [0.48, 0.3, 0.035], material: "group-face" });
scene.box({ id: "group-face-center", parent: "group-root", position: [0, 0.49, 0.37], size: [0.48, 0.3, 0.035], material: "group-face" });`;

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
