/**
 * 文本执行面板宿主回归（change: 2026-10-27-merge-nonessential-panel-chunks，任务 2.2）。
 *
 * 文本宿主改为静态装配后，composer 仍需经过一次按需加载：
 * - 解析期间显示与真实面板同一表面的 `AuthoringGeneratePlaceholder`（节点锚定 dock），
 *   不能退回文档流裸骨架；
 * - composer 就绪后替换骨架，但复用同一个锚定表面元素，不重新挂载外壳。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { TextExecutionHost } from "./text-execution-host.js";
import { SlotRegistry } from "../../slots.js";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

beforeEach(async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("cv", "2026-10-27T00:00:00Z");
  canvas.document.nodes.push({ id: "text-1", type: "text", position: { x: 0, y: 0 } });
  const emptySnapshot = {
    conversations: [],
    active: null,
    detail: null,
    mcp: null,
    loading: false,
    error: null,
    contextRevision: 0
  };
  const agentConversationService = {
    subscribe: () => () => undefined,
    getSnapshot: () => emptySnapshot,
    getDataScopeId: () => "page",
    findConversationForTarget: async () => ({ ok: true, value: { conversation: null } }),
    listConnections: async () => ({ ok: true, value: [] }),
    navigateToDetail: () => undefined
  };
  const canvasState = {
    subscribe: () => () => undefined,
    getWorkingCanvas: () => canvas,
    getCanvas: () => canvas
  };
  const slots = new SlotRegistry();
  runtime = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("agentConversationService" as never, agentConversationService as never);
      ctx.provide("canvasState" as never, canvasState as never);
      ctx.provide("canvasSession" as never, { isWritable: () => true } as never);
    },
    plugins: []
  });
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  await runtime?.dispose();
  runtime = null;
  document.body.innerHTML = "";
});

describe("文本面板宿主与 composer 骨架", () => {
  it("composer 加载期间渲染锚定骨架，就绪后复用同一表面替换为真实面板", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => {
      root!.render(
        <RuntimeProvider runtime={runtime!}>
          <TextExecutionHost canvasId="cv" nodeId="text-1" writable presentation="compact" onPresentationIntent={() => undefined} />
        </RuntimeProvider>
      );
    });
    const dock = el.querySelector('.node-execution-dock[data-node-id="text-1"]');
    expect(dock).not.toBeNull();
    expect(dock!.querySelector(".authoring-generate-placeholder")).not.toBeNull();
    expect(dock!.querySelector('[data-testid="authoring-generate"]')).toBeNull();

    await act(async () => {
      await import("./authoring-generate-panel.js");
    });
    // 同一个外壳元素：骨架与真实面板共用锚定表面，不做二次挂载。
    expect(el.querySelector(".node-execution-dock")).toBe(dock);
    expect(dock!.querySelector(".authoring-generate-placeholder")).toBeNull();
    expect(dock!.querySelector('[data-testid="authoring-generate"]')).not.toBeNull();
  });
});
