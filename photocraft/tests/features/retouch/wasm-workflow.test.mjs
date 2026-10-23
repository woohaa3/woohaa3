/**
 * U37/U38/U39 真实 WASM 主线回归
 * （change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 用**构建出来的真实 WASM 产物**（`packages/editor/dist/wasm/`）跑验收主线，证明
 * 「命令门 + wasm-bindgen 编解码 + 内核事务」作为一个整体可用，而不只是 Rust 函数可测：
 *
 *   海绵增/减饱和 → 减淡高光 → 多仿制源旋转采样（变换冻结）→ 修补移动
 *   → 红眼 → 图案图章 → 移除 → 历史画笔（不动游标）→ 工程往返
 *
 * 每条内容命令都断言「预览不改内容指纹 / 确认一步历史 / 取消或撤销回到原样」。
 * 需要先构建产物：`pnpm -C photocraft run wasm`。缺产物时整组跳过并说明原因（不静默通过）。
 *
 * 运行：`node --test tests/features/retouch/wasm-workflow.test.mjs`
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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

/** 画笔形状参数：与共享画布编译出的补丁同形（尺寸/硬度/不透明度/流量/间距）。 */
function stroke(size = 10) {
  return { size, hardness: 100, opacity: 100, flow: 100, spacing: 25 };
}

const points = (values) => values.map(([x, y]) => [x, y]);

/**
 * 有真实像素的文档：新图层上画一块红块。空层上的修饰没有可改的内容，
 * 用它做断言会把「无变化」误判成实现错误。
 */
function content(wasm, name = "retouch") {
  wasm.execute("file.new", JSON.stringify({ width: 64, height: 64, name }));
  wasm.execute("layer.new.layer", JSON.stringify({ name: "修饰层" }));
  const layer = JSON.parse(wasm.stateJson()).document.activeLayer;
  wasm.execute("paint.stroke", JSON.stringify({
    points: [[10, 10], [20, 20], [28, 28]], ...stroke(24), hardness: 60,
    color: "#d02020", mode: "normal", target: "pixels", layer
  }));
  return layer;
}

const historyCount = (wasm) => JSON.parse(wasm.stateJson()).document.history.length;
const retouchState = (wasm) => JSON.parse(wasm.retouchStateJson());

/**
 * 一次完整笔迹：开始（首点已在 `points` 里）→ 追加一个后续采样点 → 确认。
 *
 * 追加的点不重复传入的首点：内核按「基线 + 追加」累计采样数，重复传会把点数翻倍。
 */
function paintStroke(wasm, command, params) {
  const begun = JSON.parse(wasm.beginRetouch(command, JSON.stringify(params)));
  wasm.appendRetouch(JSON.stringify({ points: [[params.points.length + 2, params.points.length + 2]] }));
  const committed = JSON.parse(wasm.commitRetouch());
  return { begun, committed };
}

