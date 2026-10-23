/**
 * U77 真实 WASM 主线回归（change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 用**构建出来的真实 WASM 产物**（`packages/editor/dist/wasm/`）跑验收主线：
 *
 *   导入三帧 → 编辑持续时间/顺序 → 定位绘画 → 保存重开 → 帧序列交付
 *
 * 与 Rust 单元测试的区别：这里走 wasm-bindgen 绑定（类型转换、字节传递、JSON 编码）与真实的
 * 内核命令门，因此能证明「WASM 面已接通」而不只是「Rust 函数可测」。
 *
 * 需要先构建产物：`pnpm -C photocraft run wasm`。缺产物时整组跳过并给出原因（不静默通过）。
 *
 * 运行：`node --test tests/features/animation/wasm-workflow.test.mjs`
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..", "..");
const wasmDir = join(packageRoot, "packages", "editor", "dist", "wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");
const built = existsSync(glue) && existsSync(binary);

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

/** 一帧纯色 RGBA8。 */
function solid(width, height, [r, g, b, a = 255]) {
  const frame = new Uint8Array(width * height * 4);
  for (let index = 0; index < frame.length; index += 4) {
    frame[index] = r;
    frame[index + 1] = g;
    frame[index + 2] = b;
    frame[index + 3] = a;
  }
  return frame;
}

function stack(frames) {
  const out = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

test("U77 主线：导入三帧 → 编辑 → 定位绘画 → 保存重开 → 帧交付", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));

    // 1. 帧导入：浏览器侧解码好的 3 帧 RGBA8 字节交给内核。
    const imported = JSON.parse(
      wasm.importFrames("我的三帧", 8, 8, 10, 3, stack([
        solid(8, 8, RED),
        solid(8, 8, GREEN),
        solid(8, 8, BLUE)
      ]))
    );
    assert.equal(imported.frames, 3);
    assert.equal(imported.duration, 3);
    assert.equal(imported.fps, 10);

    const info = () => JSON.parse(wasm.timelineJson());
    let timeline = info().timeline;
    assert.equal(timeline.duration, 3);
    assert.equal(timeline.fps, 10);
    assert.equal(timeline.current, 0);
    assert.equal(info().videoLayers[0].frames, 3);
    assert.equal(info().budget.maxFrames, 120);

    // 2. 每帧保留自己的像素（不能只取首帧）。
    const center = (4 * 8 + 4) * 4;
    for (const [index, expected] of [RED, GREEN, BLUE].entries()) {
      const rgba = wasm.renderFrame(index);
      assert.equal(rgba.length, 8 * 8 * 4);
      assert.deepEqual([...rgba.slice(center, center + 3)], expected, `第 ${index} 帧像素不符`);
    }

    // 3. 定位不新增历史（播放语义）。
    const moved = JSON.parse(wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 2 })));
    assert.equal(moved.historyAdded, 0);
    assert.equal(info().timeline.current, 2);
    assert.equal(wasm.contentHash().length > 0, true);

    // 4. 定位绘画：画到当前帧，写回后只影响这一帧。
    const painted = wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 1 }));
    assert.equal(JSON.parse(painted).historyAdded, 0);
    wasm.execute("paint.stroke", JSON.stringify({
      points: [[2, 2], [5, 5]], size: 4, hardness: 1, opacity: 1, flow: 1,
      color: "#ff0000", target: "pixels"
    }));
    const flushed = JSON.parse(wasm.flushVideoFrames());
    assert.equal(flushed.written, true);
    assert.deepEqual([...wasm.renderFrame(1).slice(center, center + 3)], RED);
    assert.deepEqual([...wasm.renderFrame(0).slice(center, center + 3)], RED, "第 0 帧本来是红色");
    assert.deepEqual([...wasm.renderFrame(2).slice(center, center + 3)], BLUE);

    // 5. 保存重开：持续时间、帧率、顺序与像素都随工程往返。
    const project = wasm.saveProject();
    assert.ok(project instanceof Uint8Array && project.length > 0);
    const reopened = await editor();
    try {
      reopened.openProject(project, "");
      const after = JSON.parse(reopened.timelineJson());
      assert.equal(after.timeline.duration, 3);
      assert.equal(after.timeline.fps, 10);
      assert.equal(after.videoLayers[0].frames, 3);
      assert.deepEqual([...reopened.renderFrame(0).slice(center, center + 3)], RED);
      assert.deepEqual([...reopened.renderFrame(2).slice(center, center + 3)], BLUE);

      // 6. 交付：计划 + 真实动画 GIF（不是只取首帧）。
      const plan = JSON.parse(reopened.deliveryPlan());
      assert.equal(plan.frames, 3);
      assert.equal(plan.width, 8);
      assert.equal(plan.frameBytes, 8 * 8 * 4);
      const gif = reopened.renderAnimationGif();
      assert.equal(String.fromCharCode(...gif.slice(0, 6)), "GIF89a");
      assert.equal(gif[gif.length - 1], 0x3b);
      assert.ok(gif.length > 3 * 64, "动画 GIF 应包含三帧数据");
    } finally {
      reopened.free();
    }

    // 7. 帧预算：121 帧被拒绝，且不留下半份时间轴。
    const before = wasm.contentHash();
    const frames = Array.from({ length: 121 }, () => solid(4, 4, RED));
    assert.throws(() => wasm.importFrames("太多", 4, 4, 30, 121, stack(frames)), /帧数超过上限/);
    assert.equal(wasm.contentHash(), before);

    // 8. 依赖文件路径或原生解复用的未移植命令保持关闭（浏览器没有等价物）。
    for (const id of [
      "layer.videoLayers.newVideoLayerFromFile",
      "layer.videoLayers.replaceFootage",
      "layer.videoLayers.reloadFrame",
      "file.import.videoFramesToLayers",
      "file.export.renderVideo"
    ]) {
      assert.equal(JSON.parse(wasm.allowedCommandIdsJson()).includes(id), false, `${id} 不应开放`);
      assert.throws(() => wasm.execute(id, "{}"), /能力|capability|未开放/);
    }
    // 已开放的时间轴命令都在唯一命令门里。
    const allowed = JSON.parse(wasm.allowedCommandIdsJson());
    for (const id of ["timeline.create", "timeline.setFrame", "layer.videoLayers.duplicateFrame"]) {
      assert.equal(allowed.includes(id), true, `${id} 应已开放`);
    }
  } finally {
    wasm.free();
  }
});

