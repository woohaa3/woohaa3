/**
 * 图像模式的工作区门禁（真实控制器回归）
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
 *
 * 这里的重点是「来源失效不误写目标」：计划携带的修订与内容指纹相同，但文档已经被换掉
 * （重新打开/替换内容）时，代际必须把它判成过期；保存阶段与草稿也要真的挡住写入。
 * 像素级转换在 Rust 域测试，面板接线在 `features/modes/panels.test.tsx`。
 */
import { expect, it } from "vitest";
import { EditorHandle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { DevDocumentSession } from "../../../dev/src/dev-session.js";

const HASH = "aabbccddeeff0011";

function stateJson(revision: number): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 8, height: 6, mode: "Rgb", depth: 8, activeLayer: 1, selectedLayers: [1],
      hasSelection: false, canUndo: false, canRedo: false, revision, history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
}

/** 一次转换计划的响应（与内核 `plan_mode`/`apply_mode` 的 JSON 同形）。 */
function planJson(revision: number, hash: string, missingInks = false): string {
  return JSON.stringify({
    report: {
      target: "grayscale", label: "灰度", fromMode: "rgb", toMode: "grayscale", depth: 8,
      layersBefore: 1, layersAfter: 1, flattened: false, dropped: {}, lossy: false,
      colorCount: null, colors: null, transparentIndex: null, inks: null, notes: [], changed: true
    },
    preview: { width: 1, height: 1, pixelsBase64: "AAAAAA==" },
    baseRevision: revision,
    baseContentHash: hash,
    changed: true,
    ...(missingInks ? {} : {})
  });
}

function fakeHandle() {
  let revision = 1;
  let hash = HASH;
  const calls: string[] = [];
  const edit = () => { revision += 1; };
  const instance = {
    openImage: () => { revision = 1; hash = HASH; return stateJson(revision); },
    openProject: () => { revision = 1; hash = HASH; return stateJson(revision); },
    stateJson: () => stateJson(revision),
    commandsJson: () => JSON.stringify([]),
    allowedCommandIdsJson: () => JSON.stringify([]),
    contentHash: () => hash,
    assetIdsJson: () => "[]",
    closeDocument: () => stateJson(revision),
    exportBundle: () => ({
      revision, documentContentHash: hash, canvasWidth: 8, canvasHeight: 6,
      project: new TextEncoder().encode("PROJECT"), output: new TextEncoder().encode("OUTPUT")
    }),
    execute: () => { edit(); return "null"; },
    beginFilter: () => JSON.stringify({ filter: "filter.blur.gaussianBlur" }),
    updateFilter: () => JSON.stringify({ active: true }),
    commitFilter: () => "{}",
    cancelFilter: () => JSON.stringify({ cancelled: true }),
    modeInfo: () => JSON.stringify({
      mode: "rgb", rawMode: "Rgb", depth: 8, colorTable: null, duotone: null, layers: 1,
      targets: [
        { id: "rgb", label: "RGB", available: true, reason: null },
        { id: "grayscale", label: "灰度", available: true, reason: null },
        { id: "bitmap", label: "位图", available: true, reason: null },
        { id: "indexed", label: "索引色", available: true, reason: null },
        { id: "duotone", label: "双色调", available: true, reason: null }
      ],
      revision, contentHash: hash, readOnly: false,
      trap: { available: false, requires: "cmyk", reason: "陷印需要 CMYK 文档" }
    }),
    planMode: (target: string) => { calls.push(`planMode:${target}`); return planJson(revision, hash); },
    applyMode: (target: string) => {
      calls.push(`applyMode:${target}`);
      edit();
      hash = `${HASH}-${revision}`;
      return planJson(revision - 1, `${HASH}-${revision - 1}`);
    },
    planColorTable: () => planJson(revision, hash),
    applyColorTable: () => { calls.push("applyColorTable"); edit(); hash = `${HASH}-${revision}`; return planJson(revision - 1, `${HASH}-${revision - 1}`); },
    renderPreview: () => { throw new Error("render not stubbed"); },
    renderRegion: () => { throw new Error("render not stubbed"); }
  } as unknown as EditorInstance;
  return {
    handle: new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1 }),
    calls,
    edit,
    /** 模拟权威内容替换（宿主侧代际递增之外的另一种文档变化）。 */
    replace: () => { revision = 1; hash = `${HASH}-replaced`; }
  };
}

