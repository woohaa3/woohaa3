/**
 * 编辑器工作区控制器回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/4.1/4.3）。
 *
 * 用替身内核句柄覆盖：按需加载、打开工程、命令分派与拒绝、冻结成对产物、保存失败保留现场。
 * 不加载 wasm、不需要 GPU。
 */
import { describe, expect, it, vi } from "vitest";
import type { ImageProjectDocument, StoredAsset } from "@woohaa3/contracts";
import { IMAGE_PROJECT_CONTENT_TYPE, PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
import { EditorHandle, type EditorInstance, type EditorExportBundle } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { ProjectSession } from "../src/project-session.js";
import type { ProjectSaveDeps } from "../src/project-save.js";

const PROJECT_SHA = "1".repeat(64);
const OUTPUT_SHA = "2".repeat(64);
const DOC_HASH = "aabbccddeeff0011";

function projectDocument(): ImageProjectDocument {
  return {
    version: "woohaa-image-project-v1",
    engine: "photocraft",
    engineVersion: PHOTOCRAFT_ENGINE_VERSION,
    formatVersion: 1,
    baseAssetId: "asset-base",
    sourceWidth: 800,
    sourceHeight: 600,
    canvasWidth: 800,
    canvasHeight: 600,
    documentContentHash: DOC_HASH,
    project: { storageKey: "old-key", checksum: "e".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 },
    sourceAssetIds: ["asset-base"]
  };
}

function session(): ProjectSession {
  return new ProjectSession({
    nodeId: "node-1",
    baseAssetId: "asset-base",
    baseStorageKey: "media/base.png",
    sourceWidth: 800,
    sourceHeight: 600,
    edit: projectDocument(),
    projectObjectAvailable: true
  });
}

function stateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "photo.pcraft" }] },
    document: {
      name: "photo.pcraft",
      width: 800,
      height: 600,
      mode: "Rgb",
      depth: 8,
      activeLayer: 1,
      selectedLayers: [1],
      hasSelection: false,
      canUndo: true,
      canRedo: false,
      revision: 3,
      history: ["打开"],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }],
      ...overrides
    }
  });
}

function commandsJson(): string {
  return JSON.stringify([
    {
      id: "layer.delete",
      label: "删除图层",
      menu: ["Layer"],
      shortcut: null,
      params: "",
      enabled: true,
      disabledReason: null,
      needsDocument: true,
      allowed: true
    },
    {
      id: "select.subject",
      label: "主体选择",
      menu: ["Select"],
      shortcut: null,
      params: "",
      enabled: true,
      disabledReason: null,
      needsDocument: true,
      allowed: false
    }
  ]);
}

