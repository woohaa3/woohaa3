/**
 * U74/U75/U76 真实 WASM 主线回归
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 用**构建出来的真实 WASM 产物**（`packages/editor/dist/wasm/`）跑验收主线：
 *
 *   命名快照 → 清理确认门 → 录制两步动作 → 播放对照 → ATN 往返
 *   → 两个文件前台批处理（+ 三文件取消）→ 数据集 CSV/像素替换/交付
 *
 * 与 Rust 单元测试的区别：这里走 wasm-bindgen 绑定（JSON 编解码、base64 字节传递、u32 队列
 * id）与真实的唯一命令门，能证明「WASM 面 + 命令门」已接通，而不只是「Rust 函数可测」。
 *
 * 需要先构建产物：`pnpm -C photocraft run wasm`。缺产物时整组跳过并给出原因（不静默通过）。
 *
 * 运行：`node --test tests/features/history/wasm-workflow.test.mjs`
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..", "..");
const wasmDir = join(packageRoot, "packages", "editor", "dist", "wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");
const built = existsSync(glue) && existsSync(binary);
const skip = built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）";

let module;
let initialized = false;
async function editor() {
  module ??= await import(pathToFileURL(glue));
  if (!initialized) {
    module.initSync({ module: readFileSync(binary) });
    initialized = true;
  }
  return new module.WasmEditor();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 最小 PNG 编码器（RGB8、无过滤）。
 *
 * 用真实 PNG 而不是「随便一段字节」：批处理与数据集替换都要求内核用真实解码器读它，
 * 否则测试证明不了「输入真的是图片」。
 */
