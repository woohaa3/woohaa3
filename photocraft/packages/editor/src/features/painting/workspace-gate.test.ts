/**
 * 绘画域命令经过**真实共享工作区控制器**时的门禁回归
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，任务 3.3 / 3.1）。
 *
 * 为什么不用手写 `WorkspaceFeatureContext` 替身：`workflow-state.test.ts` 验证的是本域
 * 自己的分支，替身会把「共享门禁是否真的在域命令上生效」这件事验证成假命题。这里装配真实
 * `EditorWorkspaceController`（内核用替身实例，只记录调用），由控制器自己提供
 * `blockingDraft`/`afterWrite`/`unavailable`，因此能证明：
 *
 * 1. 草稿进行中像素命令被共享门禁拒绝，且**没有**到达内核（不写半个像素）；
 * 2. 偏好命令不受草稿门限制（改工具选项不该被未结算笔迹挡住），也不推进 dirty；
 * 3. 控制器释放后（代际失效）域命令返回 `no-document`，不会写回已释放的文档；
 * 4. 内核拒绝时错误原样冒泡且不推进修订。
 */
import { describe, expect, it } from "vitest";
import { EditorHandle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../../editor-workspace.js";
import { DevDocumentSession } from "../../../../../dev/src/dev-session.js";

const HASH = "00112233445566aa";

function stateJson(revision: number): string {
  return JSON.stringify({
    session: { active: 0, documents: [{ index: 0, name: "art" }] },
    document: {
      name: "art", width: 16, height: 12, mode: "Rgb", depth: 8,
      activeLayer: 1, selectedLayers: [1], hasSelection: false,
      canUndo: revision > 1, canRedo: false, revision,
      history: ["打开"], redoHistory: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
}

/** 内核替身：只记录调用，`execute` 成功即推进一次修订。 */
function fakeEditor(options: { rejectPainting?: string } = {}) {
  let revision = 1;
  const calls: string[] = [];
  const write = () => { revision += 1; };
  const instance = {
    openImage: () => stateJson(revision),
    stateJson: () => stateJson(revision),
    commandsJson: () => "[]",
    allowedCommandIdsJson: () => "[]",
    contentHash: () => HASH,
    assetIdsJson: () => "[]",
    closeDocument: () => stateJson(revision),
    renderPreview: () => { throw new Error("render not stubbed"); },
    renderRegion: () => { throw new Error("render not stubbed"); },
    // 冻结导出：`save()` 需要成对产物；内容字节无关紧要，摘要替身也不校验。
    exportBundle: () => ({
      revision,
      documentContentHash: HASH,
      canvasWidth: 16,
      canvasHeight: 12,
      project: new Uint8Array([1, 2, 3]),
      output: new Uint8Array([4, 5, 6]),
      free: () => undefined,
    }),
    // 本域入口：只有 `paint.*` 像素命令会写文档（工具/色板等偏好命令按内核语义不推进修订）；
    // `rejectPainting` 模拟内核拒绝。
    paintingCommand: (id: string) => {
      calls.push(`painting:${id}`);
      if (options.rejectPainting === id) throw JSON.stringify({ code: "capability-disabled", message: `${id} 未开放` });
      if (id.startsWith("paint.")) write();
      return JSON.stringify({ ok: true });
    },
    // 滤镜草稿用来制造「草稿进行中」的共享门禁现场。
    beginFilter: () => { calls.push("filter:begin"); return JSON.stringify({ filter: "filter.blur.gaussianBlur" }); },
    updateFilter: () => JSON.stringify({ active: true }),
    commitFilter: () => { write(); return JSON.stringify({ filter: "filter.blur.gaussianBlur" }); },
    cancelFilter: () => JSON.stringify({ cancelled: true }),
  } as unknown as EditorInstance;
  return {
    handle: new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1 }),
    calls,
    revision: () => revision,
  };
}

function build(options: { rejectPainting?: string; saveGate?: () => void } = {}) {
  const editor = fakeEditor(options);
  const controller = new EditorWorkspaceController({
    session: new DevDocumentSession(),
    dialogOwner: () => ({ canvasId: "dev", sessionId: "dev" }),
    load: async () => ({ ok: true, value: editor.handle }),
    digest: async () => "0".repeat(64),
    yieldTask: async () => undefined,
    save: async () => {
      // 让 `save()` 停在 `saving` 阶段，供冻结门断言。
      if (options.saveGate) await new Promise<void>((resolve) => { (globalThis as { __releaseSave?: () => void }).__releaseSave = resolve; });
      return { ok: true };
    },
  });
  return { controller, editor };
}

async function opened(controller: EditorWorkspaceController) {
  const result = await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
  expect(result.ok).toBe(true);
}

describe("绘画命令的共享门禁（任务 3.3）", () => {
  it("像素命令写文档、推进修订并同步视图", async () => {
    const { controller, editor } = build();
    await opened(controller);
    const before = editor.revision();

    const result = controller.features.painting.paintCommand("paint.bucket", { x: 1, y: 1 });

    expect(result.ok).toBe(true);
    expect(editor.calls).toContain("painting:paint.bucket");
    expect(editor.revision()).toBe(before + 1);
    // afterWrite 已经把新修订同步到视图：不是只写了内核却没更新界面。
    expect(controller.currentView().document?.revision).toBe(before + 1);
  });

  it("草稿进行中像素命令被拒绝，且根本没有到达内核", async () => {
    const { controller, editor } = build();
    await opened(controller);

    // 用共享控制器的真实滤镜草稿制造门禁现场。
    expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 }).ok).toBe(true);
    expect(controller.hasFilter()).toBe(true);
    const revision = editor.revision();
    const callsBefore = editor.calls.length;

    const result = controller.features.painting.paintCommand("paint.gradient", {
      from: [0, 0], to: [9, 0], stops: [[0, "#000000"], [1, "#ffffff"]],
    });

    expect(result).toMatchObject({ ok: false, code: "filter-active" });
    // 关键断言：门禁在内核**之前**，没有半个像素落地，也没有花掉一次历史。
    expect(editor.calls.length).toBe(callsBefore);
    expect(editor.revision()).toBe(revision);

    controller.cancelFilter();
    expect(controller.features.painting.paintCommand("paint.bucket", { x: 1, y: 1 }).ok).toBe(true);
  });

  it("偏好命令不受草稿门限制，也不产生 dirty", async () => {
    const { controller, editor } = build();
    await opened(controller);
    expect(controller.beginFilter("filter.blur.gaussianBlur", { radius: 2 }).ok).toBe(true);

    const revision = editor.revision();
    // 改工具选项不该被未结算的滤镜草稿挡住。
    const result = controller.features.painting.preferenceCommand("tool.select", { tool: "brush" });

    expect(result.ok).toBe(true);
    expect(editor.revision()).toBe(revision);
    // 偏好命令仍然真的到了内核（不是被静默丢弃）。
    expect(editor.calls).toContain("painting:tool.select");
    controller.cancelFilter();
  });

  it("控制器释放后域命令返回 no-document，不写回已释放的文档", async () => {
    const { controller, editor } = build();
    await opened(controller);
    const revision = editor.revision();
    const callsBefore = editor.calls.length;
    controller.dispose();

    expect(controller.features.painting.paintCommand("paint.bucket", { x: 1, y: 1 }))
      .toMatchObject({ ok: false, code: "no-document" });
    expect(controller.features.painting.preferenceCommand("tool.select", { tool: "brush" }))
      .toMatchObject({ ok: false, code: "no-document" });
    expect(controller.features.painting.sampleColorOptions({ x: 1, y: 1 }))
      .toMatchObject({ ok: false, code: "no-document" });
    expect(controller.features.painting.symmetryState()).toMatchObject({ ok: false, code: "no-document" });
    expect(editor.calls.length).toBe(callsBefore);
    expect(editor.revision()).toBe(revision);
  });

  it("导出/保存期间像素命令被冻结门拒绝，与共享 dispatch() 同一道门", async () => {
    const { controller, editor } = build({ saveGate: () => undefined });
    await opened(controller);
    const revision = editor.revision();
    const callsBefore = editor.calls.length;

    const saving = controller.save();
    // 让 `performSave` 走到 await save(…)：phase 已是 `saving`，`pendingArtifacts` 已就位。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.currentState().phase).toBe("saving");

    const painted = controller.features.painting.paintCommand("paint.bucket", { x: 1, y: 1 });
    expect(painted).toMatchObject({ ok: false, code: "frozen" });
    // 关键断言：冻结门在内核之前，导出期间没有任何像素落地、也没有花掉一次历史。
    expect(editor.calls.length).toBe(callsBefore);
    expect(editor.revision()).toBe(revision);

    // 共享 `dispatch()` 对同一阶段给出同样的失败，证明两条路径说的是同一件事。
    expect(controller.dispatch("layer.setProps", { layer: 1, opacity: 0.5 })).toMatchObject({ ok: false, code: "frozen" });

    (globalThis as { __releaseSave?: () => void }).__releaseSave?.();
    expect((await saving).ok).toBe(true);
    // 保存完成、冻结产物已释放后，像素命令恢复可写。
    expect(controller.features.painting.paintCommand("paint.bucket", { x: 1, y: 1 })).toMatchObject({ ok: true });
    expect(editor.revision()).toBe(revision + 1);
  });

  it("文档代际在 dispose 后递增，异步结果可据此丢弃", async () => {
    const { controller } = build();
    await opened(controller);
    const before = controller.documentGeneration();
    controller.dispose();
    expect(controller.documentGeneration()).toBeGreaterThan(before);
  });

  it("内核拒绝原样冒泡，且不推进修订", async () => {
    const { controller, editor } = build({ rejectPainting: "paint.colorReplacement" });
    await opened(controller);
    const revision = editor.revision();

    const result = controller.features.painting.paintCommand("paint.colorReplacement", { x: 2, y: 2 });

    expect(result).toMatchObject({ ok: false, code: "capability-disabled" });
    expect(editor.revision()).toBe(revision);
    expect(controller.currentView().document?.revision).toBe(revision);
  });

  it("两条通道互不接受对方的命令 id，且都不触达内核", async () => {
    const { controller, editor } = build();
    await opened(controller);
    const callsBefore = editor.calls.length;

    expect(controller.features.painting.paintCommand("swatches.list", {})).toMatchObject({ ok: false, code: "unsupported-command" });
    expect(controller.features.painting.preferenceCommand("paint.gradient", {})).toMatchObject({ ok: false, code: "unsupported-command" });

    // 归属判断在内核之前：错通道的 id 不会变成一次静默成功。
    expect(editor.calls.length).toBe(callsBefore);
  });

  it("没有句柄时所有入口统一返回 unavailable", () => {
    const { controller, editor } = build();
    // 未调用 openImage：句柄还没加载。
    expect(controller.features.painting.paintCommand("paint.bucket", { x: 0, y: 0 })).toMatchObject({ ok: false, code: "no-document" });
    expect(controller.features.painting.preferenceCommand("tool.select", { tool: "brush" })).toMatchObject({ ok: false, code: "no-document" });
    expect(editor.calls).toHaveLength(0);
  });
});
