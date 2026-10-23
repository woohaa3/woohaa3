/**
 * 在**真实构建产物**（`packages/editor/dist/wasm`，非 mock）上跑本域的生产命令。
 *
 * 为什么需要这个脚本：本域的 jsdom 测试用的是替身会话，Rust 测试用的是原生静态库；
 * 两者都不会暴露「参数经 WASM 边界 JSON 编解码后是否仍被内核接受」这一类问题
 * （例如把文档名夹进 `DocumentSettings` 就只在真 WASM 上暴露）。这里不渲染、不取帧，
 * 因此**不需要 GPU 和显示会话**，可以在无图形环境的 CI 上执行。
 *
 * 运行：
 *   pnpm run wasm
 *   node tests/features/files/wasm-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, "packages/editor/dist/wasm");
const mod = await import(pathToFileURL(path.join(source, "photocraft_editor.js")).href);
mod.initSync({ module: fs.readFileSync(path.join(source, "photocraft_editor_bg.wasm")) });

/** 断言某个调用抛出且错误文本包含关键字（WASM 边界把错误转成异常）。 */
const rejects = (label, fn, expected) => {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    const text = String(error);
    assert.ok(
      text.includes(expected),
      `${label}: 拒绝原因应包含「${expected}」，实际为 ${text}`
    );
  }
  assert.ok(threw, `${label}: 应当失败，但成功了`);
};

const info = (editor) => JSON.parse(editor.fileInfo("null"));
const history = (editor) => JSON.parse(editor.stateJson()).document.history;

// --- 命令门：本域启用项与刻意关闭项都必须在真 WASM 上成立 ---------------------
const gate = new mod.WasmEditor();
const allowed = new Set(JSON.parse(gate.allowedCommandIdsJson()));
for (const id of [
  "file.new",
  "file.fileInfo",
  "document.presets.list",
  "document.presets.save",
  "document.presets.delete",
  "document.recent.list",
  "document.recent.add"
]) {
  assert.ok(allowed.has(id), `真 WASM 应启用 ${id}`);
}
// 关闭项必须仍然关闭：`file.revert` 没有原生保存路径。
// （`file.closeAll`/`file.closeOthers` 不是内核命令，批量关闭由宿主串行结算执行，见 U03。）
for (const id of ["file.revert", "file.closeAll", "file.closeOthers"]) {
  assert.ok(!allowed.has(id), `真 WASM 不应启用 ${id}`);
}
gate.free();

