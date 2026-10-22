import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
/**
 * 游戏炼丹炉 extension 前端装配测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.4/2.5）。
 *
 * 覆盖：descriptor 形状与装配策略；插件向宿主 `canvas.node-template` slot 注册「游戏炼丹炉」
 * 菜单项与默认 nodeData；菜单 item 的 section/order；inject 门禁；dispose 后零残留；
 * createNodeData 产出复合资产定义（composite-asset + 炉体几何），无业务专属 node 字段。
 *
 * 独立包测试不依赖宿主 Vite 扫描器或宿主 service 实现：这里用**显式注入的公开 capability
 * 替身**驱动 plugin，并以最小 harness 模拟 Cordis 的 `inject` 门禁与 apply 失败回滚
 * （与 prompt-snippets 包同构）。
 */
import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@deepseek-ai/cordis";
import { CANVAS_MENU_SECTION } from "@woohaa3/contracts";
import { descriptor } from "../src/frontend/index.js";
import { gameFurnaceExtension, GAME_FURNACE_NODE_TEMPLATE_ID, GAME_FURNACE_FOCUS_WORKSPACE_ID, GAME_FURNACE_NODE_DROP_ID, GAME_FURNACE_FOCUS_KIND } from "../src/frontend/plugin.js";
import { GAME_FURNACE_NODE_TYPE, GAME_FURNACE_GEOMETRY_SCRIPT, createGameFurnaceNodeData } from "../src/geometry.js";
import { gameFurnaceNodeIds, isGameFurnaceNodeData, startTargetDetachWatcher, type TargetDetachResult } from "../src/frontend/target-watcher.js";

type Disposer = () => void;

/** 构造一个最小的权威画布（drawing nodes + nodeData）。 */
function canvasOf(id: string, nodes: Array<{ id: string; data?: Record<string, unknown>; type?: string }>) {
  return {
    id,
    document: { nodes: nodes.map((node) => ({ id: node.id, type: node.type ?? "composite-asset" })) },
    nodeData: Object.fromEntries(nodes.map((node) => [node.id, node.data ?? createGameFurnaceNodeData()]))
  };
}

/** 最小 slot registry 替身（只覆盖 plugin 使用的 register/list 语义）。 */
function fakeSlots() {
  const contributions = new Map<string, Array<{ id: string; [key: string]: unknown }>>();
  return {
    list(slot: string) {
      return contributions.get(slot) ?? [];
    },
    register(slot: string, contribution: { id: string }) {
      const list = contributions.get(slot) ?? [];
      list.push(contribution);
      contributions.set(slot, list);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = contributions.get(slot) ?? [];
        contributions.set(slot, current.filter((entry) => entry !== contribution));
      };
    }
  };
}

