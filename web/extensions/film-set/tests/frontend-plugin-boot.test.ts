/**
 * 片场前端入口在**真实 Cordis Context** 上的装配回归
 * （change: 2026-10-13-add-node-to-film-set-shortcut，design D6；缺陷修复回归）。
 *
 * 背景：`installFilmSetConversionEntries({ ...ctx, ... })` 展开 Cordis Context 只复制自有可枚举
 * 属性，会丢掉 ctx 上由 `ctx.provide()` 定义的 service 访问器（它们在原型/reflect 上，不在自有
 * 属性里）。结果是注册模块读到 `undefined` 的 `canvasScope`，apply 抛
 * `Cannot read properties of undefined (reading 'canvasId')`，required 的 film-set fiber 进入
 * unloading → canvas page scope 报错 → 白屏。
 *
 * 本测试用**真实** Cordis `Context`（不是纯对象替身）装配完整 `filmSetExtension()`：只有真实
 * Context 才具备前述访问器语义，纯对象替身会掩盖该缺陷。装配完成后断言 fiber 处于 active、
 * 四个转换入口与片场模板均已注册——任何「spread 掉 service 访问器」或「注入服务缺失」的回归
 * 都会在此失败，而不是只在浏览器里白屏。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import { CompositeAssetRegistry, ModelEditorSession, type SlotContribution, type SlotName, type SlotsService } from "@woohaa3/frontend/extension-api";
import { DialogService } from "../../../frontend/src/cordis/services/dialogs/service.js";
import { describeNodeActions } from "../../../frontend/src/cordis/plugins/canvas-shell/node-action-host.js";
import type { NodeActionContribution } from "../../../frontend/src/cordis/contract/platform.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { filmSetExtension } from "../src/frontend/index.js";

/** 最小 Slot registry 替身：覆盖 register/list/version/subscribe 语义。 */
function fakeSlots(): SlotsService {
  const slots = new Map<string, SlotContribution<SlotName>[]>();
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    register(slot: SlotName, contribution: SlotContribution<SlotName>) {
      const list = slots.get(slot) ?? [];
      if (list.some((entry) => entry.id === contribution.id)) {
        throw new Error(`slot "${slot}" 已存在 contribution "${contribution.id}"`);
      }
      list.push(contribution);
      slots.set(slot, list);
      revision += 1;
      for (const listener of listeners) listener();
      return () => {
        const current = slots.get(slot) ?? [];
        const index = current.indexOf(contribution);
        if (index >= 0) current.splice(index, 1);
        revision += 1;
        for (const listener of listeners) listener();
      };
    },
    list(slot: SlotName) {
      return (slots.get(slot) ?? []) as never;
    },
    subscribe(_slot: SlotName, listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version() {
      return revision;
    },
    owners() {
      return [];
    }
  } as unknown as SlotsService;
}

/** 装配一个具有 film-set 所需全部注入 service 的真实 Cordis Context。 */
function bootFilmSet(canvas: ServerCanvas | null = null): { ctx: Context; fiber: Fiber; slots: SlotsService; dialogs: DialogService } {
  const ctx = new Context();
  const slots = fakeSlots();
  const dialogs = new DialogService();
  ctx.provide("dialogs" as never, dialogs as never);
  ctx.provide("slots" as never, slots as never);
  ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
  ctx.provide("canvasState" as never, {
    getCanvas: () => canvas,
    getWorkingCanvas: () => canvas,
    subscribe: () => () => undefined
  } as never);
  ctx.provide("canvasSession" as never, {
    isWritable: () => true,
    submitCommands: () => ({ ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } })
  } as never);
  ctx.provide("canvasRuntime" as never, {
    modelFocusMode: () => "edit",
    pauseAnimation: () => undefined,
    controller: () => ({ invalidate: () => undefined, cancelTransientGesture: () => undefined }),
    modelFocusProjection: () => null,
    modelEditorState: () => null,
    queryCompositeAssetItemBounds: () => [],
    queryCompositeAssetItemPick: () => null,
    queryGizmoHit: () => null,
    setFilmSetObjectGesture: () => undefined,
    setFilmSetObjectAction: () => undefined,
    subscribeModelFocus: () => () => undefined,
    setAnimationPlayback: () => undefined,
    setAnimationPauseSink: () => undefined,
    isFocused: () => false,
    animationPlaybackState: () => null,
    compositeAssetMediaSessions: () => null
  } as never);
  ctx.provide("canvasEdit" as never, { record: async () => ({ ok: true }) } as never);
  ctx.provide("canvasNavigation" as never, {
    getSnapshot: () => ({ mode: { type: "overview" }, panel: null, menu: null }),
    subscribe: () => () => undefined,
    openDialog: () => ({ ok: true }),
    requestExitNodeFocus: async () => ({ ok: true })
  } as never);
  ctx.provide("mediaRemote" as never, { upload: async () => ({ ok: false, error: "unused" }) } as never);
  ctx.provide("modelWorkspace" as never, {
    session: new ModelEditorSession({ readCameras: () => [], isWritable: () => true, submitCameras: () => true }),
    captureSession: {},
    acquireCapture: async () => () => undefined,
    refreshGizmo: () => undefined,
    renderCameraPanel: () => null,
    renderCameraPreview: () => null
  } as never);
  ctx.provide("hoverState" as never, { getNodeId: () => null, subscribe: () => () => undefined } as never);
  ctx.provide("canvasScope" as never, { canvasId: () => "c1" } as never);
  ctx.provide("canvasRemote" as never, {} as never);
  ctx.provide("canvasLocate" as never, { locateNodes: () => ({ ok: true }) } as never);

  const fiber = ctx.plugin(filmSetExtension()) as Fiber;
  return { ctx, fiber, slots, dialogs };
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  document.body.innerHTML = "";
});

