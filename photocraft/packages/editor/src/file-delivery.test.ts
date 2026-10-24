/**
 * 独立文件交付回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.3 / design D5）。
 *
 * 用替身内核句柄覆盖：同一修订冻结、四种交付结果（可信写入/仅下载/取消/失败）与基线推进规则，
 * 以及不依赖 nodeId 的弹窗 owner。不加载 wasm、不采集渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorHandle, type EditorExportBundle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { DevDocumentSession } from "../../../dev/src/dev-session.js";
import { DEFAULT_EXPORT_OPTIONS } from "../src/ports.js";

const PROJECT = new Uint8Array([1, 2, 3]);
const OUTPUT = new Uint8Array([4, 5, 6, 7]);
const OPEN_HASH = "aabbccddeeff0011";
const EDITED_HASH = "1122334455667788";

/** 固定摘要：与字节一一对应，便于重试用例复用同一 attempt。 */
function digest(bytes: Uint8Array): Promise<string> {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return Promise.resolve(hex.padEnd(64, "0").slice(0, 64));
}

function stateJson(revision: number): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 4, height: 3, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
      hasSelection: false, canUndo: true, canRedo: false, revision, history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
}

/** 替身内核：只实现控制器用到的调用；`edit()` 模拟一次内容修改。 */
function fakeHandle() {
  let revision = 1;
  let hash = OPEN_HASH;
  const edit = () => {
    revision += 1;
    hash = EDITED_HASH;
  };
  const bundle = (): EditorExportBundle => ({
    revision, documentContentHash: hash, canvasWidth: 4, canvasHeight: 3, project: PROJECT, output: OUTPUT
  });
  const instance = {
    openImage: () => stateJson(revision),
    openProject: () => stateJson(revision),
    placeImage: () => stateJson(revision),
    execute: () => { edit(); return "null"; },
    stateJson: () => stateJson(revision),
    commandsJson: () => JSON.stringify([{
      id: "layer.delete", label: "删除图层", menu: ["Layer"], shortcut: null, params: "",
      enabled: true, disabledReason: null, needsDocument: true, allowed: true
    }]),
    allowedCommandIdsJson: () => JSON.stringify(["layer.delete"]),
    contentHash: () => hash,
    assetIdsJson: () => "[]",
    exportBundle: bundle,
    closeDocument: () => stateJson(revision),
    beginText: () => JSON.stringify({ ok: true, value: { layer: 1, new: true, text: "" } }),
    previewText: () => JSON.stringify({ ok: true, value: { layer: 1, new: true, text: "a" } }),
    textGeometry: () => JSON.stringify({ ok: true, value: { caret: [[0, 0], [0, 10]], selection: [], hit: 1, next: 0 } }),
    checkpointText:()=>{edit();return JSON.stringify({layer:1,new:false,text:"a"});},
    commitText: () => { edit(); return "null"; },
    cancelText: () => undefined,
    renderPreview: () => { throw new Error("render not stubbed"); },
    renderRegion: () => { throw new Error("render not stubbed"); }
  } as unknown as EditorInstance;
  return {
    handle: new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1 }),
    edit
  };
}

type Delivery = (file: { fileName: string; contentType: string; bytes: Uint8Array }) => Promise<unknown>;

type BuildOptions = {
  delivery?: Delivery | null;
  save?: (request: unknown) => Promise<unknown>;
};

function build(options: BuildOptions = {}) {
  const session = new DevDocumentSession();
  const delivered: Array<{ fileName: string; contentType: string; bytes: Uint8Array }> = [];
  const editor = fakeHandle();
  const delivery = options.delivery === null
    ? undefined
    : options.delivery ?? (async (file) => {
        delivered.push(file);
        return { ok: true, status: "written" };
      });
  const controller = new EditorWorkspaceController({
    session,
    dialogOwner: () => ({ canvasId: "canvas-1", documentId: "doc-1", sessionId: "session-1" }),
    load: async () => ({ ok: true, value: editor.handle }),
    digest,
    yieldTask: async () => undefined,
    // 独立文件不走上行端口。
    save: (options.save as never) ?? (async () => ({ ok: false, code: "complete-failed", message: "不应调用节点上传", retriable: false })),
    ...(delivery ? { fileDelivery: delivery as never } : {})
  });
  return { controller, session, delivered, editor };
}

