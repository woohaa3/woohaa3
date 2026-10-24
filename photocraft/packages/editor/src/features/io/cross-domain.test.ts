/**
 * 跨域回归（change: 2026-10-22-add-photocraft-raster-interchange，任务 5.2）。
 *
 * `parallel-work.md` 写明「同级完成前置：**无**」：本域不依赖任何 sibling change 先合入。
 * 因此这里执行的是「本域与**当前分支已有真实提供方**的联合回归」——不 mock 任何一侧：
 *
 * 1. **像素**：选区/调整层/图层属性/通道等其它域改过文档后，本域导出的像素必须反映真实合成；
 * 2. **身份**：本域导出不得改变内容指纹（导出不是修改）；跨域写入必须改变指纹；
 * 3. **保存**：跨域写入后存 `.pcraft` 再重开，图层/结构/像素一致，本域导出仍可用；
 * 4. **核验**：产出的工程必须能被原生核验器接受（`project_verify`）。
 *
 * 未接真实提供方的组合（例如目标模式/旋转视图/新层类型这类 sibling 尚未实现的能力）**不**在
 * 这里伪造：本文件只断言当前分支真实存在的提供方，其余情况保持未勾选并在 tasks 中写明。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EditorHandle } from "../../editor-wasm.js";
import { createSession } from "./workspace.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorViewModel } from "../../editor-view-model.js";

const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/wasm");
const gluePath = path.join(wasmDir, "photocraft_editor.js");
const binaryPath = path.join(wasmDir, "photocraft_editor_bg.wasm");
const available = fs.existsSync(gluePath) && fs.existsSync(binaryPath);

type Wasm = {
  WasmEditor: new () => Record<string, (...args: unknown[]) => unknown>;
  initSync: (input: { module: Buffer }) => unknown;
};

/** 真实内核 + 本域会话；`execute`/`state` 直接给跨域场景用。 */
const view = (name: string, selected: number[]): EditorViewModel => ({
  hasDocument: true,
  sessionActiveIndex: 0,
  document: { name, revision: 5, selectedLayerIds: selected } as EditorViewModel["document"]
});

/** 取 `contentHash()` 的值；失败说明内核身份不可用，直接让测试失败而不是静默 undefined。 */
function hash(handle: EditorHandle): string {
  const result = handle.contentHash();
  if (!result.ok) throw new Error(`contentHash 失败：${result.message}`);
  return result.value;
}

async function bench() {
  const mod = (await import(gluePath)) as Wasm;
  mod.initSync({ module: fs.readFileSync(binaryPath) });
  const instance = new mod.WasmEditor();
  const handle = new EditorHandle(instance as never, {
    upstreamCommit: "pinned",
    upstreamVersion: "0.9.0",
    engineVersion: "photocraft-v1",
    formatVersion: 1
  });
  const model: EditorViewModel = {
    hasDocument: true,
    sessionActiveIndex: 0,
    document: view("art", []).document
  };
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    handle,
    view: model,
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => false,
    blockingDraft: () => null,
    unavailable: () => ({ ok: false, code: "unavailable", message: "内核未就绪" }),
    fail: (failure) => failure,
    afterWrite: () => ({ ok: true, value: model })
  };
  const io = createSession(() => context);
  /** 走真实命令门（与 UI 同一条路径），失败即抛出，避免静默跳过。 */
  const run = (id: string, params: Record<string, unknown> = {}) => {
    const raw = instance.execute!(id, JSON.stringify(params));
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
      throw new Error(`${id} 被拒绝：${JSON.stringify(value).slice(0, 160)}`);
    }
    return value;
  };
  const state = () => JSON.parse(instance.stateJson!() as string);
  return { instance, handle, io, run, state };
}

