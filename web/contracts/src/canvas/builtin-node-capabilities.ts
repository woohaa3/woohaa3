import { executeModelScriptVersioned } from "./model-executor-v2.js";
/** The only builtin rendering implementation bindings. Domain type validation stays separate. */
import { isSupportedModelScriptVersion, sceneIrVersionFor } from './model-script.js';
import { prepareModelResource } from './prepared-model.js';
import { DEFAULT_MODEL_PREVIEW, type BevyModelPreview } from './render-scene/wire-model.js';
import { CANVAS_CAMERA_PITCH } from './model-focus/canvas-projection.js';
import type { NodeCapabilities, NodeCapabilityResolver, NodeModelPreparation } from './node-capabilities.js';

export const scriptModelPreparation: NodeModelPreparation = {
  executionKey: ({ data }) => data?.modelScript ? `${String(data.modelScriptVersion)}:${data.modelScript}` : undefined,
  prepare: ({ data }) => {
    const execution = executeModelScriptVersioned(String(data?.modelScript ?? ''), data?.modelScriptVersion);
    if (!execution.ok) return { status: `fail:${execution.stage}:${execution.code}` };
    if (!isSupportedModelScriptVersion(data?.modelScriptVersion)) return { status: 'fail:compile:version-mismatch' };
    return { status: 'ok', resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(data.modelScriptVersion), ops: execution.scene.ops }) };
  }
};
/**
 * 模型卡片预览的默认姿态：正对模型正面（方位 0），俯仰跟随画布镜头
 * `CANVAS_CAMERA_PITCH`，让片场/模型卡片与画布中的真实模型保持同一视角。
 */
export function defaultModelPreview(): BevyModelPreview {
  return { ...DEFAULT_MODEL_PREVIEW, elevation: CANVAS_CAMERA_PITCH };
}

export const orbitModelPreview: NonNullable<NodeCapabilities['modelPreview']> = {
  project: (_context, view) => ({ ...defaultModelPreview(), ...view })
};
export const modelWorkspaceFocus: NonNullable<NodeCapabilities['focus']> = { kind: () => 'model' };
export const nodeActionContributions: NonNullable<NodeCapabilities['actions']> = { accepts: () => true };
export const rectangularNodeResize: NonNullable<NodeCapabilities['resize']> = { mode: 'rect', minimum: () => ({ width: 180, height: 64 }) };
export const modelResourceDemand: NonNullable<NodeCapabilities['resources']> = { channel: 'model', previewSlot: true, contentKey: context => context.modelResourceKey };
const rich = { width: 248, height: 232 };
export function builtinNodeImplementations(): ReadonlyMap<string, NodeCapabilities> {
  const entries = new Map<string, NodeCapabilities>();
  for (const type of ['text', 'image', 'audio', 'video'] as const) entries.set(type, {
    appearance: { palette: type, defaultSize: rich }, resize: rectangularNodeResize,
    ...(type !== "text" ? { actions: nodeActionContributions } : {}), connections: { endpoints: () => 'ordinary' },
    ...((type === 'image' || type === 'video') ? { resources: { channel: type, previewSlot: false, contentKey: context => context.assetContentKey } } satisfies Pick<NodeCapabilities, 'resources'> : {})
  });
  entries.set('model3d', {
    appearance: { palette: 'model', defaultSize: rich, cardLabel: '3D 模型' },
    modelPreparation: scriptModelPreparation, modelPreview: orbitModelPreview,
    resources: modelResourceDemand, focus: modelWorkspaceFocus, actions: nodeActionContributions,
    connections: { endpoints: () => 'ordinary' },
    resize: { mode: 'rect', legacyPreviewHeight: 116, minimum: () => ({ width: 180, height: 160 }) }
  });
  entries.set('composite-asset', {
    appearance: { palette: 'model', defaultSize: { width: 260, height: 195 } },
    actions: nodeActionContributions,
    connections: { endpoints: () => 'ordinary' },
    resize: { ...rectangularNodeResize, mode: 'rect' }
  });
  return entries;
}
const builtins = builtinNodeImplementations();
export function builtinNodeCapabilitiesForType(type: string): NodeCapabilities { return builtins.get(type) ?? {}; }
/** Pure fixtures/domain defaults. Production supplies the page resolver explicitly. */
export const builtinNodeCapabilityResolver: NodeCapabilityResolver = {
  getRevision: () => 0,
  resolve: ({ node }) => ({ ...builtins.get(node.type), generation: 0 })
};
