/**
 * 图片聚焦 owner 让位测试（change: default-image-focus-viewer）。
 *
 * 回归点：宿主默认查看器与图片编辑器扩展都会贡献 `canvas.focus-workspace`（kind=image）。
 * 公共宿主对同一 focus kind 的两个 owner 判成歧义（「多个扩展声明了此节点的工作区」），
 * 所以「让位」必须是**注册期**行为，而不是渲染期再挑一个。
 */
import { describe, expect, it } from "vitest";
import { SlotRegistry } from "../slots.js";
import { candidatesForFocus, resolveFocusWorkspaceEntry } from "./host.js";

const VIEWER_ID = "image-viewer-workspace";
const EDITOR_ID = "photocraft-focus";

function props(nodeId = "n1") {
  return { revision: 0, writable: false, focus: { nodeId, kind: "image" } };
}

function registerViewer(slots: SlotRegistry): () => void {
  return slots.register("canvas.focus-workspace", {
    id: VIEWER_ID, owner: "image-viewer", kind: "image", exclusive: true, render: () => null
  });
}

function registerEditor(slots: SlotRegistry): () => void {
  return slots.register("canvas.focus-workspace", {
    id: EDITOR_ID, owner: "photocraft", kind: "image", exclusive: true, render: () => null
  });
}

describe("图片聚焦工作区 owner 让位", () => {
  it("只有查看器时解析到唯一 owner", () => {
    const slots = new SlotRegistry();
    registerViewer(slots);
    const resolved = resolveFocusWorkspaceEntry(slots.list("canvas.focus-workspace"), props());
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.entry.id).toBe(VIEWER_ID);
  });

  it("查看器 + 编辑器同时存在是歧义（因此必须有让位）", () => {
    const slots = new SlotRegistry();
    registerViewer(slots);
    registerEditor(slots);
    const resolved = resolveFocusWorkspaceEntry(slots.list("canvas.focus-workspace"), props());
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toContain("多个扩展");
  });

  it("按 kind 过滤：查看器不影响视频/模型/extension 聚焦", () => {
    const slots = new SlotRegistry();
    registerViewer(slots);
    for (const kind of ["video", "model", "extension"]) {
      expect(candidatesForFocus(slots.list("canvas.focus-workspace"), null, { nodeId: "n1", kind })).toHaveLength(0);
    }
  });
});
