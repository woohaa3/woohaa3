/**
 * Input Scope Host drag/paste 门禁测试
 * （change: add-paste-import-workflows，任务 1.3 / 4.2）。
 *
 * 关键回归：`dragover`/`dragenter` 必须 `preventDefault`，否则浏览器不会派发 `drop`，
 * 且会把文件当导航目标打开。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeProvider } from "./react.js";
import { InputScopeHost } from "./input-scope-host.js";
import { SlotRegistry } from "./slots.js";
import { InputScopeService } from "./services/input-scopes.js";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { pasteImportExtension } from "./plugins/paste-import/plugin.js";
import { DialogService } from "./services/dialogs/service.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  act(() => {
    root?.unmount();
  });
  root = null;
  await runtime?.dispose();
  runtime = null;
  document.body.innerHTML = "";
});

/** 构造真实 DragEvent，并把 dataTransfer 替换为「dragover 语义」替身。 */
function dragoverEvent(kind: string, type: string): { event: DragEvent; transfer: Record<string, unknown> } {
  const transfer: Record<string, unknown> = {
    files: Object.assign([], { item: () => null }),
    items: [{ kind, type, getAsFile: () => null }],
    types: kind === "file" ? ["Files"] : ["text/plain"],
    dropEffect: "none"
  };
  const event = new Event("dragover", { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, "target", { value: document.body, configurable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer, configurable: true });
  return { event, transfer };
}

describe("InputScopeHost dragover 门禁", () => {
  it("含文件的 dragover 一定 preventDefault（否则 drop 不派发/浏览器打开文件）", async () => {
    const slots = new SlotRegistry();
    const inputScopes = new InputScopeService();
    runtime = await startFrontendRuntime({
      installPlatform: (ctx) => {
        ctx.provide("slots" as never, slots as never);
        ctx.provide("inputScopes" as never, inputScopes as never);
        ctx.provide("dialogs" as never, new DialogService() as never);
        ctx.provide("canvasSession" as never, { isWritable: () => true } as never);
        ctx.provide("canvasEdit" as never, { record: async () => ({ ok: true }) } as never);
        ctx.provide("selection" as never, { getSnapshot: () => ({ nodeIds: [], primaryNodeId: null, editingFocus: false, keyboardActive: false }) } as never);
        ctx.provide("canvasRuntime" as never, { controller: () => null } as never);
        ctx.provide("canvasRemote" as never, {} as never);
        ctx.provide("mediaRemote" as never, {} as never);
        ctx.provide("importService" as never, {} as never);
      },
      plugins: [{ id: "paste-import", required: false, plugin: pasteImportExtension() }]
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RuntimeProvider runtime={runtime!}>
          <InputScopeHost />
        </RuntimeProvider>
      );
    });

    // dragover 阶段：无 files 内容、只有 item.kind/type —— 仍必须 preventDefault。
    const { event: fileEvent, transfer: fileTransfer } = dragoverEvent("file", "image/png");
    await act(async () => {
      document.dispatchEvent(fileEvent);
    });
    expect(fileEvent.defaultPrevented).toBe(true);
    expect(fileTransfer.dropEffect).toBe("copy");

    // 纯文本拖放不认领：留给浏览器/编辑面。
    const { event: textEvent } = dragoverEvent("string", "text/plain");
    await act(async () => {
      document.dispatchEvent(textEvent);
    });
    expect(textEvent.defaultPrevented).toBe(false);
  });
});