/** 最小 Cordis Context 替身：`inject` 门禁 + apply 失败回滚。 */
function makeHarness(options: { slots?: boolean; canvas?: unknown; request?: (input: { path: string; body: unknown }) => Promise<unknown>; record?: (...args: unknown[]) => Promise<unknown> } = { slots: true }) {
  const slots = fakeSlots();
  const disposers: Disposer[] = [];
  const listeners = new Set<() => void>();
  let canvas: unknown = options.canvas ?? null;
  const notify = () => listeners.forEach((fn) => fn());
  const ctx: Record<string, unknown> = {
    compositeAssets: new CompositeAssetRegistry(),
    effect: (factory: () => Disposer) => {
      disposers.push(factory());
    },
    canvasState: {
      getCanvas: () => canvas as never,
      getWorkingCanvas: () => canvas as never,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }
    },
    canvasCommands: {
      isWritable: () => true,
      submit: () => ({ ok: true as const, handle: { commandId: "test" } })
    },
    canvasRuntime: { clientToWorld: (point: { x: number; y: number }) => point },
    canvasEdit: { record: options.record ?? (async () => ({ ok: true as const })) },
    taskCatalog: { getState: () => ({ status: "loading" }), subscribe: () => () => undefined, load: async () => undefined },
    mediaRemote: { upload: async () => ({ ok: false as const, error: "unused" }), urlFor: (key: string) => `/api/media/${key}`, isAllowedUrl: () => true, resolveCanonicalUrl: () => null },
    canvasNavigation: { openDialog: () => ({ ok: true }), requestExitNodeFocus: async () => ({ ok: true }) },
    applicationRemote: {
      transport: {
        request: options.request ?? (async () => ({ ok: false as const, code: "unavailable" as const, error: "test" })),
        stream: () => ({ cancel: () => undefined })
      }
    }
  };
  if (options.slots !== false) ctx.slots = slots;
  const dispose = () => {
    for (const disposeEffect of disposers.splice(0)) disposeEffect();
  };
  const apply = (plugin: Plugin.Function<void>) => {
    const inject = (plugin as { inject?: readonly string[] }).inject ?? [];
    for (const name of inject) {
      if (!(name in ctx)) throw new Error(`cannot get property ${name} without inject`);
    }
    try {
      plugin(ctx as never);
    } catch (error) {
      dispose();
      throw error;
    }
  };
  const setCanvas = (next: unknown) => { canvas = next; notify(); };
  return { ctx, slots, apply, dispose, setCanvas };
}

const MENU_CONTEXT = {
  nodeId: null,
  screen: { x: 0, y: 0 },
  world: { x: 0, y: 0 },
  writable: true
} as const;

it("文件拖到炉体只关联素材与项目，不新建画布节点", async () => {
  const c = canvasOf("c", [{ id: "f" }]);
  Object.assign(c.document.nodes[0]!, { position: { x: 0, y: 0 }, width: 260, height: 195 });
  const record = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
  const h = makeHarness({ canvas: c, record, request: async () => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "saved", inputHash: "hash", resources: [] } }) });
  h.ctx.mediaRemote = { upload: async () => ({ ok: true, media: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "text/plain", size: 4 } }) };
  h.apply(gameFurnaceExtension());
  const contribution = h.slots.list("input.drop")[0]! as unknown as { handle: (event: DragEvent) => boolean };
  const file = new File(["test"], "rules.txt", { type: "text/plain" });
  expect(contribution.handle({ clientX: 20, clientY: 20, dataTransfer: { files: [file] } } as unknown as DragEvent)).toBe(true);
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  const commands = record.mock.calls[0]![0] as { type: string }[];
  expect(commands.map(command => command.type)).toEqual(["asset.upsert", "nodeData.patch"]);
  h.dispose();
});