/** 替身内核：记录调用，按需抛错。 */
function fakeInstance() {
  const calls: string[] = [];
  const bundle: EditorExportBundle = {
    revision: 3,
    documentContentHash: DOC_HASH,
    canvasWidth: 800,
    canvasHeight: 600,
    project: new TextEncoder().encode("PROJECT-BYTES"),
    output: new TextEncoder().encode("OUTPUT-BYTES")
  };
  const instance: EditorInstance = {
    patternLibrary:()=>'{"presets":[]}',importPatternPresets:()=>'{"presets":[]}',renamePatternPreset:()=>'{"presets":[]}',deletePatternPreset:()=>'{"presets":[]}',
    exportPatternPresets:()=>new Uint8Array(),patternLibrarySnapshot:()=>new Uint8Array(),restorePatternLibrary:()=>'{"presets":[]}',
    importContourPresets:()=>"[]",exportContourPreset:()=>new Uint8Array(),
    stylePositionFrame:()=>"[0,0,200,80]",
    beginLayerProperties: (layer)=>{calls.push("beginLayerProperties");return JSON.stringify({layer,opacity:1});},
    previewLayerProperties: (params)=>{calls.push("previewLayerProperties");return params;},
    commitLayerProperties: ()=>{calls.push("commitLayerProperties");return "null";},
    cancelLayerProperties: ()=>{calls.push("cancelLayerProperties");},
    curveGeometry: () => JSON.stringify(Array.from({length:256},(_,i)=>i)),
    beginAdjustment: (layer) => {calls.push("beginAdjustment");return JSON.stringify({layer,kind:"brightnessContrast",params:{brightness:0,contrast:0}});},
    previewAdjustment: (params) => {calls.push("previewAdjustment");return params;},
    commitAdjustment: () => {calls.push("commitAdjustment");return "null";},
    cancelAdjustment: () => {calls.push("cancelAdjustment");},
    beginText: () => {calls.push("beginText");return JSON.stringify({layer:null,new:true,text:""});},
    textGeometry: () => JSON.stringify({caret:[[10,10],[10,20]],selection:[],hit:null}),
    previewText: () => {calls.push("previewText");return JSON.stringify({layer:2,new:true,text:"草稿"});},
    commitText: () => {calls.push("commitText");return "null";},
    cancelText: () => {calls.push("cancelText");},
    openImage: () => {
      calls.push("openImage");
      return stateJson();
    },
    openProject: () => {
      calls.push("openProject");
      return stateJson();
    },
    placeImage: () => {
      calls.push("placeImage");
      return stateJson();
    },
    beginStroke: () => { calls.push("beginStroke"); },
    appendStroke: () => { calls.push("appendStroke"); },
    takeStrokeDamage:()=>JSON.stringify([{x:10,y:20,width:30,height:40}]),
    commitStroke: () => { calls.push("commitStroke"); return "null"; },
    cancelStroke: () => { calls.push("cancelStroke"); },
    beginSelectionTransform: () => { calls.push("beginSelectionTransform"); },
    beginMove: () => true,
    beginTransform: () => { calls.push("beginTransform"); },
    previewTransform: () => { calls.push("previewTransform"); },
    commitTransform: () => { calls.push("commitTransform"); return "null"; },
    cancelTransform: () => { calls.push("cancelTransform"); },
    saveProject: () => bundle.project,
    sampleColor: () => undefined,
    layerThumbnail: () => ({width:1,height:1,pixels:new Uint8Array(4)}),
    renderPreview: (maxSide) => ({ width: Math.min(maxSide, 800), height: Math.min(maxSide, 600), pixels: new Uint8Array(4) }),
    renderRegion: (params) => {
      const {width,height}=JSON.parse(params);
      return {width,height,pixels:new Uint8Array(width*height*4)};
    },
    exportBundle: () => {
      calls.push("exportBundle");
      return bundle;
    },
    contentHash: () => DOC_HASH,
    assetIdsJson: () => JSON.stringify({ baseAssetId: "asset-base", placed: [] }),
    commandsJson,
    allowedCommandIdsJson: () => JSON.stringify(["layer.delete"]),
    stateJson,
    execute: (id) => {
      calls.push(`execute:${id}`);
      if (id !== "layer.delete") {
        throw JSON.stringify({ code: "capability-disabled", message: `首期未开放的功能：${id}` });
      }
      return "null";
    },
    undo: () => {
      calls.push("undo");
      return "null";
    },
    redo: () => "null",
    hasDocument: () => true,
    closeDocument: () => stateJson()
  };
  return { instance, calls, bundle };
}

function digestOf(bytes: Uint8Array): Promise<string> {
  const marker = String.fromCharCode(...bytes.slice(0, 1));
  return Promise.resolve(marker === "P" ? PROJECT_SHA : OUTPUT_SHA);
}

function asset(): StoredAsset {
  return {
    id: "asset-base",
    title: "原图",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-10-16T00:00:00.000Z"
  };
}

function saveDeps(overrides: Partial<ProjectSaveDeps> = {}): ProjectSaveDeps {
  const uploaded = {
    storageKey: "media/project.pcraft",
    checksum: "f".repeat(64),
    contentType: IMAGE_PROJECT_CONTENT_TYPE,
    size: 13,
    url: "/media/project.pcraft"
  };
  return {
    uploadProject: async () => uploaded,
    uploadOutput: async () => ({ ...uploaded, storageKey: "media/out.png", contentType: "image/png" }),
    complete: async () => ({
      ok: true,
      receipt: {
        requestId: "req-1",
        sessionId: "session-1",
        canvasId: "default",
        nodeId: "node-1",
        kind: "image",
        status: "completed",
        contentIdentity: DOC_HASH,
        entryId: "entry-1",
        revision: 1,
        contentCommitted: true
      }
    }),
    assetIdFor: (checksum) => `asset-image-edit-${checksum}`,
    digest: digestOf,
    ...overrides
  };
}

