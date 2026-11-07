/**
 * 每条编辑记录状态测试（change: 2026-11-06-nonblocking-canvas-edit-history，任务 4.2 / 4.3）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createCanvasEditService } from "../../services/canvas-state/store/canvas-edit-service.js";
import { CanvasEditStatus } from "./canvas-edit-status.js";

function canvas(): ServerCanvas {
  const value = createEmptyWoohaa3ServerCanvas("c1", "2026-11-06T00:00:00.000Z");
  value.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "text", position: { x: 300, y: 0 }, width: 260, height: 195 }
  ];
  return value;
}

type Settlement = { resolve: (value: { state: "committed" | "rejected"; error: string | null }) => void };

function service() {
  let current = canvas();
  const submitted: string[] = [];
  const settlements: Settlement[] = [];
  const session = {
    isWritable: () => true,
    commandLifecycle: () => null,
    submitCommands: (_commands: unknown, commandId: string) => {
      submitted.push(commandId);
      let resolve!: Settlement["resolve"];
      const settled = new Promise<{ state: "committed" | "rejected"; error: string | null }>((done) => { resolve = done; });
      settlements.push({ resolve });
      return { ok: true as const, handle: { settled } };
    }
  };
  return {
    edit: createCanvasEditService({ session: session as never, getCanvas: () => current }),
    submitted,
    settlements,
    setCanvas: (next: ServerCanvas) => { current = next; }
  };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function mount(edit: ReturnType<typeof service>["edit"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CanvasEditStatus edit={edit} />));
  return { container, root };
}

describe("CanvasEditStatus", () => {
  it("连续结构动作不被弹窗阻断，按记录显示等待状态", async () => {
    const harness = service();
    const { container } = mount(harness.edit);
    await act(async () => {
      expect((await harness.edit.record([{ type: "node.update", nodeId: "a", position: { x: 10, y: 0 } }], "移动作品")).ok).toBe(true);
      expect((await harness.edit.record([{ type: "node.update", nodeId: "b", position: { x: 20, y: 0 } }], "移动另一个作品")).ok).toBe(true);
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(container.textContent).toContain("2 项等待保存");

    await act(async () => {
      harness.settlements[0]!.resolve({ state: "committed", error: null });
      await tick();
    });
    expect(container.textContent).toContain("1 项等待保存");

    await act(async () => {
      harness.settlements[1]!.resolve({ state: "committed", error: null });
      await tick();
    });
    expect(container.querySelector("[data-testid=canvas-edit-status]")).toBeNull();
    expect(harness.edit.getSnapshot().canUndo).toBe(true);
  });

  it("冲突记录不自动跳过；显式跳过后后续记录继续 drain", async () => {
    const harness = service();
    const { container } = mount(harness.edit);
    await act(async () => {
      await harness.edit.record([{ type: "node.remove", nodeIds: ["a"] }], "删除作品");
    });
    await act(async () => {
      harness.settlements[0]!.resolve({ state: "rejected", error: "其他修改已影响该作品" });
      await tick();
    });
    const conflict = container.querySelector("[data-testid=canvas-edit-status-conflict]");
    expect(conflict?.textContent).toContain("删除作品未保存");
    expect(harness.edit.getSnapshot().canUndo).toBe(false);

    await act(async () => {
      (container.querySelector("[data-testid=canvas-edit-status-skip]") as HTMLButtonElement).click();
    });
    expect(container.querySelector("[data-testid=canvas-edit-status-conflict]")).toBeNull();

    await act(async () => {
      expect((await harness.edit.record([{ type: "node.update", nodeId: "b", position: { x: 30, y: 0 } }], "移动作品")).ok).toBe(true);
    });
    await act(async () => {
      harness.settlements[harness.settlements.length - 1]!.resolve({ state: "committed", error: null });
      await tick();
    });
    expect(container.querySelector("[data-testid=canvas-edit-status]")).toBeNull();
    expect(harness.edit.getSnapshot().canUndo).toBe(true);
  });
});