test("U77 时间轴与帧进入内容身份：改帧率改变指纹，定位与只读交付不变", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));
    const plain = wasm.contentHash();
    wasm.importFrames("身份", 8, 8, 24, 2, stack([solid(8, 8, RED), solid(8, 8, GREEN)]));
    const imported = wasm.contentHash();
    assert.notEqual(imported, plain, "导入帧后时间轴/帧栈属于内容");
    assert.notEqual(imported, "", "带帧工程的指纹必须可计算");

    // 播放头是会话视图：定位不改变指纹。
    wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 1 }));
    assert.equal(wasm.contentHash(), imported, "定位不改变内容身份");

    // 只读交付也不改变指纹。
    wasm.deliveryPlan();
    wasm.renderFrame(1);
    wasm.renderAnimationGif();
    assert.equal(wasm.contentHash(), imported, "只读交付不改变内容身份");

    // 帧率属于内容：改它必须改变指纹，改回去必须回到原值。
    wasm.setTimelineProps(JSON.stringify({ fps: 30 }));
    const at30 = wasm.contentHash();
    assert.notEqual(at30, imported, "改帧率必须改变 documentContentHash");
    wasm.setTimelineProps(JSON.stringify({ fps: 24 }));
    assert.equal(wasm.contentHash(), imported, "改回原值必须回到原指纹");

    // 播放头只是帧栈的投影：多走几帧再回来，指纹始终不变（宿主不会因为播放就报「已修改」）。
    for (const frame of [0, 1, 0, 1]) {
      wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame }));
      assert.equal(wasm.contentHash(), imported, `定位到第 ${frame} 帧不改变内容身份`);
    }

    // 但**未写回**的绘画编辑必须被算作内容变化，否则保存时会被当成无变化而丢掉。
    wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 0 }));
    wasm.execute("paint.stroke", JSON.stringify({
      points: [[4, 4], [4, 4]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#0000ff", target: "pixels"
    }));
    const painted = wasm.contentHash();
    assert.notEqual(painted, imported, "有未写回的编辑时指纹必须改变");
    const flushed = JSON.parse(wasm.flushVideoFrames());
    assert.equal(flushed.written, true);
    const afterFlush = wasm.contentHash();
    assert.notEqual(afterFlush, imported, "写回后帧栈已改，指纹仍不同于导入时");
    wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 1 }));
    assert.equal(wasm.contentHash(), afterFlush, "写回后再定位仍不改变内容身份");

    // 保存重开后指纹不变（摘要不能含图层 id）。
    const project = wasm.saveProject();
    const reopened = await editor();
    try {
      reopened.openProject(project, "");
      assert.equal(reopened.contentHash(), afterFlush, "重开不得改变内容身份");
    } finally {
      reopened.free();
    }
  } finally {
    wasm.free();
  }
});

