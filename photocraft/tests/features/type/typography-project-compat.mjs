/**
 * 旧工程兼容与内容身份的域内实测（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 需要先构建真实内核：
 *
 *   pnpm -C photocraft run wasm
 *   node photocraft/tests/features/type/typography-project-compat.mjs
 *
 * 这是 tasks 3.2 中**本域可自动化**的部分：把本域新增的持久字段
 * （`warp` / `antialias` / `features` / `text_styles` / `style_sheet`）从导出的 manifest 里删掉，
 * 模拟这次功能上线前的旧工程，再确认：
 *
 * 1. 旧工程仍能打开，文字层与正文都在；
 * 2. 旧工程的内容身份**等于**从未写过这些字段的值（「空新字段不改变旧身份」）；
 * 3. 去掉新字段后本域查询仍可用（排版投影不依赖这些字段存在）。
 *
 * 它**不**证明内容身份包含完整排版：那需要修改共享的 `document_content.rs`（见 verification 缺口 1）。
 * 本脚本只在 zip 层改写 manifest，不引入第二套摘要。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/editor/dist/wasm");
const glue = path.join(root, "photocraft_editor.js");
const wasm = path.join(root, "photocraft_editor_bg.wasm");
if (!fs.existsSync(glue) || !fs.existsSync(wasm)) {
  console.error(`缺少已构建内核：先运行 pnpm -C photocraft run wasm（${root}）`);
  process.exit(2);
}

const mod = await import(glue);
mod.initSync({ module: fs.readFileSync(wasm) });

/**
 * 本域这次新增的持久字段：旧工程里不存在这些键。
 *
 * 注意 `style_sheet` **不在此列**：它是上游既有的段落样式表索引（只在应用样式时出现），
 * 不属于本 change 新增的持久面，删它不是「旧工程」的合理模拟。
 */
const NEW_KEYS = ["warp", "antialias", "features", "text_styles"];

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail).slice(0, 300)}`}`);
};

// ---- 最小 zip 读写（只处理 stored/deflate，用于改写 manifest，不校验签名） ----
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("工程不是 zip：找不到 EOCD");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    entries.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
  }
  return entries;
}

function crc32(data) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(data) >>> 0;
  let value = ~0;
  for (const byte of data) {
    value ^= byte;
    for (let k = 0; k < 8; k += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return ~value >>> 0;
}

function writeZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    Buffer.from(nameBytes).copy(local, 30);
    parts.push(local, compressed);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...centrals, eocd]);
}

function stripNewKeys(value, removed) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (NEW_KEYS.includes(key)) { delete value[key]; removed.add(key); } else stripNewKeys(value[key], removed);
  }
}

