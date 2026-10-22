/**
 * 前后端 reducer 等价性（change: add-frontend-speculative-canvas-state，任务 1.2）。
 *
 * 断言服务端 storage/core 的 `applyCanvasCommands` 与 contracts 的共享 reducer 对同一
 * 输入产生完全相同的规范结果与拒绝码。二者本应是同一实现，这里作为回归守卫：任何重新
 * 分叉（例如服务端又自行实现一份）都会让本测试失败。
 */
import { describe, expect, it } from "vitest";
import {
  applyCanvasCommands as sharedApply,
  createEmptyWoohaa3ServerCanvas,
  type CanvasCommand,
  type ServerCanvas
} from "@woohaa3/contracts";
import { applyCanvasCommands as serviceApply } from "./command-applier.js";

const NOW = "2026-09-26T00:00:00.000Z";

const SCENARIOS: Array<{ name: string; commands: CanvasCommand[] }> = [
  {
    name: "创建 + 拉线创建 + nodeData",
    commands: [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } }, connect: { fromNodeId: "a", edgeId: "e1" } },
      { type: "nodeData.patch", nodeId: "b", value: { prompt: "hi" } }
    ]
  },
  {
    name: "移动 + 尺寸 + 删除级联",
    commands: [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } }, connect: { fromNodeId: "a", edgeId: "e1" } },
      { type: "node.update", nodeId: "b", position: { x: 300, y: 40 }, width: 300, height: 200 },
      { type: "node.remove", nodeIds: ["a"] }
    ]
  },
  {
    name: "非法引用拒绝",
    commands: [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "edge.add", edge: { source: "a", target: "ghost" } }
    ]
  },
  {
    name: "过小尺寸拒绝",
    commands: [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 }, width: 5, height: 5 } }
    ]
  },
  {
    name: "边删除 + 标题",
    commands: [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 1, y: 0 } }, connect: { fromNodeId: "a", edgeId: "e1" } },
      { type: "edge.remove", edgeId: "e1" },
      { type: "canvas.setTitle", title: "标题" }
    ]
  }
];

describe("服务端与前端共享 reducer 等价", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const canvas: ServerCanvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
      const shared = sharedApply(canvas, scenario.commands, { now: NOW });
      const service = serviceApply(canvas, scenario.commands, { now: NOW });

      expect(service.ok).toBe(shared.ok);
      if (shared.ok && service.ok) {
        expect(service.changed).toBe(shared.changed);
        expect(JSON.stringify(service.canvas)).toBe(JSON.stringify(shared.canvas));
      } else if (!shared.ok && !service.ok) {
        expect(service.rejection.code).toBe(shared.rejection.code);
      }
    });
  }
});
