/**
 * Showcase 自有导航树的纯函数测试
 * （change: 2026-09-29-refresh-showcase-shell，任务 2）。
 */
import { describe, expect, it } from "vitest";
import {
  buildStoryTree,
  orderStoryIds,
  parseStoryMeta,
  storyFromSearch,
  type StoryMetaEntry
} from "./story-nav.js";

const meta = {
  stories: {
    "画布组件--执行面板--生产组合--音频--带参考音频": {
      name: "带参考音频",
      levels: ["画布组件", "执行面板", "生产组合", "音频"]
    },
    "画布组件--执行面板--生产组合--菜单--三组菜单": {
      name: "三组菜单",
      levels: ["画布组件", "执行面板", "生产组合", "菜单"]
    },
    "画布组件--执行面板--生产组合--图片-·-生产组合": {
      name: "图片 · 生产组合",
      levels: ["画布组件", "执行面板", "生产组合"]
    }
  }
};

describe("parseStoryMeta", () => {
  it("解析 name / levels 并按传入 storyOrder 排序", () => {
    const entries = parseStoryMeta(meta);
    // 图片（title 只有 3 层）挂在组目录下；它出现在 storyOrder 首位，因此排最前。
    expect(entries[0]).toEqual({
      id: "画布组件--执行面板--生产组合--图片-·-生产组合",
      name: "图片 · 生产组合",
      levels: ["画布组件", "执行面板", "生产组合"]
    });
  });

  it("非法输入返回空数组", () => {
    expect(parseStoryMeta(null)).toEqual([]);
    expect(parseStoryMeta({})).toEqual([]);
    expect(parseStoryMeta({ stories: { bad: 1 } })).toEqual([]);
  });
});

describe("orderStoryIds", () => {
  it("前缀通配按表排序，未命中保留在末尾（不丢弃）", () => {
    const ids = ["b--x", "a--1", "unmatched--z", "a--2"];
    const ordered = orderStoryIds(ids, ["a--*", "b--*"]);
    expect(ordered).toEqual(["a--1", "a--2", "b--x", "unmatched--z"]);
  });

  it("空/缺省顺序时保留全部 id", () => {
    expect(orderStoryIds(["x", "y"], [])).toEqual(["x", "y"]);
  });
});

describe("buildStoryTree", () => {
  it("levels 全部是分组，name 是叶子显示名", () => {
    const tree = buildStoryTree(parseStoryMeta(meta));
    const root = tree[0]!;
    expect(root.name).toBe("画布组件");
    expect(root.storyId).toBeNull();
    const panel = root.children[0]!;
    expect(panel.name).toBe("执行面板");
    const combo = panel.children[0]!;
    expect(combo.name).toBe("生产组合");
    // 生产组合下：图片是直接叶子，音频/菜单是分组。
    const leafNames = combo.children.filter((n) => n.storyId !== null).map((n) => n.name);
    expect(leafNames).toEqual(["图片 · 生产组合"]);
    const audio = combo.children.find((n) => n.name === "音频")!;
    expect(audio.storyId).toBeNull();
    expect(audio.children[0]).toEqual({
      id: "画布组件--执行面板--生产组合--音频--带参考音频",
      name: "带参考音频",
      storyId: "画布组件--执行面板--生产组合--音频--带参考音频",
      children: []
    });
  });

  it("叶子节点保留完整 story id", () => {
    const tree = buildStoryTree([
      { id: "a--b--c--leaf", name: "Leaf", levels: ["a", "b", "c"] }
    ] satisfies StoryMetaEntry[]);
    let node = tree[0]!;
    expect(node.id).toBe("group:a");
    node = node.children[0]!;
    expect(node.id).toBe("group:a/b");
    node = node.children[0]!;
    expect(node.id).toBe("group:a/b/c");
    expect(node.children[0]!.storyId).toBe("a--b--c--leaf");
  });
});

describe("storyFromSearch", () => {
  it("解析 ?story= 并解码", () => {
    expect(storyFromSearch("?story=" + encodeURIComponent("画布组件--x"))).toBe("画布组件--x");
    expect(storyFromSearch("?mode=preview&story=abc")).toBe("abc");
    expect(storyFromSearch("?mode=preview")).toBeNull();
  });
});