function png(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (text) => Buffer.from(text, "base64");

/** PNG 尺寸（IHDR 前两个 u32）；用来证明交付的字节是真实可再打开的图片。 */
function pngSize(bytes) {
  const buffer = Buffer.from(bytes);
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "交付的不是 PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("U74 主线：命名快照、清理确认门与自历史新建", { skip }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 32, height: 24, name: "history" }));
    wasm.execute("layer.new.layer", JSON.stringify({ name: "底色" }));
    wasm.execute("paint.stroke", JSON.stringify({
      points: [[4, 4], [20, 14]], size: 8, hardness: 100, opacity: 100, flow: 100,
      color: "#c02020", mode: "normal", target: "pixels"
    }));

    const state = () => JSON.parse(wasm.historyStateJson());
    const before = state();
    assert.ok(before.entries.length >= 3, `需要可清理的历史：${before.entries}`);
    assert.equal(before.epoch.length > 0, true);
    // 历史源句柄：只有最后一个状态是活文档，消费者据此决定取样归档还是活文档。
    assert.deepEqual(before.sources.map((entry) => entry.live).filter(Boolean).length, 1);
    assert.equal(before.sources[before.sources.length - 1].live, true);
    // 快照视图里的 `activeLayer` 是活动图层 id，不是图层数量。
    assert.equal(before.snapshots.length, 0, "新文档还没有快照");

    // `epoch` 必须带文档身份：另建一份历史列表**完全相同**的文档，两者的 epoch 不能相同，
    // 否则历史画笔缓存的源会跨文档命中，取样 A 的归档状态可能落到 B 上。
    const twin = await editor();
    try {
      twin.execute("file.new", JSON.stringify({ width: 32, height: 24, name: "history" }));
      twin.execute("layer.new.layer", JSON.stringify({ name: "底色" }));
      twin.execute("paint.stroke", JSON.stringify({
        points: [[4, 4], [20, 14]], size: 8, hardness: 100, opacity: 100, flow: 100,
        color: "#c02020", mode: "normal", target: "pixels"
      }));
      const twinState = JSON.parse(twin.historyStateJson());
      assert.deepEqual(twinState.entries, before.entries, "构造前提：两份文档的历史标签相同");
      assert.notEqual(twinState.epoch, before.epoch, "历史相同的文档也不能共用 epoch");
    } finally {
      twin.free();
    }

    // 1. 快照：指向真实内容，不是标签。三种来源各取一份，内容不同。
    const taken = JSON.parse(wasm.newSnapshot(JSON.stringify({ name: "起点" })));
    assert.equal(taken.result.name, "起点");
    const snapshot = taken.result.snapshot;
    const mergedSnapshot = JSON.parse(wasm.newSnapshot(JSON.stringify({ name: "合并", from: "mergedLayers" }))).result.snapshot;
    const layerSnapshot = JSON.parse(wasm.newSnapshot(JSON.stringify({ name: "单层", from: "currentLayer" }))).result.snapshot;
    assert.equal(new Set([snapshot, mergedSnapshot, layerSnapshot]).size, 3, "快照 id 不重复");
    assert.throws(() => wasm.newSnapshot(JSON.stringify({ from: "everything" })), /from/);
    const withSnapshot = state();
    assert.deepEqual(withSnapshot.snapshots.map((entry) => entry.id), [snapshot, mergedSnapshot, layerSnapshot]);
    const layersAtSnapshot = JSON.parse(wasm.stateJson()).document.layers.length;

    wasm.execute("layer.new.layer", JSON.stringify({ name: "后续" }));
    assert.equal(JSON.parse(wasm.stateJson()).document.layers.length, layersAtSnapshot + 1);

    // 2. 回到快照是真实回滚，且是一个可撤销步骤。
    const hashAfterLayer = wasm.contentHash();
    const restored = JSON.parse(wasm.selectSnapshot(JSON.stringify({ snapshot })));
    assert.equal(restored.result.snapshot, snapshot);
    assert.equal(JSON.parse(wasm.stateJson()).document.layers.length, layersAtSnapshot);
    wasm.undo();
    assert.equal(wasm.contentHash(), hashAfterLayer, "回到快照必须可撤销");

    // 3. 清理确认门：不确认拒绝并说明范围；确认后不改像素/修订，只换历史源身份。
    const hash = wasm.contentHash();
    const revision = JSON.parse(wasm.stateJson()).document.revision;
    assert.throws(() => wasm.purge("undo", JSON.stringify({})), /不可恢复|确认/);
    assert.equal(wasm.contentHash(), hash);
    const plan = JSON.parse(wasm.purgePlanJson("histories"));
    assert.equal(plan.recoverable, false);
    assert.equal(plan.confirm.required, true);
    assert.equal(typeof plan.scope, "string");
    assert.ok(plan.scope.length > 0);

    const epochBefore = state().epoch;
    const purgePlan = JSON.parse(wasm.purgePlanJson("histories"));
    assert.equal(purgePlan.freed, undefined, "范围说明不伪造内核报告字段");
    const purged = JSON.parse(wasm.purge("histories", JSON.stringify({ confirm: true })));
    assert.equal(purged.freed !== undefined, true);
    // 确认框里承诺的字节数必须是这个范围**实际会释放**的量，否则它就是在骗人。
    assert.equal(purgePlan.bytes, purged.freed, `范围说明 ${purgePlan.bytes} ≠ 实际释放 ${purged.freed}`);
    assert.equal(purgePlan.available, true, "有历史可清时范围可用");
    assert.equal(wasm.contentHash(), hash, "清理不能改变当前像素");
    assert.equal(JSON.parse(wasm.stateJson()).document.revision, revision, "清理不是内容编辑");
    assert.notEqual(state().epoch, epochBefore, "历史源身份必须变化");
    // 清完之后同一范围在**确认前**就报不可用，并给出内核自己的原因（不是界面猜的）。
    const emptied = JSON.parse(wasm.purgePlanJson("histories"));
    assert.equal(emptied.bytes, 0);
    assert.equal(emptied.available, false, `清空后应报不可用：${JSON.stringify(emptied)}`);
    assert.match(emptied.reason, /no history to purge/);
    // 没有视频图层时这个范围释放 0 字节：不能把历史字节算进来吓人（用户确认后会看到什么都没清）。
    const video = JSON.parse(wasm.purgePlanJson("videoCache"));
    assert.equal(video.bytes, 0, "无视频图层时视频缓存范围释放 0 字节");

    // 4. 自当前状态新建文档：独立，不改源文档。
    //    内核这个命令会把**活动文档**切到新文档；域会话因此「取字节 → 立刻关闭派生文档」，
    //    否则宿主标签仍指向源文档，下一次保存会把派生内容写回源节点。这里钉住内核侧事实：
    //    派生文档可独立重开，关闭后回到源文档且指纹不变。
    const sourceHash = wasm.contentHash();
    const sourceLayers = JSON.parse(wasm.stateJson()).document.layers.length;
    const created = JSON.parse(wasm.newDocumentFromHistory(JSON.stringify({ name: "派生" })));
    assert.equal(created.result.name, "派生");
    assert.equal(JSON.parse(wasm.stateJson()).document.name, "派生", "内核切到了派生文档");
    const derivedBytes = wasm.saveProject();
    wasm.closeDocument();
    assert.equal(JSON.parse(wasm.stateJson()).document.name, "history", "关闭派生文档后回到源文档");
    assert.equal(wasm.contentHash(), sourceHash, "源文档内容没有被派生文档改动");
    assert.equal(JSON.parse(wasm.stateJson()).document.layers.length, sourceLayers);

    const reopenedDerived = await editor();
    try {
      reopenedDerived.openProject(derivedBytes, "");
      const derived = JSON.parse(reopenedDerived.stateJson()).document;
      assert.equal(derived.name, "派生", "派生文档是一份独立工程");
      assert.equal(derived.layers.length, sourceLayers, "派生内容取自所选历史状态");
    } finally {
      reopenedDerived.free();
    }

    // 5. `edit.purge.histories` 清的是**撤销状态**，命名快照是用户显式保存的资产，必须留下；
    //    而删除快照之后同一 id 就不能再用（不能静默回落到别的快照）。
    assert.equal(state().snapshots.some((entry) => entry.id === snapshot), true,
      "清理历史状态不得丢掉命名快照");
    assert.equal(JSON.parse(wasm.selectSnapshot(JSON.stringify({ snapshot }))).result.snapshot, snapshot);
    wasm.deleteSnapshot(JSON.stringify({ snapshot }));
    assert.equal(state().snapshots.some((entry) => entry.id === snapshot), false);
    assert.throws(() => wasm.selectSnapshot(JSON.stringify({ snapshot })), /快照|snapshot/);

    // 6. `epoch` 的身份语义（供历史画笔判定源是否仍可用）：不产生历史步骤的编辑不能让
    //    归档源失效——改变量只推进修订号，归档状态本身没变。
    const epochNow = state().epoch;
    const entryCount = state().entries.length;
    const layerForVar = JSON.parse(wasm.stateJson()).document.layers[0].id;
    wasm.defineVariables(JSON.stringify({
      defs: [{ name: "showTitle", layer: layerForVar, type: "visibility" }]
    }));
    assert.equal(state().entries.length, entryCount, "改变量不产生历史步骤");
    assert.equal(state().epoch, epochNow, "没有历史步骤时归档源仍然有效");

    // 7. 取样点是「正确失效历史画笔源」真正落地的地方：消费方把取源时的 epoch 一起送回，
    //    内核在读取点判定。清理后同一个索引指向别的内容，旧句柄必须被拒——而不是按索引
    //    取到新像素（那会让历史画笔画出「看起来对、其实不对」的内容）。
    const freshEpoch = state().epoch;
    const live = JSON.parse(wasm.sampleHistory(JSON.stringify({ epoch: freshEpoch, maxSide: 16 })));
    assert.equal(live.live, true, "不指定 state 时取活文档");
    assert.equal(live.width <= 16 && live.height <= 16, true, `maxSide 生效：${live.width}x${live.height}`);
    assert.equal(unb64(live.pixels).length, live.width * live.height * 4, "返回的是 RGBA8 预览");

    // 改变量之后源仍然有效（归档内容没变）。
    assert.equal(JSON.parse(wasm.sampleHistory(JSON.stringify({ epoch: freshEpoch }))).epoch, freshEpoch);

    // 7b. 历史画笔落笔前只需问「这个源还能用吗」：`preview: false` 走同一套身份与索引校验，
    //     但不合成缩略图（不返回 pixels，尺寸报的是源文档而不是缩略图）。
    const checked = JSON.parse(wasm.sampleHistory(JSON.stringify({ epoch: freshEpoch, state: 0, preview: false })));
    assert.equal(checked.pixels, undefined, "只校验时不返回像素");
    assert.equal(checked.state, 0);
    assert.equal(checked.live, false);
    assert.ok(checked.width >= checked.height, `报源文档尺寸：${checked.width}x${checked.height}`);
    assert.throws(() => wasm.sampleHistory(JSON.stringify({ epoch: "deadbeef", preview: false })), /已失效/);
    assert.throws(() => wasm.sampleHistory(JSON.stringify({ preview: false })), /epoch/);

    // 新增一步后旧句柄失效。
    wasm.execute("layer.new.layer", JSON.stringify({ name: "之后" }));
    assert.throws(() => wasm.sampleHistory(JSON.stringify({ epoch: freshEpoch })), /已失效/);

    // 重新取源可用；清理历史后它再次失效，且报错说清「不会按旧索引返回新内容」。
    const rebased = state().epoch;
    assert.equal(JSON.parse(wasm.sampleHistory(JSON.stringify({ epoch: rebased }))).epoch, rebased);
    wasm.purge("histories", JSON.stringify({ confirm: true }));
    assert.throws(() => wasm.sampleHistory(JSON.stringify({ epoch: rebased })), /已失效/);
    assert.throws(
      () => wasm.sampleHistory(JSON.stringify({ epoch: rebased, preview: false })),
      /已失效/,
      "只校验的路径同样拒绝过期句柄"
    );
    // 缺 epoch 的句柄无法判定失效，直接拒绝（不能默认「当前状态」）。
    assert.throws(() => wasm.sampleHistory(JSON.stringify({})), /epoch/);

  } finally {
    wasm.free();
  }
});

