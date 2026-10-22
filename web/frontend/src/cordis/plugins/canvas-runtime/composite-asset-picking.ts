/** Bevy picking 结果的只读适配；不构造领域命令。 */
import type { BevyRuntime } from "./bevy-runtime.js";

export type CompositeAssetPickInput = {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number };
};

export function queryCompositeAssetItemPick(runtime: BevyRuntime | null, input: CompositeAssetPickInput): { nodeId: string; itemId: string } | null {
  if (!runtime) return null;
  const result = runtime.queryCompositeAssetItemPick?.(input);
  return result?.ok ? result.value ?? null : null;
}