function saveInput() {
  return {
    canvasId: "default",
    nodeId: "node-1",
    sessionId: "session-1",
    requestId: "req-1",
    baselineContentIdentity: "media/base.png",
    baseAsset: asset(),
    baseStorageKey: "media/base.png",
    baseChecksum: "a".repeat(64),
    baseContentType: "image/png",
    baseSize: 1024
  };
}

function makeController(options: {
  load?: () => Promise<{ ok: true; value: EditorHandle } | { ok: false; code: string; message: string }>;
  deps?: ProjectSaveDeps;
  project?: ProjectSession;
  yieldTask?: () => Promise<void>;
} = {}) {
  const { instance } = fakeInstance();
  const handle = new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 });
  const project = options.project ?? session();
  const controller = new EditorWorkspaceController({
    session: project,
    sessionId: "session-1",
    dialogOwner: () => ({canvasId:"canvas-1",nodeId:"node-1",sessionId:"session-1"}),
    saveDeps: options.deps ?? saveDeps(),
    baselineDocument: projectDocument(),
    load: options.load ?? (async () => ({ ok: true as const, value: handle })),
    yieldTask: options.yieldTask ?? (() => Promise.resolve()),
    digest: digestOf
  });
  return { controller, project, handle };
}

describe("编辑器工作区加载与打开", () => {
  it("加载内核失败时进入 unavailable，不抛异常", async () => {
    const { controller } = makeController({
      load: async () => ({ ok: false as const, code: "editor-load-failed", message: "内核缺失" })
    });
    const result = await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    expect(result.ok).toBe(false);
    expect(controller.currentState()).toMatchObject({ phase: "unavailable" });
  });

  it("打开工程后进入 editing 并同步内容状态", async () => {
    const { controller, project } = makeController();
    const opened = await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    expect(opened.ok).toBe(true);
    expect(controller.currentState().phase).toBe("editing");
    expect(controller.currentView().document?.layers).toHaveLength(1);
    expect(project.currentPhase()).toBe("editing");
    expect(project.contentHash()).toBe(DOC_HASH);
    // 基线相同 → 无净变化。
    expect(controller.isDirty()).toBe(false);
  });

  it("旧工程指纹迁移只更新本地基线；编辑、撤销和权威保存身份仍正确", async () => {
    const { instance, bundle } = fakeInstance();
    const loadedHash = "1111222233334444";
    let currentHash = loadedHash;
    instance.contentHash = () => currentHash;
    const handle = new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 });
    const complete = vi.fn(saveDeps().complete);
    const { controller, project } = makeController({
      load: async () => ({ ok: true, value: handle }),
      deps: saveDeps({ complete })
    });
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    expect(project.baselineContent()).toBe(loadedHash);
    expect(controller.currentState().dirty).toBe(false);
    currentHash = "5555666677778888";
    controller.dispatch("layer.delete");
    expect(controller.isDirty()).toBe(true);
    currentHash = loadedHash;
    controller.dispatch("layer.delete");
    expect(controller.isDirty()).toBe(false);
    currentHash = "5555666677778888";
    bundle.documentContentHash = currentHash;
    controller.dispatch("layer.delete");
    expect(await controller.save(saveInput())).toMatchObject({ ok: true });
    expect(complete.mock.calls[0][0]).toMatchObject({ baselineContentIdentity: "media/base.png" });
    expect(project.baselineContent()).toBe(currentHash);
  });

  it("快照在状态未变时保持同一引用，状态变化后换新引用", async () => {
    // React 的 useSyncExternalStore 会反复读取 getSnapshot；每次返回新对象会被判定为
    // 「一直在变化」，触发 `Maximum update depth exceeded`（真实缺陷，已修）。
    const { controller } = makeController();
    const initial = controller.snapshot();
    expect(controller.snapshot()).toBe(initial);
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    const opened = controller.snapshot();
    expect(opened).not.toBe(initial);
    expect(controller.snapshot()).toBe(opened);
    controller.dispose();
    const disposed = controller.snapshot();
    expect(disposed).not.toBe(opened);
    expect(controller.snapshot()).toBe(disposed);
  });

  it("通知订阅者并暴露只读快照", async () => {
    const { controller } = makeController();
    const seen = vi.fn();
    controller.subscribe(seen);
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    expect(seen).toHaveBeenCalled();
    const snapshot = controller.snapshot();
    expect(snapshot.commands.has("layer.delete")).toBe(true);
    expect(snapshot.commands.has("select.subject")).toBe(false);
  });
});

