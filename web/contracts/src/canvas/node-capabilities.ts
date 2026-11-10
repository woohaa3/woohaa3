/** Runtime implementation contracts. Never persisted and never sent as executable wire data. */
import type { CanvasNodeData, ServerCanvas } from './domain/index.js';
import type { PreparedModelResource } from './prepared-model.js';
import type { BevyNodeKind } from './render-scene/node-geometry.js';

export type NodeCapabilityContext = {
  canvas: ServerCanvas;
  node: ServerCanvas['document']['nodes'][number];
  data: CanvasNodeData | undefined;
};
export type NodePreparationResult = {
  resource?: PreparedModelResource;
  diagnostic?: string;
  status: string;
  /** Optional ownership-specific resource cleanup, including discarded late results. */
  release?: () => void;
};
export type NodeModelPreparation = {
  executionKey(context: NodeCapabilityContext): string | undefined;
  prepare(context: NodeCapabilityContext): NodePreparationResult | Promise<NodePreparationResult>;
  /**
   * Whether the outcome becomes canonical model-script status (`modelScriptStatus`).
   * Presentation-only resources — such as a group's own appearance — pass `false`: they are
   * never model tasks and must not write task state into nodeData.
   */
  reportsStatus?: boolean;
};
export type NodeResourceContext = NodeCapabilityContext & {
  modelResourceKey: string | null;
  assetContentKey: string | null;
};
export type NodeCapabilities = {
  appearance?: Readonly<{ palette: BevyNodeKind; defaultSize: Readonly<{ width: number; height: number }>; cardLabel?: string }>;
  modelPreparation?: NodeModelPreparation;
  connections?: { endpoints(context: NodeCapabilityContext): 'ordinary' | 'none' | 'aggregate' };
  resources?: { channel: 'image' | 'video' | 'model'; contentKey(context: NodeResourceContext): string | null };
  focus?: { kind(context: NodeCapabilityContext): 'model' | 'extension' | null };
  resize?: { mode: 'rect' | 'scope'; minimum(context: NodeCapabilityContext): { width: number; height: number } };
  actions?: { accepts(context: NodeCapabilityContext): boolean };
};
export type ResolvedNodeCapabilities = Readonly<NodeCapabilities> & { readonly generation: number };
export interface NodeCapabilityResolver {
  resolve(context: NodeCapabilityContext): ResolvedNodeCapabilities;
  getRevision(): number;
}
export function nodeCapabilityContext(canvas: ServerCanvas, nodeId: string): NodeCapabilityContext | null {
  const node = canvas.document.nodes.find(node => node.id === nodeId);
  return node ? { canvas, node, data: canvas.nodeData[nodeId] } : null;
}