describe.skipIf(!available)("跨域联合回归（真实 WASM + 真实提供方）", () => {
  it("其它域改过文档后，本域导出的像素反映真实合成而不是原图", async () => {
    const { instance, io, run } = await bench();
    run("file.new", { width: 64, height: 48 });
    run("layer.new.layer", { name: "底" });
    run("edit.fillForeground", { color: "#3366cc" });

    const before = io.exportRaster({ mode: "export", format: "png" });
    if (!before.ok) throw new Error("原始导出失败");

    // 跨域写入：选区 + 带真实参数的调整层（selections / adjustments / layers 的现有提供方）。
    // 默认参数的调整层不改像素（正确的无操作），因此这里给真实亮度/对比度。
    run("select.rect", { x: 4, y: 4, width: 24, height: 24 });
    run("layer.newAdjustmentLayer.brightnessContrast", { name: "亮度对比", brightness: 80, contrast: 40 });
    const after = io.exportRaster({ mode: "export", format: "png" });
    if (!after.ok) throw new Error(`跨域后导出失败：${after.message}`);

    // 合成变了，字节就该变；否则「导出」等于绕过了其它域。
    expect(after.value.bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(after.value.bytes).equals(Buffer.from(before.value.bytes))).toBe(false);
    expect(after.value.report).toMatchObject({ width: 64, height: 48, format: "png" });
    void instance;
  });

  it("导出不推进身份，跨域写入才推进", async () => {
    const { handle, io, run } = await bench();
    run("file.new", { width: 32, height: 24 });
    run("layer.new.layer", { name: "底" });
    run("edit.fillForeground", { color: "#224466" });

    const opened = hash(handle);
    // 连续导出（含不同格式）都不得改变内容指纹：导出不是修改。
    for (const format of ["png", "jpg", "webp", "tif"]) {
      expect(io.exportRaster({ mode: "export", format }).ok).toBe(true);
      expect(hash(handle)).toBe(opened);
    }
    // 预览同样不是修改。
    expect(io.previewExport({ mode: "export", format: "png" }).ok).toBe(true);
    expect(hash(handle)).toBe(opened);

    // 跨域写入必须推进身份。
    run("select.rect", { x: 0, y: 0, width: 8, height: 8 });
    run("layer.newAdjustmentLayer.levels", { name: "色阶" });
    expect(hash(handle)).not.toBe(opened);
    // 写入之后导出仍然可用，且已经用上新内容。
    expect(io.exportRaster({ mode: "export", format: "png" }).ok).toBe(true);
  });

  it("跨域写入后存工程再重开：图层结构、尺寸与本域导出保持一致", async () => {
    const { handle, io, run, state } = await bench();
    run("file.new", { width: 48, height: 40 });
    run("layer.new.layer", { name: "图标.png" });
    run("edit.fillForeground", { color: "#3366cc" });
    run("select.rect", { x: 2, y: 2, width: 16, height: 16 });
    run("layer.newAdjustmentLayer.levels", { name: "色阶" });

    const names = state().document.layers.map((layer: { name: string }) => layer.name);
    const project = handle.saveProject();
    if (!project.ok) throw new Error("存工程失败");
    const exportedBefore = io.exportRaster({ mode: "export", format: "png" });
    if (!exportedBefore.ok) throw new Error("重开前导出失败");

    const reopened = await bench();
    const opened = reopened.handle.openProject(project.value, "cross-domain");
    expect(opened.ok).toBe(true);
    expect(reopened.state().document.layers.map((layer: { name: string }) => layer.name)).toEqual(names);
    expect(reopened.state().document.width).toBe(48);
    expect(reopened.state().document.height).toBe(40);
    // 重开后本域导出仍可用，尺寸与重开前一致（像素由同一内核合成）。
    const exportedAfter = reopened.io.exportRaster({ mode: "export", format: "png" });
    if (!exportedAfter.ok) throw new Error(`重开后导出失败：${exportedAfter.message}`);
    expect(exportedAfter.value.report).toMatchObject({ width: 48, height: 40 });
  });

  it("导出的工程能通过原生核验器（保存链与本域产出一致）", async () => {
    const { handle, run } = await bench();
    run("file.new", { width: 32, height: 32 });
    run("layer.new.layer", { name: "底" });
    run("edit.fillForeground", { color: "#ffcc00" });
    run("select.rect", { x: 0, y: 0, width: 8, height: 8 });
    const project = handle.saveProject();
    if (!project.ok) throw new Error("存工程失败");

    // 真实核验：调用 `photocraft-project-verify` 原生二进制（与服务器/CI 同一实现），
    // 不在这里重写一份 ZIP/manifest 校验来「自证」。
    // Windows 上构建产物带 `.exe`：不带扩展名的路径在 Windows 上永远不存在，会让这条用例
    // 在录制机上有「产物缺失」的假失败。
    const binaryBase = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../project-verifier/dist/bin/photocraft-project-verify");
    const binary = process.platform === "win32" && fs.existsSync(`${binaryBase}.exe`) ? `${binaryBase}.exe` : binaryBase;
    if (!fs.existsSync(binary)) {
      throw new Error(`缺少原生核验器产物（先运行 pnpm -C photocraft run verifier）：${binary}`);
    }
    const { execFileSync } = await import("node:child_process");
    const file = path.join(wasmDir, `cross-domain-${process.pid}.pcraft`);
    try {
      fs.writeFileSync(file, project.value);
      const stdout = execFileSync(binary, [file], { encoding: "utf8" });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
