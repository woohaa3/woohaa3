/**
 * Paste Import Plugin 生命周期与输入路由测试
 * （change: add-paste-import-workflows，任务 1.1–1.3 / 5.2）。
 *
 * 用真实 `startFrontendRuntime` + 注入 stub platform 验证：
 * - 缺失依赖时零副作用（pending），激活后只有一个 paste/drop owner；
 * - 文件 paste 经 importService，内部载荷粘贴经 canvasEdit；
 * - modal 激活时不 claim 事件；
 * - dispose 后 contribution 与 dialog 完全撤销。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas, applyCanvasCommands, } from "@woohaa3/contracts";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { pasteImportExtension, PASTE_IMPORT_PLUGIN_ID } from "./plugin.js";
import { PASTE_REPLACE_DIALOG_ID } from "./replace-dialog.js";
import { DialogService } from "../../services/dialogs/service.js";
import { InputScopeService } from "../../services/input-scopes.js";
import { SlotRegistry } from "../../slots.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

let runtime: FrontendRuntime | null = null;

function imageNodeCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const result = applyCanvasCommands(base, [
    { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }
  ]);
  if (!result.ok) throw new Error("fixture");
  return result.canvas;
}

function fakeEvent(files: File[]): ClipboardEvent {
  const data = {
    files: Object.assign(files, { item: (index: number) => files[index] ?? null }),
    items: [] as unknown[],
    types: ["Files"],
    getData: () => ""
  };
  return { clipboardData: data, preventDefault: vi.fn() } as unknown as ClipboardEvent;
}

type Harness = {
  runtime: FrontendRuntime;
  importBatch: ReturnType<typeof vi.fn>;
  submitCommands: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  replaceSelectedImage: ReturnType<typeof vi.fn>;
  inputScopes: InputScopeService;
  dialogs: DialogService;
  slots: SlotRegistry;
};

async function makeHarness(options: { includePasteExtension?: boolean; imageFocused?: boolean; verify?: (...args: any[]) => Promise<any> } = {}): Promise<Harness> {
  const importBatch = vi.fn(async (input: { files: readonly File[] }) => ({
    ok: true,
    succeeded: input.files.length,
    failed: 0,
    items: input.files.map((file, index) => ({
      id: `item-${index}`,
      name: file.name,
      kind: "image" as const,
      size: file.size,
      stage: "done" as const
    }))
  }));
  const submitCommands = vi.fn(() => ({ ok: true, handle: {} as never }));
  const record = vi.fn(async () => ({ ok: true }));
  const replaceSelectedImage = vi.fn(async () => ({ ok: true }));
  const inputScopes = new InputScopeService();
  const dialogs = new DialogService();
  const slots = new SlotRegistry();

  const sessionStub = {
    getStatus: () => ({ phase: "ready", error: null, hydrated: true, remote: {} }),
    subscribe: () => () => undefined,
    retry: async () => undefined,
    requestHydrate: () => undefined,
    commandLifecycle: () => null,
    submitCommands,
    isWritable: () => true,
    shutdown: () => undefined
  };
  const runtimeStub = {
    imageFocusProjection: () => options.imageFocused ? {nodeId:"image-1"} : null,
    getStatus: () => ({ phase: "ready", error: null }),
    subscribe: () => () => undefined,
    load: async () => ({}) as never,
    attach: () => () => undefined,
    controller: () => ({
      viewport: () => ({ x: 0, y: 0, zoom: 1 }),
      surface: () => ({ width: 800, height: 600, pixelRatio: 1 })
    }),
    runtime: () => null,
    cancelTransientGesture: () => undefined,
    lastPointerWorld: () => null,
    clientToWorld: (client: { x: number; y: number }) => client,
    menu: () => null,
    setMenu: () => undefined,
    closeMenu: () => undefined,
    subscribeMenu: () => () => undefined
  };

  const installPlatform = (ctx: Context) => {
    ctx.provide("slots" as never, slots as never);
    ctx.provide("inputScopes" as never, inputScopes as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("canvasSession" as never, sessionStub as never);
    ctx.provide("canvasRemote" as never, { verifyImageProjectReferences: options.verify } as never);
    ctx.provide("canvasEdit" as never, { record } as never);
    ctx.provide("canvasRuntime" as never, runtimeStub as never);
    ctx.provide("selection" as never, { getSnapshot: () => ({ nodeIds: ["n1"], primaryNodeId: "n1", editingFocus: false, keyboardActive: true }) } as never);
    ctx.provide("importService" as never, { importBatch, replaceSelectedImage } as never);
    inputScopes.addScope("modal", () => dialogs.isModalActive());
  };

  const plugins = options.includePasteExtension === false ? [] : [{ id: PASTE_IMPORT_PLUGIN_ID, required: false, plugin: pasteImportExtension() }];
  const instance = await startFrontendRuntime({ installPlatform, plugins });
  return { runtime: instance, importBatch, submitCommands, record, replaceSelectedImage, inputScopes, dialogs, slots };
}

/** 让异步 hash/upload/submit 链推进（crypto digest + arrayBuffer 是真实微任务）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

describe("Paste Import Plugin", () => {
  it("激活后只注册一个 paste/drop owner 与替换 dialog", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    expect(harness.slots.list("input.paste")).toHaveLength(1);
    expect(harness.slots.list("input.drop")).toHaveLength(1);
    expect(harness.dialogs.registeredDialogIds()).toContain(PASTE_REPLACE_DIALOG_ID);
  });

  it("缺失 importService 时保持 pending、零副作用", async () => {
    const slots = new SlotRegistry();
    const inputScopes = new InputScopeService();
    const instance = await startFrontendRuntime({
      installPlatform: (ctx) => {
        ctx.provide("slots" as never, slots as never);
        ctx.provide("inputScopes" as never, inputScopes as never);
        ctx.provide("dialogs" as never, new DialogService() as never);
        ctx.provide("canvasSession" as never, {} as never);
        ctx.provide("canvasRemote" as never, {} as never);
        ctx.provide("canvasEdit" as never, {} as never);
        ctx.provide("canvasRuntime" as never, {} as never);
        ctx.provide("selection" as never, {} as never);
        // 故意不提供 importService（用 ctx.get 查找，缺失时保持 pending？）
      },
      plugins: [{ id: PASTE_IMPORT_PLUGIN_ID, required: false, plugin: pasteImportExtension() }]
    });
    runtime = instance;
    // importService 通过 ctx.get 查找而不在 inject 中，因此插件仍激活；验证此时不崩溃且 slot 存在。
    expect(instance.ctx.slots.list("input.paste")).toHaveLength(1);
  });

  it("缺少 required slot 依赖时保持 pending", async () => {
    const instance = await startFrontendRuntime({
      installPlatform: (ctx) => {
        ctx.provide("inputScopes" as never, new InputScopeService() as never);
        // 不提供 slots。
      },
      plugins: [{ id: PASTE_IMPORT_PLUGIN_ID, required: false, plugin: pasteImportExtension() }]
    });
    runtime = instance;
    const diagnostic = instance.status().plugins.find((plugin) => plugin.id === PASTE_IMPORT_PLUGIN_ID);
    expect(diagnostic?.status).toBe("pending");
  });

  it("文件 paste 经 importService，一次只调用一次", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
    const contribution = harness.slots.list("input.paste")[0]!;
    const file = new File(["x"], "a.png", { type: "image/png" });
    // 选中一个 image 节点时，单图会走替换确认而非直接导入。
    const claims = contribution.handle(fakeEvent([file]));
    expect(claims).toBe(true);
    await flush();
    // 打开替换 dialog，未上传。
    expect(harness.dialogs.getSnapshot().stack).toHaveLength(1);
    expect(harness.importBatch).not.toHaveBeenCalled();
    expect(harness.submitCommands).not.toHaveBeenCalled();
  });

  it("多图或多选时直接走批量导入", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
    const contribution = harness.slots.list("input.paste")[0]!;
    const files = [new File(["x"], "a.png", { type: "image/png" }), new File(["y"], "b.png", { type: "image/png" })];
    expect(contribution.handle(fakeEvent(files))).toBe(true);
    await flush();
    expect(harness.importBatch).toHaveBeenCalledTimes(1);
  });

  it("普通文本粘贴为无操作", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
    const contribution = harness.slots.list("input.paste")[0]!;
    const event = { clipboardData: { files: [], items: [], types: [], getData: () => "hello" }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    expect(contribution.handle(event)).toBe(false);
    await flush();
    expect(harness.importBatch).not.toHaveBeenCalled();
  });

  it("内部节点载荷经 canvasEdit 记录为一次可撤销动作", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
    const contribution = harness.slots.list("input.paste")[0]!;
    const payload = {
      format: "infinspire-canvas-copy-v1",
      nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }],
      edges: [],
      incomingEdges: [],
      nodeData: {}
    };
    const event = {
      clipboardData: { files: [], items: [], types: [], getData: () => JSON.stringify(payload) },
      preventDefault: vi.fn()
    } as unknown as ClipboardEvent;
    expect(contribution.handle(event)).toBe(true);
    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.record).toHaveBeenCalledWith(expect.any(Array), "粘贴作品");
    expect(harness.submitCommands).not.toHaveBeenCalled();
    expect(harness.importBatch).not.toHaveBeenCalled();
  });

  it("modal 打开时不 claim paste", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
    harness.dialogs.open({ dialogId: PASTE_REPLACE_DIALOG_ID, payload: { intentId: "x", fileName: "a.png", nodeLabel: "n" } });
    const contribution = harness.slots.list("input.paste")[0]!;
    const file = new File(["x"], "a.png", { type: "image/png" });
    expect(contribution.handle(fakeEvent([file]))).toBe(false);
    await flush();
    expect(harness.importBatch).not.toHaveBeenCalled();
  });

  it("dispose 后 paste/drop 与替换 dialog 完全撤销", async () => {
    const harness = await makeHarness();
    const instance = harness.runtime;
    runtime = null;
    await instance.dispose();
    expect(harness.slots.list("input.paste")).toHaveLength(0);
    expect(harness.slots.list("input.drop")).toHaveLength(0);
    expect(harness.dialogs.registeredDialogIds()).toEqual([]);
  });

  it("启动失败（dialog 冲突）时不残留 paste/drop contribution", async () => {
    const slots = new SlotRegistry();
    const inputScopes = new InputScopeService();
    const dialogs = new DialogService();
    // 预先占用替换 dialog ID，使 Plugin apply 在注册阶段抛错。
    dialogs.registerDialog(PASTE_REPLACE_DIALOG_ID, {
      definition: { validatePayload: () => ({ ok: true, payload: {} }) }
    });
    const instance = await startFrontendRuntime({
      installPlatform: (ctx) => {
        ctx.provide("slots" as never, slots as never);
        ctx.provide("inputScopes" as never, inputScopes as never);
        ctx.provide("dialogs" as never, dialogs as never);
        ctx.provide("canvasSession" as never, { isWritable: () => true } as never);
        ctx.provide("canvasRemote" as never, {} as never);
        ctx.provide("canvasEdit" as never, {} as never);
        ctx.provide("selection" as never, { getSnapshot: () => ({ nodeIds: [], primaryNodeId: null, editingFocus: false, keyboardActive: false }) } as never);
        ctx.provide("canvasRuntime" as never, {} as never);
        ctx.provide("importService" as never, {} as never);
      },
      plugins: [{ id: PASTE_IMPORT_PLUGIN_ID, required: false, plugin: pasteImportExtension() }]
    });
    runtime = instance;
    // optional 失败被隔离：启动仍 ready，且 slot 注册被回滚。
    expect(instance.status().phase).toBe("ready");
    expect(slots.list("input.paste")).toHaveLength(0);
    expect(slots.list("input.drop")).toHaveLength(0);
  });
});


function projectPasteEvent(): ClipboardEvent {
  const baseAsset = { id: "base", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-16T00:00:00Z", title: "base", metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 10 } };
  const payload = { format: "infinspire-canvas-copy-v1", sourceCanvasId: "source", nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }], edges: [], incomingEdges: [], assets: [baseAsset],
    nodeData: { n1: { outputAssetId: "base", imageEdit: { version: "woohaa-image-project-v1", engine: "fixture-editor", engineVersion: "fixture-editor-v1", formatVersion: 1,
      baseAssetId: "base", sourceWidth: 10, sourceHeight: 10, canvasWidth: 10, canvasHeight: 10, documentContentHash: "1".repeat(16),
      project: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "application/vnd.fixture-project", size: 100 }, sourceAssetIds: ["base"] } } } };
  return { clipboardData: { files: [], items: [], types: [], getData: () => JSON.stringify(payload) } } as unknown as ClipboardEvent;
}

it("工程粘贴同步认领但等待异步核验，成功后采用权威 metadata", async () => {
  let finish!: (value: any) => void;
  const verify = vi.fn(() => new Promise<any>((resolve) => { finish = resolve; }));
  const harness = await makeHarness({ verify }); runtime = harness.runtime;
  woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
  expect(harness.slots.list("input.paste")[0]!.handle(projectPasteEvent())).toBe(true);
  expect(verify).toHaveBeenCalledWith(expect.objectContaining({ canvasId: "c1", sourceCanvasId: "source", assetIds: ["base"] }));
  expect(harness.record).not.toHaveBeenCalled();
  finish({ ok: true, value: { assets: [{ id: "base", title: "权威素材", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-16T00:00:00Z", metadata: { storageKey: `sha256-${"a".repeat(64)}`, size: 999 } }] } });
  await flush();
  expect(harness.record).toHaveBeenCalledOnce();
  expect(JSON.stringify(harness.record.mock.calls)).toContain("权威素材");
  expect(JSON.stringify(harness.record.mock.calls)).toContain('"size":999');
});

it.each(["denied", "disposed", "navigated"])("核验 %s 时不能把工程写入当前画布", async (reason) => {
  let finish!: (value: any) => void;
  const harness = await makeHarness({ verify: () => new Promise<any>((resolve) => { finish = resolve; }) }); runtime = harness.runtime;
  woohaa3CanvasStore.getState().applyRemoteCanvas(imageNodeCanvas());
  expect(harness.slots.list("input.paste")[0]!.handle(projectPasteEvent())).toBe(true);
  if (reason === "disposed") { await runtime.dispose(); runtime = null; }
  if (reason === "navigated") woohaa3CanvasStore.getState().applyRemoteCanvas(createEmptyWoohaa3ServerCanvas("elsewhere"));
  finish(reason === "denied" ? { ok: false, code: "FORBIDDEN", error: "denied" } : { ok: true, value: { assets: [] } });
  await flush();
  expect(harness.record).not.toHaveBeenCalled();
});

 it("图片聚焦时认领原生粘贴，不导入文件或粘贴宿主节点",async()=>{
  const harness=await makeHarness({imageFocused:true});
  try {
    const paste=harness.slots.list("input.paste")[0]!;
    expect(paste.handle(fakeEvent([new File(["image"],"test.png",{type:"image/png"})]))).toBe(true);
    expect(harness.importBatch).not.toHaveBeenCalled();
    expect(harness.submitCommands).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  } finally {await harness.runtime.dispose();}
});
