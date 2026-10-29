/**
 * 画布工作流 Showcase 夹具（change: 2026-10-09-improve-canvas-workflow）。
 *
 * 复用生产 `CanvasEditService`、`EditJournal`、`CanvasSearchPanel` 与 `planCanvasEdit`，
 * 只替换 IO（内存 session 与固定画布），并支持延迟确认、拒绝、并发变化与失效引用，
 * 不用 noop 假装成功。
 */
import { useMemo } from "react";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  planCanvasEdit,
  type CanvasCommand,
  type ServerCanvas
} from "@woohaa3/contracts";
import { createCanvasEditService } from "../../../../frontend/src/cordis/services/canvas-state/store/canvas-edit-service.js";
import { CanvasSearchStore } from "../../../../frontend/src/cordis/services/canvas-search-store.js";

export type WorkflowControls = {
  edit: ReturnType<typeof createCanvasEditService>;
  search: CanvasSearchStore;
  canvas: () => ServerCanvas;
  /** 模拟另一个标签页修改节点 A 的名称（制造同字段冲突）。 */
  remoteRenameA(name: string): void;
  /** 让下一次受保护提交被拒绝。 */
  rejectNext(reason: string): void;
  /** 记录所有被接受的命令批次。 */
  submitted: CanvasCommand[][];
};

const NOW = "2026-10-09T00:00:00.000Z";

export function sampleCanvas(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("showcase", NOW);
  canvas.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "image", position: { x: 320, y: 0 }, width: 260, height: 195 },
    { id: "c", type: "video", position: { x: 640, y: 0 }, width: 260, height: 195 }
  ];
  canvas.nodeData = { a: { title: "作品 A" }, b: { title: "海边日落" }, c: { prompt: "开场镜头：晨雾中的城市天际线" } };
  return canvas;
}

export function createWorkflowFixture(): WorkflowControls {
  let canvas = sampleCanvas();
  let rejectReason: string | null = null;
  const submitted: CanvasCommand[][] = [];

  // 最小 CanvasSession 适配：只实现 canvas-edit-service 消费的接口。
  const session = {
    isWritable: () => true,
    commandLifecycle: () => null,
    submitCommands(commands: readonly CanvasCommand[]) {
      if (rejectReason) {
        const reason = rejectReason;
        rejectReason = null;
        return { ok: true as const, handle: { settled: Promise.resolve({ state: "rejected" as const, error: reason }) } };
      }
      const applied = applyCanvasCommands(canvas, commands as never, { now: NOW });
      if (applied.ok) canvas = applied.canvas;
      submitted.push([...commands]);
      return { ok: true as const, handle: { settled: Promise.resolve({ state: "committed" as const, error: null }) } };
    }
  };

  const edit = createCanvasEditService({
    session: session as never,
    getCanvas: () => canvas
  });

  return {
    edit,
    search: new CanvasSearchStore(),
    canvas: () => canvas,
    remoteRenameA(name) {
      canvas = { ...canvas, nodeData: { ...canvas.nodeData, a: { ...canvas.nodeData.a, title: name } } } as ServerCanvas;
    },
    rejectNext(reason) {
      rejectReason = reason;
    },
    submitted
  };
}

export function useWorkflowFixture(): WorkflowControls {
  return useMemo(() => createWorkflowFixture(), []);
}

/** 生成一个可撤销的移动计划（供 story 直接记录）。 */
export function movePlan(canvas: ServerCanvas, nodeId: string, dx: number) {
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  return planCanvasEdit(canvas, [{ type: "node.update", nodeId, position: { x: node.position.x + dx, y: node.position.y } }]);
}