// ---- 场景 1：旧工程没有新字段，内容身份与「从未写过」一致 ----
{
  const editor = new mod.WasmEditor();
  editor.execute("file.new", JSON.stringify({ width: 200, height: 100, background: "white" }));
  const layer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 10, y: 40, text: "Legacy text", size: 20, font: "Inter" }))).layer;
  const baseline = editor.contentHash();
  editor.typeCommand("type.warpText", JSON.stringify({ layer, style: "arc", bend: 20 }));
  editor.typeCommand("type.antiAlias.none", JSON.stringify({ layer }));
  editor.typeCommand("type.openType.fractions", JSON.stringify({ layer, on: true }));
  editor.typeCommand("type.characterStyle.new", JSON.stringify({ name: "标题", layer }));

  const bundle = editor.exportBundle();
  const original = Buffer.from(bundle.project);
  bundle.free();
  editor.free();

  const entries = readZip(original);
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  check("工程包含 manifest.json", Boolean(manifestEntry));
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));

  // 先确认导出里**确实**有新字段，否则「删掉再开」什么也没证明。
  const serialized = JSON.stringify(manifest);
  for (const key of ["warp", "antialias", "features", "text_styles"]) {
    check(`导出包含新字段 ${key}`, serialized.includes(`"${key}"`));
  }

  const removed = new Set();
  stripNewKeys(manifest, removed);
  // 否则「删掉再开」什么也没证明：必须确认这些键确实存在于导出里并被移除。
  for (const key of NEW_KEYS) check(`导出确实含有可移除的 ${key}`, removed.has(key), [...removed]);
  const stripped = writeZip(entries.map((entry) => (
    entry.name === "manifest.json" ? { name: entry.name, data: Buffer.from(JSON.stringify(manifest)) } : entry
  )));

  const reopened = new mod.WasmEditor();
  reopened.openProject(stripped, "");
  const state = JSON.parse(reopened.stateJson());
  check("旧工程可以打开", state.document.layers.length > 0);
  check("旧工程保留文字层", state.document.layers.some((item) => item.kind === "Type"));
  check("旧工程保留正文", state.document.layers.some((item) => item.text?.text === "Legacy text"));
  // 关键结论：去掉新字段后，内容身份回到从未写过它们的值。
  check("空新字段不改变旧身份", reopened.contentHash() === baseline, {
    old: reopened.contentHash(),
    baseline
  });
  // 去掉了新字段，本域投影必须仍然可读，且字号仍是导出前的 20pt（不是被重置成默认值）。
  const reopenedLayer = state.document.layers.find((item) => item.kind === "Type").id;
  const info = JSON.parse(reopened.typeQuery("type.info", JSON.stringify({ layer: reopenedLayer })));
  check("旧工程仍可查询排版", Array.isArray(info.runs) && info.runs.length > 0);
  check("旧工程保留原字号", info.runs?.[0]?.style?.size_pt === 20, info.runs?.[0]?.style);
  reopened.free();
}

// ---- 场景 2：旧工程去掉新字段后仍能继续写入、导出并重开（前向再兼容） ----
{
  const editor = new mod.WasmEditor();
  editor.execute("file.new", JSON.stringify({ width: 160, height: 90, background: "white" }));
  const layer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 8, y: 30, text: "Forward", size: 16, font: "Inter" }))).layer;
  const bundle = editor.exportBundle();
  const entries = readZip(Buffer.from(bundle.project));
  bundle.free();
  editor.free();

  const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === "manifest.json").data));
  const removed = new Set();
  stripNewKeys(manifest, removed);
  const stripped = writeZip(entries.map((entry) => (
    entry.name === "manifest.json" ? { name: entry.name, data: Buffer.from(JSON.stringify(manifest)) } : entry
  )));

  const reopened = new mod.WasmEditor();
  reopened.openProject(stripped, "");
  const before = JSON.parse(reopened.typeQuery("type.info", JSON.stringify({ layer })));
  check("旧工程变形字段为空", before.warp === null, before.warp);

  const warped = JSON.parse(reopened.typeCommand("type.warpText", JSON.stringify({ layer, style: "arc", bend: 30 })));
  check("旧工程可继续应用变形", warped.result !== undefined);
  const afterWarp = JSON.parse(reopened.typeQuery("type.info", JSON.stringify({ layer })));
  check("旧工程写入后模型有变形", afterWarp.warp?.value === 30 && afterWarp.warp?.style === "warpArc", afterWarp.warp);

  // 重新导出再重开：变形是持久字段，必须原样回来（不是只证明「有 runs」）。
  const next = reopened.exportBundle();
  const again = new mod.WasmEditor();
  again.openProject(Buffer.from(next.project), "");
  const roundTripped = JSON.parse(again.typeQuery("type.info", JSON.stringify({ layer })));
  check("再次导出后重开保留变形", roundTripped.warp?.value === 30 && roundTripped.warp?.style === "warpArc", roundTripped.warp);
  check("再次导出后重开保留正文", roundTripped.text === "Forward", roundTripped.text);
  next.free();
  again.free();
  reopened.free();
}

if (failures) {
  console.error(`旧工程兼容实测失败 ${failures} 项`);
  process.exit(1);
}
console.log("旧工程兼容实测通过：缺失新字段的工程可打开、内容身份回到旧值、仍可查询与继续写入");