test("U74 主线：`all` 的范围说明覆盖剪贴板与渲染缓存，且等于实际释放量", { skip }, async () => {
  // `edit.purge.all` 不止清历史：它还丢剪贴板与四类渲染缓存。先前把 `all` 与 `histories`
  // 共用同一个求和，确认框就**低报**了几百 KiB 到几 MiB——用户会比较「清完怎么少了这么多」。
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 400, height: 300, name: "purge-all" }));
    for (const color of ["#c02020", "#20c020", "#2020c0"]) {
      wasm.execute("paint.stroke", JSON.stringify({
        points: [[5, 5], [380, 280]], size: 60, hardness: 100, color, target: "pixels"
      }));
    }
    // 复制一块真实像素（刚建的图层是空的，复制会被拒），这样剪贴板里确有字节。
    wasm.execute("select.rect", JSON.stringify({ x: 10, y: 10, width: 200, height: 200, mode: "replace" }));
    wasm.execute("edit.copy", JSON.stringify({}));

    const histories = JSON.parse(wasm.purgePlanJson("histories"));
    const clipboard = JSON.parse(wasm.purgePlanJson("clipboard"));
    assert.ok(histories.bytes > 0, `有历史可清：${JSON.stringify(histories)}`);
    assert.ok(clipboard.bytes > 0, `复制后剪贴板应有字节：${JSON.stringify(clipboard)}`);
    const all = JSON.parse(wasm.purgePlanJson("all"));
    assert.ok(
      all.bytes >= histories.bytes + clipboard.bytes,
      `「全部」至少覆盖历史 ${histories.bytes} + 剪贴板 ${clipboard.bytes}，实际 ${all.bytes}`
    );
    // `all` 还含没有公开字节读数的形状描边缓存，界面必须能把它标成近似值。
    assert.equal(all.approximate, true);
    assert.equal(histories.approximate, false);
    assert.equal(clipboard.approximate, false);
    const freed = JSON.parse(wasm.purge("all", JSON.stringify({ confirm: true })));
    assert.equal(all.bytes, freed.freed, `「全部」范围说明 ${all.bytes} ≠ 实际释放 ${freed.freed}`);
    // 清空之后这个范围在确认前就不可用，而不是让用户确认后收到 `nothing to purge`。
    const emptied = JSON.parse(wasm.purgePlanJson("all"));
    assert.equal(emptied.bytes, 0);
    assert.equal(emptied.available, false, `清空后应报不可用：${JSON.stringify(emptied)}`);
  } finally {
    wasm.free();
  }
});

