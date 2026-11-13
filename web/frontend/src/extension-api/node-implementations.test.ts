import { describe, expect, it, vi } from 'vitest';
import { createEmptyWoohaa3ServerCanvas, scriptModelPreparation, type NodeCapabilities } from '@woohaa3/contracts';
import { NodeImplementationRegistry } from './node-implementations.js';
const canvas = createEmptyWoohaa3ServerCanvas('registry');
const context = { canvas, node: { id: 'custom', type: 'custom', position: { x: 0, y: 0 } }, data: undefined };
describe('page node implementation registry', () => {
  it('isolates scopes, snapshots declarations, diagnoses conflicts and publishes one invalidation per mutation', () => {
    const a = new NodeImplementationRegistry(), b = new NodeImplementationRegistry();
    const notify = vi.fn(); a.subscribe(notify);
    const capabilities: NodeCapabilities = { appearance: { palette: 'node', defaultSize: { width: 300, height: 220 } }, modelPreparation: scriptModelPreparation };
    const stop = a.register({ type: 'custom', capabilities });
    expect(notify).toHaveBeenCalledTimes(1);
    (capabilities as { modelPreparation?: unknown }).modelPreparation = undefined;
    expect(a.resolve(context).modelPreparation).toBeDefined();
    expect(Object.isFrozen(a.resolve(context).appearance?.defaultSize)).toBe(true);
    expect(b.resolve(context).modelPreparation).toBeUndefined();
    expect(() => a.register({ type: 'custom', capabilities: {} })).toThrow('conflict');
    expect(() => a.register({ type: 'model3d', capabilities: {} })).toThrow('conflict');
    expect(notify).toHaveBeenCalledTimes(1);
    const oldGeneration = a.resolve(context).generation;
    stop(); stop();
    expect(notify).toHaveBeenCalledTimes(2);
    const stopNew = a.register({ type: 'custom', capabilities: { modelPreparation: scriptModelPreparation } });
    stop(); expect(a.resolve(context).generation).toBeGreaterThan(oldGeneration);
    expect(a.resolve(context).modelPreparation).toBeDefined();
    a.clear(); a.clear(); stopNew();
    expect(notify).toHaveBeenCalledTimes(4);
    expect(a.resolve(context).modelPreparation).toBeUndefined();
    const modelNode = { ...context.node, type: 'model3d' };
    expect(b.resolve({ ...context, node: modelNode, data: undefined }).modelPreparation).toBeUndefined();
    expect(b.resolve({ ...context, node: modelNode, data: undefined }).focus).toBeUndefined();
    const worldModel = b.resolve({
      ...context,
      node: modelNode,
      data: { sharedWorldInstance: { kind: 'world-instance', version: 'shared-world-v1', instanceId: 'i1',
        transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } }
    });
    expect(worldModel.modelPreparation).toBeDefined();
    expect(worldModel.focus?.kind({ ...context, node: modelNode, data: undefined })).toBe('model');
  });
  it.each([
    { isModel: true }, { modelPreparation: {} }, { modelPreview: true },
    { resources: { channel: 'unknown', contentKey: () => null } },
    { appearance: { palette: 'model', defaultSize: { width: NaN, height: 20 } } },
    { resize: { mode: 'unknown', minimum: () => ({ width: 1, height: 1 }) } }
  ])('rejects invalid declarations atomically: %j', capabilities => {
    const registry = new NodeImplementationRegistry();
    expect(() => registry.register({ type: 'custom', capabilities: capabilities as NodeCapabilities })).toThrow();
    expect(registry.getRevision()).toBe(0);
    expect(registry.resolve(context)).toEqual({ generation: 0 });
  });
});
