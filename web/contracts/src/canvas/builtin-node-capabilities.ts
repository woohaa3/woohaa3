import { isPureModelNodeType } from "./domain/core/input-role.js";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
/** The only builtin rendering implementation bindings. Domain type validation stays separate. */
import { isSupportedModelScriptVersion, sceneIrVersionFor } from './model-script.js';
import { prepareModelResource } from './prepared-model.js';
import { compositeAssetSceneOps } from './composite-asset-scene.js';
import { isFilmSetNode } from './domain/core/composite-asset-identity.js';
import { getGroupRequiredMinSize } from './domain/index.js';
import { readGroupAppearanceForNode } from './group-appearance.js';
import { minimumNodeSizeFor } from './node-minimum-size.js';
import { DEFAULT_MODEL_PREVIEW } from './render-scene/wire-model.js';
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
export const savedCompositePreparation: NodeModelPreparation = {
  executionKey: context => `saved:${JSON.stringify(context.data?.scenePlacement)}:${scriptModelPreparation.executionKey(context) ?? ''}`,
  prepare: async context => {
    const result = await scriptModelPreparation.prepare(context);
    if (result.resource) result.resource = prepareModelResource({ sceneVersion: result.resource.sceneVersion, ops: compositeAssetSceneOps(result.resource.ops, context.data?.scenePlacement) });
    return result;
  }
};
export const orbitModelPreview: NonNullable<NodeCapabilities['modelPreview']> = {
  project: (_context, view) => ({ ...DEFAULT_MODEL_PREVIEW, ...view })
};
/**
 * A group's own appearance model is presentation, never a member task: preparation reports no
 * canonical status (change: 2026-10-24-unify-group-and-film-set-authoring).
 */
export const groupAppearancePreparation: NodeModelPreparation = {
  reportsStatus: false,
  executionKey: ({ data }) => {
    const appearance = readGroupAppearanceForNode(data);
    return `group:${appearance.source}:${String(appearance.value.model.modelScriptVersion)}:${appearance.value.model.modelScript}`;
  },
  prepare: ({ data }) => {
    const model = readGroupAppearanceForNode(data).value.model;
    const execution = executeModelScriptVersioned(model.modelScript, model.modelScriptVersion);
    if (!execution.ok) return { status: `fail:${execution.stage}:${execution.code}` };
    if (!isSupportedModelScriptVersion(model.modelScriptVersion)) return { status: 'fail:compile:version-mismatch' };
    return {
      status: 'ok',
      resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(model.modelScriptVersion), ops: execution.scene.ops })
    };
  }
};
export const modelWorkspaceFocus: NonNullable<NodeCapabilities['focus']> = { kind: () => 'model' };
export const nodeActionContributions: NonNullable<NodeCapabilities['actions']> = { accepts: () => true };
export const rectangularNodeResize: NonNullable<NodeCapabilities['resize']> = { mode: 'rect', minimum: () => ({ width: 180, height: 64 }) };
export const modelResourceDemand: NonNullable<NodeCapabilities['resources']> = { channel: 'model', previewSlot: true, contentKey: context => context.modelResourceKey };
const rich = { width: 248, height: 232 }, compact = { width: 196, height: 64 };
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
    modelPreparation: savedCompositePreparation,
    scope: { shape: () => 'isometric-diamond' },
    resources: { ...modelResourceDemand, contentKey: context => context.modelResourceKey ?? `${context.canvas.id}:composite:${context.node.id}` },
    focus: { kind: context => isFilmSetNode(context.node.type, context.data) ? 'model' : 'extension' },
    actions: nodeActionContributions, connections: { endpoints: context => isPureModelNodeType(context.node.type, context.data as Record<string, unknown>) ? 'none' : 'ordinary' },
    resize: { ...rectangularNodeResize, mode: 'scope', minimum: context => minimumNodeSizeFor(context.node.type) }
  });
  entries.set('group', {
    appearance: { palette: 'group', defaultSize: compact },
    container: { project: ({ data }, counts) => ({ title: typeof data?.title === 'string' ? data.title : '', ...counts }) },
    connections: { endpoints: () => 'aggregate' }, actions: nodeActionContributions,
    resize: { mode: 'rect', minimum: ({ canvas, node }) => {
      const min = getGroupRequiredMinSize(canvas.document.nodes.map(entry => ({ ...entry, data: {} })), node.id);
      return { width: min.minWidth, height: min.minHeight };
    } }
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
