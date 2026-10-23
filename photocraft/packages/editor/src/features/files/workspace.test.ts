/**
 * 本域工作区会话回归（change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 这里用最小内核替身验证**语义边界**，不重复内核测试：
 * - 缺句柄/缺文档/草稿未结算时必须在调用内核之前拒绝，并保留稳定 code；
 * - 内核返回结构不对时转成 `invalid-message`，不把坏数据交给面板；
 * - 真正写入后只推进一次会话基线（恢复把净变化清零）。
 */
import { describe, expect, it, vi } from "vitest";

/**
 * 候选内核实例的替身（`createDocumentBytes` 用独立实例产出字节）。
 *
 * 只替身 `loadEditor` 这一个导出；其余 `editor-wasm` 行为在用例里直接用类型断言构造。
 */
const loadEditorStub = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({
  ok: false as const,
  code: "editor-load-failed",
  message: "用例未预设候选实例"
})));
vi.mock("../../editor-wasm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../editor-wasm.js")>();
  return { ...actual, loadEditor: loadEditorStub };
});

import type { EditorHandle, EditorFailure, EditorResult } from "../../editor-wasm.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import { createSession } from "./workspace.js";

const SPEC = {
  width: 640,
  height: 480,
  resolution: 72,
  mode: "rgb",
  depth: 8,
  background: "white",
  name: "未命名"
} as const;

const VIEW_WITH_DOCUMENT: EditorViewModel = {
  hasDocument: true,
  document: null,
  sessionActiveIndex: null
};

type FakeFiles = {
  createDocument: ReturnType<typeof vi.fn>;
  createDocumentFromImage: ReturnType<typeof vi.fn>;
  duplicateDocumentBytes: ReturnType<typeof vi.fn>;
  restoreSavedBaseline: ReturnType<typeof vi.fn>;
  fileInfo: ReturnType<typeof vi.fn>;
  documentPresets: ReturnType<typeof vi.fn>;
  recentDocuments: ReturnType<typeof vi.fn>;
  recordRecentDocument: ReturnType<typeof vi.fn>;
};

function fakeFiles(): FakeFiles {
  return {
    createDocument: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { width: 640, height: 480, resolution: 72 } })),
    createDocumentFromImage: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { name: "剪贴板", width: 8, height: 8 } })),
    duplicateDocumentBytes: vi.fn((): EditorResult<Uint8Array> => ({ ok: true, value: new Uint8Array([1, 2, 3]) })),
    restoreSavedBaseline: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { restored: true, width: 8, height: 8, layers: 1, revision: 2 } })),
    fileInfo: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { title: "封面" } })),
    documentPresets: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { presets: [] } })),
    recentDocuments: vi.fn((): EditorResult<unknown> => ({ ok: true, value: { recent: [] } })),
    recordRecentDocument: vi.fn((): EditorResult<unknown> => ({ ok: true, value: {} }))
  };
}

const FAILURE: EditorFailure = { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };

function setup(options: { handle?: boolean; document?: boolean; blocked?: EditorFailure | null; phase?: string; pendingArtifacts?: boolean } = {}) {
  const files = fakeFiles();
  const afterWrite = vi.fn((_establishBaseline?: boolean): EditorResult<EditorViewModel> => ({
    ok: true,
    value: { hasDocument: true, document: null, sessionActiveIndex: 0 }
  }));
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    phase: options.phase ?? "editing",
    pendingArtifacts: options.pendingArtifacts ?? false,
    handle: options.handle === false ? null : ({ features: { files } } as unknown as EditorHandle),
    view: options.document === false ? { hasDocument: false, document: null, sessionActiveIndex: null } : VIEW_WITH_DOCUMENT,
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => options.blocked != null,
    blockingDraft: () => options.blocked ?? null,
    unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未就绪" }),
    fail: <T,>(failure: EditorFailure) => failure as EditorResult<T>,
    afterWrite: (establishBaseline?: boolean) => afterWrite(establishBaseline)
  };
  return { session: createSession(() => context), context, files, afterWrite };
}

