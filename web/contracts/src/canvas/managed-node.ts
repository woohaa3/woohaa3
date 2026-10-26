/**
 * Neutral, persistent ownership for extension managed nodes.
 *
 * The canvas core deliberately treats `entityId` as opaque.  Business codecs
 * belong to the extension which registered the lifecycle implementation.
 */
export type ManagedNodeLifecycle = "owner-managed";
export type ManagedNodeRelation = {
  schemaVersion: 1;
  extensionId: string;
  ownerNodeId: string;
  entityId: string;
  lifecycle: ManagedNodeLifecycle;
};

const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const ENTITY_ID = /^[^\u0000\s]{1,512}$/;

export function decodeManagedNodeRelation(value: unknown): { ok: true; value: ManagedNodeRelation } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "managedBy 必须是对象" };
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) return { ok: false, reason: "managedBy.schemaVersion 不受支持" };
  if (typeof input.extensionId !== "string" || !EXTENSION_ID.test(input.extensionId) || input.extensionId.length > 200) return { ok: false, reason: "managedBy.extensionId 非法" };
  if (typeof input.ownerNodeId !== "string" || !ENTITY_ID.test(input.ownerNodeId)) return { ok: false, reason: "managedBy.ownerNodeId 非法" };
  if (typeof input.entityId !== "string" || !ENTITY_ID.test(input.entityId)) return { ok: false, reason: "managedBy.entityId 非法" };
  if (input.lifecycle !== "owner-managed") return { ok: false, reason: "managedBy.lifecycle 不受支持" };
  return { ok: true, value: { schemaVersion: 1, extensionId: input.extensionId, ownerNodeId: input.ownerNodeId, entityId: input.entityId, lifecycle: "owner-managed" } };
}

export function managedNodeRelationOf(data: unknown): ManagedNodeRelation | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>).managedBy;
  if (value === undefined) return null;
  const decoded = decodeManagedNodeRelation(value);
  return decoded.ok ? decoded.value : null;
}

export function nodePolicy(data: unknown): { canDeleteIndependently: boolean; lifecycle: ManagedNodeLifecycle | "independent" } {
  const relation = managedNodeRelationOf(data);
  return relation ? { canDeleteIndependently: false, lifecycle: relation.lifecycle } : { canDeleteIndependently: true, lifecycle: "independent" };
}

export function managedNodeIdsForOwner(nodeData: Record<string, unknown>, ownerNodeId: string): string[] {
  return Object.entries(nodeData).flatMap(([nodeId, data]) => managedNodeRelationOf(data)?.ownerNodeId === ownerNodeId ? [nodeId] : []);
}

/** Selection policy shared by menus and shortcuts, including group descendants. */
export function partitionManagedNodeDeletion(
  nodes: readonly { id: string; parentId?: string }[],
  nodeData: Readonly<Record<string, unknown>>,
  selectedNodeIds: readonly string[]
): { allowed: string[]; blocked: string[] } {
  const descendants = (roots: readonly string[]): Set<string> => {
    const ids = new Set(roots);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id); grew = true;
      }
      for (const node of nodes) {
        const relation = managedNodeRelationOf(nodeData[node.id]);
        if (relation && ids.has(relation.ownerNodeId) && !ids.has(node.id)) { ids.add(node.id); grew = true; }
      }
    }
    return ids;
  };
  let allowed = [...new Set(selectedNodeIds)].filter(id => nodes.some(node => node.id === id));
  let changed = true;
  while (changed) {
    const removed = descendants(allowed);
    const next = allowed.filter(id => [...descendants([id])].every(childId => {
      const relation = managedNodeRelationOf(nodeData[childId]);
      return !relation || removed.has(relation.ownerNodeId);
    }));
    changed = next.length !== allowed.length;
    allowed = next;
  }
  const accepted = new Set(allowed);
  return { allowed, blocked: selectedNodeIds.filter(id => !accepted.has(id)) };
}

