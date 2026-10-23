/**
 * 关闭/离开结算与打开文件校验回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.1/4.1 / design D2/D6）。
 */
import { describe, expect, it, vi } from "vitest";
import { planCloseDocument, planLeave, settleSerially, type DocumentSettlementItem } from "../src/document-close.js";
import { settleDocument } from "../src/document-settlement.js";
import { IMAGE_PROJECT_CONTENT_TYPE, PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
import { OPEN_FILE_ACCEPT, classifyOpenFile, projectVersionSupported, validateOpenProjectDocument } from "../src/open-file.js";
import { OPEN_RASTER_EXTENSIONS } from "@woohaa3/photocraft-protocol";
import { canOpenDocument, DEFAULT_WORKSPACE_POLICY, SerialGate, shouldProducePreview } from "../src/workspace-policy.js";

function item(overrides: Partial<DocumentSettlementItem> = {}): DocumentSettlementItem {
  return {
    documentId: "doc-1",
    name: "图片",
    dirty: false,
    pendingDraft: null,
    phase: "editing",
    message: null,
    nodeDocument: true,
    receiptUnknown: false,
    ...overrides
  };
}

describe("打开文件校验", () => {
  it.each([
    { name: "a.png", type: "image/png", kind: "image" },
    { name: "a.JPG", type: "image/jpeg", kind: "image" },
    { name: "a.webp", type: "image/webp", kind: "image" },
    // 本 change 扩充的格式：内核矩阵可打开，宿主选择器不得再挡在外面
    // （change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
    { name: "a.tiff", type: "image/tiff", kind: "image" },
    { name: "a.gif", type: "image/gif", kind: "image" },
    { name: "a.bmp", type: "image/bmp", kind: "image" },
    { name: "a.qoi", type: "", kind: "image" },
    { name: "a.pcx", type: "", kind: "image" },
    { name: "a.dds", type: "", kind: "image" },
    { name: "a.pcraft", type: "", kind: "project" },
    { name: "无 MIME 的图片.png", type: "", kind: "image" }
  ])("$name → $kind", ({ name, type, kind }) => {
    expect(classifyOpenFile({ name, type })).toEqual({ ok: true, kind });
  });

  it.each([
    { name: "a.psd", reason: "PSD" },
    { name: "a.psb", reason: "PSB" }
  ])("分层格式 $name 明确拒绝", ({ name, reason }) => {
    const result = classifyOpenFile({ name, type: "image/vnd.adobe.photoshop" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(reason);
  });

  it("未知格式与空文件名拒绝", () => {
    // 暂缓格式仍拒绝：内核没有对应解码器，放进来只会让用户选中后被拒。
    for (const name of ["a.exr", "a.hdr", "a.dpx", "a.fits", "a.avif", "a.heif"]) {
      expect(classifyOpenFile({ name, type: "" }), name).toMatchObject({ ok: false });
    }
    expect(classifyOpenFile({ name: "a.xyz", type: "" })).toMatchObject({ ok: false });
    expect(classifyOpenFile({ name: "  ", type: "image/png" })).toMatchObject({ ok: false, reason: "未选择文件" });
  });

  it("选择器的 accept 值与内核可打开格式同源，且不混入工程扩展名之外的东西", () => {
    // 宿主不再自己硬编码 image/png,image/jpeg,image/webp：清单来自协议域（= 内核矩阵）。
    for (const extension of OPEN_RASTER_EXTENSIONS) expect(OPEN_FILE_ACCEPT).toContain(`.${extension}`);
    for (const deferred of ["exr", "hdr", "dpx", "fits", "avif", "heif"]) {
      expect(OPEN_FILE_ACCEPT).not.toContain(`.${deferred}`);
    }
    // 工程仍可选：它是同一个「打开文件」入口的另一种候选类型。
    expect(OPEN_FILE_ACCEPT).toContain(".pcraft");
  });

  it("工程版本过新/引擎不匹配明确拒绝，不压平成图片", () => {
    expect(projectVersionSupported({ engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 })).toBe(true);
    expect(projectVersionSupported({ engineVersion: "future-engine", formatVersion: 1 })).toBe(false);
    expect(projectVersionSupported({ engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 99 })).toBe(false);
  });

  it("结构校验区分旧标注、非工程与受支持工程", () => {
    expect(validateOpenProjectDocument(null)).toMatchObject({ ok: false });
    expect(validateOpenProjectDocument({ version: "woohaa-image-edit-v1", shapes: [] })).toMatchObject({ ok: false });
    expect(validateOpenProjectDocument({
      version: "woohaa-image-project-v1",
      engine: "photocraft",
      engineVersion: PHOTOCRAFT_ENGINE_VERSION,
      formatVersion: 1,
      baseAssetId: "asset-1",
      sourceWidth: 10, sourceHeight: 10, canvasWidth: 10, canvasHeight: 10,
      documentContentHash: "aabbccddeeff0011",
      project: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "c".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 1 },
      sourceAssetIds: ["asset-1"]
    })).toEqual({ ok: true, kind: "project" });
  });
});

describe("关闭计划", () => {
  it("干净文档直接关闭；脏文档需要确认", () => {
    expect(planCloseDocument(item())).toEqual({ kind: "close" });
    expect(planCloseDocument(item({ dirty: true }))).toMatchObject({ kind: "confirm", canSave: true });
  });

  it("活动操作未结束或保存中先拒绝", () => {
    expect(planCloseDocument(item({ dirty: true, pendingDraft: "请先确认或取消文字编辑" }))).toMatchObject({
      kind: "block",
      reason: "请先确认或取消文字编辑"
    });
    expect(planCloseDocument(item({ phase: "saving" }))).toMatchObject({ kind: "block" });
    expect(planCloseDocument(item({ receiptUnknown: true }))).toMatchObject({
      kind: "block",
      reason: "上次保存结果未知，请先核对保存结果再关闭"
    });
  });
});

describe("离开计划", () => {
  it("全部干净时可以直接离开", () => {
    expect(planLeave([item(), item({ documentId: "doc-2" })])).toEqual({ kind: "leave" });
  });

  it("列出需要结算的文档并定位阻塞项", () => {
    const dirty = item({ documentId: "doc-2", dirty: true });
    const plan = planLeave([item(), dirty]);
    expect(plan.kind).toBe("settle");
    if (plan.kind !== "settle") return;
    expect(plan.items.map((entry) => entry.documentId)).toEqual(["doc-2"]);

    const blocked = planLeave([item(), item({ documentId: "doc-3", pendingDraft: "请先确认或取消自由变换" })]);
    expect(blocked).toEqual({ kind: "block", reason: "请先确认或取消自由变换", documentId: "doc-3" });
  });
});

describe("串行结算", () => {
  it("保存成功后继续；失败即停止并保留已成功项的基线", async () => {
    const a = item({ documentId: "a", dirty: true });
    const b = item({ documentId: "b", dirty: true });
    const save = vi.fn(async (entry: DocumentSettlementItem) => entry.documentId === "b"
      ? { ok: false, message: "保存失败" }
      : { ok: true });
    const outcome = await settleSerially([a, b], async () => "save", save);
    expect(outcome).toMatchObject({ ok: false, failedDocumentId: "b", settled: ["a"] });
  });

  it("重试不重复保存已成功项", async () => {
    const a = item({ documentId: "a", dirty: true });
    const b = item({ documentId: "b", dirty: true });
    const save = vi.fn(async () => ({ ok: true }));
    await settleSerially([a, b], async () => "save", save);
    expect(save).toHaveBeenCalledTimes(2);
    // 第二次只结算剩余项（调用方按 settled 过滤）。
    await settleSerially([b], async () => "save", save);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("取消停止离开并保留现场", async () => {
    const a = item({ documentId: "a", dirty: true });
    const outcome = await settleSerially([a], async () => "cancel", async () => ({ ok: true }));
    expect(outcome).toMatchObject({ ok: false, reason: "已取消离开", failedDocumentId: "a" });
  });

  it("放弃只丢未提交修改，不调用保存", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const outcome = await settleSerially([item({ dirty: true })], async () => "discard", save);
    expect(outcome).toMatchObject({ ok: true, abandoned: ["doc-1"] });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("单文档结算", () => {
  const ui = () => ({ confirm: vi.fn(async () => true), abandon: vi.fn(async () => true) });

  it("有净变化：确认后保存并关闭", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const outcome = await settleDocument({ ...item({ dirty: true }), ui: ui(), save });
    expect(outcome).toEqual({ ok: true, action: "closed" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("取消确认时保留现场", async () => {
    const confirm = vi.fn(async () => false);
    const save = vi.fn(async () => ({ ok: true }));
    const outcome = await settleDocument({ ...item({ dirty: true }), ui: { confirm, abandon: vi.fn() }, save });
    expect(outcome).toMatchObject({ ok: false, reason: "已取消" });
    expect(save).not.toHaveBeenCalled();
  });

  it("保存失败时不关闭", async () => {
    const outcome = await settleDocument({
      ...item({ dirty: true }), ui: ui(), save: async () => ({ ok: false, message: "上传失败" })
    });
    expect(outcome).toMatchObject({ ok: false, reason: "上传失败" });
  });

  it("仅发起下载时必须再确认一次（不能当磁盘写入）", async () => {
    const abandon = vi.fn(async () => true);
    const outcome = await settleDocument({
      ...item({ dirty: true, nodeDocument: false }), ui: { confirm: vi.fn(async () => true), abandon },
      save: async () => ({ ok: true, downloadOnly: true })
    });
    expect(outcome).toEqual({ ok: true, action: "closed" });
    expect(abandon).toHaveBeenCalledOnce();

    const refuse = await settleDocument({
      ...item({ dirty: true, nodeDocument: false }), ui: { confirm: vi.fn(async () => true), abandon: async () => false },
      save: async () => ({ ok: true, downloadOnly: true })
    });
    expect(refuse).toMatchObject({ ok: false, reason: "已取消" });
  });

  it("干净文档不询问、不保存", async () => {
    const confirm = vi.fn(async () => true);
    const save = vi.fn(async () => ({ ok: true }));
    expect(await settleDocument({ ...item(), ui: { confirm, abandon: vi.fn() }, save })).toEqual({ ok: true, action: "closed" });
    expect(confirm).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("工作区资源政策", () => {
  it("达到上限明确拒绝并给出关闭指引", () => {
    expect(canOpenDocument(0)).toEqual({ ok: true });
    const rejected = canOpenDocument(DEFAULT_WORKSPACE_POLICY.maxDocuments);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toContain("请先关闭一个");
  });

  it("只有活动文档生产主预览", () => {
    expect(shouldProducePreview("a", "a")).toBe(true);
    expect(shouldProducePreview("b", "a")).toBe(false);
    expect(shouldProducePreview(null, null)).toBe(false);
  });

  it("串行闸门保证一次只跑一个打开/解码，失败不阻塞后续", async () => {
    const gate = new SerialGate(1);
    const order: string[] = [];
    const slow = gate.run(async () => { order.push("a-start"); await Promise.resolve(); order.push("a-end"); });
    const next = gate.run(async () => { order.push("b"); return 1; });
    await Promise.all([slow, next]);
    expect(order).toEqual(["a-start", "a-end", "b"]);

    const failing = new SerialGate(1);
    await expect(failing.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(failing.run(async () => "ok")).resolves.toBe("ok");
  });
});
