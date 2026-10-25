/**
 * Canvas Shell 插件装配回归
 *
 * 横条目标解析读取 `ctx.compositeAssets` 的节点能力声明。该服务由 scope 安装阶段在**另一个**
 * fiber 里 provide，插件不把它写进 `inject` 时访问会抛
 * `cannot get property "compositeAssets" without inject`；异常发生在每帧场景构建里，表现为
 * 「画布更新失败，正在尝试恢复」。
 *
 * 这里用真实 kernel 装配（install 与插件是兄弟 fiber）复现该路径：选中节点后读取横条描述必须
 * 不抛错。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { SlotRegistry } from "../../slots.js";
import { startFrontendScope, type FrontendRuntime } from "../../kernel.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { readNodeActionToolbars, setNodeActionBridge } from "./node-action-bridge.js";
import { CANVAS_SHELL_PLUGIN_ID, canvasShellExtension } from "./plugin.js";

let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  setNodeActionBridge(null);
  await runtime?.dispose();
  runtime = null;
});

function canvasWithNode() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-10-25T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }] },
    nodeData: { n1: { title: "T" } }
  };
}

describe("canvas-shell 插件装配", () => {
  it("横条目标解析可以读取 scope 提供的 compositeAssets（不需要 inject 报错）", async () => {
    const canvas = canvasWithNode();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    nodeSelectionStore.setFromRuntime(
      { nodeIds: ["n1"], primaryNodeId: "n1", editingFocus: false },
      new Set(["n1"])
    );
    // scope 的 install 在独立 fiber 里运行，feature plugin 是它的兄弟 fiber：
    // 这正是「install 阶段 provide、插件属性访问」会抛 without inject 的装配形态。
    runtime = await startFrontendScope(new Context(), {
      install: (ctx) => {
        ctx.provide("slots" as never, new SlotRegistry() as never);
        ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
        ctx.provide("canvasLocate" as never, {} as never);
        ctx.provide("canvasEdit" as never, {} as never);
        ctx.provide("canvasSession" as never, { isWritable: () => true } as never);
        ctx.provide("canvasNavigation" as never, {
          getSnapshot: () => ({ mode: { type: "canvas" } })
        } as never);
        ctx.provide("canvasRuntime" as never, { controller: () => null } as never);
      },
      plugins: [
        { id: CANVAS_SHELL_PLUGIN_ID, required: true, plugin: canvasShellExtension() }
      ]
    });

    expect(() => readNodeActionToolbars()).not.toThrow();
    expect(readNodeActionToolbars()).toBeInstanceOf(Map);
  });
});
