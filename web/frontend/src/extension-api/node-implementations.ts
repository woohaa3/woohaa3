/** Trusted implementation bindings owned by a single page scope. */
import {
  builtinNodeImplementations, scriptModelPreparation,
  type NodeCapabilities, type NodeCapabilityContext, type NodeCapabilityResolver,
  type ResolvedNodeCapabilities,
} from '@woohaa3/contracts';
import type { FileModelPreparation } from '../cordis/services/file-model-preparation.js';

export type NodeImplementation = { type: string; capabilities: NodeCapabilities };
const keys = new Set(['appearance', 'modelPreparation', 'modelPreview', 'connections', 'resources', 'focus', 'resize', 'actions']);
const handlers = { connections: ['endpoints'], modelPreparation: ['executionKey', 'prepare'], modelPreview: ['project'], resources: ['contentKey'], focus: ['kind'], resize: ['minimum'], actions: ['accepts'] } as const;
function snapshot<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]))) as T;
}
function validate(capabilities: NodeCapabilities): void {
  if (!capabilities || typeof capabilities !== 'object') throw new Error('Invalid node capabilities');
  for (const [key, value] of Object.entries(capabilities)) {
    if (!keys.has(key) || !value || typeof value !== 'object') throw new Error(`Invalid node capability: ${key}`);
    for (const handler of handlers[key as keyof typeof handlers] ?? []) {
      if (typeof (value as Record<string, unknown>)[handler] !== 'function') throw new Error(`Missing node capability handler: ${key}.${handler}`);
    }
  }
  const appearance = capabilities.appearance;
  if (appearance && (!['text', 'image', 'model', 'audio', 'video', 'shot', 'node'].includes(appearance.palette) || ![appearance.defaultSize?.width, appearance.defaultSize?.height].every(value => Number.isFinite(value) && value > 0))) throw new Error('Invalid node appearance');
  if (capabilities.resize && capabilities.resize.mode !== 'rect') throw new Error('Invalid resize mode');
  if (capabilities.resources && (!['image', 'video', 'model'].includes(capabilities.resources.channel) || typeof capabilities.resources.previewSlot !== 'boolean')) throw new Error('Invalid resource demand');
}
export class NodeImplementationRegistry implements NodeCapabilityResolver {
  private readonly bindings = new Map<string, ResolvedNodeCapabilities>();
  private readonly reserved = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  constructor(builtins: ReadonlyMap<string, NodeCapabilities> = builtinNodeImplementations()) {
    for (const [type, capabilities] of builtins) {
      validate(capabilities);
      this.reserved.add(type);
      this.bindings.set(type, snapshot({ ...capabilities, generation: ++this.generation }));
    }
  }
  getRevision = (): number => this.revision;
  resolve = (context: NodeCapabilityContext): ResolvedNodeCapabilities => this.bindings.get(context.node.type) ?? EMPTY;
  register({ type, capabilities }: NodeImplementation): () => void {
    if (!type.trim() || this.reserved.has(type) || this.bindings.has(type)) throw new Error(`Node implementation conflict: ${type}`);
    validate(capabilities);
    const binding = snapshot({ ...capabilities, generation: ++this.generation });
    this.bindings.set(type, binding);
    this.invalidate();
    let alive = true;
    return () => {
      if (!alive) return;
      alive = false;
      if (this.bindings.get(type) !== binding) return;
      this.bindings.delete(type);
      this.invalidate();
    };
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private invalidate(): void { this.revision++; for (const listener of this.listeners) listener(); }
  clear(): void { if (!this.bindings.size) return; this.bindings.clear(); this.invalidate(); }
}
const EMPTY = Object.freeze({ generation: 0 });

/**
 * Bind existing adapter execution without exposing business interpretation to consumers.
 *
 * `fileModel` 是页面注入的 GLB 渲染准备端口（change: 2026-10-28-support-glb-model-nodes）：
 * 普通 `model3d` 按节点数据的权威来源在脚本执行与文件解析之间分流，两者不共存。
 */
export function createNodeImplementationRegistry(
  fileModel?: FileModelPreparation
): NodeImplementationRegistry {
  const builtins = new Map(builtinNodeImplementations());
  if (fileModel) {
    const model = builtins.get('model3d')!;
    builtins.set('model3d', { ...model, modelPreparation: {
      executionKey: context => fileModel.executionKey(context) ?? scriptModelPreparation.executionKey(context),
      prepare: context => fileModel.executionKey(context) !== undefined
        ? fileModel.prepare(context)
        : scriptModelPreparation.prepare(context)
    } });
  }
  return new NodeImplementationRegistry(builtins);
}