test("U37/U38/U39 主线：真实 WASM 的修饰命令、事务与工程往返", { skip }, async () => {
  const wasm = await editor();
  try {
    // ---- 命令门：新增命令经唯一白名单放行，未登记的名字仍然拒绝。
    const allowed = JSON.parse(wasm.allowedCommandIdsJson());
    for (const id of [
      "paint.patch",
      "paint.contentAwareMove",
      "paint.remove",
      "paint.redEye",
      "paint.patternStamp",
      "paint.historyBrush",
      "cloneSource.list",
      "cloneSource.select",
      "cloneSource.set",
      "cloneSource.resetTransform",
      "cloneSource.overlay"
    ]) {
      assert.equal(allowed.includes(id), true, `${id} 应已进入命令门`);
    }
    assert.throws(() => wasm.execute("cloneSource.magic", "{}"), /能力|capability|未开放/);

    const layer = content(wasm);
    const painted = wasm.contentHash();
    const historyAtPaint = historyCount(wasm);

    // ---- U39 海绵：通用笔迹模板写入的 mode=normal 必须被换成增/减饱和，且不崩编辑器。
    for (const mode of ["saturate", "desaturate"]) {
      const before = wasm.contentHash();
      const { begun, committed } = paintStroke(wasm, "paint.sponge", {
        ...stroke(), layer, points: points([[14, 14], [16, 16]]), mode: "normal", spongeMode: mode
      });
      assert.equal(begun.command, "paint.sponge");
      assert.equal(committed.points, 3);
      assert.notEqual(wasm.contentHash(), before, `海绵 ${mode} 必须真的改动像素`);
      assert.equal(retouchState(wasm).active, false, "提交后必须清空门禁");
      wasm.undo();
      assert.equal(wasm.contentHash(), before, `海绵 ${mode} 撤销后回到原样`);
    }
    // 归一化只在本域入口发生：直接 execute 通用笔迹模板的 mode=normal 仍被内核拒绝，
    // 证明「改对了」而不是「校验被放宽」。
    assert.throws(
      () => wasm.execute("paint.sponge", JSON.stringify({ ...stroke(), layer, points: [[5, 5]], mode: "normal" })),
      /mode/
    );
    assert.throws(
      () => wasm.execute("paint.sponge", JSON.stringify({ ...stroke(), layer, points: [[5, 5]], mode: "multiply" })),
      /mode/
    );
    // 入口收到非法 mode 时按工具选项纠正（这里给的是加色），不是把非法值透传。
    const corrected = paintStroke(wasm, "paint.sponge", {
      ...stroke(), layer, points: points([[5, 5]]), mode: "multiply", spongeMode: "saturate"
    });
    assert.equal(corrected.begun.command, "paint.sponge");
    wasm.undo();
    assert.equal(wasm.contentHash(), painted);
    assert.equal(retouchState(wasm).active, false);

    // ---- U39 减淡：范围 + 曝光按工具语义透传。
    const dodgeBefore = wasm.contentHash();
    paintStroke(wasm, "paint.dodge", {
      ...stroke(), layer, points: points([[16, 16], [20, 20]]), range: "highlights", exposure: 40
    });
    assert.notEqual(wasm.contentHash(), dodgeBefore, "减淡必须真的改动像素");
    assert.throws(
      () => wasm.beginRetouch("paint.dodge", JSON.stringify({ ...stroke(), layer, points: [[5, 5]], range: "elsewhere" })),
      /范围|range/
    );

    // ---- U39 多仿制源：五槽位是工具状态（不改内容/历史），落笔时冻结取样点与变换。
    const listed = JSON.parse(wasm.execute("cloneSource.list", "{}"));
    assert.equal(listed.sources.length, 5);
    assert.equal(listed.active, 0);
    const hashBeforeSlots = wasm.contentHash();
    const historyBeforeSlots = historyCount(wasm);
    wasm.execute("cloneSource.set", JSON.stringify({
      index: 0, source: [8, 8], layer, width: 200, height: 100, rotation: 30, flipH: true
    }));
    wasm.execute("cloneSource.overlay", JSON.stringify({ show: true, opacity: 60, blend: "difference" }));
    assert.equal(wasm.contentHash(), hashBeforeSlots, "槽位/叠加是工具状态，不改内容指纹");
    assert.equal(historyCount(wasm), historyBeforeSlots, "槽位/叠加不新增撤销步骤");
    const slot = JSON.parse(wasm.execute("cloneSource.list", "{}"));
    assert.deepEqual(slot.sources[0].source, [8, 8]);
    assert.equal(slot.sources[0].width, 200);
    assert.equal(slot.sources[0].rotation, 30);
    assert.equal(slot.sources[0].flipH, true);
    assert.equal(slot.overlay.blend, "difference");
    // 落笔期间叠加取样框仍能读到取景（只读端口走会话，不撞草稿门禁）；写命令仍被拒绝。
    const overlaySlot = JSON.parse(wasm.retouchCloneSourcesJson());
    assert.equal(overlaySlot.active, 0);
    assert.deepEqual(overlaySlot.sources[0].source, [8, 8]);
    assert.equal(overlaySlot.overlay.blend, "difference");
    // 槽位已有取样点时不必再传 source；仿制到透明区才看得出真实采样。
    const cloneBefore = wasm.contentHash();
    const clone = JSON.parse(wasm.beginRetouch("paint.cloneStamp", JSON.stringify({
      ...stroke(8), layer, points: points([[40, 40]])
    })));
    assert.equal(clone.historySource, null);
    // 落笔中：取样框可读、工具状态不可改（冻结于一笔）。
    assert.equal(JSON.parse(wasm.retouchCloneSourcesJson()).sources[0].rotation, 30);
    assert.throws(
      () => wasm.execute("cloneSource.overlay", JSON.stringify({ opacity: 40 })),
      /请先结束|请先确认/
    );
    wasm.appendRetouch(JSON.stringify({ points: [[42, 42], [44, 44]] }));
    assert.equal(wasm.contentHash(), cloneBefore, "预览不改内容指纹");
    wasm.commitRetouch();
    assert.notEqual(wasm.contentHash(), cloneBefore, "带旋转/翻转的仿制必须有实际采样结果");
    wasm.undo();
    assert.equal(wasm.contentHash(), cloneBefore);
    // 越界槽位与未知叠加混合模式拒绝，槽位状态不被写坏。
    assert.throws(() => wasm.execute("cloneSource.select", JSON.stringify({ index: 9 })), /index|槽位|范围/);
    assert.throws(() => wasm.execute("cloneSource.overlay", JSON.stringify({ blend: "multiply" })), /overlay|blend/);
    assert.equal(JSON.parse(wasm.execute("cloneSource.list", "{}")).overlay.blend, "difference");

    // ---- U37 修补：候选预览不改正式文档，确认一步，取消/撤销回到原样。
    wasm.execute("select.rect", JSON.stringify({ x: 6, y: 6, width: 12, height: 12, mode: "replace" }));
    const patchBaseline = wasm.contentHash();
    const patchHistory = historyCount(wasm);
    const patch = JSON.parse(wasm.beginRetouchRegion("paint.patch", JSON.stringify({
      layer, offset: [14, 0], mode: "source", structure: 4, color: 0
    })));
    assert.equal(patch.command, "paint.patch");
    assert.equal(patch.changed, true);
    assert.equal(wasm.contentHash(), patchBaseline, "候选只是预览，不改正式内容");
    assert.deepEqual(retouchState(wasm), { active: false, command: "paint.patch", points: 0, region: true });
    // 候选期间不接受笔迹，也不能用笔迹确认入口消费候选。
    assert.throws(
      () => wasm.beginRetouch("paint.blur", JSON.stringify({ ...stroke(4), layer, points: [[2, 2]] })),
      /区域|修饰/
    );
    assert.throws(() => wasm.commitRetouch(), /区域|修饰/);
    wasm.cancelRetouchRegion();
    assert.equal(wasm.contentHash(), patchBaseline, "取消后不留下半次修补");
    assert.equal(retouchState(wasm).region, false);

    wasm.beginRetouchRegion("paint.patch", JSON.stringify({ layer, offset: [14, 0], mode: "source" }));
    const committedPatch = JSON.parse(wasm.commitRetouchRegion());
    assert.equal(committedPatch.changed, true);
    assert.notEqual(wasm.contentHash(), patchBaseline, "修补必须真的改动像素");
    assert.equal(historyCount(wasm), patchHistory + 1, "一次确认只新增一步历史");
    wasm.undo();
    assert.equal(wasm.contentHash(), patchBaseline);

    // ---- U37 内容识别移动：取消不提交。
    const moveBaseline = wasm.contentHash();
    wasm.beginRetouchRegion("paint.contentAwareMove", JSON.stringify({
      layer, offset: [10, 4], mode: "move", structure: 4, color: 0, scaleX: 100, scaleY: 100, rotate: 0
    }));
    wasm.cancelRetouchRegion();
    assert.equal(wasm.contentHash(), moveBaseline);
    assert.equal(retouchState(wasm).region, false);

    // ---- U37 过期候选：文档在候选之后被改，确认必须拒绝且不改内容。
    wasm.beginRetouchRegion("paint.patch", JSON.stringify({ layer, offset: [8, 0] }));
    wasm.execute("paint.stroke", JSON.stringify({
      points: [[40, 40]], ...stroke(8), color: "#00ff00", mode: "normal", target: "pixels", layer
    }));
    const staleHash = wasm.contentHash();
    assert.throws(() => wasm.commitRetouchRegion(), /过期候选/);
    assert.equal(wasm.contentHash(), staleHash, "拒绝后也不得改内容");
    assert.equal(retouchState(wasm).region, false);
    wasm.undo();
    assert.equal(wasm.contentHash(), moveBaseline);

    // ---- U37 红眼：区域命令，不退化普通画笔；拒绝时文档不变。
    const eyeBaseline = wasm.contentHash();
    const redEye = JSON.parse(wasm.beginRetouchRegion("paint.redEye", JSON.stringify({
      layer, points: [[14, 14], [20, 20]], pupilSize: 60, darken: 80
    })));
    assert.equal(redEye.command, "paint.redEye");
    assert.equal(wasm.contentHash(), eyeBaseline, "红眼候选只是预览");
    wasm.cancelRetouchRegion();
    assert.equal(wasm.contentHash(), eyeBaseline, "红眼取消后文档不变");
    // 没有位置/瞳孔大小越界一律拒绝，且不落成普通画笔。
    assert.throws(() => wasm.beginRetouchRegion("paint.redEye", JSON.stringify({ layer })), /红眼位置|points|x\/y/);
    assert.throws(
      () => wasm.beginRetouchRegion("paint.redEye", JSON.stringify({ layer, points: [[4, 4]], pupilSize: 0 })),
      /瞳孔大小/
    );
    assert.equal(wasm.contentHash(), eyeBaseline);
    assert.equal(retouchState(wasm).region, false);

    // ---- U38 图案图章：显式未知图案拒绝（不换图案），空 key 用当前图案可落笔。
    assert.throws(
      () => wasm.beginRetouch("paint.patternStamp", JSON.stringify({
        ...stroke(), layer, points: [[8, 8]], pattern: "no-such-pattern"
      })),
      /图案/
    );
    const patternBaseline = wasm.contentHash();
    paintStroke(wasm, "paint.patternStamp", {
      ...stroke(), layer, points: points([[8, 8], [10, 10]]), scale: 100, angle: 0, aligned: true
    });
    assert.notEqual(wasm.contentHash(), patternBaseline, "图案图章必须真的落笔");
    wasm.undo();
    assert.equal(wasm.contentHash(), patternBaseline);
    assert.throws(
      () => wasm.beginRetouch("paint.patternStamp", JSON.stringify({ ...stroke(), layer, points: [[8, 8]], scale: 0 })),
      /缩放/
    );

    // ---- U37 移除：半笔取消不残留；确认至多一步历史。
    const removeBaseline = wasm.contentHash();
    wasm.beginRetouch("paint.remove", JSON.stringify({ ...stroke(), layer, points: points([[14, 14]]) }));
    wasm.appendRetouch(JSON.stringify({ points: [[18, 18]] }));
    wasm.cancelRetouch();
    assert.equal(wasm.contentHash(), removeBaseline, "取消的移除笔迹不留半笔");
    const removeHistory = historyCount(wasm);
    wasm.beginRetouch("paint.remove", JSON.stringify({
      ...stroke(), layer, points: points([[14, 14], [18, 18]]), removeNewLayer: false
    }));
    wasm.appendRetouch(JSON.stringify({ points: [[20, 20]] }));
    wasm.commitRetouch();
    assert.ok(historyCount(wasm) <= removeHistory + 1, "移除至多一步历史");
    if (wasm.contentHash() !== removeBaseline) {
      wasm.undo();
      assert.equal(wasm.contentHash(), removeBaseline);
    } else {
      assert.equal(historyCount(wasm), removeHistory);
    }

    // ---- U38 历史画笔：可用的历史源恢复内容、不移动游标；不可用/越界源拒绝。
    // 先落一笔已知的减淡，让「当前状态之前最近的一步」确定含有不同内容，取样才有可观察的变化。
    paintStroke(wasm, "paint.dodge", {
      ...stroke(), layer, points: points([[18, 18], [22, 22]]), range: "midtones", exposure: 100
    });
    const states = JSON.parse(wasm.retouchHistorySourcesJson()).states;
    assert.ok(states.length >= 3, `需要可清理的历史：${JSON.stringify(states)}`);
    assert.equal(states.at(-1).current, true, "最后一个状态是当前状态");
    assert.equal(states.some((state) => state.available === false), true, "早于图层创建的状态必须标为不可用");
    const source = states.filter((state) => state.available && !state.current).at(-1);
    assert.ok(source, "应至少有一个可用的历史源");
    const cursorBefore = historyCount(wasm);
    const historyBrushBaseline = wasm.contentHash();
    const begun = JSON.parse(wasm.beginRetouch("paint.historyBrush", JSON.stringify({
      ...stroke(), layer, points: points([[16, 16]]), historyState: source.index
    })));
    assert.equal(begun.historySource, source.index);
    wasm.appendRetouch(JSON.stringify({ points: [[20, 20]] }));
    wasm.commitRetouch();
    assert.notEqual(wasm.contentHash(), historyBrushBaseline, "历史画笔必须恢复源内容");
    assert.equal(historyCount(wasm), cursorBefore + 1, "只多一步历史，游标不跳到源状态");
    wasm.undo();
    assert.equal(wasm.contentHash(), historyBrushBaseline, "撤销只回退这一笔");
    // 不可用源：开始一笔时就拒绝并说明图层不在该状态里（不退化为普通画笔）。
    const unavailable = states.find((state) => !state.available);
    assert.throws(
      () => wasm.beginRetouch("paint.historyBrush", JSON.stringify({
        ...stroke(), layer, points: [[16, 16]], historyState: unavailable.index
      })),
      /图层|历史源/
    );
    assert.throws(
      () => wasm.beginRetouch("paint.historyBrush", JSON.stringify({
        ...stroke(), layer, points: [[16, 16]], historyState: 250
      })),
      /历史源/
    );
    // 非法索引不得被静默当成「最旧状态」（那会恢复错误内容却报告成功）。
    for (const bad of [-1, 1.5, "2"]) {
      for (const key of ["state", "historyState"]) {
        assert.throws(
          () => wasm.beginRetouch("paint.historyBrush", JSON.stringify({
            ...stroke(), layer, points: [[16, 16]], [key]: bad
          })),
          /非负整数/,
          `非法历史源索引必须被拒绝（${key}=${bad}）`
        );
      }
    }
    assert.equal(wasm.contentHash(), historyBrushBaseline, "被拒绝的历史源不改内容");
    assert.equal(retouchState(wasm).active, false);

    // ---- 目标图层：不带 layer 的区域/笔迹命令必须作用于**活动层**，不是文档最上层。
    //      在活动层之上加一个锁定层，若实现仍取「最上层」就会命中它并失败。
    wasm.execute("layer.new.layer", JSON.stringify({ name: "锁定层" }));
    const topLayer = JSON.parse(wasm.stateJson()).document.activeLayer;
    wasm.execute("layer.lockLayers", JSON.stringify({ pixels: true }));
    wasm.execute("layer.select", JSON.stringify({ layer, mode: "replace" }));
    assert.equal(JSON.parse(wasm.stateJson()).document.activeLayer, layer, "活动层已切回可写层");
    assert.notEqual(topLayer, layer);
    wasm.execute("select.rect", JSON.stringify({ x: 8, y: 8, width: 10, height: 10, mode: "replace" }));
    const activeBaseline = wasm.contentHash();
    // 显式指定锁定层仍被拒绝（可写性校验没有放宽）。
    assert.throws(
      () => wasm.beginRetouchRegion("paint.patch", JSON.stringify({ layer: topLayer, offset: [12, 0] })),
      /锁定|可写|像素/
    );
    assert.equal(wasm.contentHash(), activeBaseline);
    const activePatch = JSON.parse(wasm.beginRetouchRegion("paint.patch", JSON.stringify({ offset: [12, 0] })));
    assert.equal(activePatch.command, "paint.patch", "不带 layer 的修补应落到活动层而不是锁定层");
    assert.equal(wasm.contentHash(), activeBaseline);
    wasm.commitRetouchRegion();
    if (wasm.contentHash() !== activeBaseline) {
      wasm.undo();
      assert.equal(wasm.contentHash(), activeBaseline);
    }
    // 笔迹同样以活动层为目标。
    paintStroke(wasm, "paint.dodge", {
      points: points([[20, 20], [24, 24]]), range: "midtones", exposure: 60
    });
    wasm.undo();
    assert.equal(wasm.contentHash(), activeBaseline);
    wasm.execute("layer.select", JSON.stringify({ layer, mode: "replace" }));

    // ---- 工程往返：内容身份与编辑器一致；仿制源槽位是会话工具状态，重开后回到默认（不进内容）。
    const finalHash = wasm.contentHash();
    assert.notEqual(finalHash, painted, "主线里确实发生了内容变化");
    const bundle = wasm.exportBundle();
    try {
      assert.equal(bundle.documentContentHash, finalHash, "导出的内容身份与编辑器一致");
      const reopened = await editor();
      try {
        // 空 baseAssetId：本例没有嵌入源，指定资产会让登记表进入内容身份。
        reopened.openProject(bundle.project, "");
        assert.equal(reopened.contentHash(), finalHash, "重开后内容身份一致");
        const reopenedSlots = JSON.parse(reopened.execute("cloneSource.list", "{}"));
        assert.equal(reopenedSlots.active, 0);
        assert.equal(reopenedSlots.sources[0].source, null, "仿制源槽位不随工程保存");
        assert.equal(reopenedSlots.sources[0].width, 100);
        assert.equal(reopenedSlots.overlay.blend, "normal");
        // 重开后的历史源从「打开」重新开始，不携带上一条会话的候选。
        assert.equal(reopened.retouchStateJson().includes('"region":true'), false);
        assert.equal(JSON.parse(reopened.retouchHistorySourcesJson()).states.length, 1);
      } finally {
        reopened.free();
      }
    } finally {
      bundle.free();
    }
  } finally {
    wasm.free();
  }
});

