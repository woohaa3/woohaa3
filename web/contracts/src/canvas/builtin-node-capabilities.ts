import { executeModelScriptVersioned } from "./model-executor-v2.js";
/** The only builtin rendering implementation bindings. Domain type validation stays separate. */
import { isSupportedModelScriptVersion, sceneIrVersionFor } from './model-script.js';
import { prepareModelResource } from './prepared-model.js';
import type { NodeCapabilities, NodeCapabilityContext, NodeCapabilityResolver, NodeModelPreparation } from './node-capabilities.js';
import { WORLD_CAMERA_CARD_SIZE } from './world-camera-ui.js';
import { LEGACY_MODEL_CARD_BODY } from './render-scene/scene-builder.js';

export const scriptModelPreparation: NodeModelPreparation = {
  executionKey: ({ data }) => data?.modelScript ? `${String(data.modelScriptVersion)}:${data.modelScript}` : undefined,
  prepare: ({ data }) => {
    const execution = executeModelScriptVersioned(String(data?.modelScript ?? ''), data?.modelScriptVersion);
    if (!execution.ok) return { status: `fail:${execution.stage}:${execution.code}` };
    if (!isSupportedModelScriptVersion(data?.modelScriptVersion)) return { status: 'fail:compile:version-mismatch' };
    return { status: 'ok', resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(data.modelScriptVersion), ops: execution.scene.ops }) };
  }
};
export const modelWorkspaceFocus: NonNullable<NodeCapabilities['focus']> = { kind: () => 'model' };
export const nodeActionContributions: NonNullable<NodeCapabilities['actions']> = { accepts: () => true };
export const rectangularNodeResize: NonNullable<NodeCapabilities['resize']> = { mode: 'rect', minimum: () => ({ width: 180, height: 64 }) };
export const modelResourceDemand: NonNullable<NodeCapabilities['resources']> = { channel: 'model', contentKey: context => context.modelResourceKey };
const rich = { width: 248, height: 232 };

/** `model3d` 只有携带共享世界实例才是受支持的模型节点。 */
export function hasSharedWorldInstance(context: Pick<NodeCapabilityContext, 'data'>): boolean {
  const value = context.data?.sharedWorldInstance;
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 旧卡片模型不提供任何模型能力，只保留结构诊断与删除身份。 */
const legacyModelCardCapabilities: NodeCapabilities = {
  appearance: { palette: 'model', defaultSize: rich },
  connections: { endpoints: () => 'ordinary' }
};

/**
 * 受支持的模型节点能力：世界驻留、准备、聚焦与动作。
 *
 * 缺少 `sharedWorldInstance` 的旧卡片模型没有模型准备、预览、聚焦、动作或缩放能力
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
export const worldModelCapabilities: NodeCapabilities = {
  appearance: { palette: 'model', defaultSize: rich },
  modelPreparation: scriptModelPreparation,
  resources: modelResourceDemand,
  focus: modelWorkspaceFocus,
  actions: nodeActionContributions,
  connections: { endpoints: () => 'ordinary' }
};

export function modelNodeCapabilities(context: Pick<NodeCapabilityContext, 'data'>): NodeCapabilities {
  return hasSharedWorldInstance(context) ? worldModelCapabilities : legacyModelCardCapabilities;
}

/**
 * 旧卡片模型的诊断正文；受支持的世界模型或非模型节点返回 `null`。
 *
 * Render Scene 用同一判定把缺少 `sharedWorldInstance` 的 `model3d` 投影为只读诊断卡片。
 */
export function legacyDiagnosticCardBodyFor(
  node: { type: string },
  context: Pick<NodeCapabilityContext, 'data'>
): string | null {
  return node.type === "model3d" && !hasSharedWorldInstance(context) ? LEGACY_MODEL_CARD_BODY : null;
}

export function builtinNodeImplementations(): ReadonlyMap<string, NodeCapabilities> {
  const entries = new Map<string, NodeCapabilities>();
  for (const type of ['text', 'image', 'audio', 'video'] as const) entries.set(type, {
    appearance: { palette: type, defaultSize: rich }, resize: rectangularNodeResize,
    ...(type !== "text" ? { actions: nodeActionContributions } : {}), connections: { endpoints: () => 'ordinary' },
    ...((type === 'image' || type === 'video') ? { resources: { channel: type, contentKey: context => context.assetContentKey } } satisfies Pick<NodeCapabilities, 'resources'> : {})
  });
  entries.set('model3d', worldModelCapabilities);
  entries.set('composite-asset', {
    appearance: { palette: 'model', defaultSize: { width: 260, height: 195 } },
    actions: nodeActionContributions,
    connections: { endpoints: () => 'ordinary' },
    resize: { ...rectangularNodeResize, mode: 'rect' }
  });
  entries.set('workflow-group-2d', {
    appearance: { palette: 'node', defaultSize: { width: 260, height: 195 }, cardLabel: '2D 组' },
    actions: nodeActionContributions,
    resize: rectangularNodeResize
  });
  entries.set('scene-area', {
    actions: nodeActionContributions,
    appearance: { palette: 'node', defaultSize: { width: 260, height: 195 }, cardLabel: '导演区' }
  });
  entries.set('world-camera', {
    appearance: { palette: 'shot', defaultSize: WORLD_CAMERA_CARD_SIZE, cardLabel: '镜头' },
    resources: { channel: 'video', contentKey: context => context.assetContentKey },
    actions: nodeActionContributions,
    connections: { endpoints: () => 'ordinary' },
    resize: rectangularNodeResize
  });
  return entries;
}
const builtins = builtinNodeImplementations();
export function builtinNodeCapabilitiesForType(type: string): NodeCapabilities { return builtins.get(type) ?? {}; }
/** Pure fixtures/domain defaults. Production supplies the page resolver explicitly. */
export const builtinNodeCapabilityResolver: NodeCapabilityResolver = {
  getRevision: () => 0,
  resolve: (context) => ({
    ...(context.node.type === 'model3d' ? modelNodeCapabilities(context) : builtins.get(context.node.type)),
    generation: 0
  })
};
