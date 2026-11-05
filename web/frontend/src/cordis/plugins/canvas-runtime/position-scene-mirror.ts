import type { CanvasRenderScene, CanvasPositionUpdate } from "@woohaa3/contracts";

/** Mirror after renderer acceptance; Rust owns validation and query/render acceptance. */
export class PositionSceneMirror {
  private slots = new Map<string, { index: number }>();

  reset(scene: CanvasRenderScene): CanvasRenderScene {
    this.slots.clear();
    scene.nodes.forEach((node, index) => {
      this.slots.set(node.id, { index });
    });
    return { ...scene, nodes: [...scene.nodes] };
  }

  node(scene: CanvasRenderScene, nodeId: string): CanvasRenderScene["nodes"][number] | null {
    const slot = this.slots.get(nodeId);
    return slot ? scene.nodes[slot.index] ?? null : null;
  }

  apply(scene: CanvasRenderScene, input: Omit<CanvasPositionUpdate, "version">): CanvasRenderScene {
    for (const position of input.positions) {
      const slot = this.slots.get(position.id);
      if (!slot) continue; // Accepted by Rust; no speculative mirror writes before acceptance.
      const node = scene.nodes[slot.index]!;
      scene.nodes[slot.index] = { ...node, x: position.x, y: position.y };
    }
    return input.viewport ? { ...scene, viewport: { ...input.viewport } } : scene;
  }
}
