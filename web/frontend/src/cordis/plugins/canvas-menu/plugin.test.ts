/**
 * canvas-menu 节点菜单项测试（change: add-canvas-node-grouping，任务 3.1）。
 *
 * 只测纯函数 `nodeContextMenuItems`：打组/解组/整理/删除的可用性判定。
 */
import { describe, expect, it } from "vitest";
import {
  nodeContextMenuItems,
  type CanvasMenuNode
} from "./plugin.js";
import { shotReferenceTemplateItems } from "./shot-reference-menu.js";
import { NODE_TEMPLATES } from "../../domain/node-catalog.js";

const nodes: CanvasMenuNode[] = [
  { id: "g", type: "group" },
  { id: "a", type: "image", parentId: "g" },
  { id: "b", type: "image" },
  { id: "c", type: "text" }
];

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

describe("nodeContextMenuItems（change: add-canvas-node-grouping）", () => {
  it("选中两个顶层非 group 节点时提供打组", () => {
    const items = nodeContextMenuItems(nodes, ["b", "c"], true);
    expect(ids(items)).toContain("group-selection");
    expect(ids(items)).toContain("delete-node");
    // 不提供解组/整理。
    expect(ids(items)).not.toContain("ungroup-selection");
    expect(ids(items)).not.toContain("tidy-group");
  });

  it("只选中一个节点时不提供打组", () => {
    expect(ids(nodeContextMenuItems(nodes, ["b"], true))).not.toContain("group-selection");
  });

  it("选中 group 时提供解组", () => {
    expect(ids(nodeContextMenuItems(nodes, ["g"], true))).toContain("ungroup-selection");
  });

  it("选中 group 成员时提供解组", () => {
    expect(ids(nodeContextMenuItems(nodes, ["a"], true))).toContain("ungroup-selection");
  });

  it("单选 group 时同时提供整理", () => {
    const items = ids(nodeContextMenuItems(nodes, ["g"], true));
    expect(items).toContain("tidy-group");
    expect(items).toContain("ungroup-selection");
  });

  it("单选 group 时提供运行，多选时不提供", () => {
    expect(ids(nodeContextMenuItems(nodes, ["g"], true))).toContain("run-group");
    expect(ids(nodeContextMenuItems(nodes, ["g", "b"], true))).not.toContain("run-group");
    expect(ids(nodeContextMenuItems(nodes, ["b"], true))).not.toContain("run-group");
  });

  it("多选时不提供整理", () => {
    expect(ids(nodeContextMenuItems(nodes, ["g", "b"], true))).not.toContain("tidy-group");
  });

  it("不可写时所有动作禁用", () => {
    const items = nodeContextMenuItems(nodes, ["b", "c"], false);
    expect(items.every((item) => item.disabled)).toBe(true);
  });

  it("删除项始终存在且为 danger", () => {
    const items = nodeContextMenuItems(nodes, ["b"], true);
    const del = items.find((item) => item.id === "delete-node");
    expect(del?.danger).toBe(true);
  });
});

describe("nodeContextMenuItems 预览保护（change: 2026-10-15 任务 5.5）", () => {
  const withPreview: CanvasMenuNode[] = [
    ...nodes,
    { id: "shot-preview:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", type: "film-set-shot-preview" }
  ];
  const PREVIEW = "shot-preview:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("选择集只含受保护预览时只给说明项，不提供删除/重命名/打组", () => {
    const items = nodeContextMenuItems(withPreview, [PREVIEW], true, { activeNodeId: PREVIEW });
    expect(ids(items)).toEqual(["shot-preview-protected"]);
  });

  it("指针位于预览上时隐藏删除与重命名", () => {
    const items = ids(nodeContextMenuItems(withPreview, [PREVIEW], true, { activeNodeId: PREVIEW }));
    expect(items).not.toContain("delete-node");
    expect(items).not.toContain("rename-node");
  });

  it("混合选择时过滤预览后仍可操作普通节点", () => {
    const items = ids(nodeContextMenuItems(withPreview, [PREVIEW, "b"], true, { activeNodeId: "b" }));
    // 预览被剔除后只剩 b：「打组」不可用，但删除仍可用。
    expect(items).not.toContain("group-selection");
    expect(items).toContain("delete-node");
  });
});

describe("shotReferenceTemplateItems（change: 2026-10-15，任务 8.2）", () => {
  const connectFrom = { nodeId: "shot-preview:x", nodeType: "film-set-shot-preview" };

  it("从镜头预览拉线时只提供视频节点，其余显式禁用并给出原因", () => {
    const items = shotReferenceTemplateItems(NODE_TEMPLATES, true, connectFrom);
    const video = items.find((item) => item.id === "insert:video")!;
    expect(video.disabled).toBe(false);
    const image = items.find((item) => item.id === "insert:image")!;
    expect(image.disabled).toBe(true);
    expect(image.reason).toBe("镜头参考只能连到视频生成节点");
  });

  it("只读时视频项也禁用", () => {
    const items = shotReferenceTemplateItems(NODE_TEMPLATES, false, connectFrom);
    expect(items.every((item) => item.disabled)).toBe(true);
  });
});