describe("film-set 入口在真实 Cordis Context 上装配（白屏回归）", () => {
  it("顶部栏保留支持类型的创建入口：未就绪或只读只禁用，就绪后启用", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", "2026-10-21T00:00:00.000Z");
    const { ctx, fiber, slots } = bootFilmSet(canvas);
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();
    const describe = (nodeType: string, writable = true) => describeNodeActions({
      contributions: slots.list("canvas.node-action") as NodeActionContribution[],
      context: { nodeId: "source", nodeType, writable }
    });
    for (const nodeType of ["image", "video", "model3d"]) {
      expect(describe(nodeType)?.presentation.actions).toEqual([
        expect.objectContaining({ id: "film-set-conversion", label: "创建片场", enabled: false })
      ]);
    }
    expect(describe("text")).toBeNull();
    canvas.nodeData.source = { outputAssetId: "image" };
    canvas.assets.push({ id: "image", title: "Image", mediaKind: "image", source: "uploaded",
      status: "ready", createdAt: canvas.updatedAt, url: "/image.png" });
    expect(describe("image")?.presentation.actions[0]?.enabled).toBe(true);
    expect(describe("image", false)?.presentation.actions[0]?.enabled).toBe(false);
    expect(describe("image")?.owners.get("film-set-conversion")?.describe({
      nodeId: "source", nodeType: "image", writable: false
    })).toEqual(expect.objectContaining({ reason: "当前会话不可写，无法创建片场" }));
  });

  it("装配成功：fiber active，转换入口与片场模板均已注册", async () => {
    const { ctx, fiber, slots, dialogs } = bootFilmSet();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    expect(dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } }).ok).toBe(true);
    // 提供播放服务是 apply 的第一条语句；此后任一注入 service 缺失或 apply 抛错都会卸载它。
    expect(ctx.get("filmSetPlayback" as never)).toBeTruthy();
    expect(slots.list("canvas.node-template").map((entry) => entry.id)).toContain("film-set-node");
    expect(slots.list("canvas.node-action").map((entry) => entry.id)).toContain("film-set-conversion");
    expect(slots.list("canvas.context-menu").map((entry) => entry.id)).toContain("film-set-conversion-menu");
    expect(slots.list("canvas.focus-header").map((entry) => entry.id)).toContain("film-set-conversion-focus");
    expect(slots.list("canvas.overlay").map((entry) => entry.id)).not.toContain("film-set-conversion-node-status");
    expect(slots.list("authoring.delivery").map((entry) => entry.id)).toContain("film-set-conversion-delivery");
  });

  it("释放后贡献零残留", async () => {
    const { ctx, fiber, slots, dialogs } = bootFilmSet();
    await fiber.await();
    await fiber.dispose();
    expect(slots.list("canvas.node-action")).toHaveLength(0);
    expect(slots.list("canvas.node-template")).toHaveLength(0);
    expect(slots.list("canvas.overlay")).toHaveLength(0);
    expect(dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } }).ok).toBe(false);
    await ctx.fiber.dispose();
  });
});