/**
 * 单位归一化回归（真实 WASM）。
 *
 * 上游 `retouch_cmds::stroke_brush` 把 `hardness/opacity/flow` 当**百分比**（`/100`，
 * opacity/flow 下限 1），共享 `buildStroke` 发的却是 0–1 小数。真实界面走查发现：不换算时
 * 模糊/锐化/涂抹/减淡/加深/海绵/污点修复「落笔成功、也是一步历史，但画面几乎没变化」。
 *
 * 这里直接对内核断言两套单位确实不等价，锁定「必须换算」这件事本身。
 */
test("修饰笔迹的画笔单位：0–1 小数会被内核当成 1%，必须换算成百分比", { skip }, async () => {
  const wasm = await editor();
  const layer = content(wasm, "units");
  wasm.execute("paint.stroke", JSON.stringify({
    points: [[0, 10], [63, 10], [0, 30], [63, 30], [0, 50], [63, 50]], size: 6, hardness: 100,
    opacity: 100, flow: 100, color: "#ff2020", mode: "normal", target: "pixels", layer
  }));
  const params = { points: [[10, 20], [30, 40]], size: 10, spacing: 0.25, smoothing: 0,
    color: "#0020ff", erase: false, zoom: 1, target: "pixels", layer, strength: 60, sampleAllLayers: false };
  const run = (units) => {
    const before = wasm.contentHash();
    wasm.beginRetouch("paint.blur", JSON.stringify({ ...params, ...units }));
    wasm.appendRetouch(JSON.stringify({ points: [[50, 20]] }));
    wasm.commitRetouch();
    const changed = wasm.contentHash() !== before;
    wasm.undo();
    return changed;
  };
  // 小数（1 == 满值）被内核读成 1%：几乎不透明，效果不可辨。
  assert.equal(run({ hardness: 1, opacity: 1, flow: 1 }), false, "0–1 小数对内核无效果");
  // 百分比（100 == 满值）才是内核要的单位。
  assert.equal(run({ hardness: 100, opacity: 100, flow: 100 }), true, "百分比才生效");
  wasm.free();
});

