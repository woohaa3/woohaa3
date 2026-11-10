/**
 * canvas-menu 节点菜单项测试。
 *
 * 只测纯函数 `nodeContextMenuItems`：重命名/删除的可用性与托管删除门禁。
 */
import { describe, expect, it } from "vitest";
import {
  createdNodeIdOf,
  nodeContextMenuItems,
  type CanvasMenuNode
} from "./plugin.js";

const nodes: CanvasMenuNode[] = [
  { id: "a", type: "image" },
  { id: "b", type: "image" },
  { id: "c", type: "text" }
];

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

describe("createdNodeIdOf", () => {
  it("returns the node.add id so creation can select the new node", () => {
    expect(createdNodeIdOf([
      { type: "node.add", node: { id: "new-node", type: "text", position: { x: 0, y: 0 } } }
    ] as never)).toBe("new-node");
    expect(createdNodeIdOf([{ type: "edge.remove", edgeId: "e" }] as never)).toBeNull();
  });
});

describe("nodeContextMenuItems", () => {
  it("offers no conversion entry for any model", () => {
    const models = [{ id: "legacy", type: "model3d" }, { id: "world", type: "model3d" }];
    const nodeData = { world: { sharedWorldInstance: { instanceId: "i" } } };
    expect(ids(nodeContextMenuItems(models, ["legacy"], true, { activeNodeId: "legacy", nodeData }))).not.toContain("convert-world");
    expect(ids(nodeContextMenuItems(models, ["world"], true, { activeNodeId: "world", nodeData }))).not.toContain("convert-world");
  });
  it("hides independent deletion for a managed node from an unrelated extension", () => {
    const nodeData = { b: { managedBy: { schemaVersion: 1, extensionId: "test.extension", ownerNodeId: "c", entityId: "entry", lifecycle: "owner-managed" } } };
    expect(ids(nodeContextMenuItems(nodes, ["b"], true, { activeNodeId: "b", nodeData }))).not.toContain("delete-node");
    expect(ids(nodeContextMenuItems(nodes, ["c"], true, { activeNodeId: "c", nodeData }))).toContain("delete-node");
  });

  it("single selection offers rename and delete", () => {
    const items = ids(nodeContextMenuItems(nodes, ["b"], true));
    expect(items).toContain("rename-node");
    expect(items).toContain("delete-node");
  });

  it("multi selection offers delete but not rename", () => {
    const items = ids(nodeContextMenuItems(nodes, ["a", "b"], true));
    expect(items).not.toContain("rename-node");
    expect(items).toContain("delete-node");
  });

  it("readonly session disables rename and delete", () => {
    const items = nodeContextMenuItems(nodes, ["b"], false);
    expect(items.find((item) => item.id === "rename-node")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete-node")?.disabled).toBe(true);
  });
});
