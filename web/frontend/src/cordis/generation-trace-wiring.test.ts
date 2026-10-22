/**
 * 菜单贡献 → 浮窗的接线回归（change: 生成溯源改为画布内浮窗）。
 *
 * 纯函数测试只能证明「决定逻辑」正确，证不了注册处的接线：曾经出现过
 * `registerGenerationTraceMenu` 收到的 deps 没把 openTraceDialog 传下去，
 * 结果点菜单仍然跳独立页（拆掉 Canvas page scope）。这里用真实 runtime + 真实
 * dialogs + 真实插件树跑一遍，只假造画布数据。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { installAppServices, installCanvasPageServices } from "./install-services.js";
import { createSourceCanvasExtensionManifest } from "./test-support/source-extensions.js";
import { woohaa3CanvasStore } from "./services/canvas-state/index.js";
import { canvasFixture, imageAsset, NOW } from "./plugins/task-execution/test-support/fixtures.js";
import { GENERATION_TRACE_DIALOG_ID } from "./plugins/task-execution/generation-trace-dialog.js";

let runtime: FrontendRuntime | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function installGlobals(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("{}", { status: 200 });
}

async function installFullPlatform(ctx: Context): Promise<void> {
  installAppServices(ctx, { testHooks: false });
  await installCanvasPageServices(ctx, { testHooks: false });
}

type MenuContribution = {
  id?: string;
  onSelect?: (itemId: string, context: { nodeId?: string }) => void;
};

/** 画布：一个已产出资产的节点 + 对应的 job（taskId 与 runId 同值，生产缺省语义）。 */
function seedCanvas(): void {
  const canvas = canvasFixture({
    nodes: [{ id: "n1", type: "image", data: { activeRunId: "run-1", outputAssetId: "asset-1" } as never }],
    assets: [imageAsset({ id: "asset-1", provenance: { runId: "run-1" } } as never)]
  });
  woohaa3CanvasStore.getState().applyRemoteCanvas({
    ...canvas,
    jobs: [{ id: "job-1", nodeId: "n1", taskId: "run-1", runId: "run-1", status: "success", updatedAt: NOW }]
  } as never);
}

afterEach(async () => {
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
  await runtime?.dispose();
  runtime = null;
});

describe("查看生成溯源：菜单点击落到画布内浮窗", () => {
  it("onSelect 打开 generation-trace 浮窗，且不切换页面", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    expect(runtime.status().phase).toBe("ready");
    seedCanvas();

    const contribution = runtime.ctx.slots
      .list("canvas.context-menu")
      .find((entry) => (entry as unknown as { id?: string }).id === "generation-trace") as unknown as MenuContribution | undefined;
    expect(contribution, "generation-trace 菜单贡献应已注册").toBeDefined();

    const locationBefore = JSON.stringify(runtime.ctx.appRouter.getLocation?.() ?? null);
    contribution!.onSelect!("view-generation-trace", { nodeId: "n1" } as never);

    // 浮窗已入栈：这是「画布内查看」而不是「跳独立页」。
    expect(runtime.ctx.dialogs.getSnapshot().stack.map((entry) => entry.dialogId)).toContain(GENERATION_TRACE_DIALOG_ID);
    expect(runtime.ctx.dialogs.getDiagnostic()).toBeNull();
    // 页面位置不变（跳页会 dispose Canvas page scope）。
    expect(JSON.stringify(runtime.ctx.appRouter.getLocation?.() ?? null)).toBe(locationBefore);
  });

  it("没有 tasks.inspect 时不贡献菜单项（不把管理面暴露给普通用户）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    seedCanvas();
    const contribution = runtime.ctx.slots
      .list("canvas.context-menu")
      .find((entry) => (entry as unknown as { id?: string }).id === "generation-trace") as unknown as
      | (MenuContribution & { items?: (context: unknown) => unknown[] })
      | undefined;
    // 测试环境没有 siteAccessCapability ⇒ canInspect=false，整项隐藏。
    // 节点可溯源/不可溯源的解析由 generation-trace.test.ts 的纯函数用例覆盖。
    expect(contribution!.items!({ nodeId: "n1" })).toHaveLength(0);
  });
});
