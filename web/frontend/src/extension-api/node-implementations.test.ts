import { describe, expect, it, vi } from 'vitest';
import { createEmptyWoohaa3ServerCanvas, scriptModelPreparation, orbitModelPreview, type NodeCapabilities } from '@woohaa3/contracts';
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
    const stopNew = a.register({ type: 'custom', capabilities: { modelPreview: orbitModelPreview } });
    stop(); expect(a.resolve(context).generation).toBeGreaterThan(oldGeneration);
    expect(a.resolve(context).modelPreview).toBeDefined();
    a.clear(); a.clear(); stopNew();
    expect(notify).toHaveBeenCalledTimes(4);
    expect(a.resolve(context).modelPreview).toBeUndefined();
    expect(b.resolve({ ...context, node: { ...context.node, type: 'model3d' } }).modelPreparation).toBeDefined();
  });
  it.each([
    { isModel: true }, { modelPreparation: {} }, { modelPreview: true },
    { resources: { channel: 'unknown', previewSlot: true, contentKey: () => null } },
    { appearance: { palette: 'model', defaultSize: { width: NaN, height: 20 } } },
    { resize: { mode: 'unknown', minimum: () => ({ width: 1, height: 1 }) } }
  ])('rejects invalid declarations atomically: %j', capabilities => {
    const registry = new NodeImplementationRegistry();
    expect(() => registry.register({ type: 'custom', capabilities: capabilities as NodeCapabilities })).toThrow();
    expect(registry.getRevision()).toBe(0);
    expect(registry.resolve(context)).toEqual({ generation: 0 });
  });
});
