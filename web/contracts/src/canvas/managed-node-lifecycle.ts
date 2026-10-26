import type { CanvasNodeData, ServerCanvas } from "./domain/index.js";
import { minimumNodeSizeFor } from "./node-minimum-size.js";
import { decodeMediaContentRef } from "./media-content.js";
import { stableStringify } from "./canvas-script/planner/hash.js";
import { managedNodeRelationOf } from "./managed-node.js";

/** Pure, JSON-only input. Hosts pass snapshots, never their mutable transaction. */
export type ManagedNodeLifecycleContext = {
  readonly before: ServerCanvas;
  readonly canvas: ServerCanvas;
  readonly positionedNodeIds: readonly string[];
};
export type ManagedNodeLifecyclePlan = {
  /** Complete desired entity set, including unchanged nodes. */
  readonly nodes: readonly { node: ServerCanvas["document"]["nodes"][number]; data: CanvasNodeData }[];
};
export type ManagedNodeCopyContext = {
  readonly nodes: readonly ServerCanvas["document"]["nodes"][number][];
  readonly nodeData: Readonly<ServerCanvas["nodeData"]>;
  readonly nodeIds: ReadonlyMap<string, string>;
  createId(prefix: string, index: number): string;
};
export type ManagedNodeCopyEntry = { sourceNodeId: string; nodeId: string; data: CanvasNodeData };
export type ManagedNodeLifecycleAdapter = {
  readonly extensionId: string;
  readonly schemaVersion: 1;
  plan(context: ManagedNodeLifecycleContext): ManagedNodeLifecyclePlan;
  /** Pure extension-owned remapping, reused by the existing clipboard planner. */
  remapCopy?(context: ManagedNodeCopyContext): readonly ManagedNodeCopyEntry[];
};
export type ManagedNodeLifecycleResolver = {
  resolve(extensionId: string): ManagedNodeLifecycleAdapter | null;
  implementations(): readonly ManagedNodeLifecycleAdapter[];
};
/** Explicit offline boundary, called before repositories or live rooms open. */
export type ManagedNodeMigrationAdapter = {
  readonly extensionId: string;
  readonly schemaVersion: 1;
  migrate(canvas: ServerCanvas): { canvas: ServerCanvas; changed: boolean };
};

/** Registered identities come from host composition, never a command field. */
export class ManagedNodeLifecycleRegistry implements ManagedNodeLifecycleResolver {
  private readonly adapters = new Map<string, ManagedNodeLifecycleAdapter>();
  register(adapter: ManagedNodeLifecycleAdapter): () => void {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(adapter.extensionId) || adapter.extensionId.length > 200 || adapter.schemaVersion !== 1 || typeof adapter.plan !== "function") throw Error("managed-lifecycle-invalid-registration");
    if (this.adapters.has(adapter.extensionId)) throw Error("managed-lifecycle-registration-conflict");
    this.adapters.set(adapter.extensionId, adapter);
    let active = true;
    return () => { if (active && this.adapters.get(adapter.extensionId) === adapter) { active = false; this.adapters.delete(adapter.extensionId); } };
  }
  resolve(extensionId: string): ManagedNodeLifecycleAdapter | null { return this.adapters.get(extensionId) ?? null; }
  implementations(): readonly ManagedNodeLifecycleAdapter[] { return [...this.adapters.values()].sort((a, b) => a.extensionId.localeCompare(b.extensionId)); }
  has(extensionId: string): boolean { return this.adapters.has(extensionId); }
  clear(): void { this.adapters.clear(); }
}

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) immutable(entry); Object.freeze(value); }
  return value;
}