test("U74 主线：形状描边缓存读不到字节，`all` 只会低报且必须自报近似", { skip }, async () => {
  // 上游 `purge_cache` 只给「清空并返回释放量」，没有「当前占多少」的读数。所以 `all` 的
  // `bytes` 是**低估值**：确认框不能把它说成精确值，也不能在恰好为 0 时说「不会腾出空间」。
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 300, height: 200, name: "stroke-cache" }));
    wasm.execute("shape.create", JSON.stringify({
      kind: "rect", rect: [20, 20, 200, 120], fill: "#20a020", stroke: { color: "#202020", width: 8 }
    }));
    // 描边缓存只在「形状被裁剪层盖住」时产生（Photoshop 把描边画在裁剪层之上）。
    wasm.execute("layer.new.layer", JSON.stringify({ name: "裁剪" }));
    wasm.execute("layer.createClippingMask", JSON.stringify({}));
    const preview = wasm.renderPreview(600, 400);
    preview?.free?.();

    const all = JSON.parse(wasm.purgePlanJson("all"));
    assert.equal(all.approximate, true, `all 必须自报近似：${JSON.stringify(all)}`);
    const freed = JSON.parse(wasm.purge("all", JSON.stringify({ confirm: true })));
    const strokes = freed.purged.includes("shape stroke cache");
    assert.ok(strokes, `本次应真的清到描边缓存：${JSON.stringify(freed)}`);
    // 低报方向：计划字节**小于**实际释放（差值就是读不到的那部分），绝不能反过来高报。
    assert.ok(
      freed.freed > all.bytes,
      `形状描边缓存读不到字节，实际 ${freed.freed} 应大于计划 ${all.bytes}`
    );
  } finally {
    wasm.free();
  }
});

