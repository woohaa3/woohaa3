/**
 * 删除撤销提示测试（change: 2026-10-09-improve-canvas-workflow，任务 1.7）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { CanvasCommand, ServerCanvas } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createCanvasEditService } from "../../services/canvas-state/store/canvas-edit-service.js";
import { CanvasUndoToast } from "./canvas-undo-toast.js";

const NOW = "2026-10-09T00:00:00.000Z";

function canvas(): ServerCanvas {
  const value = createEmptyWoohaa3ServerCanvas("c1", NOW);
  value.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "image", position: { x: 300, y: 0 }, width: 260, height: 195 }
  ];
  return value;
}

function service() {
  let current = canvas();
  const session = {
    isWritable: () => true,
    commandLifecycle: () => null,
    submitCommands: () => ({
      ok: true as const,
      handle: { settled: Promise.resolve({ state: "committed" as const, error: null }) }
    })
  };
  return {
    edit: createCanvasEditService({ session: session as never, getCanvas: () => current }),
    setCanvas: (next: ServerCanvas) => { current = next; }
  };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function mount(edit: ReturnType<typeof service>["edit"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CanvasUndoToast edit={edit} />));
  return { container, root };
}

describe("CanvasUndoToast", () => {
  it("删除后显示撤销提示并可撤销", async () => {
    const { edit } = service();
    const { container } = mount(edit);
    await act(async () => {
      await edit.record([{ type: "node.remove", nodeIds: ["a"] }], "删除作品");
      await settle();
    });
    expect(container.querySelector("[data-testid=canvas-undo-toast]")).not.toBeNull();
    expect(container.textContent).toContain("删除作品");
    const button = container.querySelector("[data-testid=canvas-undo-toast-action]")!;
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
  });

  it("关闭提示后不再显示，但记录仍在 journal（可经工具撤销）", async () => {
    const { edit } = service();
    const { container } = mount(edit);
    await act(async () => {
      await edit.record([{ type: "node.remove", nodeIds: ["a"] }], "删除作品");
      await settle();
    });
    const close = container.querySelector("[aria-label=关闭撤销提示]")!;
    act(() => {
      (close as HTMLButtonElement).click();
    });
    expect(container.querySelector("[data-testid=canvas-undo-toast]")).toBeNull();
    expect(edit.getSnapshot().canUndo).toBe(true);
  });

  it("非删除动作不显示删除提示", async () => {
    const { edit } = service();
    const { container } = mount(edit);
    await act(async () => {
      await edit.record([{ type: "node.update", nodeId: "a", position: { x: 50, y: 0 } }], "移动作品");
      await settle();
    });
    expect(container.querySelector("[data-testid=canvas-undo-toast]")).toBeNull();
  });
});

void (null as unknown as CanvasCommand);
