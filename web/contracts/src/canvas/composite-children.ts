/** Shared canvas children of a composite asset. Business identity stays with its extension. */
import type { CanvasCommand } from "./commands.js";
import { nextWoohaa3CanvasNodeZIndex, type CanvasNodeData, type Woohaa3CanvasNode, type ServerCanvas } from "./domain/index.js";

export type CompositeChildKind = "container" | "entity";
export type CompositeChildRelation = {
  nodeId: string;
  ownerNodeId: string;
  kind: CompositeChildKind;
  role: "object-entry" | "preview";
  /** Defaults to true. Explicitly moving the child always wins. */
  followOwner?: boolean;
};
export type CompositeContainerPanel = { title: string; message?: string; hint?: string; imageIds?: string[] };
export type CompositeChildBounds = { x: number; y: number; width: number; height: number };

/** Place only new children, preserving all existing saved positions. */
export function placeCompositeChild(input: {
  preferred: CompositeChildBounds; occupied: readonly CompositeChildBounds[];
  direction?: "up" | "down" | "right"; spacing?: number; step?: number; maxAttempts?: number;
}): CompositeChildBounds {
  const result = { ...input.preferred }, spacing = input.spacing ?? 0;
  const taken = input.occupied;
  if (input.direction === "right") {
    const intersects = (rect: CompositeChildBounds) => result.y < rect.y + rect.height && result.y + result.height > rect.y;
    for (let attempt = 0; attempt < (input.maxAttempts ?? 4096); attempt++) {
      const conflict = taken.find(rect => intersects(rect) && result.x < rect.x + rect.width + spacing && result.x + result.width + spacing > rect.x);
      if (!conflict) return result;
      result.x = conflict.x + conflict.width + spacing;
    }
    const overlapping = taken.filter(intersects);
    if (overlapping.length) result.x = Math.max(result.x, ...overlapping.map(rect => rect.x + rect.width + spacing));
    return result;
  }
  const step = input.step ?? result.height + spacing;
  for (let attempt = 0; attempt < (input.maxAttempts ?? 4096); attempt++) {
    const conflict = taken.find(rect => result.x < rect.x + rect.width && result.x + result.width > rect.x && result.y < rect.y + rect.height + spacing && result.y + result.height + spacing > rect.y);
    if (!conflict) return result;
    result.y = input.direction === "up" ? conflict.y - result.height - spacing : result.y + step;
  }
  // A dense or very tall canvas must still accept new children after the bounded scan.
  const overlapping = taken.filter(rect => result.x < rect.x + rect.width && result.x + result.width > rect.x);
  if (overlapping.length) result.y = input.direction === "up"
    ? Math.min(...overlapping.map(rect => rect.y), result.y) - result.height - spacing
    : Math.max(...overlapping.map(rect => rect.y + rect.height + spacing), result.y);
  return result;
}
export function planCompositeChildLayout(input: {
  ownerBounds: CompositeChildBounds; sizes: readonly { width: number; height: number }[];
  occupied: readonly CompositeChildBounds[]; gap?: number; spacing?: number; step?: number; maxAttempts?: number;
  /** Row above the owner, or the default column to its right. */
  layout?: "row" | "column";
}): CompositeChildBounds[] {
  const taken = input.occupied.map(rect => ({ ...rect })), result: CompositeChildBounds[] = [];
  if (input.layout === "row") {
    let x = input.ownerBounds.x;
    for (const size of input.sizes) {
      const next = placeCompositeChild({ preferred: { x, y: input.ownerBounds.y - (input.gap ?? 48) - size.height, ...size }, occupied: taken, direction: "right", spacing: input.spacing ?? 24, maxAttempts: input.maxAttempts });
      taken.push(next); result.push(next); x = next.x + size.width + (input.spacing ?? 24);
    }
    return result;
  }
  let y = input.ownerBounds.y;
  for (const size of input.sizes) {
    const next = placeCompositeChild({ preferred: { x: input.ownerBounds.x + input.ownerBounds.width + (input.gap ?? 48), y, ...size }, occupied: taken, spacing: 0, step: input.step ?? 32, maxAttempts: input.maxAttempts });
    taken.push(next); result.push(next); y = next.y + size.height + (input.spacing ?? 24);
  }
  return result;
}