describe("命令分派", () => {
  it("白名单内命令通过，白名单外返回 capability-disabled", async () => {
    const { controller } = makeController();
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    expect(controller.dispatch("layer.delete").ok).toBe(true);
    const refused = controller.dispatch("select.subject");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("capability-disabled");
  });

  it("未加载内核时拒绝并给出 no-document", () => {
    const { controller } = makeController();
    const result = controller.dispatch("layer.delete");
    expect(result).toMatchObject({ ok: false, code: "no-document" });
  });
});

describe("冻结与保存", () => {
  it("成功保存推进基线并进入 saved", async () => {
    const { controller, project } = makeController();
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    const outcome = await controller.save(saveInput());
    expect(outcome.ok).toBe(true);
    expect(controller.currentState().phase).toBe("saved");
    expect(project.currentPhase()).toBe("editing");
    expect(controller.frozenArtifacts()?.outputSummary.sha256).toBe(OUTPUT_SHA);
  });

  it("上传失败时不产生规范写入，保留现场并可重试", async () => {
    const { controller, project } = makeController({ deps: saveDeps({ uploadProject: async () => null }) });
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    const outcome = await controller.save(saveInput());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("project-upload-failed");
    expect(outcome.retriable).toBe(true);
    // 现场保留：控制器仍可继续编辑，冻结产物仍可取用。
    expect(controller.currentState().phase).toBe("failed");
    expect(project.currentPhase()).toBe("editing");
    expect(controller.frozenArtifacts()).not.toBeNull();
  });

  it("冲突回执映射为 conflict", async () => {
    const deps = saveDeps({
      complete: async () => ({
        ok: false as const,
        code: "EDIT_SESSION_CONFLICT",
        error: "被拒绝",
        receipt: {
          requestId: "req-1",
          sessionId: "session-1",
          canvasId: "default",
          nodeId: "node-1",
          kind: "image" as const,
          status: "conflict" as const,
          contentIdentity: "",
          entryId: null,
          revision: 1,
          contentCommitted: false,
          errorCode: "EDIT_SESSION_CONFLICT" as const,
          errorMessage: "内容已被其他操作更新"
        }
      })
    });
    const { controller } = makeController({ deps });
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    const outcome = await controller.save(saveInput());
    expect(outcome).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("释放", () => {
  it("dispose 后回到 idle 并清空视图", async () => {
    const { controller } = makeController();
    await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
    controller.dispose();
    expect(controller.currentState().phase).toBe("idle");
    expect(controller.currentView().hasDocument).toBe(false);
    expect(controller.editor()).toBeNull();
  });
});

it("未确认保存可重试且不重传，等待期间撤销和置入不能绕过门禁", async () => {
  let finish!: (value: Awaited<ReturnType<ProjectSaveDeps["complete"]>>) => void;
  const complete = vi.fn((_request: Parameters<ProjectSaveDeps["complete"]>[0]) => new Promise<Awaited<ReturnType<ProjectSaveDeps["complete"]>>>((resolve) => { finish = resolve; }));
  const uploadProject = vi.fn(saveDeps().uploadProject), uploadOutput = vi.fn(saveDeps().uploadOutput);
  const { controller } = makeController({ deps: saveDeps({ complete, uploadProject, uploadOutput }) });
  await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  const first = controller.save(saveInput());
  expect(controller.save(saveInput())).toBe(first);
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(controller.undo()).toMatchObject({ ok: false, code: "frozen" });
  finish({ ok: false, code: "unconfirmed", error: "回执丢失" }); await first;
  expect(controller.redo()).toMatchObject({ ok: false, code: "frozen" });
  expect(await controller.placeImage({ name: "extra", assetId: "extra", bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, code: "frozen" });
  const retry = controller.save(saveInput());
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  finish(await saveDeps().complete(complete.mock.calls[0]?.[0] as never));
  expect((await retry).ok).toBe(true);
  expect(uploadProject).toHaveBeenCalledOnce(); expect(uploadOutput).toHaveBeenCalledOnce();
});

it("上传中退出后不再调用 complete，迟到结果不改变空工作区", async () => {
  let release!: (value: Awaited<ReturnType<ProjectSaveDeps["uploadProject"]>>) => void;
  const complete = vi.fn(saveDeps().complete);
  const uploadProject = vi.fn(() => new Promise<Awaited<ReturnType<ProjectSaveDeps["uploadProject"]>>>((resolve) => { release = resolve; }));
  const { controller } = makeController({ deps: saveDeps({ complete, uploadProject }) });
  await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  const saving = controller.save(saveInput());
  await vi.waitFor(() => expect(uploadProject).toHaveBeenCalledOnce());
  controller.dispose();
  release(await saveDeps().uploadProject(new Uint8Array([1])));
  expect((await saving).ok).toBe(false);
  expect(complete).not.toHaveBeenCalled(); expect(controller.currentState().phase).toBe("idle");
  expect(controller.snapshot().view.hasDocument).toBe(false);
});

it("活动笔迹不推进快照或净变化，并阻止中途命令与保存；取消后可继续编辑", async () => {
  const { controller } = makeController();
  await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  const baseline = controller.snapshot();
  expect(controller.beginStroke({ points: [[1, 2]] }).ok).toBe(true);
  expect(controller.appendStroke([[3, 4]]).ok).toBe(true);
  expect(controller.snapshot()).toBe(baseline);
  expect(controller.isDirty()).toBe(false);
  expect(controller.dispatch("layer.delete")).toMatchObject({ ok: false, code: "stroke-active" });
  expect(await controller.save(saveInput())).toMatchObject({ ok: false, code: "freeze-failed", retriable: true });
  controller.cancelStroke();
  expect(controller.snapshot()).toBe(baseline);
  expect(controller.dispatch("layer.delete").ok).toBe(true);
  controller.dispose();
});

it("变换预览不推进正式快照，禁止交叉绘画、命令、置入与保存；确认和取消后解除门禁", async () => {
  const { controller } = makeController();
  await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  const baseline = controller.snapshot();
  expect(controller.beginTransform().ok).toBe(true);
  expect(controller.hasTransform()).toBe(true);
  expect(controller.previewTransform([1,0,0,1,20,10]).ok).toBe(true);
  expect(controller.snapshot()).toBe(baseline);
  expect(controller.isDirty()).toBe(false);
  expect(controller.dispatch("layer.delete")).toMatchObject({ ok: false, code: "transform-active" });
  expect(controller.beginStroke({ points: [[1,2]] })).toMatchObject({ ok: false, code: "transform-active" });
  expect(await controller.placeImage({ name: "extra", assetId: "extra", bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, code: "transform-active" });
  expect(await controller.save(saveInput())).toMatchObject({ ok: false, code: "freeze-failed" });
  controller.cancelTransform();
  expect(controller.hasTransform()).toBe(false);
  expect(controller.snapshot()).toBe(baseline);
  expect(controller.beginTransform().ok).toBe(true);
  expect(controller.commitTransform().ok).toBe(true);
  expect(controller.hasTransform()).toBe(false);
  expect(controller.dispatch("layer.delete").ok).toBe(true);
  controller.dispose();
});

it("局部预览跨控制器读取且不发布文档状态，失败保留现场并可重试",async()=>{
  const {controller,handle}=makeController();
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});
  controller.beginTransform();
  const before=controller.snapshot();
  expect(controller.renderRegion({x:20,y:30,width:2,height:1})).toMatchObject({ok:true,value:{width:2,height:1}});
  const read=vi.spyOn(handle,"renderRegion").mockReturnValueOnce({ok:false,code:"render-failed",message:"细节暂时不可用"});
  expect(controller.renderRegion({x:20,y:30,width:2,height:1})).toMatchObject({ok:false});
  expect(controller.snapshot()).toBe(before);
  expect(controller.hasTransform()).toBe(true);expect(controller.isDirty()).toBe(false);
  expect(controller.renderRegion({x:20,y:30,width:2,height:1})).toMatchObject({ok:true});
  read.mockRestore();controller.cancelTransform();controller.dispose();
  expect(controller.renderRegion({x:0,y:0,width:1,height:1})).toMatchObject({ok:false});
});

it("草稿预览失败保留错误，但不把未提交变换误报为净修改", async () => {
  const { controller, handle } = makeController();
  await controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  const revision = controller.currentView().document?.revision;
  controller.beginTransform();
  vi.spyOn(handle, "renderPreview").mockReturnValue({ ok: false, code: "preview-failed", message: "无法生成预览" });
  expect(controller.render(2048)).toMatchObject({ ok: false, code: "preview-failed" });
  expect(controller.currentState()).toMatchObject({ phase: "failed", dirty: false });
  expect(controller.isDirty()).toBe(false);
  expect(controller.currentView().document?.revision).toBe(revision);
  controller.cancelTransform(); controller.dispose();
});

it("移动开始刷新选层但不报净修改，活动移动阻止保存，未命中不建立草稿", async () => {
  const {controller,handle} = makeController();
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});
  const begin = vi.spyOn(handle,"beginMove").mockReturnValue({ok:true,value:true});
  const params = {x:30,y:40,autoSelect:true,duplicate:true};
  expect(controller.beginMove(params)).toEqual({ok:true,value:true});
  expect(begin).toHaveBeenLastCalledWith(params);
  expect(controller.hasTransform()).toBe(true); expect(controller.isDirty()).toBe(false);
  expect(await controller.save(saveInput())).toMatchObject({ok:false,code:"freeze-failed"});
  expect(controller.beginMove(params)).toMatchObject({ok:false,code:"transform-active"});
  controller.cancelTransform(); begin.mockReturnValue({ok:true,value:false});
  expect(controller.beginMove(params)).toEqual({ok:true,value:false});
  expect(controller.hasTransform()).toBe(false);
  controller.dispose();
});

it("调整草稿保持正式快照，阻止保存和交叉写入，失败保留会话", async () => {
  const fake=fakeInstance();
  const handle=new EditorHandle(fake.instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const {controller}=makeController({load:async()=>({ok:true,value:handle})});
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});
  const before=controller.snapshot();
  expect(controller.previewAdjustment({brightness:2})).toMatchObject({ok:false});
  expect(controller.beginAdjustment(1)).toMatchObject({ok:true,value:{layer:1}});
  expect(controller.previewAdjustment({brightness:30})).toMatchObject({ok:true,value:{brightness:30}});
  expect(controller.hasAdjustment()).toBe(true);expect(controller.snapshot()).toBe(before);
  expect(controller.isDirty()).toBe(false);
  expect(controller.dispatch("layer.delete")).toMatchObject({ok:false,code:"adjustment-active"});
  expect(await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"})).toMatchObject({ok:false,code:"adjustment-active"});
  expect(await controller.openImage({name:"x",assetId:"x",bytes:new Uint8Array()})).toMatchObject({ok:false,code:"adjustment-active"});
  expect(await controller.placeImage({name:"x",assetId:"x",bytes:new Uint8Array()})).toMatchObject({ok:false,code:"adjustment-active"});
  expect(controller.beginText({layer:1})).toMatchObject({ok:false});
  expect(controller.beginTransform()).toMatchObject({ok:false});
  expect(controller.beginMove({x:1,y:1,autoSelect:true,duplicate:false})).toMatchObject({ok:false});
  expect(controller.beginStroke({})).toMatchObject({ok:false});
  expect(controller.sampleColor(1,1)).toMatchObject({ok:false});
  expect(await controller.save(saveInput())).toMatchObject({ok:false,code:"freeze-failed"});
  expect(fake.calls).not.toContain("exportBundle");
  vi.spyOn(fake.instance,"commitAdjustment").mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"提交失败"});});
  expect(controller.commitAdjustment()).toMatchObject({ok:false});expect(controller.hasAdjustment()).toBe(true);
  expect(controller.commitAdjustment()).toMatchObject({ok:true});expect(controller.hasAdjustment()).toBe(false);
  controller.beginAdjustment(1);controller.cancelAdjustment();
  expect(controller.hasAdjustment()).toBe(false);expect(fake.calls).toContain("cancelAdjustment");
  controller.beginAdjustment(1);controller.dispose();expect(controller.hasAdjustment()).toBe(false);
  expect(fake.calls.filter(c=>c==="cancelAdjustment")).toHaveLength(2);
});