/** 打开文档并制造一次净变化（打开本身不是修改）。 */
async function openDirty(controller: EditorWorkspaceController, editor: ReturnType<typeof fakeHandle>): Promise<void> {
  await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([9]) });
  editor.edit();
  expect(controller.dispatch("layer.delete").ok).toBe(true);
}

describe("独立文件交付", () => {
  it("可信写入工程推进本地基线，单独导出 PNG 不算保存", async () => {
    const { controller, session, delivered, editor } = build();
    await openDirty(controller, editor);
    expect(session.status().dirty).toBe(true);

    await expect(controller.deliverFile("png", { fileName: "art.png" })).resolves.toEqual({ ok: true, status: "written" });
    expect(delivered[0]).toMatchObject({ fileName: "art.png", contentType: "image/png" });
    expect(delivered[0]!.bytes).toEqual(OUTPUT);
    // 导出 PNG 不等于工程已保存。
    expect(session.status().dirty).toBe(true);

    await expect(controller.deliverFile("project", { fileName: "art.pcraft" })).resolves.toEqual({ ok: true, status: "written" });
    expect(delivered[1]).toMatchObject({ fileName: "art.pcraft" });
    expect(delivered[1]!.bytes).toEqual(PROJECT);
    expect(session.status().dirty).toBe(false);
    controller.dispose();
  });

  it("仅发起下载不清除未保存状态", async () => {
    const { controller, session, editor } = build({ delivery: async () => ({ ok: true, status: "download-started" }) });
    await openDirty(controller, editor);
    await expect(controller.deliverFile("project")).resolves.toEqual({ ok: true, status: "download-started" });
    expect(session.status().dirty).toBe(true);
    controller.dispose();
  });

  it.each([
    { label: "取消", result: { ok: false, status: "cancelled" } },
    { label: "失败", result: { ok: false, status: "failed", message: "磁盘不可写" } }
  ])("$label 保留文档与未保存状态，且可重试", async ({ result }) => {
    const delivery = vi.fn(async () => result);
    const { controller, session, editor } = build({ delivery });
    await openDirty(controller, editor);
    const outcome = await controller.deliverFile("project");
    expect(outcome.ok).toBe(false);
    expect(session.status().dirty).toBe(true);
    expect(controller.snapshot().state.phase).toBe("editing");
    await expect(controller.deliverFile("project")).resolves.toMatchObject({ ok: false });
    expect(delivery).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("未配置文件端口时明确失败，不伪装成功", async () => {
    const { controller, editor } = build({ delivery: null });
    await openDirty(controller, editor);
    expect(controller.canDeliverFiles()).toBe(false);
    await expect(controller.deliverFile("project")).resolves.toMatchObject({
      ok: false,
      status: "failed",
      message: "当前宿主不支持本地文件保存"
    });
    controller.dispose();
  });

  it("未确认的草稿活动时拒绝导出，现场保留", async () => {
    const { controller, editor } = build();
    await openDirty(controller, editor);
    expect(controller.beginText({ x: 0, y: 0 }).ok).toBe(true);
    await expect(controller.deliverFile("png")).resolves.toMatchObject({ ok: false, message: "请先确认或取消文字编辑" });
    controller.cancelText();
    await expect(controller.deliverFile("png")).resolves.toMatchObject({ ok: true });
    controller.dispose();
  });
});

describe("文档级 owner", () => {
  it("文件文档的 owner 使用 documentId 且不依赖 nodeId", async () => {
    const { controller, editor } = build();
    await openDirty(controller, editor);
    const owner = controller.dialogOwner();
    expect(owner).toMatchObject({ canvasId: "canvas-1", documentId: "doc-1", sessionId: "session-1" });
    expect(owner?.nodeId).toBeUndefined();
    controller.dispose();
  });

  it("释放后不再提供 owner", async () => {
    const { controller, editor } = build();
    await openDirty(controller, editor);
    controller.dispose();
    expect(controller.dialogOwner()).toBeNull();
  });
});


it("文字检查点经文件保存写入，冻结期间拒绝改动且保留继续输入会话",async()=>{
 let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
 const {controller,editor}=build({delivery:async()=>{await gate;return {ok:true,status:"written"};}});
 try {await openDirty(controller,editor);controller.beginText({layer:1});controller.previewText({text:"a"});expect(controller.checkpointText().ok).toBe(true);
 const delivery=controller.deliverFile("project");expect(controller.previewText({text:"late"}).ok).toBe(false);expect(controller.commitText().ok).toBe(false);
 finish();expect(await delivery).toMatchObject({ok:true,status:"written"});expect(controller.hasText()).toBe(true);expect(controller.isDirty()).toBe(false);expect(controller.previewText({text:"next"}).ok).toBe(true);
 }finally{finish();controller.dispose();}
});

describe("按格式导出（I045）", () => {
  it("字节走同一交付端口，文件名与 MIME 跟随所选格式，且不推进工程基线", async () => {
    const delivered: Array<{ fileName: string; contentType: string; bytes: Uint8Array }> = [];
    const { controller, session, editor } = build({
      delivery: async (file) => { delivered.push(file); return { ok: true, status: "download-started" }; }
    });
    await openDirty(controller, editor);
    expect(session.status().dirty).toBe(true);

    // 替身内核按请求返回不同字节，便于核对格式映射。
    (editor.handle as unknown as { exportImage: (options: { format: string }) => unknown }).exportImage = (options: { format: string }) => ({
      ok: true as const,
      value: { revision: 2, documentContentHash: EDITED_HASH, canvasWidth: 4, canvasHeight: 3, project: new Uint8Array(), output: new TextEncoder().encode(options.format) }
    });

    await expect(controller.exportImage({ ...DEFAULT_EXPORT_OPTIONS, format: "jpeg" })).resolves.toEqual({ ok: true, status: "download-started" });
    expect(delivered[0]).toMatchObject({ fileName: "art.jpg", contentType: "image/jpeg" });
    expect(new TextDecoder().decode(delivered[0]!.bytes)).toBe("jpeg");
    // 下载只代表交给浏览器，工程仍未保存。
    expect(session.status().dirty).toBe(true);

    await controller.exportImage({ ...DEFAULT_EXPORT_OPTIONS, format: "webp" });
    expect(delivered[1]).toMatchObject({ fileName: "art.webp", contentType: "image/webp" });
    expect(controller.snapshot().state.phase).toBe("editing");
    controller.dispose();
  });

  it("没有文件端口、内核失败或存在未结算草稿时拒绝导出", async () => {
    const missing = build({ delivery: null });
    (missing.editor.handle as unknown as { exportImage?: unknown }).exportImage = () => ({ ok: true, value: {} });
    await expect(missing.controller.exportImage(DEFAULT_EXPORT_OPTIONS)).resolves.toMatchObject({ ok: false, status: "failed" });
    missing.controller.dispose();

    const failing = build();
    await openDirty(failing.controller, failing.editor);
    (failing.editor.handle as unknown as { exportImage: () => unknown }).exportImage = () => ({ ok: false, code: "save-failed", message: "编码失败" });
    await expect(failing.controller.exportImage(DEFAULT_EXPORT_OPTIONS)).resolves.toMatchObject({ ok: false, status: "failed", message: "编码失败" });
    failing.controller.dispose();

    // 文字草稿未检查点时不允许导出，避免导出旧内容。
    const drafts = build();
    await openDirty(drafts.controller, drafts.editor);
    (drafts.editor.handle as unknown as { exportImage: () => unknown }).exportImage = () => ({ ok: true, value: { revision: 2, documentContentHash: EDITED_HASH, canvasWidth: 4, canvasHeight: 3, project: new Uint8Array(), output: OUTPUT } });
    drafts.controller.beginText({ layer: 1 });
    await expect(drafts.controller.exportImage(DEFAULT_EXPORT_OPTIONS)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("文字") });
    drafts.controller.dispose();
  });
});