it("文件上传期间卸载插件不写回项目，也不回退创建节点", async () => {
  const c = canvasOf("c", [{ id: "f" }]);
  Object.assign(c.document.nodes[0]!, { position: { x: 0, y: 0 } });
  const record = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
  const request = vi.fn(async () => ({ ok: false, code: "unavailable" }));
  const h = makeHarness({ canvas: c, record, request });
  let resolve!: (value: unknown) => void;
  h.ctx.mediaRemote = { upload: () => new Promise(r => { resolve = r; }) };
  h.apply(gameFurnaceExtension());
  const contribution = h.slots.list("input.drop")[0]! as unknown as { handle: (event: DragEvent) => boolean };
  expect(contribution.handle({ clientX: 20, clientY: 20, dataTransfer: { files: [new File(["test"], "rules.txt")] } } as unknown as DragEvent)).toBe(true);
  h.dispose(); resolve({ ok: true, media: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "text/plain", size: 4 } });
  await Promise.resolve(); await Promise.resolve();
  expect(record).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

describe("游戏炼丹炉前端入口（任务 2.4/2.5）", () => {
  it("descriptor 是站点 server-active 入口，extensionId 与后端 identity 对齐", () => {
    expect(descriptor.extensionId).toBe("game-furnace");
    expect(descriptor.configScope).toBe("site");
    expect(descriptor.activation).toBe("server-active");
    expect(descriptor.label).toBe("游戏炼丹炉");
    expect(typeof descriptor.plugin).toBe("function");
  });

  it("注册中途失败立即回滚先前贡献；释放可重复且下次可重新启用", () => {
    const h = makeHarness();
    const register = h.slots.register.bind(h.slots);
    const failed = vi.spyOn(h.slots, "register").mockImplementation((slot, contribution) => {
      if (slot === "input.drop") throw Error("slot registration failed");
      return register(slot, contribution);
    });
    expect(() => h.apply(gameFurnaceExtension())).toThrow("slot registration failed");
    for (const slot of ["canvas.node-template", "canvas.focus-workspace", "canvas.node-drop", "input.drop"]) expect(h.slots.list(slot)).toHaveLength(0);
    h.dispose(); h.dispose();
    failed.mockRestore(); h.apply(gameFurnaceExtension());
    expect(h.slots.list("canvas.focus-workspace")).toHaveLength(1);
    h.dispose(); expect(h.slots.list("canvas.focus-workspace")).toHaveLength(0);
  });

  it("装配后注册通用节点模板菜单项（创作工具 section、紧随导演场之后），dispose 零残留", () => {
    const harness = makeHarness();
    harness.apply(gameFurnaceExtension());

    const contributions = harness.slots.list("canvas.node-template");
    expect(contributions).toHaveLength(1);
    const contribution = contributions[0]!;
    expect(contribution.id).toBe(GAME_FURNACE_NODE_TEMPLATE_ID);
    expect(contribution.owner).toBe("game-furnace");
    expect(contribution.owner).toBe(descriptor.extensionId);
    expect(contribution.label).toBe("游戏炼丹炉");
    expect(contribution.nodeType).toBe(GAME_FURNACE_NODE_TYPE);
    expect(contribution.nodeType).toBe("composite-asset");
    expect(contribution.section).toBe(CANVAS_MENU_SECTION.creationTools);
    expect(contribution.order).toBe(1);

    harness.dispose();
    expect(harness.slots.list("canvas.node-template")).toHaveLength(0);
  });

  it("注册通用聚焦工作区与复制拖入接收方（kind/nodeType 通用 + 严格 owner 匹配），dispose 零残留", () => {
    const harness = makeHarness();
    harness.apply(gameFurnaceExtension());

    const workspace = harness.slots.list("canvas.focus-workspace");
    expect(workspace).toHaveLength(1);
    expect(workspace[0]!.id).toBe(GAME_FURNACE_FOCUS_WORKSPACE_ID);
    expect(workspace[0]!.owner).toBe("game-furnace");
    expect(workspace[0]!.kind).toBe(GAME_FURNACE_FOCUS_KIND);
    expect(typeof workspace[0]!.render).toBe("function");
    // 严格业务匹配：同 kind 可被多个业务复用，宿主据此解析唯一 owner
    // （change: 2026-10-11-extract-film-set-extension）。
    expect(typeof workspace[0]!.matchesFocus).toBe("function");

    const drops = harness.slots.list("canvas.node-drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]!.id).toBe(GAME_FURNACE_NODE_DROP_ID);
    expect(drops[0]!.owner).toBe("game-furnace");
    expect(drops[0]!.nodeType).toBe("composite-asset");
    expect(typeof drops[0]!.onDrop).toBe("function");
    // 同 nodeType 可承载多个业务：drop 接收方提供严格 owner 匹配，宿主不按注册顺序选第一个。
    expect(typeof drops[0]!.matchesTarget).toBe("function");

    harness.dispose();
    expect(harness.slots.list("canvas.focus-workspace")).toHaveLength(0);
    expect(harness.slots.list("canvas.node-drop")).toHaveLength(0);
  });

  it("createNodeData 产出复合资产定义（composite-asset + 炉体几何），无业务专属 node 字段", () => {
    const harness = makeHarness();
    harness.apply(gameFurnaceExtension());
    const contribution = harness.slots.list("canvas.node-template")[0] as unknown as {
      createNodeData: (context: unknown) => Record<string, unknown>;
    };
    const data = contribution.createNodeData(MENU_CONTEXT);
    expect(data.title).toBe("游戏炼丹炉");
    expect(typeof data.modelScript).toBe("string");
    expect(data.modelScriptVersion).toBe("woohaa-model-js-v2");
    expect(data.container).toBeUndefined();
    expect(data.gameFurnace).toBeUndefined();
    // 每次调用返回全新对象（不共享可变引用）。
    expect(contribution.createNodeData(MENU_CONTEXT)).not.toBe(data);
    harness.dispose();
  });

  it("缺失 slots 时 inject 未满足、零部分贡献", () => {
    const harness = makeHarness({ slots: false });
    expect(() => harness.apply(gameFurnaceExtension())).toThrow();
    expect(harness.slots.list("canvas.node-template")).toHaveLength(0);
  });

  it("其他扩展节点不匹配炼丹炉工作区或拖入，不发送收集请求", async () => {
    const canvas = canvasOf("c", [{ id: "other", data: { extensionId: "other-extension" } }, { id: "source", type: "text", data: { prompt: "copied" } }]);
    const request = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const record = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const harness = makeHarness({ canvas, record, request });
    harness.apply(gameFurnaceExtension());
    const workspace = harness.slots.list("canvas.focus-workspace")[0]! as unknown as { matchesFocus?: (input: unknown) => boolean };
    expect(workspace.matchesFocus?.({ focus: { nodeId: "other", kind: "extension" } } as never)).toBe(false);
    const drop = harness.slots.list("canvas.node-drop")[0]! as unknown as { matchesTarget?: (input: unknown) => boolean; onPreview?: (input: unknown) => string | null; onDrop: (input: unknown) => boolean };
    const input = { canvas, targetNodeId: "other", sourceNodeIds: ["source"], point: { x: 0, y: 0 } };
    expect(drop.matchesTarget?.(input)).toBe(false);
    expect(drop.onPreview?.(input)).toBeNull();
    expect(drop.onDrop(input)).toBe(false);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    harness.dispose();
  });

  it.each(["current", "switched", "deleted", "reassigned"])("拖入迟到响应仅在原画布目标仍有效时记录撤销动作：%s", async (state) => {
    const canvas = canvasOf("c", [{ id: "gf" }, { id: "source", type: "text", data: { prompt: "copied" } }]);
    let resolve!: (value: unknown) => void;
    const record = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const harness = makeHarness({ canvas, record, request: ({ path }) => path.endsWith("project-collect")
      ? new Promise((done) => { resolve = done; })
      : Promise.resolve({ ok: true, data: { ok: true } }) });
    harness.apply(gameFurnaceExtension());
    const drop = harness.slots.list("canvas.node-drop")[0] as unknown as { onDrop: (input: unknown) => boolean };
    expect(drop.onDrop({ canvas, targetNodeId: "gf", sourceNodeIds: ["source"] })).toBe(true);
    if (state === "switched") harness.setCanvas(canvasOf("other", [{ id: "gf" }]));
    if (state === "reassigned") harness.setCanvas(canvasOf("c", [{ id: "gf", data: { extensionId: "other-extension" } }, { id: "source", type: "text", data: { prompt: "copied" } }]));
    if (state === "deleted") harness.setCanvas(canvasOf("c", [{ id: "source", type: "text", data: { prompt: "copied" } }]));
    resolve({ ok: true, data: { ok: true, projectStorageKey: "copied-key", inputHash: "copied-hash" } });
    await new Promise((done) => setTimeout(done, 0));
    expect(record).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
    if (state === "current") expect(record).toHaveBeenCalledWith([expect.objectContaining({ type: "nodeData.patch", nodeId: "gf" })], "收集 1 项素材");
    harness.dispose();
  });
});

describe("目标节点删除观察器（任务 6.10，Canvas scope）", () => {
  /** 可观察画布替身。 */
  function watcherHarness(initialCanvas: unknown, detach: (input: { canvasId: string; nodeId: string }) => Promise<TargetDetachResult>) {
    let canvas: unknown = initialCanvas;
    const listeners = new Set<() => void>();
    const calls: Array<{ canvasId: string; nodeId: string }> = [];
    const failures: Array<{ nodeId: string; code: string }> = [];
    const stop = startTargetDetachWatcher({
      canvasState: {
        getCanvas: () => canvas as never,
        getWorkingCanvas: () => canvas as never,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }
      },
      detach: async (input) => { calls.push(input); return detach(input); },
      onFailure: (input, failure) => failures.push({ nodeId: input.nodeId, code: failure.code })
    });
    const set = (next: unknown) => { canvas = next; listeners.forEach((fn) => fn()); };
    return { stop, calls, failures, set };
  }

  /** 推进微任务，使 watcher 的异步 detach 结果回调完成。 */
  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  }

  it("isGameFurnaceNodeData / gameFurnaceNodeIds 只认炼丹炉节点（extensionId 或炉体脚本）", () => {
    expect(isGameFurnaceNodeData(createGameFurnaceNodeData())).toBe(true);
    expect(isGameFurnaceNodeData({ extensionId: "game-furnace" })).toBe(true);
    expect(isGameFurnaceNodeData({ modelScript: GAME_FURNACE_GEOMETRY_SCRIPT })).toBe(false);
    expect(isGameFurnaceNodeData({ modelScript: "scene.group({ id: 'x' })" })).toBe(false);
    expect(isGameFurnaceNodeData(undefined)).toBe(false);
    const canvas = canvasOf("c", [
      { id: "f1" },
      { id: "other", type: "text", data: { prompt: "hi" } },
      { id: "not-gf", type: "composite-asset", data: { modelScript: "scene.group({ id: 'x' })" } }
    ]);
    expect(gameFurnaceNodeIds(canvas as never)).toEqual(["f1"]);
  });

  it("普通画布删除未被聚焦的炼丹炉节点也触发脱离（关键场景）", async () => {
    const h = watcherHarness(canvasOf("c", [{ id: "gf" }]), async () => ({ ok: true }));
    // 首次观察建立基线，不触发。
    expect(h.calls).toEqual([]);
    // 删除未被聚焦的节点（无任何聚焦工作区）：仍触发。
    h.set(canvasOf("c", []));
    await flush();
    expect(h.calls).toEqual([{ canvasId: "c", nodeId: "gf" }]);
    h.stop();
  });

  it("无关节点删除不触发；多节点时只脱离被删除的那个", async () => {
    const h = watcherHarness(canvasOf("c", [{ id: "gf-a" }, { id: "gf-b" }, { id: "note", type: "text", data: {} }]), async () => ({ ok: true }));
    // 删除一个无关文本节点：不触发。
    h.set(canvasOf("c", [{ id: "gf-a" }, { id: "gf-b" }]));
    await flush();
    expect(h.calls).toEqual([]);
    // 删除 gf-a：只脱离 gf-a。
    h.set(canvasOf("c", [{ id: "gf-b" }]));
    await flush();
    expect(h.calls).toEqual([{ canvasId: "c", nodeId: "gf-a" }]);
    h.stop();
  });

  it("切画布重置基线不触发；新画布内删除再触发", async () => {
    const h = watcherHarness(canvasOf("c1", [{ id: "gf" }]), async () => ({ ok: true }));
    // 切换画布（旧画布节点在新画布不存在）：不触发。
    h.set(canvasOf("c2", []));
    await flush();
    expect(h.calls).toEqual([]);
    // c2 建立基线后再删除新增的炼丹炉节点：触发，canvasId 为新画布。
    h.set(canvasOf("c2", [{ id: "gf2" }]));
    await flush();
    expect(h.calls).toEqual([]);
    h.set(canvasOf("c2", []));
    await flush();
    expect(h.calls).toEqual([{ canvasId: "c2", nodeId: "gf2" }]);
    h.stop();
  });

  it("画布临时为 null 保留基线、不误判为全部删除", async () => {
    const h = watcherHarness(canvasOf("c", [{ id: "gf" }]), async () => ({ ok: true }));
    h.set(null);
    await flush();
    expect(h.calls).toEqual([]);
    h.set(canvasOf("c", [{ id: "gf" }]));
    await flush();
    expect(h.calls).toEqual([]);
    h.stop();
  });

  it("同一 canvas+node 去重：多次通知只发一次请求", async () => {
    const h = watcherHarness(canvasOf("c", [{ id: "gf" }]), async () => ({ ok: true }));
    const empty = canvasOf("c", []);
    h.set(empty);
    h.set(empty);
    h.set(empty);
    await flush();
    expect(h.calls).toEqual([{ canvasId: "c", nodeId: "gf" }]);
    h.stop();
  });

  it("远端失败回报且允许后续重试（不崩溃）", async () => {
    let attempt = 0;
    const h = watcherHarness(canvasOf("c", [{ id: "gf" }]), async () => {
      attempt += 1;
      return attempt === 1 ? { ok: false, code: "unavailable", message: "offline" } : { ok: true };
    });
    h.set(canvasOf("c", []));
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.failures).toEqual([{ nodeId: "gf", code: "unavailable" }]);
    // 失败后允许重试：再次观察同一删除状态会再发一次请求。
    h.set(canvasOf("c", []));
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.failures).toHaveLength(1); // 第二次成功，无新失败回报
    h.stop();
  });

  it("dispose 后停止观察，不再发请求", async () => {
    const h = watcherHarness(canvasOf("c", [{ id: "gf" }]), async () => ({ ok: true }));
    h.stop();
    h.set(canvasOf("c", []));
    await flush();
    expect(h.calls).toEqual([]);
  });

  it("插件装配：普通画布删除炼丹炉节点经受控 handler 发起 target-detach；dispose 后停止", async () => {
    const requests: string[] = [];
    const harness = makeHarness({
      canvas: canvasOf("c", [{ id: "gf" }]),
      request: async (input) => {
        requests.push(input.path);
        return { ok: true, status: 200, data: { ok: true, detached: 1 } };
      }
    });
    harness.apply(gameFurnaceExtension());
    // 初始装配不请求。
    expect(requests.filter((path) => path.includes("game-furnace/target-detach"))).toHaveLength(0);
    harness.setCanvas(canvasOf("c", []));
    await flush();
    const detachRequests = requests.filter((path) => path.includes("game-furnace/target-detach"));
    expect(detachRequests).toHaveLength(1);
    // dispose（owner 释放）后不再观察。
    harness.dispose();
    harness.setCanvas(canvasOf("c", [{ id: "gf" }]));
    harness.setCanvas(canvasOf("c", []));
    await flush();
    expect(requests.filter((path) => path.includes("game-furnace/target-detach"))).toHaveLength(1);
  });

  it("插件装配：无关/同画布切换/临时 null 不产生 target-detach 请求", async () => {
    const requests: string[] = [];
    const harness = makeHarness({
      canvas: canvasOf("c", [{ id: "gf" }, { id: "note", type: "text", data: {} }]),
      request: async (input) => { requests.push(input.path); return { ok: true, status: 200, data: { ok: true } }; }
    });
    harness.apply(gameFurnaceExtension());
    const detachCount = () => requests.filter((path) => path.includes("game-furnace/target-detach")).length;
    harness.setCanvas(canvasOf("c", [{ id: "gf" }])); // 删无关节点
    harness.setCanvas(null); // 临时 null
    harness.setCanvas(canvasOf("c", [{ id: "gf" }]));
    harness.setCanvas(canvasOf("other", [{ id: "gf" }])); // 切画布
    await flush();
    expect(detachCount()).toBe(0);
    harness.dispose();
  });
});
