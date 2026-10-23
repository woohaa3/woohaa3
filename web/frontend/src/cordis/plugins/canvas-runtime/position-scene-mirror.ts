import type { CanvasRenderScene, CanvasPositionUpdate } from "@woohaa3/contracts";

/** Mirror after renderer acceptance; Rust owns validation and query/render acceptance. */
export class PositionSceneMirror {
  private slots = new Map<string, { index: number; scopeOffset?: { x: number; y: number } }>();

  reset(scene: CanvasRenderScene): CanvasRenderScene {
    this.slots.clear();
    scene.nodes.forEach((node, index) => {
      this.slots.set(node.id, {
        index,
        ...(node.compositeAsset ? { scopeOffset: {
          x: node.compositeAsset.x - node.x, y: node.compositeAsset.y - node.y
        } } : {})
      });
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
      scene.nodes[slot.index] = {
        ...node, x: position.x, y: position.y,
        ...(node.compositeAsset && slot.scopeOffset ? { compositeAsset: {
          ...node.compositeAsset, x: position.x + slot.scopeOffset.x, y: position.y + slot.scopeOffset.y,
          ...(node.compositeAsset.scopeGround ? { scopeGround: {
            ...node.compositeAsset.scopeGround,
            cx: node.compositeAsset.scopeGround.cx + position.x - node.x,
            cy: node.compositeAsset.scopeGround.cy + position.y - node.y
          } } : {})
        } } : {})
      };
    }
    return input.viewport ? { ...scene, viewport: { ...input.viewport } } : scene;
  }
}
