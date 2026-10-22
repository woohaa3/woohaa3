import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "../domain/index.js";
import { isSameCommittedState } from "./finalize.js";

// Retained comparison contract: timestamps/revision are deliberately excluded.
function original(a: ServerCanvas, b: ServerCanvas): boolean {
  const state = (canvas: ServerCanvas) => ({
    title: canvas.title ?? "", nodes: canvas.document.nodes, edges: canvas.document.edges,
    nodeData: canvas.nodeData, assets: canvas.assets, jobs: canvas.jobs
  });
  return JSON.stringify(state(a)) === JSON.stringify(state(b));
}

describe("committed state JSON comparison", () => {
  it("matches the original for content edits, ordering, moves and ignored metadata", () => {
    const base = createEmptyWoohaa3ServerCanvas("c", "2026-10-13T00:00:00Z");
    base.document.nodes = [{ id: "a", type: "model3d", position: { x: 0, y: 0 } }];
    base.nodeData = { a: { title: "model", modelScript: "scene.box({});" } };
    const variants = [structuredClone(base)];
    for (const mutate of [
      (c: ServerCanvas) => { c.document.nodes[0].position.x = 1; },
      (c: ServerCanvas) => { c.document.nodes.reverse(); c.document.nodes.push({ id: "b", type: "text", position: { x: 0, y: 0 } }); },
      (c: ServerCanvas) => { c.title = "changed"; },
      (c: ServerCanvas) => { c.nodeData.a.title = "changed"; },
      (c: ServerCanvas) => { c.nodeData.a = { modelScript: "scene.box({});", title: "model" }; },
      (c: ServerCanvas) => { c.document.edges.push({ id: "e", source: "a", target: "a", data: {} }); },
      (c: ServerCanvas) => { c.assets = [{ id: "asset", title: "image", mediaKind: "image", source: "generated", status: "ready", createdAt: "2026-10-13T00:00:00Z" }]; },
      (c: ServerCanvas) => { c.jobs = [{ id: "job", nodeId: "a", taskId: "task", status: "queued", updatedAt: "2026-10-13T00:00:00Z" }]; },
      (c: ServerCanvas) => { c.revision++; c.updatedAt = "2026-10-14T00:00:00Z"; }
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      variants.push(changed);
    }
    for (const a of variants) for (const b of variants) {
      expect(isSameCommittedState(a, b)).toBe(original(a, b));
    }
  });

  it("does not read unrelated content when node JSON already differs", () => {
    const a = createEmptyWoohaa3ServerCanvas("c");
    const b = structuredClone(a);
    b.document.nodes.push({ id: "a", type: "text", position: { x: 1, y: 0 } });
    Object.defineProperty(a, "nodeData", { get() { throw new Error("unrelated content read"); } });
    expect(isSameCommittedState(a, b)).toBe(false);
  });
});