/** Apply all plans to an isolated aggregate. Throws before any host state is published. */
export function planManagedNodeLifecycles(context: ManagedNodeLifecycleContext, resolver: ManagedNodeLifecycleResolver): ServerCanvas {
  const implementations = resolver.implementations();
  if (!implementations.length && !Object.values(context.before.nodeData).some(managedNodeRelationOf) && !Object.values(context.canvas.nodeData).some(managedNodeRelationOf)) return context.canvas;
  // Match the document's JSON boundary before giving snapshots to a planner.
  // Commands may still contain undefined/function fields stripped by finalize.
  const jsonContext: ManagedNodeLifecycleContext = JSON.parse(JSON.stringify(context));
  const before = jsonContext.before, result = structuredClone(jsonContext.canvas);
  const beforeNodes = new Map(before.document.nodes.map(n => [n.id, n]));
  const afterNodes = new Map(result.document.nodes.map(n => [n.id, n]));
  // Missing implementations preserve relations and permit unrelated/layout/cache
  // edits. A source edit needs its business planner; deleting an owner does not.
  for (const [id, data] of Object.entries({ ...before.nodeData, ...result.nodeData })) {
    const relation = managedNodeRelationOf(data);
    if (!relation || resolver.resolve(relation.extensionId)) continue;
    const owner = afterNodes.get(relation.ownerNodeId);
    if (!owner) continue;
    if (!same(beforeNodes.get(owner.id)?.type, owner.type) || !same(before.nodeData[owner.id], result.nodeData[owner.id])
      || !beforeNodes.has(id) || !same(managedNodeRelationOf(before.nodeData[id]), managedNodeRelationOf(result.nodeData[id]))
      || !same(before.nodeData[id]?.mediaContent, result.nodeData[id]?.mediaContent)) {
      throw Error(`managed-lifecycle-unavailable: ${relation.extensionId}`);
    }
  }
  for (const adapter of implementations) {
    const snapshot = immutable(structuredClone({ before, canvas: result, positionedNodeIds: context.positionedNodeIds }));
    const plan = adapter.plan(snapshot);
    if (!plan || !Array.isArray(plan.nodes)) throw Error("managed-lifecycle-invalid-plan");
    const plannedIds = new Set(plan.nodes.map(entry => entry.node?.id));
    const desired = new Map<string, { node: ServerCanvas["document"]["nodes"][number]; data: CanvasNodeData }>();
    const entities = new Set<string>();
    for (const entry of plan.nodes) {
      const node = entry.node;
      if (!node || typeof node.id !== "string" || !/^[^\u0000\s]{1,512}$/.test(node.id) || typeof node.type !== "string" || !node.type
        || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
        || (node.zIndex !== undefined && !Number.isFinite(node.zIndex))) throw Error("managed-lifecycle-invalid-node");
      const currentNode = afterNodes.get(node.id);
      const minimum = minimumNodeSizeFor(node.type);
      if ((node.width !== undefined && node.width !== currentNode?.width && (!Number.isFinite(node.width) || node.width < minimum.width))
        || (node.height !== undefined && node.height !== currentNode?.height && (!Number.isFinite(node.height) || node.height < minimum.height))) throw Error("managed-lifecycle-invalid-node-size");
      if (node.parentId && node.parentId !== afterNodes.get(node.id)?.parentId && !afterNodes.has(node.parentId) && !plannedIds.has(node.parentId)) throw Error("managed-lifecycle-invalid-parent");
      if (node.parentId === node.id) throw Error("managed-lifecycle-invalid-parent");
      if (entry.data?.mediaContent !== undefined && (!["image", "video"].includes(node.type) || !decodeMediaContentRef(entry.data.mediaContent).ok)) throw Error("managed-lifecycle-invalid-content");
      // JSON-only planner output; do not silently sanitize trusted plans.
      const checkJson = (value: unknown): void => {
        if (value === null || typeof value === "string" || typeof value === "boolean") return;
        if (typeof value === "number" && Number.isFinite(value)) return;
        if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw Error("managed-lifecycle-invalid-data");
        for (const child of Object.values(value)) checkJson(child);
      };
      checkJson(entry.data);
      const relation = managedNodeRelationOf(entry.data);
      if (!relation || relation.extensionId !== adapter.extensionId || relation.ownerNodeId === entry.node.id || (!afterNodes.has(relation.ownerNodeId) && !plannedIds.has(relation.ownerNodeId))) throw Error("managed-lifecycle-invalid-ownership");
      const key = JSON.stringify([relation.ownerNodeId, relation.entityId]);
      if (desired.has(entry.node.id) || entities.has(key)) throw Error("managed-lifecycle-duplicate-entity");
      const existing = result.document.nodes.find(n => n.id === entry.node.id);
      if (existing && managedNodeRelationOf(result.nodeData[entry.node.id])?.extensionId !== adapter.extensionId) throw Error("managed-lifecycle-node-conflict");
      const existingRelation = managedNodeRelationOf(result.nodeData[node.id]);
      if (existingRelation && !same(existingRelation, relation)) throw Error("managed-lifecycle-ownership-conflict");
      const cloned = structuredClone(entry);
      delete (cloned.node as typeof cloned.node & { data?: unknown }).data;
      desired.set(entry.node.id, cloned); entities.add(key);
    }
    const removed = new Set(result.document.nodes.filter(n => managedNodeRelationOf(result.nodeData[n.id])?.extensionId === adapter.extensionId && !desired.has(n.id)).map(n => n.id));
    // Releasing an entity which owns other entities has the same persistent
    // cascade as deleting an owner, including unloaded extensions.
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of result.document.nodes) {
        const relation = managedNodeRelationOf(result.nodeData[node.id]);
        if (relation && removed.has(relation.ownerNodeId) && !removed.has(node.id)) { removed.add(node.id); grew = true; }
      }
    }
    // New client-created ownership must be one of the extension's desired
    // identities, not silently discarded by reconciliation.
    for (const id of removed) if (!beforeNodes.has(id)) throw Error("managed-lifecycle-forged-entity");
    const affected = new Set([...removed, ...[...desired.values()].filter(entry => {
      const existing = afterNodes.get(entry.node.id);
      return existing && existing.type !== entry.node.type;
    }).map(entry => entry.node.id)]);
    for (const id of affected) {
      const status = result.nodeData[id]?.taskStatus;
      if (status === "pending" || status === "processing" || result.jobs.some(job => job.nodeId === id && ["queued", "running", "draft"].includes(job.status))) throw Error("managed-lifecycle-active-run");
    }
    result.document.nodes = result.document.nodes.filter(n => !removed.has(n.id));
    result.document.edges = result.document.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
    for (const id of removed) { delete result.nodeData[id]; afterNodes.delete(id); }
    for (const { node, data } of desired.values()) {
      const index = result.document.nodes.findIndex(n => n.id === node.id);
      if (index < 0) result.document.nodes.push(node); else result.document.nodes[index] = node;
      result.nodeData[node.id] = data;
      afterNodes.set(node.id, node);
    }
  }
  // Validate the complete graph before ordinary normalization can prune or
  // reparent malformed planner output.
  const nodes = new Map(result.document.nodes.map(node => [node.id, node]));
  for (const node of nodes.values()) {
    const relation = managedNodeRelationOf(result.nodeData[node.id]);
    if (!relation) continue;
    if (!nodes.has(relation.ownerNodeId)) throw Error("managed-lifecycle-owner-missing");
    for (const kind of ["ownership", "parent"] as const) {
      const seen = new Set([node.id]);
      let current: string | undefined = kind === "ownership" ? relation.ownerNodeId : node.parentId;
      while (current) {
        if (seen.has(current)) throw Error("managed-lifecycle-cycle");
        seen.add(current);
        const ancestor = nodes.get(current);
        if (!ancestor || (kind === "parent" && ancestor.type !== "group")) throw Error("managed-lifecycle-invalid-parent");
        current = kind === "ownership" ? managedNodeRelationOf(result.nodeData[current])?.ownerNodeId : ancestor.parentId;
      }
    }
  }
  return result;
}