test("U75 主线：录制两步动作、播放与手动一致、ATN 往返", { skip }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 24, height: 18, name: "actions" }));
    JSON.parse(wasm.recordAction(JSON.stringify({ name: "两步" })));
    wasm.execute("layer.new.layer", JSON.stringify({ name: "动作层" }));
    wasm.execute("layer.new.layer", JSON.stringify({ name: "第二层" }));
    JSON.parse(wasm.recordAction(JSON.stringify({ stop: true })));

    const detail = JSON.parse(wasm.actionsStateJson(JSON.stringify({ action: "两步" })));
    const ids = detail.detail.steps.map((step) => step[0]);
    assert.deepEqual(ids, ["layer.new.layer", "layer.new.layer"], "查询/失败命令不进录制");
    assert.equal(detail.preflight.playable, true);
    assert.equal(detail.budget.maxActions > 0, true);

    // 播放：逐步骤提交，结果与手动执行一致。
    const base = JSON.parse(wasm.historyStateJson()).entries.length;
    const replayed = JSON.parse(wasm.playAction(JSON.stringify({ action: "两步" })));
    assert.equal(replayed.ran, 2);
    assert.equal(replayed.failed, undefined);
    const names = () => JSON.parse(wasm.stateJson()).document.layers.map((layer) => layer.name);
    const viaAction = names();
    assert.equal(JSON.parse(wasm.historyStateJson()).entries.length, base + 2, "逐步可撤销");

    // ATN 往返：导出字节 → 另一会话导入 → 步骤一致。
    const saved = JSON.parse(wasm.saveActions(JSON.stringify({ action: "两步" })));
    const bytes = unb64(saved.data);
    assert.ok(bytes.length > 0, "导出的 .atn 不能是空文件");
    assert.throws(() => wasm.saveActions(JSON.stringify({ path: "/tmp/a.atn" })), /路径|path/);

    const other = await editor();
    try {
      other.execute("file.new", JSON.stringify({ width: 24, height: 18, name: "replay" }));
      const loaded = JSON.parse(other.loadActions(JSON.stringify({ data: saved.data })));
      assert.deepEqual(loaded.actions, ["两步"]);
      assert.deepEqual(loaded.unsupported, []);
      const imported = JSON.parse(other.actionsStateJson(JSON.stringify({ action: "两步" })));
      assert.deepEqual(imported.detail.steps.map((step) => step[0]), ids);
      JSON.parse(other.playAction(JSON.stringify({ action: "两步" })));
      assert.deepEqual(names().slice(-2), viaAction.slice(-2), "播放结果与手动执行一致");
    } finally {
      other.free();
    }

    // `.atn` 解析警告要如实返回：尾部多出 4 个字节时文件仍能导入，但内容可能少了东西。
    // 丢掉这条警告等于告诉用户「文件被完整读入」。
    const padded = unb64(saved.data);
    const noisy = new Uint8Array([...padded, 1, 2, 3, 4]);
    const reloaded = JSON.parse(wasm.loadActions(JSON.stringify({ data: b64(noisy) })));
    assert.equal(reloaded.warnings.length, 1, "解析警告必须返回");
    assert.match(reloaded.warnings[0], /trailing bytes/);

    // 路径输入一律拒绝：浏览器里没有可写路径。
    assert.throws(() => wasm.loadActions(JSON.stringify({ path: "/tmp/a.atn" })), /路径|path|data/);
    assert.throws(() => wasm.loadActions(JSON.stringify({ data: "不是 base64" })), /base64/);
    // 域内入口不能变成通用转发器。
    assert.throws(() => wasm.historyCommand("layer.new.layer", "{}"), /能力|capability|未开放/);
    assert.throws(() => wasm.actionCommand("filter.liquify", "{}"), /能力|capability|未开放/);

    // 步骤/条件编辑与动作集：面板用的就是这些命令，走 WASM 面同样可用。
    const inserted = JSON.parse(wasm.actionCommand("actions.insert", JSON.stringify({
      action: "两步", id: "actions.stopMessage", params: { message: "停" }
    })));
    assert.equal(inserted.id, "actions.stopMessage");
    assert.equal(inserted.step, 2, "默认追加到末尾");
    const dialog = JSON.parse(wasm.actionCommand("actions.dialog", JSON.stringify({ action: "两步", step: 0 })));
    assert.deepEqual(dialog.dialogs, [0]);
    const toggled = JSON.parse(wasm.actionCommand("actions.toggle", JSON.stringify({ action: "两步", step: 0 })));
    assert.deepEqual(toggled.disabled, [0]);
    const assigned = JSON.parse(wasm.actionCommand("actions.assignSet", JSON.stringify({ action: "两步", set: "常用" })));
    assert.equal(assigned.set, "常用");
    const cond = JSON.parse(wasm.actionCommand("actions.conditional", JSON.stringify({ if: "always", then: "两步", else: null })));
    assert.equal(cond.holds, true);
    assert.equal(cond.played, "两步");
    // 步骤移动 / 重命名 / 按钮颜色：面板的「上移/下移」「重命名」「按钮颜色」走这几条命令。
    const moved = JSON.parse(wasm.actionCommand("actions.move", JSON.stringify({ action: "两步", step: 2, to: 0 })));
    assert.equal(moved.step, 0);
    const renamed = JSON.parse(wasm.actionCommand("actions.rename", JSON.stringify({ action: "两步", name: "改名的两步" })));
    assert.equal(renamed.action, "改名的两步");
    const colored = JSON.parse(wasm.actionCommand("actions.setColor", JSON.stringify({ action: "改名的两步", color: "green" })));
    assert.equal(colored.color, "green");
    // 从第 N 步播放：`from` 是 0 基起点，跳过的步骤不执行。
    const fromSecond = JSON.parse(wasm.playAction(JSON.stringify({ action: "改名的两步", from: 1 })));
    assert.equal(fromSecond.ran, 1, "从第 2 步播放只跑一步");
    // 中途失败：`actions.play` 仍返回成功但带 `failed`，界面层据此报错（不能显示成功）。
    // 用一个独立动作，避免已有动作里的 stopMessage 先中止。
    JSON.parse(wasm.recordAction(JSON.stringify({ name: "会失败" })));
    JSON.parse(wasm.recordAction(JSON.stringify({ stop: true })));
    JSON.parse(wasm.actionCommand("actions.insert", JSON.stringify({ action: "会失败", id: "layer.new.layer", params: { name: "先成功" } })));
    JSON.parse(wasm.actionCommand("actions.insert", JSON.stringify({ action: "会失败", id: "layer.select", params: { layer: 9999 } })));
    const halted = JSON.parse(wasm.playAction(JSON.stringify({ action: "会失败" })));
    assert.equal(halted.failed.id, "layer.select", `${JSON.stringify(halted)}`);
    assert.equal(halted.failed.step, 1);
    assert.equal(halted.ran, 1, "失败前的步骤已经执行并保留");
    assert.ok(halted.failed.error.length > 0);
    // 快捷键摘要可读（只读端口）。
    assert.ok(Array.isArray(JSON.parse(wasm.actionShortcutsJson()).bindings));
  } finally {
    wasm.free();
  }
});

