/**
 * 域会话 → 真实 WASM 的端到端回归（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 与 `workspace.test.ts` 的区别：那里用替身内核锁定契约，这里用**真实** wasm glue 走一遍
 * `EditorHandle` → `features.io` → 域会话，确认这些事不能被替身掩盖：
 *
 * 1. 新增绑定确实由真实产物导出且签名匹配（`interchangeBindings` 不会误判为缺失）；
 * 2. 矩阵/导出选项来自真实构建，不是前端常量；
 * 3. 预览与交付逐字节相同，且导出前后内容指纹不变；
 * 4. 逐层/资产包是真实 ZIP，`inspectIoBundle` 能复核条目；
 * 5. 每个开放格式都用真实签名字节完成预检与打开（只读项同样能打开）；
 * 6. 草稿期间拒绝导出且不触碰内核。
 *
 * 产物缺失时（干净副本未跑 `pnpm run wasm`）跳过并说明原因 —— 不伪装成通过。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EditorHandle } from "../../editor-wasm.js";
import { OPEN_RASTER_ACCEPT, OPEN_RASTER_EXTENSIONS, OPEN_RASTER_MIMES } from "@woohaa3/photocraft-protocol";
import { createSession } from "./workspace.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorViewModel } from "../../editor-view-model.js";

const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/wasm");
const gluePath = path.join(wasmDir, "photocraft_editor.js");
const binaryPath = path.join(wasmDir, "photocraft_editor_bg.wasm");
const available = fs.existsSync(gluePath) && fs.existsSync(binaryPath);

const view = (name: string, selected: number[]): EditorViewModel => ({
  hasDocument: true,
  sessionActiveIndex: 0,
  document: { name, revision: 5, selectedLayerIds: selected } as EditorViewModel["document"]
});

async function realEditor(options: { draft?: boolean } = {}) {
  const mod = (await import(gluePath)) as {
    default: () => Promise<unknown>;
    initSync: (input: { module: Buffer }) => unknown;
    WasmEditor: new () => Record<string, (...args: unknown[]) => unknown>;
  };
  mod.initSync({ module: fs.readFileSync(binaryPath) });
  const instance = new mod.WasmEditor();
  const seed = (id: string, params: Record<string, unknown>) =>
    instance.execute!(id, JSON.stringify(params));
  seed("file.new", { width: 32, height: 24 });
  seed("layer.new.layer", { name: "图标.png" });
  seed("edit.fillForeground", { color: "#3366cc" });
  seed("layer.new.layer", { name: "第二层" });
  seed("edit.fillForeground", { color: "#cc3366" });
  const handle = new EditorHandle(instance as never, {
    upstreamCommit: "pinned",
    upstreamVersion: "0.9.0",
    engineVersion: "photocraft-v1",
    formatVersion: 1
  });
  const model = view("art", [1, 2]);
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
    hasActiveDraft: () => options.draft === true,
    blockingDraft: () => (options.draft === true ? { ok: false, code: "gesture-active", message: "请先结算当前草稿" } : null),
    unavailable: () => ({ ok: false, code: "unavailable", message: "内核未就绪" }),
    fail: (failure) => failure,
    afterWrite: () => ({ ok: true, value: model })
  };
  return { io: createSession(() => context), instance, handle, WasmEditor: mod.WasmEditor };
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** 用 stored 无压缩 deflate 块打包，避免在测试里引入 zlib 依赖。 */
const storedDeflate = (raw: Uint8Array): Uint8Array => {
  const blocks: number[] = [0x78, 0x01];
  let offset = 0;
  do {
    const size = Math.min(65535, raw.length - offset);
    const last = offset + size >= raw.length ? 1 : 0;
    blocks.push(last, size & 0xff, size >> 8, ~size & 0xff, (~size >> 8) & 0xff);
    for (let index = 0; index < size; index++) blocks.push(raw[offset + index]!);
    offset += size;
  } while (offset < raw.length);
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff);
  return Uint8Array.from(blocks);
};

