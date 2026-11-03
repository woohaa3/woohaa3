/**
 * 版本图层列表：数据搬运与 store 去重
 *
 * 图片/视频节点的圆点从 scene 搬进 store 并从 scene 删除（Bevy 不再画）；其它类型保持不动；
 * scene 每帧重建、内容没变时 store 不换引用不通知。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BevyRenderNode } from "@woohaa3/contracts";
import { historyLayersStore } from "../../services/history-layers-store.js";
import { relocateHistoryStrips } from "./history-layers.js";

afterEach(() => historyLayersStore.reset());

const dot = (presentationId: string, extra: Record<string, unknown> = {}) => ({
  state: "succeeded" as const,
  current: false,
  presentationId,
  entryId: `entry-${presentationId}`,
  ...extra
});

function node(id: string, type: string, dots: ReturnType<typeof dot>[], truncated = 0): BevyRenderNode {
  return { id, type, historyStrip: { dots, truncated } } as unknown as BevyRenderNode;
}

describe("relocateHistoryStrips", () => {
  it("图片/视频：圆点搬进 store 并从 scene 删除；去掉只服务 Bevy 的 hovered / pressed", () => {
    const image = node("img", "image", [dot("a", { hovered: true, pressed: true }), dot("b", { current: true })], 2);
    const video = node("vid", "video", [dot("v")]);
    relocateHistoryStrips([image, video]);

    expect(image.historyStrip).toBeUndefined();
    expect(video.historyStrip).toBeUndefined();
    const snapshot = historyLayersStore.getSnapshot();
    expect([...snapshot.keys()]).toEqual(["img", "vid"]);
    expect(snapshot.get("img")?.truncated).toBe(2);
    expect(snapshot.get("img")?.nodeType).toBe("image");
    expect(snapshot.get("vid")?.nodeType).toBe("video");
    expect(snapshot.get("img")?.layers.map((layer) => layer.presentationId)).toEqual(["a", "b"]);
    expect(snapshot.get("img")?.layers[0]).not.toHaveProperty("hovered");
    expect(snapshot.get("img")?.layers[0]).not.toHaveProperty("pressed");
  });

  it("其它类型（模型等）保持 Bevy 圆点，不进 store", () => {
    const model = node("m", "model", [dot("x")]);
    relocateHistoryStrips([model]);
    expect(model.historyStrip).toBeDefined();
    expect(historyLayersStore.getSnapshot().size).toBe(0);
  });

  it("没有历史条的节点不进 store；之后整体清空", () => {
    relocateHistoryStrips([node("img", "image", [dot("a")])]);
    expect(historyLayersStore.getSnapshot().size).toBe(1);
    relocateHistoryStrips([{ id: "img", type: "image" } as unknown as BevyRenderNode]);
    expect(historyLayersStore.getSnapshot().size).toBe(0);
  });

  it("内容没变时不换引用、不通知（scene 每帧重建也不会引发重渲染）", () => {
    const listener = vi.fn();
    const off = historyLayersStore.subscribe(listener);
    relocateHistoryStrips([node("img", "image", [dot("a")])]);
    const first = historyLayersStore.getSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);

    relocateHistoryStrips([node("img", "image", [dot("a")])]);
    expect(historyLayersStore.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    // hovered 只服务 Bevy 指针反馈，变化不应触发 DOM 重渲染。
    relocateHistoryStrips([node("img", "image", [dot("a", { hovered: true })])]);
    expect(listener).toHaveBeenCalledTimes(1);

    relocateHistoryStrips([node("img", "image", [dot("a", { current: true })])]);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