it("文字草稿只在确认后同步正式状态，活动草稿阻止保存及其他写操作", async () => {
  const fake=fakeInstance();
  const handle=new EditorHandle(fake.instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const {controller}=makeController({load:async()=>({ok:true,value:handle})});
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});
  const before=controller.snapshot();
  expect(controller.textGeometry({start:0,end:0})).toMatchObject({ok:false});
  expect(controller.beginText({x:10,y:20,box:[10,20,40,30]})).toMatchObject({ok:true});
  expect(controller.hasText()).toBe(true);
  expect(controller.previewText({text:"中文草稿",size:24,font:"Inter"})).toMatchObject({ok:true});
  expect(controller.textGeometry({start:0,end:2})).toEqual({ok:true,value:{caret:[[10,10],[10,20]],selection:[],hit:null}});
  expect(controller.snapshot()).toBe(before);expect(controller.isDirty()).toBe(false);
  expect(controller.dispatch("layer.delete")).toMatchObject({ok:false,code:"text-active"});
  expect(await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"})).toMatchObject({ok:false,code:"text-active"});
  expect(controller.beginTransform()).toMatchObject({ok:false});
  expect(controller.beginStroke({})).toMatchObject({ok:false});
  expect(await controller.save(saveInput())).toMatchObject({ok:false,code:"freeze-failed"});
  expect(fake.calls).not.toContain("exportBundle");
  const commit=vi.spyOn(fake.instance,"commitText");
  commit.mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"文字提交失败"});});
  expect(controller.commitText()).toMatchObject({ok:false});expect(controller.hasText()).toBe(true);
  expect(controller.commitText()).toMatchObject({ok:true});expect(controller.hasText()).toBe(false);
  expect(fake.calls.filter(c=>c==="commitText")).toHaveLength(1);
  controller.beginText({layer:1});controller.cancelText();
  expect(controller.hasText()).toBe(false);expect(fake.calls).toContain("cancelText");
  expect(controller.textGeometry({start:0,end:0})).toMatchObject({ok:false});
  expect(controller.previewText({text:"迟到输入"})).toMatchObject({ok:false});
  controller.beginText({layer:1});controller.dispose();expect(controller.hasText()).toBe(false);
  expect(fake.calls.filter(c=>c==="cancelText")).toHaveLength(2);
});
it("图层属性草稿不发布净变化，门禁覆盖保存、其他草稿与普通命令",async()=>{
  const fake=fakeInstance();const handle=new EditorHandle(fake.instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const {controller}=makeController({load:async()=>({ok:true,value:handle})});
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});const before=controller.snapshot();
  expect(controller.stylePositionFrame(0)).toMatchObject({ok:false});
  expect(controller.beginLayerProperties(1)).toMatchObject({ok:true});
  expect(controller.stylePositionFrame(0)).toEqual({ok:true,value:[0,0,200,80]});
  expect(controller.previewLayerProperties({opacity:0.4})).toMatchObject({ok:true});
  expect(controller.snapshot()).toBe(before);expect(controller.isDirty()).toBe(false);
  expect(controller.dispatch("edit.undo")).toMatchObject({ok:false,code:"properties-active"});
  expect(controller.beginAdjustment(1)).toMatchObject({ok:false});expect(controller.beginText({layer:1})).toMatchObject({ok:false});
  expect(controller.beginTransform()).toMatchObject({ok:false});expect(controller.beginStroke({})).toMatchObject({ok:false});
  expect(await controller.openImage({name:"x",assetId:"x",bytes:new Uint8Array()})).toMatchObject({ok:false});
  expect(await controller.placeImage({name:"x",assetId:"x",bytes:new Uint8Array()})).toMatchObject({ok:false});
  expect(controller.sampleColor(1,1)).toMatchObject({ok:false});
  expect(await controller.save(saveInput())).toMatchObject({ok:false,code:"freeze-failed"});expect(fake.calls).not.toContain("exportBundle");
  vi.spyOn(fake.instance,"commitLayerProperties").mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"提交失败"});});
  expect(controller.commitLayerProperties()).toMatchObject({ok:false});expect(controller.hasLayerProperties()).toBe(true);
  expect(controller.commitLayerProperties()).toMatchObject({ok:true});expect(controller.hasLayerProperties()).toBe(false);
  controller.beginLayerProperties(1);controller.cancelLayerProperties();
  expect(controller.stylePositionFrame(0)).toMatchObject({ok:false});
  expect(controller.previewLayerProperties({opacity:0.8})).toMatchObject({ok:false});
  controller.beginLayerProperties(1);controller.dispose();expect(controller.hasLayerProperties()).toBe(false);
  expect(fake.calls.filter(c=>c==="cancelLayerProperties")).toHaveLength(2);
});