// --- U01 新建：真实尺寸 / DPI / 背景，且第二份文档被拒绝 ---------------------
const editor = new mod.WasmEditor();
// WASM 边界返回 JSON 文本（不是对象），与域会话的解码路径一致。
const created = JSON.parse(
  editor.createDocument(JSON.stringify({ width: 40, height: 30, resolution: 300, background: "transparent" }))
);
assert.equal(created.width, 40);
assert.equal(created.height, 30);
assert.equal(created.resolution, 300);
assert.equal(created.background, "transparent");
assert.equal(created.recentRecorded, true, "新建后应同时记录最近设置");
// 同一实例上再新建：本域明确要求候选实例，宿主需建独立槽位。
rejects("第二个文档", () => editor.createDocument(JSON.stringify({ width: 8, height: 8 })), "独立文档槽位");
// 可绘画：真实笔迹在真 WASM 上落盘。
editor.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
editor.execute(
  "paint.stroke",
  JSON.stringify({ points: [[4, 5], [7, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels" })
);

// --- U04 File Info：真 WASM 上一步历史、无变化不加历史 ----------------------
editor.fileInfo(JSON.stringify({ title: "封面", author: "摄影组" }));
assert.equal(info(editor).title, "封面");
const afterFirst = history(editor);
const hashAfterFirst = editor.contentHash();
// 重复提交相同内容：不得压入新的历史步（上游无条件 edit 的缺陷由此暴露）。
editor.fileInfo(JSON.stringify({ title: "封面", author: "摄影组" }));
assert.deepEqual(history(editor), afterFirst, "无变化的 File Info 不得新增历史");
assert.equal(editor.contentHash(), hashAfterFirst, "元数据不改变内容身份");
// 真改一次：一步历史。
editor.fileInfo(JSON.stringify({ title: "封面（改）" }));
assert.equal(info(editor).title, "封面（改）");
assert.equal(history(editor).length, afterFirst.length + 1);
assert.equal(editor.contentHash(), hashAfterFirst, "元数据仍不改变内容身份");

// --- U04 预设 / 最近：真 WASM 必须接受界面发出的参数形状 --------------------
// 界面只发设置字段（不含文档名）；多一个 `name` 在过去会让保存必然失败。
editor.documentPresets(
  "save",
  JSON.stringify({ name: "方形海报", settings: { width: 800, height: 800, resolution: 72, mode: "rgb", depth: 8, background: "white" } })
);
const presets = JSON.parse(editor.documentPresets("list", "null")).presets;
assert.equal(presets.length, 1);
assert.equal(presets[0].name, "方形海报");
assert.equal(presets[0].settings.width, 800);
editor.recordRecentDocument(JSON.stringify({ width: 640, height: 480, resolution: 72, mode: "rgb", depth: 8, background: "white" }));
// 新建时已簿记一条，再记一条不同尺寸 → 两条（最新在前）。
assert.equal(JSON.parse(editor.recentDocuments()).recent.length, 2);
assert.equal(JSON.parse(editor.recentDocuments()).recent[0].width, 640, "最近项最新在前");
rejects(
  "同名预设",
  () => editor.documentPresets("save", JSON.stringify({ name: "方形海报", settings: { width: 800, height: 800, resolution: 72, mode: "rgb", depth: 8, background: "white" } })),
  "already exists"
);
rejects("未知预设操作", () => editor.documentPresets("rename", "{}"), "未知的预设操作");
editor.documentPresets("delete", JSON.stringify({ name: "方形海报" }));
assert.equal(JSON.parse(editor.documentPresets("list", "null")).presets.length, 0);

// --- U02 整份复制：自包含工程字节，原文不被推进 -----------------------------
// 先加图层蒙版：spec 的成功证据点名「含组/蒙版文档」。
editor.execute("layer.layerMask.revealAll", "{}");
const maskedSource = JSON.parse(editor.stateJson()).document.layers.some((layer) => layer.maskEnabled === true);
assert.ok(maskedSource, "测试前提：源文档确实带图层蒙版");
const beforeDuplicate = { hash: editor.contentHash(), state: JSON.parse(editor.stateJson()).document };
const duplicate = editor.duplicateDocumentBytes("副本");
assert.ok(duplicate instanceof Uint8Array && duplicate.length > 0);
assert.equal(editor.contentHash(), beforeDuplicate.hash, "复制不得改变原文内容身份");
assert.equal(JSON.parse(editor.stateJson()).document.revision, beforeDuplicate.state.revision, "复制不得推进原文修订");
// 副本打开后必须自带蒙版（不能只保留空图层）。
const copy = new mod.WasmEditor();
copy.openProject(duplicate, "null");
assert.ok(
  JSON.parse(copy.stateJson()).document.layers.some((layer) => layer.maskEnabled === true),
  "副本必须保留图层蒙版"
);
copy.free();

// --- U03 恢复基线：真 WASM 上一步历史且尺寸回到基线 -------------------------
const baseline = new mod.WasmEditor();
baseline.execute("file.new", JSON.stringify({ width: 24, height: 16, name: "baseline" }));
const baselineBytes = baseline.saveProject();
baseline.free();
editor.restoreSavedBaseline(baselineBytes, "");
assert.equal(JSON.parse(editor.stateJson()).document.width, 24);
// 非工程字节必须被拒绝且不破坏现场。
rejects("坏基线", () => editor.restoreSavedBaseline(new Uint8Array([1, 2, 3, 4]), ""), "工程");
assert.equal(JSON.parse(editor.stateJson()).document.width, 24, "坏基线不得改变现场");

// --- U01 独立文档槽位：候选实例产出工程字节，宿主能开成第二个文档 ----------------
// 这是「已有文档时再新建」的真实落地方式：一个会话一个槽位，所以候选实例建好文档后
// 序列化成自包含工程包，宿主用自己的打开路径落地成独立文档/标签。
const slotCandidate = new mod.WasmEditor();
slotCandidate.createDocument(
  JSON.stringify({ width: 120, height: 80, resolution: 300, background: "transparent", name: "第二份" })
);
slotCandidate.execute("layer.new.layer", JSON.stringify({ name: "层" }));
const slotBytes = slotCandidate.saveProject();
slotCandidate.free();
assert.ok(slotBytes instanceof Uint8Array && slotBytes.length > 0, "候选实例应产出工程字节");

// 落成独立文档：尺寸/DPI/背景与图层结构必须完整保留，不能被压平成位图。
const slotOpened = new mod.WasmEditor();
slotOpened.openProject(slotBytes, "file-project");
const slotDoc = JSON.parse(slotOpened.stateJson()).document;
assert.equal(slotDoc.width, 120);
assert.equal(slotDoc.height, 80);
assert.equal(slotDoc.resolution, 300);
assert.equal(slotDoc.layers.length, 2, "新文档必须保留全部图层（背景 + 新层），不能被压平");
// 落成后它就是一个正常可编辑文档。
slotOpened.execute("layer.new.layer", JSON.stringify({ name: "第三层" }));
assert.equal(JSON.parse(slotOpened.stateJson()).document.layers.length, 3);
slotOpened.free();

editor.free();
console.log(
  "文件工作流真 WASM 校验通过：命令门、新建/拒绝第二份、独立槽位字节往返（尺寸/DPI/图层完整）、File Info 一步历史与无变化、预设/最近参数形状、整份复制（含蒙版保留）、恢复基线与坏字节拒绝。"
);