describe("U01/U02 新建与复制在调用内核前先过门禁", () => {
  it("没有内核句柄时统一 unavailable，不调用任何内核方法", () => {
    const { session, files } = setup({ handle: false });
    expect(session.createDocument(SPEC as never)).toMatchObject({ ok: false, code: "no-document" });
    expect(session.duplicateDocument("副本")).toMatchObject({ ok: false, code: "no-document" });
    expect(session.recentDocuments()).toMatchObject({ ok: false, code: "no-document" });
    for (const method of Object.values(files)) expect(method).not.toHaveBeenCalled();
  });

  it("草稿未结算时拒绝新建/复制/恢复，理由原样返回", () => {
    const { session, files } = setup({ blocked: FAILURE });
    for (const result of [
      session.createDocument(SPEC as never),
      session.createDocumentFromImage("剪贴板", new Uint8Array([1])),
      session.duplicateDocument("副本"),
      session.restoreSavedBaseline(new Uint8Array([1]))
    ]) {
      expect(result).toEqual(FAILURE);
    }
    for (const method of Object.values(files)) expect(method).not.toHaveBeenCalled();
  });

  it("新建成功返回内核真实尺寸，并透传预设形状参数", () => {
    const { session, files, afterWrite } = setup();
    const result = session.createDocument(SPEC as never);
    expect(result).toMatchObject({ ok: true, value: { width: 640, height: 480, resolution: 72 } });
    expect(files.createDocument).toHaveBeenCalledWith(SPEC);
    // 内核里已经有文档：视图必须同步一次，否则界面停在「未打开文档」而内核确有文档。
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it("从图像新建同样同步工作区视图", () => {
    const { session, afterWrite } = setup();
    expect(session.createDocumentFromImage("剪贴板", new Uint8Array([1]))).toMatchObject({ ok: true });
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it("视图同步失败时不谎称新建成功", () => {
    const { session, afterWrite } = setup();
    afterWrite.mockReturnValue({ ok: false, code: "invalid-message", message: "内核状态结构非法" });
    const result = session.createDocument(SPEC as never);
    // 内核文档已建好但界面无法呈现：必须报失败，不能返回一副「成功」的样子。
    expect(result).toMatchObject({ ok: false, code: "invalid-message" });
  });

  it("内核报告与状态不一致时转成 invalid-message，不返回半截数据", () => {
    const { session, files } = setup();
    files.createDocument.mockReturnValue({
      ok: true,
      value: { width: 640, height: 480, resolution: 72, state: { document: { width: 641, height: 480 } } }
    });
    const result = session.createDocument(SPEC as never);
    expect(result).toMatchObject({ ok: false, code: "invalid-message" });
    expect(result.ok === false && result.message).toContain("不一致");
  });

  it("内核失败原样返回稳定 code", () => {
    const { session, files } = setup();
    files.createDocument.mockReturnValue({ ok: false, code: "command-failed", message: "当前编辑会话已有文档" });
    expect(session.createDocument(SPEC as never)).toEqual({ ok: false, code: "command-failed", message: "当前编辑会话已有文档" });
  });

  it("空字节在调用内核之前就被拒绝，并提示重新复制或选择", () => {
    const { session, files } = setup();
    expect(session.createDocumentFromImage("剪贴板", new Uint8Array())).toMatchObject({
      ok: false,
      code: "import-failed",
      message: expect.stringContaining("重新复制或选择")
    });
    expect(files.createDocumentFromImage).not.toHaveBeenCalled();
  });

  it("没有文档时不能复制副本", () => {
    const { session, files } = setup({ document: false });
    expect(session.duplicateDocument("副本")).toEqual({ ok: false, code: "no-document", message: "没有可复制的文档" });
    expect(files.duplicateDocumentBytes).not.toHaveBeenCalled();
  });

  it("复制为字节且不推进会话基线（原文 dirty 不变）", () => {
    const { session, files, afterWrite } = setup();
    const result = session.duplicateDocument(" 副本 ");
    expect(result).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
    expect(files.duplicateDocumentBytes).toHaveBeenCalledWith(" 副本 ");
    expect(afterWrite).not.toHaveBeenCalled();
  });
});

describe("U03 恢复基线推进一次会话基线", () => {
  it("空基线在调用内核前拒绝，理由说明要重新选择工程", () => {
    const { session, files } = setup();
    expect(session.restoreSavedBaseline(new Uint8Array())).toMatchObject({
      ok: false,
      code: "load-failed",
      message: expect.stringContaining("重新选择工程文件")
    });
    expect(files.restoreSavedBaseline).not.toHaveBeenCalled();
  });

  it("恢复成功后以 establishBaseline 推进基线，并透传 baseAssetId", () => {
    const { session, files, afterWrite } = setup();
    const bytes = new Uint8Array([9, 9]);
    const result = session.restoreSavedBaseline(bytes, "asset-1");
    expect(result).toMatchObject({ ok: true, value: { hasDocument: true } });
    expect(files.restoreSavedBaseline).toHaveBeenCalledWith(bytes, "asset-1");
    expect(afterWrite).toHaveBeenCalledWith(true);
  });

  it("恢复报告缺字段时转成 invalid-message，且不推进基线", () => {
    const { session, files, afterWrite } = setup();
    files.restoreSavedBaseline.mockReturnValue({ ok: true, value: { restored: true } });
    expect(session.restoreSavedBaseline(new Uint8Array([1]))).toMatchObject({ ok: false, code: "invalid-message" });
    expect(afterWrite).not.toHaveBeenCalled();
  });
});

describe("U04 File Info 与预设/最近", () => {
  it("读取只做解码，不推进修订或基线", () => {
    const { session, files, afterWrite } = setup();
    expect(session.readFileInfo()).toEqual({ ok: true, value: { title: "封面" } });
    expect(files.fileInfo).toHaveBeenCalledWith(null);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("没有文档时拒绝读取/写入", () => {
    const { session, files } = setup({ document: false });
    expect(session.readFileInfo()).toEqual({ ok: false, code: "no-document", message: "没有可读取 File Info 的文档" });
    expect(session.writeFileInfo({ title: "x" })).toEqual({ ok: false, code: "no-document", message: "没有可写入 File Info 的文档" });
    expect(files.fileInfo).not.toHaveBeenCalled();
  });

  it("非法表单在调用内核前拒绝，合法表单一步写入", () => {
    const { session, files, afterWrite } = setup();
    const tooLong = session.writeFileInfo({ title: "x".repeat(5000) });
    expect(tooLong).toMatchObject({ ok: false, code: "command-failed" });
    expect(files.fileInfo).not.toHaveBeenCalled();

    session.writeFileInfo({ title: "封面", keywords: "海报; 样张" });
    expect(files.fileInfo).toHaveBeenCalledWith({ title: "封面", keywords: ["海报", "样张"] });
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(afterWrite.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("预设保存/删除后用重新列出的结果回答，不本地猜测", () => {
    const { session, files } = setup();
    files.documentPresets.mockReturnValue({ ok: true, value: { presets: [{ name: "方形", settings: SPEC }] } });
    const saved = session.saveDocumentPreset("方形", SPEC as never);
    expect(saved).toMatchObject({ ok: true, value: [{ name: "方形" }] });
    expect(files.documentPresets).toHaveBeenNthCalledWith(1, "save", {
      name: "方形",
      settings: {
        width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white",
        unit: "px", resolutionUnit: "in"
      }
    });
    expect(files.documentPresets).toHaveBeenNthCalledWith(2, "list");
  });

  it("内核拒绝保存时直接返回原因，不追加列表读取", () => {
    const { session, files } = setup();
    files.documentPresets.mockReturnValue({ ok: false, code: "command-failed", message: 'A preset named "方形" already exists' });
    expect(session.saveDocumentPreset("方形", SPEC as never)).toEqual({
      ok: false, code: "command-failed", message: 'A preset named "方形" already exists'
    });
    expect(files.documentPresets).toHaveBeenCalledTimes(1);
  });

  it("记录最近设置只传内核认识的键，不传文档名与显示单位", () => {
    const { session, files } = setup();
    session.recordRecentDocument(SPEC as never);
    expect(files.recordRecentDocument).toHaveBeenCalledWith({
      width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white"
    });
  });

  it("保存预设的 settings 不夹带文档名（否则内核整体拒绝）", () => {
    const { session, files } = setup();
    session.saveDocumentPreset("方形", SPEC as never);
    const saveCall = files.documentPresets.mock.calls.find(([action]) => action === "save");
    expect(saveCall).toBeDefined();
    const params = saveCall![1] as { settings: Record<string, unknown> };
    expect(params.settings).toEqual({
      width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white",
      unit: "px", resolutionUnit: "in"
    });
    expect(params.settings).not.toHaveProperty("name");
  });

  it("预设列表结构非法时报告 invalid-message 而不是空列表", () => {
    const { session, files } = setup();
    files.documentPresets.mockReturnValue({ ok: true, value: { items: [] } });
    expect(session.listDocumentPresets()).toMatchObject({ ok: false, code: "invalid-message" });
  });
});

describe("U01 独立文档槽位：在候选实例上产出工程字节", () => {
  it("已有文档时仍能产出新文档字节，且不动当前会话", async () => {
    // 回归：一个会话只有一个文档槽位，已有文档时 `createDocument` 必然被内核拒绝；
    // 「已有文档再新建」必须走独立候选实例，当前文档与其基线完全不受影响。
    const { session, files, afterWrite } = setup();
    const bytes = new Uint8Array([7, 7, 7]);
    const candidate = {
      createDocument: vi.fn(() => ({ ok: true, value: { name: "海报", width: 120, height: 80, resolution: 300, background: "transparent" } })),
      saveProject: vi.fn(() => ({ ok: true, value: bytes })),
      closeDocument: vi.fn(() => ({ ok: true, value: {} }))
    };
    loadEditorStub.mockResolvedValueOnce({
      ok: true,
      value: { features: { files: candidate }, saveProject: candidate.saveProject, closeDocument: candidate.closeDocument }
    });

    const result = await session.createDocumentBytes(SPEC as never);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.bytes).toBe(bytes);
    expect(result.value.report).toMatchObject({ width: 120, height: 80, resolution: 300, background: "transparent" });
    // 候选实例建好后必须释放；当前会话的新建/写回一次都不能发生。
    expect(candidate.closeDocument).toHaveBeenCalledOnce();
    expect(files.createDocument).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("候选实例的工程字节为空时如实失败，不把空字节交给宿主", async () => {
    const { session } = setup();
    const candidate = {
      createDocument: vi.fn(() => ({ ok: true, value: { name: "海报", width: 8, height: 8, resolution: 72, background: "white" } })),
      saveProject: vi.fn(() => ({ ok: true, value: new Uint8Array() })),
      closeDocument: vi.fn(() => ({ ok: true, value: {} }))
    };
    loadEditorStub.mockResolvedValueOnce({
      ok: true,
      value: { features: { files: candidate }, saveProject: candidate.saveProject, closeDocument: candidate.closeDocument }
    });
    expect(await session.createDocumentBytes(SPEC as never)).toMatchObject({ ok: false, code: "invalid-artifacts" });
  });

  it("非法设置在校验阶段拒绝，不加载候选实例", async () => {
    const { session } = setup();
    const before = loadEditorStub.mock.calls.length;
    const result = await session.createDocumentBytes({ ...SPEC, width: 0 } as never);
    expect(result.ok).toBe(false);
    expect(loadEditorStub.mock.calls.length).toBe(before);
  });
});

describe("导出/保存进行中的写入被拒绝（任务 3.3）", () => {
  it.each([
    { phase: "freezing", code: "exporting" },
    { phase: "saving", code: "saving" }
  ])("阶段 $phase 时拒绝新建/复制/恢复/元数据写入且零内核调用", ({ phase, code }) => {
    // 此前这里**没有**检查：保存进行中仍可新建/复制/恢复，产物对应的修订与画面不一致。
    const { session, files } = setup({ phase });
    for (const result of [
      session.createDocument(SPEC as never),
      session.createDocumentFromImage("剪贴板", new Uint8Array([1])),
      session.duplicateDocument("副本"),
      session.restoreSavedBaseline(new Uint8Array([1])),
      session.writeFileInfo({ title: "x" })
    ]) {
      expect(result).toMatchObject({ ok: false, code });
    }
    for (const method of Object.values(files)) expect(method).not.toHaveBeenCalled();
  });

  it("上一次保存失败后仍有待重试产物时也拒绝写入", () => {
    const { session } = setup({ phase: "editing", pendingArtifacts: true });
    expect(session.duplicateDocument("副本")).toMatchObject({ ok: false, code: "saving" });
  });

  it("拒绝原因说明在保存/导出，而不是误报「没有文档」", () => {
    // 顺序错了会把「保存中」报成「没有文档」，用户按提示去新建只会更糟。
    const { session } = setup({ phase: "saving", document: false, blocked: FAILURE });
    expect(session.createDocument(SPEC as never)).toMatchObject({ code: "saving" });
  });

  it("只读查询不受导出/保存影响（File Info 读取与预设列表仍可用）", () => {
    const { session } = setup({ phase: "saving" });
    expect(session.readFileInfo()).toMatchObject({ ok: true });
    expect(session.listDocumentPresets()).toMatchObject({ ok: true });
  });
});