test("U77 一次导入只记一步历史，撤销回到导入前", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));
    assert.equal(JSON.parse(wasm.timelineJson()).timeline, null);
    wasm.importFrames("三帧", 8, 8, 10, 3, stack([solid(8, 8, RED), solid(8, 8, GREEN), solid(8, 8, BLUE)]));
    assert.equal(JSON.parse(wasm.timelineJson()).timeline.duration, 3);
    // 导航与播放不产生历史：在 0/1/2 之间来回定位后，一次撤销仍回到导入前。
    for (const frame of [1, 2, 0, 2, 1]) {
      const moved = JSON.parse(wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame })));
      assert.equal(moved.historyAdded, 0);
    }
    wasm.undo();
    assert.equal(JSON.parse(wasm.timelineJson()).timeline, null, "撤销一次应回到导入前");
    wasm.redo();
    assert.equal(JSON.parse(wasm.timelineJson()).timeline.duration, 3);
  } finally {
    wasm.free();
  }
});

test("U77 非法输入整批拒绝，文档与身份保持不变", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));
    const before = wasm.contentHash();
    const beforeInfo = wasm.timelineJson();

    // 字节长度与 帧数×尺寸 不符：绑定层在分配前拒绝。
    assert.throws(() => wasm.importFrames("坏字节", 8, 8, 10, 2, new Uint8Array(8 * 8 * 4)), /帧字节长度/);
    // 帧率为 0 / 负数 / NaN 在预算检查里拒绝。
    for (const fps of [0, -5, Number.NaN]) {
      assert.throws(() => wasm.importFrames("坏帧率", 8, 8, fps, 1, solid(8, 8, RED)), /帧率/);
    }
    // 空帧序列拒绝。
    assert.throws(() => wasm.importFrames("空", 8, 8, 10, 0, new Uint8Array(0)), /没有可导入的帧|帧尺寸为 0/);
    // 尺寸为 0 拒绝。
    assert.throws(() => wasm.importFrames("零尺寸", 0, 8, 10, 1, new Uint8Array(0)), /帧尺寸为 0/);

    assert.equal(wasm.contentHash(), before, "失败的导入不得改变文档身份");
    assert.equal(wasm.timelineJson(), beforeInfo, "失败的导入不得留下半份时间轴");

    // 没有时间轴时交付按单帧处理；越界帧号拒绝。
    const plan = JSON.parse(wasm.deliveryPlan());
    assert.equal(plan.frames, 1);
    assert.throws(() => wasm.renderFrame(3), /帧号超出时间轴范围/);
    // 非法帧率的时间轴属性不落到文档。
    wasm.createTimeline(JSON.stringify({ duration: 4, fps: 24 }));
    assert.throws(() => wasm.setTimelineProps(JSON.stringify({ fps: -1 })), /帧率/);
    assert.throws(() => wasm.setTimelineProps(JSON.stringify({ duration: 0 })), /时长|帧/);
    assert.equal(JSON.parse(wasm.timelineJson()).timeline.fps, 24);
    // 没有原始素材时「恢复原始帧」必须拒绝：上游实现取不到原始素材就写空白帧，
    // 直接执行会把导入的帧清成空白（面板据此禁用按钮，但命令本身也要拒绝）。
    wasm.importFrames("原帧", 8, 8, 24, 2, stack([solid(8, 8, RED), solid(8, 8, BLUE)]));
    const beforeRestore = wasm.contentHash();
    for (const id of ["layer.videoLayers.restoreFrame", "layer.videoLayers.restoreAllFrames"]) {
      assert.throws(() => wasm.videoLayerCommand(id, "{}"), /原始素材/);
    }
    assert.equal(wasm.contentHash(), beforeRestore, "拒绝的恢复不得清空帧或改变身份");
    assert.equal(JSON.parse(wasm.timelineJson()).videoLayers[0].hasOriginal, false);

    // 显示原始素材是内容（`showAltered` 进摘要），且可以切回；栅格化后视频层变成普通像素层。
    wasm.videoLayerCommand("layer.videoLayers.showAlteredVideo", "{}");
    assert.equal(JSON.parse(wasm.timelineJson()).videoLayers[0].showAltered, false);
    wasm.videoLayerCommand("layer.videoLayers.showAlteredVideo", "{}");
    assert.equal(JSON.parse(wasm.timelineJson()).videoLayers[0].showAltered, true);
    assert.deepEqual(JSON.parse(wasm.videoLayerCommand("layer.videoLayers.rasterize", "{}")), { rasterized: true });
    assert.equal(JSON.parse(wasm.timelineJson()).videoLayers.length, 0, "栅格化后不再是视频层");

    // 视频命令门只接受已登记 id。
    assert.throws(() => wasm.videoLayerCommand("layer.videoLayers.replaceFootage", "{}"), /不是已开放的视频图层命令|能力/);
  } finally {
    wasm.free();
  }
});