test("U76 主线：两个文件前台批处理逐文件交付，三文件取消后不再启动", { skip }, async () => {
  const wasm = await editor();
  try {
    const a = png(12, 10, [255, 0, 0]);
    const b = png(20, 16, [0, 0, 255]);
    const begun = JSON.parse(wasm.beginBatch(JSON.stringify({
      mode: "batch",
      format: "png",
      input: [{ name: "a.png", data: b64(a) }, { name: "b.png", data: b64(b) }],
      steps: [["image.imageSize", { width: 6, height: 5, resample: "bicubic" }]]
    })));
    assert.equal(begun.files, 2);
    const queue = begun.queue;

    const first = JSON.parse(wasm.stepBatch(queue));
    assert.equal(first.completed, 1);
    assert.equal(first.remaining, 1);
    assert.equal(first.running, true);
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].file, "a.png");
    assert.equal(first.results[0].ok, true);

    const taken = JSON.parse(wasm.takeBatchFile(queue, 0));
    const output = unb64(taken.data);
    assert.deepEqual(pngSize(output), { width: 6, height: 5 }, "交付的是真实可再打开的图片，且步骤已生效");
    // 字节只能领取一次，避免重复交付。
    assert.throws(() => wasm.takeBatchFile(queue, 0), /没有可交付|失败项|已交付/);

    const second = JSON.parse(wasm.stepBatch(queue));
    assert.equal(second.completed, 2);
    assert.equal(second.running, false);
    assert.equal(second.results[1].file, "b.png");
    const finished = JSON.parse(wasm.finishBatch(queue));
    assert.equal(finished.completed, 2);
    assert.equal(finished.cancelled, false);
    // 收尾后队列失效：不会继续跑，也不会伪造结果。
    assert.throws(() => wasm.stepBatch(queue), /不存在|已收尾/);
    assert.equal(JSON.parse(wasm.finishBatch(queue)).total, 0);
    // 关键语义：第 1 项**没有领取**就被收尾了，字节随队列消失。面板必须在这之前提醒，
    // 不能让用户以为「收尾」只是整理列表。
    assert.throws(() => wasm.takeBatchFile(queue, 1), /不存在|已收尾/);

    // 取消：只保留已完成项，剩余项不再启动。
    const three = [a, b, png(8, 8, [0, 255, 0])].map((bytes, index) => ({ name: `${index}.png`, data: b64(bytes) }));
    const queue2 = JSON.parse(wasm.beginBatch(JSON.stringify({ mode: "batch", input: three }))).queue;
    assert.equal(JSON.parse(wasm.stepBatch(queue2)).completed, 1);
    const cancelled = JSON.parse(wasm.cancelBatch(queue2));
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.total, 1, "取消后剩余项被丢弃");
    const after = JSON.parse(wasm.stepBatch(queue2));
    assert.equal(after.completed, 1, "取消后不再启动下一项");
    assert.equal(JSON.parse(wasm.finishBatch(queue2)).completed, 1);

    // 超预算/未知步骤在 begin 就拒绝，不留下队列。
    assert.throws(() => wasm.beginBatch(JSON.stringify({ input: [] })), /输入|文件/);
    assert.throws(
      () => wasm.beginBatch(JSON.stringify({ input: [{ name: "a.png", data: b64(a) }], steps: [["filter.liquify", {}]] })),
      /不可执行/
    );
    assert.throws(
      () => wasm.beginBatch(JSON.stringify({ mode: "background", input: [{ name: "a.png", data: b64(a) }] })),
      /未知的前台自动化|模式|mode/
    );

    // 联系表：网格（列×行）决定版面，容量不足在开始前就拒绝——面板必须能改这两个参数，
    // 否则用户选 31 张只会得到一句无从自救的拒绝（默认网格 5×6=30 格）。
    const many = Array.from({ length: 31 }, (_, index) => ({ name: `m${index}.png`, data: b64(a) }));
    assert.throws(
      () => wasm.beginBatch(JSON.stringify({ mode: "contactSheet", input: many })),
      /网格容量|超过/
    );
    const wide = JSON.parse(wasm.beginBatch(JSON.stringify({ mode: "contactSheet", input: many, columns: 8, rows: 6 })));
    assert.equal(wide.files, 31);
    wasm.cancelBatch(wide.queue);
    wasm.finishBatch(wide.queue);

    // 联系表与载入堆栈：多输入一份输出。
    for (const mode of ["contactSheet", "loadStack"]) {
      const begunMode = JSON.parse(wasm.beginBatch(JSON.stringify({
        mode,
        input: [{ name: "a.png", data: b64(a) }, { name: "b.png", data: b64(b) }]
      })));
      const progress = JSON.parse(wasm.stepBatch(begunMode.queue));
      assert.equal(progress.results.length, 1, `${mode} 是多输入一份输出`);
      const bytes = unb64(JSON.parse(wasm.takeBatchFile(begunMode.queue, 0)).data);
      const size = pngSize(bytes);
      if (mode === "loadStack") {
        assert.deepEqual(size, { width: 20, height: 16 }, "堆栈画布取最大输入");
      } else {
        assert.ok(size.width > 12, "联系表按网格排布");
      }
      wasm.finishBatch(begunMode.queue);
    }
  } finally {
    wasm.free();
  }
});