/**
 * 多仿制源真的按**活动槽位**取样。
 *
 * 真实走查发现的缺陷：共享画布把 app 本地的 Alt+取样点显式塞进笔迹参数（`source`），而上游
 * `clone_source::resolve` 只有在参数里**没有** `source` 时才去读活动槽位。于是「切到 2 号槽位」
 * 对之后的每一笔都没有影响：面板显示 2 号槽位的源，落笔却仍在用 1 号槽位的旧点——多仿制源
 * 这个交付项等于没生效。
 *
 * 这里锁定上游语义本身：同一笔、同样的落点，只换活动槽位就必须产出**不同像素**；并且
 * 「槽位没有源、也不传 source」必须是明确拒绝，而不是悄悄画出一笔无变化的笔迹。
 */
test("多仿制源：落笔按活动槽位取样，换槽位必须换源", { skip }, async () => {
  const wasm = await editor();
  // 两个可区分的取样源（左红右蓝），否则两个槽位采到的颜色相同、断言失去意义。
  wasm.execute("file.new", JSON.stringify({ width: 64, height: 64, name: "multisource" }));
  wasm.execute("layer.new.layer", JSON.stringify({ name: "双色层" }));
  const layer = JSON.parse(wasm.stateJson()).document.activeLayer;
  wasm.execute("paint.stroke", JSON.stringify({
    points: [[10, 10], [18, 18]], ...stroke(16), hardness: 100,
    color: "#e02020", mode: "normal", target: "pixels", layer
  }));
  wasm.execute("paint.stroke", JSON.stringify({
    points: [[44, 44], [52, 52]], ...stroke(16), hardness: 100,
    color: "#2040e0", mode: "normal", target: "pixels", layer
  }));
  const cloneFrom = (active) => {
    wasm.execute("cloneSource.select", JSON.stringify({ index: active }));
    const before = wasm.contentHash();
    // 不传 source：由内核读活动槽位（这与共享画布接线后的实际笔迹参数一致）。
    wasm.beginRetouch("paint.cloneStamp", JSON.stringify({
      ...stroke(8), layer, points: points([[30, 30]]), aligned: true, sampleLayer: "current"
    }));
    wasm.appendRetouch(JSON.stringify({ points: [[32, 32], [34, 34]] }));
    wasm.commitRetouch();
    const after = wasm.contentHash();
    wasm.undo();
    return { changed: after !== before, hash: after };
  };

  // 槽位 1 采左边的红块，槽位 2 采右边的蓝块。
  wasm.execute("cloneSource.set", JSON.stringify({ index: 0, source: [14, 14] }));
  wasm.execute("cloneSource.set", JSON.stringify({ index: 1, source: [48, 48] }));
  const first = cloneFrom(0);
  assert.equal(first.changed, true, "1 号槽位的仿制必须有实际像素结果");
  const second = cloneFrom(1);
  assert.equal(second.changed, true, "2 号槽位的仿制必须有实际像素结果");
  assert.notEqual(second.hash, first.hash, "换活动槽位必须换取样源（结果像素不同）");

  // 槽位没源又不传 source：明确拒绝，不画一笔「成功但无变化」。
  const fresh = await editor();
  const freshLayer = content(fresh, "nosource");
  assert.throws(
    () => fresh.beginRetouch("paint.cloneStamp", JSON.stringify({
      ...stroke(8), layer: freshLayer, points: points([[30, 30]]), aligned: true, sampleLayer: "current"
    })),
    /采样点|source|offset/
  );
  fresh.free();
  wasm.free();
});