function build() {
  const session = new DevDocumentSession();
  const editor = fakeHandle();
  const controller = new EditorWorkspaceController({
    session,
    documentId: "doc-1",
    dialogOwner: () => ({ canvasId: "dev", sessionId: "dev" }),
    load: async () => ({ ok: true, value: editor.handle }),
    digest: async () => "0".repeat(64),
    yieldTask: async () => undefined,
    save: async () => ({ ok: true })
  });
  return { controller, session, editor };
}

async function opened(controller: EditorWorkspaceController) {
  const result = await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
  expect(result.ok).toBe(true);
}

it("applies a plan made on the current document", async () => {
  const { controller, editor } = build();
  await opened(controller);
  const plan = controller.features.modes.planMode("grayscale", {});
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  const applied = controller.features.modes.applyMode("grayscale", plan.value, {});
  expect(applied.ok).toBe(true);
  expect(editor.calls).toContain("applyMode:grayscale");
});

it("rejects a plan that arrives after the document was reopened", async () => {
  // 关闭/重开同一份内容：修订回到 1，内容指纹也相同——只有代际能说明计划已过期。
  const { controller, editor } = build();
  await opened(controller);
  const plan = controller.features.modes.planMode("grayscale", {});
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;

  await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });

  expect(controller.features.modes.applyMode("grayscale", plan.value, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  // 过期计划不得落到内核上（否则会把上一份文档的转换写到新文档）。
  expect(editor.calls.filter((call) => call === "applyMode:grayscale")).toHaveLength(0);
  expect(controller.currentView().document?.mode).toBe("Rgb");
});

it("rejects a plan from a document with the same revision but different content", async () => {
  const { controller, editor } = build();
  await opened(controller);
  const plan = controller.features.modes.planMode("grayscale", {});
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  // 修订不变、内容变了（权威替换但未重建控制器）。
  editor.replace();
  expect(controller.features.modes.applyMode("grayscale", plan.value, {})).toEqual({
    ok: false, code: "stale", message: "文档已变化，请重新预览后再确认"
  });
  expect(editor.calls).not.toContain("applyMode:grayscale");
});

it("refuses conversions while the document is being frozen for saving", async () => {
  const { controller, editor } = build();
  await opened(controller);
  // 冻结后保留成对产物（保存上传中/待确认的窗口）。
  const frozen = await controller.freezeForPublish();
  expect(frozen.ok).toBe(true);

  const blocked = { ok: false, code: "frozen", message: "正在保存，请等待保存完成后再修改图像模式" };
  expect(controller.features.modes.planMode("grayscale", {})).toEqual(blocked);
  expect(controller.features.modes.planColorTable({})).toEqual(blocked);
  expect(editor.calls.filter((call) => call.startsWith("planMode"))).toHaveLength(0);
});

it("refuses conversions while another draft is open", async () => {
  const { controller, editor } = build();
  await opened(controller);
  expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 }).ok).toBe(true);
  expect(controller.features.modes.planMode("grayscale", {})).toEqual({
    ok: false, code: "filter-active", message: "请先确认或取消滤镜草稿"
  });
  expect(editor.calls.filter((call) => call.startsWith("planMode"))).toHaveLength(0);
  expect(controller.isSaving()).toBe(false);
  controller.cancelFilter();
  expect(controller.features.modes.planMode("grayscale", {}).ok).toBe(true);
});

it("refuses to save while a draft is open and reports the draft reason", async () => {
  const { controller } = build();
  await opened(controller);
  expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 }).ok).toBe(true);
  const outcome = await controller.save();
  expect(outcome).toMatchObject({ ok: false, code: "freeze-failed", message: "请先确认或取消滤镜草稿", retriable: true });
  controller.cancelFilter();
});

it("treats an unsettled frozen artifact as saving, not as a free window", async () => {
  const { controller, editor } = build();
  await opened(controller);
  expect(controller.hasActiveDraft()).toBe(false);
  expect(controller.isSaving()).toBe(false);
  const frozen = await controller.freezeForPublish();
  expect(frozen.ok).toBe(true);
  // 冻结产物未结算：此时既不是「没有草稿，可以随便写」，也不是可切换状态。
  expect(controller.isSaving()).toBe(true);
  expect(controller.features.modes.planMode("grayscale", {})).toEqual({
    ok: false, code: "frozen", message: "正在保存，请等待保存完成后再修改图像模式"
  });
  expect(editor.calls.filter((call) => call.startsWith("planMode"))).toHaveLength(0);

  // 保存复用同一冻结产物并结算；之后才允许新的转换。
  expect(await controller.save()).toMatchObject({ ok: true });
  expect(controller.isSaving()).toBe(false);
  expect(controller.features.modes.planMode("grayscale", {}).ok).toBe(true);
});
