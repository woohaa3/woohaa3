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
import { createNodeImplementationRegistry } from "../../../extension-api/node-implementations.js";
import { SlotRegistry } from "../../slots.js";
import { startFrontendScope, type FrontendRuntime } from "../../kernel.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { createMediaContentService } from "../../services/media-content.js";
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

function canvasWithCollapsedGroup() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-group-canvas", "2026-10-25T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [
        { id: "group", type: "group", position: { x: 0, y: 0 }, width: 420, height: 280 },
        { id: "image", type: "image", parentId: "group", position: { x: 40, y: 40 } },
        { id: "nested", type: "group", parentId: "group", position: { x: 100, y: 100 }, width: 180, height: 140 },
        { id: "nested-image", type: "image", parentId: "nested", position: { x: 20, y: 20 } }
      ]
    },
    nodeData: { group: { title: "镜头组", groupCollapsed: true }, image: {}, nested: {}, "nested-image": {} }
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
        const mediaContent = createMediaContentService({ canvas: () => canvas, subscribe: () => () => {}, writable: () => false, submit: async () => {} });
        ctx.provide("mediaContent" as never, mediaContent as never);
        ctx.effect(() => () => mediaContent.dispose(), "test-media-content");
        const compositeAssets = new CompositeAssetRegistry();
        ctx.provide("compositeAssets" as never, compositeAssets as never);
        ctx.provide("nodeImplementations" as never, createNodeImplementationRegistry(compositeAssets) as never);
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

  it("收起组选中后显示展开动作、递归节点数与标题；只读时动作禁用", async () => {
    const canvas = canvasWithCollapsedGroup();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    nodeSelectionStore.setFromRuntime(
      { nodeIds: ["group"], primaryNodeId: "group", editingFocus: false },
      new Set(["group"])
    );
    runtime = await startFrontendScope(new Context(), {
      install: (ctx) => {
        ctx.provide("slots" as never, new SlotRegistry() as never);
        const mediaContent = createMediaContentService({ canvas: () => canvas, subscribe: () => () => {}, writable: () => false, submit: async () => {} });
        ctx.provide("mediaContent" as never, mediaContent as never);
        ctx.effect(() => () => mediaContent.dispose(), "test-media-content");
        const compositeAssets = new CompositeAssetRegistry();
        ctx.provide("compositeAssets" as never, compositeAssets as never);
        ctx.provide("nodeImplementations" as never, createNodeImplementationRegistry(compositeAssets) as never);
        ctx.provide("canvasLocate" as never, {} as never);
        ctx.provide("canvasEdit" as never, {} as never);
        ctx.provide("canvasSession" as never, { isWritable: () => false } as never);
        ctx.provide("canvasNavigation" as never, { getSnapshot: () => ({ mode: { type: "canvas" } }) } as never);
        ctx.provide("canvasRuntime" as never, { controller: () => null } as never);
      },
      plugins: [{ id: CANVAS_SHELL_PLUGIN_ID, required: true, plugin: canvasShellExtension() }]
    });

    const presentation = readNodeActionToolbars().get("group");
    expect(presentation).toEqual({
      actions: [{ id: "group-expand", label: "展开", enabled: false, tone: "primary", icon: "expand-groups", iconOnly: true }],
      summary: "组 · 3 个节点 · 镜头组"
    });
  });

  it("展开组选中后仍显示同一摘要，并提供收起动作", async () => {
    const canvas = canvasWithCollapsedGroup();
    canvas.nodeData.group.groupCollapsed = false;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    nodeSelectionStore.setFromRuntime(
      { nodeIds: ["group"], primaryNodeId: "group", editingFocus: false },
      new Set(["group"])
    );
    runtime = await startFrontendScope(new Context(), {
      install: (ctx) => {
        ctx.provide("slots" as never, new SlotRegistry() as never);
        const mediaContent = createMediaContentService({ canvas: () => canvas, subscribe: () => () => {}, writable: () => true, submit: async () => {} });
        ctx.provide("mediaContent" as never, mediaContent as never);
        ctx.effect(() => () => mediaContent.dispose(), "test-media-content");
        const compositeAssets = new CompositeAssetRegistry();
        ctx.provide("compositeAssets" as never, compositeAssets as never);
        ctx.provide("nodeImplementations" as never, createNodeImplementationRegistry(compositeAssets) as never);
        ctx.provide("canvasLocate" as never, {} as never);
        ctx.provide("canvasEdit" as never, {} as never);
        ctx.provide("canvasSession" as never, { isWritable: () => true } as never);
        ctx.provide("canvasNavigation" as never, { getSnapshot: () => ({ mode: { type: "canvas" } }) } as never);
        ctx.provide("canvasRuntime" as never, { controller: () => null } as never);
      },
      plugins: [{ id: CANVAS_SHELL_PLUGIN_ID, required: true, plugin: canvasShellExtension() }]
    });

    expect(readNodeActionToolbars().get("group")).toEqual({
      actions: [{ id: "group-collapse", label: "收起", enabled: true, tone: "primary", icon: "collapse-groups", iconOnly: true }],
      summary: "组 · 3 个节点 · 镜头组"
    });
  });
});
