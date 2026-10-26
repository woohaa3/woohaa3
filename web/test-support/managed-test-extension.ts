import type { CanvasCommand, CanvasNodeData, ManagedNodeLifecycleAdapter } from "@woohaa3/contracts";

/** Deliberately unrelated to film-set; proves host behavior is relation-driven. */
export const testManagedLifecycle: ManagedNodeLifecycleAdapter = {
  extensionId: "test.entities", schemaVersion: 1,
  plan({ canvas }) {
    return { nodes: canvas.document.nodes.filter(n => canvas.nodeData[n.id]?.extensionId === "test.entities").flatMap(owner => {
      const entities = canvas.nodeData[owner.id]?.entries;
      if (!Array.isArray(entities) || entities.some(e => typeof e !== "string")) throw Error("invalid-test-entities");
      return entities.map(entity => {
        const id = `${owner.id}:${entity}`;
        return { node: canvas.document.nodes.find(n => n.id === id) ?? { id, type: "image", position: { x: 300, y: 0 }, width: 200, height: 200, zIndex: 2 },
          data: { ...canvas.nodeData[id], managedBy: { schemaVersion: 1 as const, extensionId: "test.entities", ownerNodeId: owner.id, entityId: String(entity), lifecycle: "owner-managed" as const } } as CanvasNodeData };
      });
    }) };
  }
};
export const testManagedOwner: CanvasCommand = {
  type: "node.add", node: { id: "owner", type: "text", position: { x: 0, y: 0 } },
  nodeData: { extensionId: "test.entities", entries: ["one"] }
};