test("U76 主线：变量与数据集的 CSV 往返、像素替换只记一步历史", { skip }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 40, height: 30, name: "数据驱动" }));
    wasm.execute("layer.new.layer", JSON.stringify({ name: "标题" }));
    const title = JSON.parse(wasm.stateJson()).document.activeLayer;
    wasm.execute("layer.new.layer", JSON.stringify({ name: "图片" }));
    const picture = JSON.parse(wasm.stateJson()).document.activeLayer;

    const defined = JSON.parse(wasm.defineVariables(JSON.stringify({
      defs: [
        { name: "showTitle", layer: title, type: "visibility" },
        { name: "photo", layer: picture, type: "pixelReplacement", method: "fill", align: "center", clip: true }
      ]
    })));
    assert.equal(defined.defs.length, 2);

    // 定义是**整份替换**：面板必须重发「现有 + 新增」，否则会静默丢掉先前的变量。
    const replaced = JSON.parse(wasm.defineVariables(JSON.stringify({
      defs: [{ name: "photo", layer: picture, type: "pixelReplacement", method: "fill", align: "center", clip: true }]
    })));
    assert.deepEqual(replaced.defs.map((def) => def.name), ["photo"], "define 是替换而不是追加");
    // 选项展平在 def 上；面板重发时必须原样带回，否则会重置成内核默认值。
    assert.equal(replaced.defs[0].method, "fill");
    assert.equal(replaced.defs[0].clip, true);

    // 变量种类必须与图层内容相容：上游只查图层存在，绑错会在应用数据集时被静默跳过。
    assert.throws(
      () => wasm.defineVariables(JSON.stringify({
        defs: [{ name: "photo", layer: picture, type: "textReplacement" }]
      })),
      /文字替换|跳过/
    );
    // 被拒绝的定义不能只写进去一半：先前的变量仍在。
    assert.deepEqual(JSON.parse(wasm.variablesStateJson()).defs.map((def) => def.name), ["photo"]);
    // 恢复到两个变量，后续 CSV/像素断言依赖它们。
    JSON.parse(wasm.defineVariables(JSON.stringify({
      defs: [
        { name: "showTitle", layer: title, type: "visibility" },
        { name: "photo", layer: picture, type: "pixelReplacement", method: "fill", align: "center", clip: true }
      ]
    })));

    // CSV 导入：未定义列有报告，不是一个静默丢弃。
    const imported = JSON.parse(wasm.importDataSets(
      JSON.stringify({}),
      "DataSet,showTitle,photo,未定义列\ntrue 行,false,red,x\n第二行,true,blue,y\n"
    ));
    assert.equal(imported.imported, 2);
    assert.equal(imported.named, true);
    assert.deepEqual(imported.skipped.map((entry) => entry.column), ["未定义列"]);

    const state = () => JSON.parse(wasm.variablesStateJson());
    assert.equal(state().dataSets.length, 2);
    // 预算随视图下发：面板要在读文件之前就拒绝，而不是先加载再失败。
    assert.ok(state().budget.maxCsvBytes > 0);
    assert.ok(state().budget.maxDataSets > 0);

    // CSV 导出 → 再导入稳定。
    const csv = JSON.parse(wasm.exportDataSetsCsv());
    assert.match(csv.text, /showTitle/);
    assert.match(csv.text, /red/);
    const again = JSON.parse(wasm.importDataSets(JSON.stringify({ append: false }), csv.text));
    assert.equal(again.imported, 2);
    assert.deepEqual(again.dataSets.map((set) => set.name), ["true 行", "第二行"]);

    // 像素替换：一步历史；缺字节整次拒绝。
    const before = JSON.parse(wasm.historyStateJson()).entries.length;
    const images = { red: b64(png(8, 8, [255, 0, 0])), blue: b64(png(8, 8, [0, 0, 255])) };
    const applied = JSON.parse(wasm.applyDataSet(JSON.stringify({ name: "true 行", images })));
    assert.equal(applied.applied, "true 行");
    assert.equal(applied.index, 0);
    assert.equal(JSON.parse(wasm.historyStateJson()).entries.length, before + 1, "应用数据集是一步可撤销的内容编辑");
    const hashRed = wasm.contentHash();
    assert.throws(() => wasm.applyDataSet(JSON.stringify({ name: "第二行" })), /资源|字节|red|blue/);
    assert.equal(wasm.contentHash(), hashRed, "缺字节不能保留旧像素冒充成功");

    // 重复应用同一数据集是幂等的。
    JSON.parse(wasm.applyDataSet(JSON.stringify({ name: "true 行", images })));
    assert.equal(wasm.contentHash(), hashRed);

    // 删除一个数据集：内核没有单项删除，只能在重发全集时原样带回其余条目。
    // 这条在真实 WASM 里跑，是因为「原样」依赖内核真实的 `{variable, kind, value}` 形状——
    // 用 `{name, values: 2}` 这样的摘要重发会被直接拒绝（`a value needs kind and value`）。
    const setsBefore = state().dataSets;
    assert.equal(setsBefore.length, 2);
    const resend = JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));
    assert.deepEqual(resend.dataSets, setsBefore, "原样重发必须幂等");
    const kept = JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: [setsBefore[1]] })));
    assert.deepEqual(kept.dataSets.map((set) => set.name), ["第二行"]);
    assert.deepEqual(kept.dataSets[0].values, setsBefore[1].values, "其余数据集的取值必须一字不改");
    // `active` 是下标：删掉排在前面的一组之后必须按**名称**重定位，否则界面会把别的组
    // 标成「当前生效」。先还原成两条并让第二行生效，再删掉第一行：`active` 应从 1 变 0。
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));
    JSON.parse(wasm.applyDataSet(JSON.stringify({ name: "第二行", images })));
    assert.equal(state().active, 1);
    const shifted = JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: [setsBefore[1]] })));
    assert.equal(shifted.active, 0, "删掉排在前面的数据集后，生效项要跟着它自己走");
    assert.deepEqual(shifted.dataSets[0].values, setsBefore[1].values);
    // 删掉正在生效的那组：`active` 清空，而不是留一个指向别人的下标。
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));
    JSON.parse(wasm.applyDataSet(JSON.stringify({ name: "第二行", images })));
    const cleared = JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: [setsBefore[0]] })));
    assert.equal(cleared.active, null, "生效的那组被删掉后不应指向别人");
    // 重定位结果会随工程持久化：保存重开后仍是重定位后的下标（不是旧下标）。
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));
    JSON.parse(wasm.applyDataSet(JSON.stringify({ name: "第二行", images })));
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: [setsBefore[1]] })));
    {
      const bytes = wasm.saveProject();
      const reopened = await editor();
      try {
        reopened.openProject(bytes, "reopen");
        const state2 = JSON.parse(reopened.variablesStateJson());
        assert.equal(state2.active, 0, "重开后生效项仍指向同一组，不回到旧下标");
        assert.deepEqual(state2.dataSets.map((set) => set.name), ["第二行"]);
      } finally {
        reopened.free();
      }
    }
    // 恢复两条，供后面的交付断言使用。
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));
    // 只给条数（`values: 2`）**不会**报错——上游把非数组的 `values` 当空列表，于是这条数据集
    // 被静默清空成「0 个值」。这比报错更危险，也正是解码器必须保留 `entries` 的原因：
    // 面板据「条数 == 原样取值数」判断能否安全重发，拿不到原始取值就不提供删除。
    const hollowed = JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: [{ name: "第二行", values: 2 }] })));
    assert.deepEqual(hollowed.dataSets, [{ name: "第二行", values: [] }], "只给条数会被当成空取值");
    // 恢复原状，后续断言依赖这两条数据集。
    JSON.parse(wasm.setDataSets(JSON.stringify({ dataSets: setsBefore })));

    // 数据集交付为文件：字节可再打开，撞名在编码前拒绝。
    const exported = JSON.parse(wasm.exportDataSetsAsFiles(JSON.stringify({ images })));
    assert.equal(exported.count, 2);
    for (const file of exported.files) {
      assert.match(file.fileName, /\.png$/);
      assert.deepEqual(pngSize(unb64(file.data)), { width: 40, height: 30 });
    }
    assert.throws(
      () => wasm.exportDataSetsAsFiles(JSON.stringify({ images, naming: "same" })),
      /同一个文件/
    );

    // 受限脚本：未知步骤在执行前整组拒绝；允许的步骤逐条执行。
    const layers = JSON.parse(wasm.stateJson()).document.layers.length;

    assert.throws(
      () => wasm.runScript(JSON.stringify({ steps: [["layer.new.layer", { name: "不该出现" }], ["filter.liquify", {}]] })),
      /不可执行/
    );
    assert.equal(JSON.parse(wasm.stateJson()).document.layers.length, layers);
    const ran = JSON.parse(wasm.runScript(JSON.stringify({ steps: [["layer.new.layer", { name: "脚本层" }]] })));
    assert.equal(ran.ok, true);
    assert.equal(JSON.parse(wasm.stateJson()).document.layers.length, layers + 1);
    assert.throws(() => wasm.runScript(JSON.stringify({ script: "app.activeDocument.close()" })), /ExtendScript|不可执行/);

    // 平台暂缓项保持关闭：原生 Droplet、任意脚本事件、后台批处理、MCP。
    const allowed = JSON.parse(wasm.allowedCommandIdsJson());
    for (const id of [
      "file.automate.createDroplet",
      "file.automate.runDroplet",
      "file.scripts.scriptEventsManager",
      "automation.mcp"
    ]) {
      assert.equal(allowed.includes(id), false, `${id} 必须保持关闭`);
      assert.throws(() => wasm.execute(id, "{}"), /能力|capability|未开放/);
    }
    // 已接通的本域命令都在唯一命令门里。
    for (const id of [
      "history.newSnapshot",
      "history.selectSnapshot",
      "edit.purge.undo",
      "actions.record",
      "actions.play",
      "actions.load",
      "actions.save",
      "variables.list",
      "image.variables.define",
      "image.variables.dataSets",
      "image.applyDataSet"
    ]) {
      assert.equal(allowed.includes(id), true, `${id} 应已开放`);
    }
    // 需要文件夹路径的上游自动化命令**不登记**：浏览器里必然失败，登记只会造出假入口。
    // 批处理/脚本/CSV 数据集走本域字节入口（`beginBatch` 等），不经过命令门。
    for (const id of [
      "file.automate.batch",
      "file.scripts.imageProcessor",
      "file.scripts.browse",
      "file.scripts.loadFilesIntoStack",
      "file.automate.contactSheetII",
      "file.import.variableDataSets",
      "file.export.dataSetsAsFiles"
    ]) {
      assert.equal(allowed.includes(id), false, `${id} 需要路径，不应登记`);
    }
  } finally {
    wasm.free();
  }
});