it("internal dialog owner rejects active local drafts and disposed controllers", async () => {
  const {controller}=makeController();
  expect(controller.dialogOwner()).toBeNull();
  await controller.openProject({bytes:new Uint8Array([1]),baseAssetId:"asset-base"});
  expect(controller.dialogOwner()).toMatchObject({canvasId:"canvas-1",nodeId:"node-1",sessionId:"session-1"});
  for (const [begin,end] of [
    [()=>controller.beginStroke({points:[[1,2]]}),()=>controller.cancelStroke()],
    [()=>controller.beginTransform(),()=>controller.cancelTransform()],
    [()=>controller.beginText({layer:1}),()=>controller.cancelText()],
    [()=>controller.beginAdjustment(1),()=>controller.cancelAdjustment()],
    [()=>controller.beginLayerProperties(1),()=>controller.cancelLayerProperties()]
  ]) {
    begin!();expect(controller.dialogOwner()).toBeNull();
    end!();expect(controller.dialogOwner()).not.toBeNull();
  }
  controller.dispose();expect(controller.dialogOwner()).toBeNull();
});

it("初始化分任务调度，退出后不再执行后续内核工作", async () => {
  const pauses: Array<() => void> = [];
  const { controller, handle } = makeController({ yieldTask: () => new Promise(resolve => pauses.push(resolve)) });
  const open = vi.spyOn(handle, "openProject");
  const state = vi.spyOn(handle, "state");
  const commands = vi.spyOn(handle, "commands");
  const pending = controller.openProject({ bytes: new Uint8Array([1]), baseAssetId: "asset-base" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(open).not.toHaveBeenCalled();
  pauses.shift()!(); await Promise.resolve(); await Promise.resolve();
  expect(open).toHaveBeenCalledOnce(); expect(state).not.toHaveBeenCalled();
  pauses.shift()!(); await Promise.resolve(); await Promise.resolve();
  expect(state).toHaveBeenCalledOnce(); expect(commands).not.toHaveBeenCalled();
  controller.dispose();
  pauses.shift()!();
  expect((await pending).ok).toBe(false);
  expect(commands).not.toHaveBeenCalled();
  expect(controller.currentState().phase).toBe("idle");
});
