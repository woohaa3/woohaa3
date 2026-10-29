import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentContributionRegistry, resolveContentHoverPlaybackTarget } from "@woohaa3/contracts";
import { hoverNodeStore } from "../../services/hover-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { installInteractionController } from "./interaction-controller.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";
installSharedSession();
afterEach(() => hoverNodeStore.reset());
function setup(withFrames = false) {
  const canvas = canvasWith([{ id: "film", x: 0, y: 0 }, { id: "preview", x: 300, y: 0 }]);
  canvas.document.nodes[0].type = "model3d";
  // 预览节点带**权威归属**：宿主只从合法内容区命中 + 当前画布 nodeData 派生 typed target。
  canvas.document.nodes[1].type = "film-set-shot-preview";
  (canvas.nodeData as Record<string, unknown>)["preview"] = {
    shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" }
  };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const pending: FrameRequestCallback[] = [];
  if (withFrames) Object.assign(dom.target, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { pending.push(callback); return pending.length; },
    cancelAnimationFrame: () => {}
  });
  const advance = () => { for (const callback of pending.splice(0)) callback(0); };
  const { runtime } = runtimeCapturing();
  let hit: import("../canvas-runtime/bevy-runtime.js").PointHit | null = { kind: "shot-preview", nodeId: "preview" };
  let generation = 1;
  let unavailable = false;
  const points: { x: number; y: number }[] = [];
  runtime.generation = () => generation;
  runtime.queryPoint = input => { points.push(input); if (unavailable) return { ok: false, reason: "unavailable" } as never; return { ok: true, generation: input.generation, value: hit }; };
  runtime.queryModelPick = () => ({ ok: true, generation: 1, value: { nodeId: "film" } } as never);
  const content = new ContentContributionRegistry();
  content.register({
    extensionId: "test-content",
    interaction: {
      isManagedNode: (type) => type === "film-set-shot-preview",
      selectionActions: () => ({ allowed: true }),
      hoverPlaybackTarget: (_type, data) => {
        const ownership = (data as { shotPreview?: { filmSetNodeId?: string; clipId?: string } } | undefined)?.shotPreview;
        return ownership?.filmSetNodeId && ownership.clipId ? { ownerNodeId: ownership.filmSetNodeId, entityId: ownership.clipId } : null;
      },
      doubleClickTarget: (_type, data) => {
        const ownership = (data as { shotPreview?: { filmSetNodeId?: string; clipId?: string } } | undefined)?.shotPreview;
        return ownership?.filmSetNodeId && ownership.clipId ? { kind: "shot-preview", nodeId: ownership.filmSetNodeId, entityId: ownership.clipId } : null;
      }
    }
  });
  expect(resolveContentHoverPlaybackTarget(content, "film-set-shot-preview", (canvas.nodeData as Record<string, unknown>)["preview"])).toEqual({ ownerNodeId: "film", entityId: "clip-1" });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    compositeAssets: { contentContributions: content, projectCanvas: (canvas: unknown) => canvas } as never,
    getRuntime: () => runtime, getSession: () => getSession() as never });
  return { dom, controller, points, advance, setUnavailable: (value: boolean) => { unavailable = value; }, setHit: (value: typeof hit) => { hit = value; }, replace: () => { generation++; } };
}
describe("shared playback eligibility", () => {
  it("retries an unavailable stationary-pointer query without selection or scene invalidation", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const f = setup(true);
    f.setUnavailable(true);
    f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    f.controller.flush();
    expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    f.setUnavailable(false);
    now.mockReturnValue(101);
    f.advance();
    // 测试 harness 的 rAF 只在显式推进时触发；同一坐标再发一次移动以结算已到期的查询。
    f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    expect(hoverNodeStore.getPlaybackSnapshot().target?.previewNodeId).toBe("preview");
    const queries = f.points.length;
    now.mockReturnValue(250);
    f.advance();
    expect(f.points.length).toBe(queries);
    f.controller.dispose(); now.mockRestore();
  });
  it("publishes only shot preview content hits; title, grips and model AABB are rejected", () => {
    const f = setup(); f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    // 内容区命中 + 合法归属 → typed 目标（含明确 owner + clip）。
    expect(hoverNodeStore.getPlaybackSnapshot().target).toEqual({ kind: "shot-preview", previewNodeId: "preview", ownerNodeId: "film", entityId: "clip-1" });
    // 抓手指向同一节点仍不建立播放入口。
    f.setHit({ kind: "resize", nodeId: "preview" }); f.dom.fire("pointermove", { clientX: 101, clientY: 101 });
    expect(hoverNodeStore.getNodeId()).toBe("preview");
    expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    // 片场地面命中（旧开播路径）不再建立候选。
    f.setHit({ kind: "film-scope", nodeId: "film" }); f.dom.fire("pointermove", { clientX: 102, clientY: 102 });
    expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    // 卡片标题/边框回落普通 Node 命中：同样不开播。
    f.setHit({ kind: "node", nodeId: "preview" }); f.dom.fire("pointermove", { clientX: 103, clientY: 103 });
    expect(hoverNodeStore.getNodeId()).toBe("preview");
    expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    expect(submitted).toHaveLength(0); f.controller.dispose();
  });
  it("viewport controls invalidate the deadline and requery beneath a stationary pointer", () => {
    const f = setup(); f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    const before = hoverNodeStore.getPlaybackSnapshot().epoch;
    const point = f.points.at(-1);
    f.controller.zoomBy(2); f.controller.flush();
    f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    expect(hoverNodeStore.getPlaybackSnapshot().epoch).toBeGreaterThan(before);
    expect(f.points.at(-1)).not.toEqual(point);
    expect(hoverNodeStore.getPlaybackSnapshot().target?.previewNodeId).toBe("preview");
    const epoch = hoverNodeStore.getPlaybackSnapshot().epoch;
    f.replace(); f.controller.flush();
    expect(hoverNodeStore.getPlaybackSnapshot().epoch).toBeGreaterThan(epoch);
    f.controller.dispose(); expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
  });
  it("pan and capture owners revoke eligibility until they release it", () => {
    const f = setup(); f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    f.dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 1 }); f.controller.flush();
    expect(hoverNodeStore.getPlaybackSnapshot().blocked).toBe(true);
    f.dom.fire("pointerup", { clientX: 100, clientY: 100, button: 1 }); f.controller.flush();
    f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    expect(hoverNodeStore.getPlaybackSnapshot().target?.previewNodeId).toBe("preview");
    const release = hoverNodeStore.acquirePlaybackOwner();
    expect(hoverNodeStore.getPlaybackSnapshot().blocked).toBe(true);
    f.controller.flush(); expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    release(); f.controller.flush();
    f.dom.fire("pointermove", { clientX: 100, clientY: 100 });
    expect(hoverNodeStore.getPlaybackSnapshot().target?.previewNodeId).toBe("preview");
    f.dom.fire("pointerleave", {}); f.controller.flush();
    expect(hoverNodeStore.getPlaybackSnapshot().target).toBeNull();
    f.controller.dispose();
  });
});
