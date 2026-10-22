/**
 * 瞬时 hover 节点存储测试
 * （动画节点 hover 播放）。
 */
import { describe, expect, it } from "vitest";
import { HoverNodeStore } from "../services/hover-store.js";

describe("HoverNodeStore", () => {
  it("设置/清除 hover 节点并通知订阅者", () => {
    const store = new HoverNodeStore();
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getNodeId()));

    store.setNodeId("anim-1");
    expect(store.getNodeId()).toBe("anim-1");
    store.setNodeId("anim-2");
    store.setNodeId(null);
    expect(store.getNodeId()).toBeNull();
    expect(seen).toEqual(["anim-1", "anim-2", null]);

    unsubscribe();
    store.setNodeId("anim-3");
    // 退订后不再收到通知。
    expect(seen).toEqual(["anim-1", "anim-2", null]);
  });

  it("相同值不重复通知，reset 清空", () => {
    const store = new HoverNodeStore();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.setNodeId("a");
    store.setNodeId("a");
    expect(count).toBe(1);
    store.reset();
    expect(count).toBe(2);
    expect(store.getNodeId()).toBeNull();
  });
});