test("U77 视频层命令与音频/路径命令的边界", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const wasm = await editor();
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));
    wasm.createTimeline(JSON.stringify({ duration: 4, fps: 24 }));
    const created = JSON.parse(wasm.videoLayerCommand("layer.videoLayers.newBlankVideoLayer", "{}"));
    assert.ok(created);
    let info = JSON.parse(wasm.timelineJson());
    assert.equal(info.videoLayers.length, 1);
    assert.equal(info.videoLayers[0].frames, 4);

    // 定位到 0 后复制/删除帧；时间轴时长随之变化。
    wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 0 }));
    wasm.videoLayerCommand("layer.videoLayers.duplicateFrame", "{}");
    info = JSON.parse(wasm.timelineJson());
    assert.equal(info.videoLayers[0].frames, 5);
    assert.equal(info.timeline.duration, 5);

    wasm.videoLayerCommand("layer.videoLayers.deleteFrame", "{}");
    info = JSON.parse(wasm.timelineJson());
    assert.equal(info.videoLayers[0].frames, 4);

    // 属性校验：非法帧率被拒绝且不写入半份时间轴。
    assert.throws(() => wasm.setTimelineProps(JSON.stringify({ fps: 0 })), /帧率/);
    assert.equal(JSON.parse(wasm.timelineJson()).timeline.fps, 24);
    // 帧数超预算被拒绝。
    assert.throws(() => wasm.createTimeline(JSON.stringify({ duration: 121 })), /121/);

    // 解释素材帧率只改视频层 fps（不读文件），非法值不写入。
    wasm.videoLayerCommand("layer.videoLayers.interpretFootage", JSON.stringify({ fps: 12 }));
    info = JSON.parse(wasm.timelineJson());
    assert.equal(info.videoLayers[0].fps, 12);
    assert.equal(info.timeline.fps, 24, "时间轴帧率不受影响");
    for (const bad of [0, -1, 1e9]) {
      assert.throws(() => wasm.videoLayerCommand("layer.videoLayers.interpretFootage", JSON.stringify({ fps: bad })), /帧率/);
    }
    assert.equal(JSON.parse(wasm.timelineJson()).videoLayers[0].fps, 12);
  } finally {
    wasm.free();
  }
});
