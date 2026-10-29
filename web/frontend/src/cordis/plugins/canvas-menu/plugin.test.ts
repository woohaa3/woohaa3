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
import { createFilmSetGroupMarker } from "@woohaa3/contracts";

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
  it("hides independent deletion for a managed node from an unrelated extension", () => {
    const nodeData = { b: { managedBy: { schemaVersion: 1, extensionId: "test.extension", ownerNodeId: "c", entityId: "entry", lifecycle: "owner-managed" } } };
    expect(ids(nodeContextMenuItems(nodes, ["b"], true, { activeNodeId: "b", nodeData }))).not.toContain("delete-node");
    expect(ids(nodeContextMenuItems(nodes, ["c"], true, { activeNodeId: "c", nodeData }))).toContain("delete-node");
  });
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

  it("片场组不提供整理、解组和批量执行", () => {
    const filmSetNodes: CanvasMenuNode[] = [{ id: "film", type: "group" }, { id: "shot", type: "image", parentId: "film" }];
    const items = ids(nodeContextMenuItems(filmSetNodes, ["film"], true, {
      nodeData: { film: { filmSetGroup: createFilmSetGroupMarker() } }
    }));
    expect(items).not.toContain("tidy-group");
    expect(items).not.toContain("run-group");
    expect(items).not.toContain("ungroup-group");
    expect(items).not.toContain("ungroup-selection");
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

describe("nodeContextMenuItems neutral managed policy", () => {
  const managedNodes: CanvasMenuNode[] = [...nodes, { id: "owned", type: "image" }];
  const nodeData = { owned: { managedBy: { schemaVersion: 1 as const, extensionId: "test.entities", ownerNodeId: "b", entityId: "entity", lifecycle: "owner-managed" as const } } };
  it("hides independent deletion without a film-set implementation", () => {
    expect(ids(nodeContextMenuItems(managedNodes, ["owned"], true, { activeNodeId: "owned", nodeData }))).not.toContain("delete-node");
  });
  it("keeps owner deletion and ordinary mixed selections available", () => {
    expect(ids(nodeContextMenuItems(managedNodes, ["owned", "b"], true, { nodeData }))).toContain("delete-node");
    expect(ids(nodeContextMenuItems(managedNodes, ["owned", "a"], true, { activeNodeId: "a", nodeData }))).toContain("delete-node");
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
