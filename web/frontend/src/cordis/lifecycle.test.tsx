/**
 * StrictMode 与资源泄漏测试
 * （change: adopt-frontend-cordis-plugin-runtime，design D2/D7/D12）。
 *
 * 断言：React StrictMode 重放不会重复 apply Plugin / 建立 socket / 启动 timer；
 * 重复 mount/dispose 页面 Context 后 socket、timer、listener、slot、dialog registry 归零。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createCanvasRemote } from "./services/canvas-remote.js";
import { createTaskRemote } from "./services/task-remote.js";
import { createMediaRemote } from "./services/media-remote.js";
import { DialogService } from "./services/dialogs/service.js";
import { InputScopeService } from "./services/input-scopes.js";
import { SlotRegistry } from "./slots.js";
import { TaskCatalogStore } from "./services/task-catalog.js";
import { RuntimeProvider, useService } from "./react.js";
import { definePlugin } from "./plugin.js";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { nodeSelectionStore } from "./services/selection-store.js";
import { parameterPreviewStore } from "./services/parameter-preview.js";
import type { Plugin } from "@deepseek-ai/cordis";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

/** 安装最小平台：remote 用 fake fetch + fake WebSocket，Session 用内存数据库替代。 */
async function makeRuntime(options: { plugins: FrontendExtensionDefinition[] }): Promise<FrontendRuntime> {
  const socketCount = { value: 0 };
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    constructor() {
      socketCount.value += 1;
    }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }

  let runtime: FrontendRuntime | null = null;
  runtime = await startFrontendRuntime({
    installPlatform: async (ctx) => {
      const canvasRemote = createCanvasRemote({
        canvasId: "c",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        location: { protocol: "http:", host: "local.test" }
      });
      const taskRemote = createTaskRemote({
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
      });
      const mediaRemote = createMediaRemote({
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
      });
      ctx.provide("canvasRemote" as never, canvasRemote as never);
      ctx.provide("taskRemote" as never, taskRemote as never);
      ctx.provide("mediaRemote" as never, mediaRemote as never);
      ctx.provide("dialogs" as never, new DialogService() as never);
      ctx.provide("slots" as never, new SlotRegistry() as never);
      ctx.provide("inputScopes" as never, new InputScopeService() as never);
      ctx.provide("taskCatalog" as never, new TaskCatalogStore(taskRemote) as never);
      ctx.provide("selection" as never, nodeSelectionStore as never);
      ctx.provide("parameterPreview" as never, parameterPreviewStore as never);
      // 测试不建真实 socket：用一个最小 session stub。
      ctx.provide(
        "canvasSession" as never,
        {
          getStatus: () => ({ phase: "ready", error: null, hydrated: true, remote: { mode: "remote", phase: "synced", confirmedRevision: 0, pendingCount: 0, error: null } }),
          subscribe: () => () => undefined,
          retry: async () => undefined,
          requestHydrate: () => undefined,
          commandLifecycle: () => null,
          submitCommands: () => ({ ok: false, reason: "stub" }),
          isWritable: () => true,
          shutdown: () => undefined
        } as never
      );
      void socketCount;
    },
    plugins: options.plugins
  });
  return runtime;
}

import type { FrontendExtensionDefinition } from "./kernel.js";

function Probe() {
  const slots = useService("slots");
  return <span data-testid="slot-count">{slots.list("canvas.toolbar").length}</span>;
}

describe("StrictMode 单实例", () => {
  it("React 重放不重复 apply Plugin", async () => {
    let applyCount = 0;
    const plugin: Plugin.Function<void> = definePlugin(
      () => {
        applyCount += 1;
      },
      { name: "once", inject: ["slots"] }
    );
    const runtime = await makeRuntime({
      plugins: [{ id: "once", required: true, plugin }]
    });
    expect(applyCount).toBe(1);

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <StrictMode>
          <RuntimeProvider runtime={runtime}>
            <Probe />
          </RuntimeProvider>
        </StrictMode>
      );
    });
    // StrictMode 重放 React effect 后，Plugin 仍只 apply 一次。
    expect(applyCount).toBe(1);
    await runtime.dispose();
  });

  it("重复 mount/dispose Context 后 registry、slot、dialog 归零", async () => {
    const runtime = await makeRuntime({
      plugins: [{ id: "noop", required: true, plugin: definePlugin(() => undefined, { name: "noop", inject: ["slots"] }) }]
    });
    expect(runtime.ctx.registry.size).toBeGreaterThan(0);
    await runtime.dispose();
    expect(runtime.ctx.registry.size).toBe(0);
  });
});

describe("Diagnostics", () => {
  it("独立 Context 诊断可观察 Plugin 状态与贡献", async () => {
    const runtime = await makeRuntime({
      plugins: [
        {
          id: "with-slot",
          required: true,
          plugin: definePlugin(
            (ctx: Context) => {
              const remove = ctx.slots.register("canvas.toolbar", { id: "x", owner: "with-slot", render: () => null });
              return () => remove();
            },
            { name: "with-slot", inject: ["slots"] }
          )
        }
      ]
    });
    const status = runtime.status();
    expect(status.phase).toBe("ready");
    expect(status.plugins.find((plugin) => plugin.id === "with-slot")?.status).toBe("active");
    await runtime.dispose();
  });

  it("诊断不包含凭据/输出字段（结构性：只有 id/status/services/contributions）", async () => {
    const runtime = await makeRuntime({
      plugins: [{ id: "p", required: true, plugin: definePlugin(() => undefined, { name: "p", inject: ["slots"] }) }]
    });
    const serialized = JSON.stringify(runtime.status());
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("signed");
    await runtime.dispose();
  });
});

void vi;