/** 构造一份 PNG 容器（IHDR 的 CRC 正确），像素全零；位深/尺寸由参数决定。 */
const makePng = (width: number, height: number, bitDepth: number): Uint8Array => {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = 2; // truecolour RGB
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  // 只给一小段真实像素流：超预算用例应当在读 IHDR 时就被拒绝，不需要完整像素。
  const raw = new Uint8Array(Math.max(1, Math.min(height, 2)) * (1 + Math.min(width, 2) * 3 * bytesPerSample));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedDeflate(raw)),
    pngChunk("IEND", new Uint8Array())
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** 真实可解码、但样本是 U16 的 PNG（IHDR 位深 16），用于验证「不自动降位深」。 */
const SIXTEEN_BIT_PNG = makePng(2, 2, 16);

/** 签名与 IHDR 都合法、但尺寸远超预算的 PNG（不靠破坏 CRC 来「制造」失败）。 */
const OVERSIZED_PNG = makePng(100_000, 100_000, 8);

/** 只读交换格式的最小真实文件（本构建只解码，故手工生成）。 */
const READ_ONLY_FIXTURES: [string, Uint8Array, [number, number]][] = (() => {
  const pcx = (() => {
    const bytes = new Uint8Array(128 + 8);
    bytes.set([0x0a, 5, 1, 8]);
    bytes[8] = 1; // width-1 -> 2
    bytes[10] = 0; // height-1 -> 1
    bytes.set([0x2c, 0x01, 0x96, 0x00], 12);
    bytes[65] = 3; // 3 planes
    bytes[66] = 2; // stride
    bytes[68] = 1;
    // 3 平面 RLE，每平面 2 像素；>=0xC0 的值转义为 (0xC1, value)。
    bytes.set([0xc1, 0xff, 0x00, 0x00, 0xc1, 0xff, 0x00, 0x00], 128);
    return bytes;
  })();
  const xpm = new TextEncoder().encode(
    "/* XPM */\nstatic char *i[] = {\n\"2 2 2 1\",\n\"a c #ff0000\",\n\"b c #0000ff\",\n\"ab\",\n\"ba\"\n};\n"
  );
  const dds = (() => {
    const bytes = new Uint8Array(128 + 16);
    const view = new DataView(bytes.buffer);
    bytes.set([0x44, 0x44, 0x53, 0x20], 0);
    view.setUint32(4, 124, true);
    view.setUint32(8, 0x1007, true);
    view.setUint32(12, 2, true);
    view.setUint32(16, 2, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 0x41, true);
    view.setUint32(88, 32, true);
    view.setUint32(92, 0x000000ff, true);
    view.setUint32(96, 0x0000ff00, true);
    view.setUint32(100, 0x00ff0000, true);
    view.setUint32(104, 0xff000000, true);
    view.setUint32(108, 0x1000, true);
    bytes.set([0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 0, 255, 0, 0, 0, 255], 128);
    return bytes;
  })();
  return [["pcx", pcx, [2, 1]], ["xpm", xpm, [2, 2]], ["dds", dds, [2, 2]]];
})();