/** One world-coordinate move/reparent rule for containers and entity cards. */
export function compositeChildMovementContext(before: readonly Woohaa3CanvasNode[], current: readonly Woohaa3CanvasNode[]) {
  return { before: new Map(before.map(node => [node.id, node])), current: new Map(current.map(node => [node.id, node])) };
}
export function followCompositeChildOwner(
  child: Woohaa3CanvasNode, owner: Woohaa3CanvasNode,
  before: readonly Woohaa3CanvasNode[], current: readonly Woohaa3CanvasNode[], explicit: boolean,
  context = compositeChildMovementContext(before, current)
): void {
  const oldMap = context.before;
  const oldChild = oldMap.get(child.id), oldOwner = oldMap.get(owner.id);
  const oldAbsolute = oldChild ? { ...oldChild.position } : null;
  let absolute = { ...child.position };
  if (!explicit && oldAbsolute && oldOwner) {
    absolute = { x: oldAbsolute.x + owner.position.x - oldOwner.position.x, y: oldAbsolute.y + owner.position.y - oldOwner.position.y };
  }
  child.position = absolute;
}

/** Construct a sibling in the owner's group from an absolute canvas placement. */
export function createCompositeChildNode(input: {
  nodes: readonly Woohaa3CanvasNode[]; owner: Woohaa3CanvasNode; id: string;
  type: Woohaa3CanvasNode["type"]; bounds: CompositeChildBounds;
}): Woohaa3CanvasNode {
  return { id: input.id, type: input.type, data: {}, position: { x: input.bounds.x, y: input.bounds.y }, width: input.bounds.width, height: input.bounds.height, zIndex: nextWoohaa3CanvasNodeZIndex(input.nodes) };
}

export function removeCompositeChildNodes<T extends { nodes: Woohaa3CanvasNode[]; edges: ServerCanvas["document"]["edges"]; nodeData: ServerCanvas["nodeData"] }>(work: T, ids: ReadonlySet<string>): void {
  work.nodes = work.nodes.filter(node => !ids.has(node.id));
  work.edges = work.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target));
  for (const id of ids) delete work.nodeData[id];
}

/** Extension-side projection uses the same grouped node constructor as canonical reducers. */
export function planCompositeChildNode(input: {
  canvas: ServerCanvas; ownerNodeId: string; id: string; type: Woohaa3CanvasNode["type"];
  bounds: CompositeChildBounds; data: CanvasNodeData; recreate?: boolean;
}): CanvasCommand[] {
  const nodes = input.canvas.document.nodes.map(node => ({ ...node, data: {} }));
  const owner = nodes.find(node => node.id === input.ownerNodeId);
  if (!owner) return [];
  const existing = nodes.find(node => node.id === input.id);
  if (!existing || input.recreate) {
    const { data: _, ...node } = createCompositeChildNode({ nodes, owner, id: input.id, type: input.type, bounds: input.bounds });
    return [{ type: "node.add", node, nodeData: input.data }];
  }
  return Object.keys(input.data).some(key => stableJson(input.canvas.nodeData[input.id]?.[key]) !== stableJson(input.data[key])) ? [{ type: "nodeData.patch", nodeId: input.id, value: input.data }] : [];
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Containers no longer exist; adapters cannot grant membership. */
export function canvasContainerRelations(canvas: ServerCanvas): Array<{ role: "member"; nodeId: string; ownerNodeId: string }> {
  void canvas;
  return [];
}
export function compositeChildPolicy(relation: CompositeChildRelation): { movement: "follow-owner" | "independent"; copy: "owner-closure"; removal: "close-presentation" | "source-only"; navigation: "owner-object" | "owner-preview" } {
  if (relation.role !== "object-entry" && relation.role !== "preview") throw Error("unknown-composite-child-relation");
  return { movement: relation.followOwner === false ? "independent" : "follow-owner", copy: "owner-closure",
    removal: relation.role === "object-entry" ? "close-presentation" : "source-only", navigation: relation.role === "object-entry" ? "owner-object" : "owner-preview" };
}