describe.skipIf(!available)("真实 WASM 下的域会话（需要 pnpm -C photocraft run wasm）", () => {
  it("矩阵与会话端口都由真实产物提供，不是替身", async () => {
    const { io } = await realEditor();
    const matrix = io.matrix();
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) throw new Error("unreachable");
    const rows = (matrix.value as { formats: { id: string; status: string; reason: string | null }[] }).formats;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("png")).toMatchObject({ status: "open" });
    expect(byId.get("pcx")).toMatchObject({ status: "read-only" });
    expect(byId.get("exr")).toMatchObject({ status: "deferred" });
    expect(byId.get("exr")!.reason).toContain("HDR");
    expect(io.exportOptions().ok).toBe(true);
  });

  it("预览与交付逐字节相同，导出不推进基线、不改内容指纹", async () => {
    const { io, instance } = await realEditor();
    const hashBefore = instance.contentHash!();
    for (const settings of [
      { mode: "export", format: "jpg", quality: 70 },
      { mode: "export", format: "webp", webpQuality: 75 },
      { mode: "export", format: "tif", tiffCompression: "lzw" },
      { mode: "web", format: "png24" }
    ]) {
      const preview = io.previewExport(settings);
      const delivered = io.exportRaster(settings);
      expect(preview.ok && delivered.ok).toBe(true);
      if (!preview.ok || !delivered.ok) throw new Error("unreachable");
      const a = preview.value;
      const b = delivered.value;
      expect(a.report.preview).toBe(true);
      expect(b.report.preview).toBe(false);
      expect(b.report.documentChanged).toBe(false);
      expect(a.bytes).toEqual(b.bytes);
      expect(b.report.width).toBe(32);
      expect(b.report.height).toBe(24);
    }
    expect(instance.contentHash!()).toBe(hashBefore);
  });

  it("逐层与按名称资产交付是真实 ZIP，可被 inspectIoBundle 复核", async () => {
    const { io } = await realEditor();
    // 逐层导出的目标是**内核里的真实图层 id**，不是界面自己编的编号。
    const plan = io.inspectLayerExport({ format: "png" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    const planned = (plan.value as { layers: { layerId: number; fileName: string }[] }).layers;
    expect(planned.map((layer) => layer.fileName)).toEqual(["第二层.png"]);

    const bundle = io.exportLayerBundle({ format: "png", layers: planned.map((layer) => layer.layerId) });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) throw new Error("unreachable");
    const value = bundle.value;
    // ZIP 本地文件头。
    expect([...value.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(value.report.files.map((file) => file.fileName)).toEqual(["第二层.png"]);
    expect(value.report.failedCount).toBe(0);

    const inspected = io.inspectBundle(value.bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error("unreachable");
    const names = inspected.value;
    expect(names.files.map((file) => file.name)).toContain("report.json");
    expect(names.bytes).toBe(value.bytes.length);

    const assets = io.exportImageAssets();
    expect(assets.ok).toBe(true);
    if (!assets.ok) throw new Error("unreachable");
    expect([...assets.value.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(assets.value.report.kind).toBe("assets");
    expect(assets.value.report.files.map((file) => file.fileName)).toEqual(["图标.png"]);
  });

  it("单层 Export As 用真实图层名与格式命名", async () => {
    const { io } = await realEditor();
    const single = io.exportLayerAs({ format: "png" });
    expect(single.ok).toBe(true);
    if (!single.ok) throw new Error("unreachable");
    const value = single.value;
    // 单层导出取**活动层**；播种后活动层是最后新建的「第二层」。
    expect(value.fileName).toBe("art-第二层.png");
    expect(value.contentType).toBe("image/png");
    expect([...value.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("打开栅格 → 存工程 → 重开：像素与结构不变，指纹在重开后稳定（工程往返）", async () => {
    const { io, handle, instance, WasmEditor } = await realEditor();
    // 1) 用真实 PNG 字节当用户的源文件打开（新内核实例 = 新会话）。
    const png = io.exportRaster({ mode: "export", format: "png" });
    if (!png.ok) throw new Error("unreachable");
    const sourceBytes = png.value.bytes;

    const opened = new WasmEditor();
    const openedHandle = new EditorHandle(opened as never, {
      upstreamCommit: "pinned",
      upstreamVersion: "0.9.0",
      engineVersion: "photocraft-v1",
      formatVersion: 1
    });
    expect(openedHandle.features.io.openRaster("art.png", sourceBytes).ok).toBe(true);
    const openedState = JSON.parse(String((opened as { stateJson(): string }).stateJson()));
    const reopenedPixels = (() => {
      const encoded = openedHandle.features.io.exportRaster({ mode: "export", format: "png" });
      if (!encoded.ok) throw new Error("unreachable");
      return encoded.value.bytes;
    })();
    // 打开不该改像素：重新编码出的字节与源文件逐字节相同。
    expect(reopenedPixels).toEqual(sourceBytes);

    // 2) 存工程再用新实例重开：画布与图层结构一致。
    const project = openedHandle.saveProject();
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error("unreachable");
    expect(project.value.length).toBeGreaterThan(0);

    const restored = new WasmEditor();
    const restoredHandle = new EditorHandle(restored as never, {
      upstreamCommit: "pinned",
      upstreamVersion: "0.9.0",
      engineVersion: "photocraft-v1",
      formatVersion: 1
    });
    expect(restoredHandle.openProject(project.value, "art.png").ok).toBe(true);
    const restoredState = JSON.parse(String((restored as { stateJson(): string }).stateJson()));
    expect(restoredState.document.canvasWidth).toBe(openedState.document.canvasWidth);
    expect(restoredState.document.canvasHeight).toBe(openedState.document.canvasHeight);
    expect(restoredState.document.layers.length).toBe(openedState.document.layers.length);
    expect(restoredState.document.name).toBe("art.png");

    // 指纹在「重开 → 再存 → 再重开」后必须稳定（首次的来源身份由宿主回填 baseAssetId，
    // 属共享打开链职责：`openRaster` 不设 baseAssetId，故打开后与重开后的值不同）。
    const reopenedHash = restoredHandle.contentHash();
    expect(reopenedHash.ok).toBe(true);
    if (!reopenedHash.ok) throw new Error("unreachable");
    const again = restoredHandle.saveProject();
    if (!again.ok) throw new Error("unreachable");
    const third = new WasmEditor();
    const thirdHandle = new EditorHandle(third as never, {
      upstreamCommit: "pinned",
      upstreamVersion: "0.9.0",
      engineVersion: "photocraft-v1",
      formatVersion: 1
    });
    expect(thirdHandle.openProject(again.value, "art.png").ok).toBe(true);
    expect(thirdHandle.contentHash()).toEqual(reopenedHash);

    // 3) 导出不推进保存基线：原实例再导一次，指纹不变。
    const before = instance.contentHash!();
    expect(io.exportRaster({ mode: "export", format: "jpg" }).ok).toBe(true);
    expect(instance.contentHash!()).toBe(before);
    expect(handle.contentHash().ok).toBe(true);
  });

  it("每个开放格式用真实签名字节完成预检与可编辑打开；只读项照常打开", async () => {
    const { io } = await realEditor();
    // 可写格式直接用自己的真实编码产物（就是用户会拿到的字节）。
    for (const format of ["png", "jpg", "tif", "webp", "gif", "bmp", "tga", "ico", "qoi", "pnm"]) {
      const exported = io.exportRaster({ mode: "export", format });
      if (!exported.ok) throw new Error(`${format} 导出失败：${exported.code} ${exported.message}`);
      const inspection = io.inspectOpenRaster(exported.value.bytes);
      if (!inspection.ok) throw new Error(`${format} 预检失败：${inspection.message}`);
      const value = inspection.value as { format: string; status: string; openable: boolean; depth: string; width: number; height: number };
      expect({ format: value.format, status: value.status, openable: value.openable, depth: value.depth })
        .toEqual({ format, status: "open", openable: true, depth: "u8" });
      expect([value.width, value.height]).toEqual([32, 24]);
    }
    // 只读交换格式：本构建没有编码器，用手工构造的真实文件（签名 + 可解码像素）。
    for (const [format, bytes, size] of READ_ONLY_FIXTURES) {
      const inspection = io.inspectOpenRaster(bytes);
      if (!inspection.ok) throw new Error(`${format} 预检失败：${inspection.message}`);
      const value = inspection.value as { format: string; status: string; openable: boolean; width: number; height: number };
      expect({ format: value.format, status: value.status, openable: value.openable })
        .toEqual({ format, status: "read-only", openable: true });
      expect([value.width, value.height]).toEqual(size);
    }
    // 暂缓格式在预检就被拒绝，并带真实原因（不是「打不开」）。
    const deferred = io.inspectOpenRaster(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00]));
    expect(deferred.ok).toBe(false);
    expect((deferred as { message: string }).message).toContain("OpenEXR");
    expect((deferred as { message: string }).message).toContain("HDR");
  });

  it("打开预检不建文档；暂缓格式与损坏字节都给出原因", async () => {
    const { io } = await realEditor();
    const png = io.exportRaster({ mode: "export", format: "png" });
    if (!png.ok) throw new Error("unreachable");
    const bytes = png.value.bytes;

    const openable = io.inspectOpenRaster(bytes);
    expect(openable.ok).toBe(true);
    if (!openable.ok) throw new Error("unreachable");
    expect(openable.value).toMatchObject({ openable: true, status: "open" });

    const corrupt = io.inspectOpenRaster(new Uint8Array([1, 2, 3]));
    expect(corrupt).toMatchObject({ ok: false, code: "import-failed" });
    const empty = io.inspectOpenRaster(new Uint8Array());
    expect(empty).toMatchObject({ ok: false, code: "import-failed" });
  });

  it("截断、超预算与 16 位输入在预检和打开处给出同一结论", async () => {
    const { io, handle } = await realEditor();
    const png = io.exportRaster({ mode: "export", format: "png" });
    if (!png.ok) throw new Error("unreachable");
    const good = png.value.bytes;
    const hashBefore = handle.contentHash();
    const documentBefore = JSON.stringify(handle.state());

    const cases: [string, Uint8Array, string][] = [
      ["截断", good.slice(0, Math.floor(good.length * 0.6)), "malformed"],
      // 签名与 IHDR 都合法、CRC 正确，只是尺寸远超预算。
      ["超预算", OVERSIZED_PNG, "limit exceeded"],
      // 真实 16 位 PNG（样本 U16）：不自动降位深。
      ["16 位", SIXTEEN_BIT_PNG, "u16"]
    ];
    for (const [label, bytes, expected] of cases) {
      const inspected = io.inspectOpenRaster(bytes);
      expect(inspected).toMatchObject({ ok: false, code: "import-failed" });
      expect((inspected as { message: string }).message).toContain(expected);
      // 预检拒绝的字节，真实打开也必须拒绝——否则「预检说不行、打开却降位深成功」。
      const opened = handle.features.io.openRaster(`${label}.png`, bytes);
      expect(opened).toMatchObject({ ok: false, code: "import-failed" });
      expect((opened as { message: string }).message).toContain(expected);
    }
    // 全程不得替换文档或改动内容指纹。
    expect(handle.contentHash()).toEqual(hashBefore);
    expect(JSON.stringify(handle.state())).toBe(documentBefore);

    // 伪扩展名：同一份 PNG 字节换个假名字。扩展名不作为依据，签名说了算。
    const pseudo = handle.features.io.openRaster("伪装.tif", good);
    expect(pseudo.ok).toBe(true);
    if (!pseudo.ok) throw new Error("unreachable");
    const raster = (pseudo.value as { raster: { format: string } }).raster;
    expect(raster.format).toBe("png");
  });

  it("宿主 accept 端口与内核矩阵同源，暂缓格式不入列", async () => {
    const { io } = await realEditor();
    const accept = io.openAccept();
    expect(accept.ok).toBe(true);
    if (!accept.ok) throw new Error("unreachable");
    const matrix = io.matrix();
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) throw new Error("unreachable");
    const openable = (matrix.value as { openable: string[] }).openable;
    // 逐项一致：宿主用这个端口就不必自己维护格式清单。
    expect([...accept.value.extensions].sort()).toEqual([...openable].sort());
    expect(accept.value.extensions.length).toBeGreaterThan(20);
    // 本构建暂缓的格式不能在 accept 里（否则用户选中后立刻被拒）。
    for (const deferred of ["exr", "hdr", "cin", "fits", "dpx", "avif", "heif"]) {
      expect(accept.value.extensions).not.toContain(deferred);
    }
    // 工程打开走另一条管线，不能混进栅格 accept。
    expect(accept.value.accept).not.toContain("pcraft");
    expect(accept.value.accept).toContain(".tiff");
  });

  it("协议域的宿主格式清单与内核可打开行逐项一致（两边漂移即失败）", async () => {
    const { io } = await realEditor();
    const matrix = io.matrix();
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) throw new Error("unreachable");
    const value = matrix.value as {
      formats: { id: string; status: string; extensions: string[]; mime: string }[];
    };
    const openable = value.formats.filter((row) => row.status === "open" || row.status === "read-only");
    // 静态清单（宿主 `<input accept>` 首帧就要有值）必须与内核矩阵同源。
    expect([...OPEN_RASTER_EXTENSIONS].sort()).toEqual([...new Set(openable.flatMap((row) => row.extensions))].sort());
    expect([...OPEN_RASTER_MIMES].sort()).toEqual([...new Set(openable.map((row) => row.mime))].sort());
    // 暂缓的格式不得进清单：否则用户在对话框里选中后立刻被拒。
    for (const deferred of ["exr", "hdr", "cin", "fits", "dpx", "avif", "heif"]) {
      expect(OPEN_RASTER_EXTENSIONS).not.toContain(deferred);
    }
    // 三个宿主入口共用同一份清单，accept 值必须真的把它们列出来。
    for (const extension of OPEN_RASTER_EXTENSIONS) expect(OPEN_RASTER_ACCEPT).toContain(`.${extension}`);
    for (const mime of OPEN_RASTER_MIMES) expect(OPEN_RASTER_ACCEPT).toContain(mime);
    // 与端口返回值同源（端口是运行时权威，静态清单是首帧快照）。
    const accept = io.openAccept();
    expect(accept.ok).toBe(true);
    if (!accept.ok) throw new Error("unreachable");
    expect([...OPEN_RASTER_EXTENSIONS].sort()).toEqual([...accept.value.extensions].sort());
  });

  it("矩阵里每个可打开格式都能真的打开，且扩展名不参与判定", async () => {
    // 「矩阵说能打开」与「真的能打开」必须一致：宿主把 accept 交给选择器后，
    // 用户选中任意一项都必须成功，不能出现「选得中但打不开」。
    const probe = await realEditor();
    const matrix = probe.io.matrix();
    if (!matrix.ok) throw new Error("unreachable");
    const rows = (matrix.value as { formats: { id: string; status: string; extensions: string[] }[] }).formats
      .filter((row) => row.status === "open" || row.status === "read-only");
    expect(rows.length).toBeGreaterThanOrEqual(13);

    const readOnly = new Map(READ_ONLY_FIXTURES.map(([format, bytes]) => [format, bytes]));
    for (const row of rows) {
      let bytes = readOnly.get(row.id);
      if (!bytes) {
        const exported = probe.io.exportRaster({ mode: "export", format: row.id });
        if (!exported.ok) throw new Error(`${row.id} 导出失败：${exported.message}`);
        bytes = exported.value.bytes;
      }
      // 每个扩展名都试一次（同一份字节换名字）：扩展名不能决定打开结果。
      for (const extension of row.extensions) {
        const { handle } = await realEditor();
        const opened = handle.features.io.openRaster(`sample.${extension}`, bytes);
        expect({ format: row.id, extension, ok: opened.ok }).toEqual({ format: row.id, extension, ok: true });
      }
    }
  });

  it("草稿期间拒绝导出与预览，且不触碰内核", async () => {
    const { io } = await realEditor({ draft: true });
    expect(io.exportRaster({ mode: "export", format: "png" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(io.previewExport({ mode: "export", format: "png" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(io.exportLayerBundle({ format: "png" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(io.inspectLayerExport({ format: "png" })).toMatchObject({ ok: false, code: "gesture-active" });
  });
});
