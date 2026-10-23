/**
 * 历史/动作/数据驱动域的解码回归（U74/U75/U76）。
 *
 * 解码是面板与内核之间唯一的结构校验层：异常形状必须得到 `null`/空数组，而不是把未校验的
 * JSON 透传进 React state。这里只测纯函数，不加载 wasm、不采集渲染。
 */
import { describe, expect, it } from "vitest";
import {
  decodeActionsState,
  decodeBatchProgress,
  decodeCsvImport,
  decodeExportedFiles,
  decodeHistorySample,
  decodeHistorySourceCheck,
  decodeHistoryState,
  decodePurgePlan,
  decodeQueueId,
  decodeScriptReport,
  decodeShortcuts,
  decodeUnsupported,
  decodeVariablesState
} from "./model.js";

describe("历史视图", () => {
  it("把标签数组折成带当前项的状态，并保留快照与 epoch", () => {
    const view = decodeHistoryState({
      entries: ["打开", "画笔", "裁切"],
      redo: ["裁切"],
      current: 1,
      canUndo: true,
      canRedo: true,
      snapshots: [{ id: 3, name: "基线", activeLayer: 7 }, { id: 4, name: "无层信息" }],
      epoch: "abc123"
    });
    expect(view?.entries.map((entry) => entry.label)).toEqual(["打开", "画笔", "裁切"]);
    expect(view?.entries.filter((entry) => entry.current).map((entry) => entry.index)).toEqual([1]);
    expect(view?.snapshots).toEqual([
      { id: 3, name: "基线", activeLayer: 7 },
      { id: 4, name: "无层信息", activeLayer: null }
    ]);
    expect(view?.epoch).toBe("abc123");
    expect(view).toMatchObject({ redo: ["裁切"], canUndo: true, canRedo: true });
    // 内核没给 sources 时按 entries 推导：只有最后一个状态是活文档，绝不全部当作活文档。
    expect(view?.sources).toEqual([
      { index: 0, label: "打开", live: false },
      { index: 1, label: "画笔", live: false },
      { index: 2, label: "裁切", live: true }
    ]);
  });

  it("内核给了 sources 就用它，不按 entries 位置猜", () => {
    const view = decodeHistoryState({
      entries: ["打开", "画笔"],
      current: 0,
      epoch: "abc123",
      sources: [
        { index: 0, label: "打开", live: true },
        { index: 1, label: "画笔", live: false }
      ]
    });
    // 用户可能停在历史中间；活文档标记必须听内核，而不是「末项就是活文档」。
    expect(view?.sources).toEqual([
      { index: 0, label: "打开", live: true },
      { index: 1, label: "画笔", live: false }
    ]);
  });

  it("拒绝没有 entries 或 current 越界的结构，并把越界 current 夹到末项", () => {
    expect(decodeHistoryState({ current: 0 })).toBeNull();
    expect(decodeHistoryState(null)).toBeNull();
    expect(decodeHistoryState([])).toBeNull();
    const clamped = decodeHistoryState({ entries: ["只有一步"], current: 99 });
    expect(clamped?.current).toBe(0);
    expect(clamped?.entries[0]?.current).toBe(true);
  });

  it("丢弃没有数字 id 的快照，不伪造快照", () => {
    const view = decodeHistoryState({ entries: ["打开"], snapshots: [{ name: "缺 id" }, { id: 2, name: "可用" }] });
    expect(view?.snapshots.map((snapshot) => snapshot.id)).toEqual([2]);
  });
});

describe("清理范围", () => {
  it("只接受 recoverable:false 的范围说明", () => {
    expect(decodePurgePlan({ command: "edit.purge.undo", scope: "可撤销记录", bytes: 4096, recoverable: false }))
      .toEqual({
        command: "edit.purge.undo", scope: "可撤销记录", bytes: 4096, recoverable: false,
        // 老运行时没有 `available`：按「有内容」处理，不能把所有范围都误禁用。
        available: true, reason: null,
        // 没有 `approximate` 时按精确值处理：多数范围本来就是精确的。
        approximate: false
      });
    // 可恢复的东西不该走清理；缺这两个字段都不能让界面显示「确认清理」。
    expect(decodePurgePlan({ command: "edit.purge.undo", scope: "x", recoverable: true })).toBeNull();
    expect(decodePurgePlan({ command: "edit.purge.undo", recoverable: false })).toBeNull();
    expect(decodePurgePlan({ scope: "x", recoverable: false })).toBeNull();
    // 空范围带着原因下发：界面据此只留「知道了」，不显示「确认清理」。
    expect(decodePurgePlan({
      command: "edit.purge.clipboard", scope: "剪贴板", bytes: 0, available: false,
      reason: "the clipboard is empty", recoverable: false
    })).toMatchObject({ available: false, reason: "the clipboard is empty" });
  });

  it("`all` 的范围说明标成近似，其余范围是精确值", () => {
    // `all` 还会释放形状描边缓存，而它没有公开的字节读数；界面不能把低估值说成精确值。
    expect(decodePurgePlan({
      command: "edit.purge.all", scope: "全部", bytes: 1024, approximate: true, recoverable: false
    })).toMatchObject({ approximate: true, bytes: 1024 });
    expect(decodePurgePlan({
      command: "edit.purge.histories", scope: "历史", bytes: 1024, approximate: false, recoverable: false
    })).toMatchObject({ approximate: false });
  });
});

describe("历史源样本", () => {
  it("解码取样结果：活文档与归档状态、尺寸与像素", () => {
    const sample = decodeHistorySample({
      epoch: "0123456789abcdef", state: 1, label: "画笔", live: false,
      width: 32, height: 24, sources: 3, pixels: "AAAAAA=="
    });
    expect(sample).toEqual({
      epoch: "0123456789abcdef", state: 1, label: "画笔", live: false,
      width: 32, height: 24, sources: 3, pixels: "AAAAAA=="
    });
    // 缺 epoch（无法判定失效）或缺像素（取不到源）都不能当成合法样本。
    expect(decodeHistorySample({ state: 0, pixels: "AAAAAA==" })).toBeNull();
    expect(decodeHistorySample({ epoch: "x", state: 0 })).toBeNull();
    expect(decodeHistorySample({ epoch: "", pixels: "AAAAAA==" })).toBeNull();
    expect(decodeHistorySample(null)).toBeNull();
  });

  it("只校验句柄的答案不带像素，两种解码器不能互相冒充", () => {
    const base = { epoch: "0123456789abcdef", state: 2, label: "裁切", live: false, width: 400, height: 300, sources: 4 };
    expect(decodeHistorySourceCheck(base)).toEqual(base);
    // 带 pixels 的是取样答案，不是「只校验」答案：混用会让面板在检查路径上意外拿到像素。
    expect(decodeHistorySourceCheck({ ...base, pixels: "AAAAAA==" })).toBeNull();
    // 取样答案反过来必须有像素，否则面板会画一张空图。
    expect(decodeHistorySample(base)).toBeNull();
    expect(decodeHistorySourceCheck({ state: 0 })).toBeNull();
    expect(decodeHistorySourceCheck(null)).toBeNull();
  });
});

describe("动作视图", () => {
  it("解码动作清单、录制状态、选中动作的步骤与预检", () => {
    const view = decodeActionsState({
      actions: [{ name: "色彩", steps: 2, set: "默认动作" }, { name: "无集" }],
      recording: "色彩",
      detail: { name: "色彩", steps: [["image.adjust", {}], ["edit.undo"], "坏步骤"], disabled: [1], dialogs: [] },
      preflight: {
        steps: [
          { step: 0, id: "image.adjust", playable: true },
          { step: 1, id: "edit.undo", playable: false, reason: "不在已交付命令门内" }
        ],
        playable: false
      },
      budget: { maxActions: 256, maxStepsPerAction: 2048, maxAtnBytes: 8388608 }
    });
    expect(view?.actions).toEqual([
      { name: "色彩", steps: 2, set: "默认动作" },
      { name: "无集", steps: 0, set: null }
    ]);
    expect(view?.recording).toBe("色彩");
    // 第三个 "坏步骤" 不是 [id, params] 形状：丢掉，不让它变成空命令。
    expect(view?.detail?.steps.map((step) => step.id)).toEqual(["image.adjust", "edit.undo"]);
    expect(view?.detail?.disabled).toEqual([1]);
    expect(view?.preflight?.playable).toBe(false);
    expect(view?.preflight?.blocked.map((step) => step.id)).toEqual(["edit.undo"]);
    expect(view?.budget).toEqual({ maxActions: 256, maxStepsPerAction: 2048, maxAtnBytes: 8388608 });
  });

  it("没有 preflight 时按步骤自证可播（blocked 为空）", () => {
    const view = decodeActionsState({ actions: [], preflight: { steps: [{ step: 0, id: "edit.undo", playable: true }] } });
    expect(view?.preflight?.playable).toBe(true);
    expect(view?.preflight?.blocked).toEqual([]);
    expect(view?.detail).toBeNull();
    expect(decodeActionsState({ recording: null })).toBeNull();
  });

  it("动作详情解码按钮颜色，缺失时按未设处理", () => {
    const colored = decodeActionsState({
      actions: [],
      detail: { name: "色彩", steps: [["image.adjust", {}]], color: "red" }
    });
    expect(colored?.detail?.color).toBe("red");
    // 内核不回颜色（或替身没给）时是空串，不是 undefined：面板的 <select> 需要一个稳定值。
    const plain = decodeActionsState({ actions: [], detail: { name: "色彩", steps: [] } });
    expect(plain?.detail?.color).toBe("");
  });

  it("ATN 未知步骤报告缺失时返回 null（不能当「没有未知步骤」）", () => {
    expect(decodeUnsupported({ unsupported: [{ action: "导入", step: 2, event: "photoshopStep", name: "Mosaic" }] }))
      .toEqual([{ action: "导入", step: 2, event: "photoshopStep", name: "Mosaic" }]);
    expect(decodeUnsupported({ actions: [] })).toBeNull();
    expect(decodeUnsupported(null)).toBeNull();
    expect(decodeUnsupported({ unsupported: [] })).toEqual([]);
  });

  it("快捷键只保留成对的动作与键位", () => {
    expect(decodeShortcuts({ bindings: [{ action: "色彩", shortcut: "F4", binding: "actions.play:色彩" }, { action: "缺键位" }] }))
      .toEqual([{ action: "色彩", shortcut: "F4" }]);
    expect(decodeShortcuts(null)).toEqual([]);
  });
});

describe("变量与数据集", () => {
  it("解码变量种类、数据集值数与活动集", () => {
    const view = decodeVariablesState({
      defs: [
        { name: "显隐", layer: 2, kind: { type: "visibility" } },
        { name: "文字", layer: 3, type: "textReplacement" },
        { name: "坏种类", layer: 4, kind: { type: "quantum" } }
      ],
      dataSets: [{ name: "第一组", values: { 显隐: true, 文字: "hello" } }],
      active: 0
    });
    expect(view?.defs).toEqual([
      { name: "显隐", layer: 2, kind: "visibility" },
      { name: "文字", layer: 3, kind: "textReplacement" },
      // 未知种类**不能**猜成 visibility：`define` 是整份替换，猜一个值写回去会把用户的变量
      // 改坏（未来版本的种类被悄悄变成显隐）。标成 null，由面板拒绝重发整份定义。
      { name: "坏种类", layer: 4, kind: null, rawKind: "quantum" }
    ]);
    // `values` 是条数（界面显示）；`entries` 是内核原始取值，删一行时要原样重发。
    // 映射形态还原不出 `{variable, kind, value}`，因此 `entries` 为空——面板据此禁用删除按钮。
    expect(view?.dataSets).toEqual([{ name: "第一组", values: 2, entries: [] }]);
    expect(view?.active).toBe(0);
    // 没有预算就当「不预检」：面板不会因为缺字段就拒绝一切导入，内核仍会拒绝超预算输入。
    expect(view?.budget).toBeNull();
    expect(decodeVariablesState({ defs: [] })).toBeNull();
  });

  it("数据集数组形态保留原始取值用于整份重发", () => {
    // `image.variables.dataSets` 是整份替换：内核返回的 `values` 数组必须原样留住，
    // 否则「删掉一个数据集」无法在不编造取值的前提下重发其余数据集。
    const view = decodeVariablesState({
      defs: [{ name: "showTitle", layer: 1, kind: { type: "visibility" } }],
      dataSets: [
        { name: "A", values: [{ variable: "showTitle", kind: "visibility", value: true }] },
        { name: "B", values: [
          { variable: "showTitle", kind: "visibility", value: false },
          { variable: "cover", kind: "pixels", value: "a.png" }
        ] }
      ],
      active: null
    });
    expect(view?.dataSets).toEqual([
      { name: "A", values: 1, entries: [{ variable: "showTitle", kind: "visibility", value: true }] },
      {
        name: "B", values: 2,
        entries: [
          { variable: "showTitle", kind: "visibility", value: false },
          { variable: "cover", kind: "pixels", value: "a.png" }
        ]
      }
    ]);
    // 数组里混进非对象时不当作取值（不能把它重发成 `{}` 覆盖别的数据集）。
    const mixed = decodeVariablesState({
      defs: [], dataSets: [{ name: "C", values: ["bad", { variable: "v", kind: "text", value: "x" }] }], active: null
    });
    expect(mixed?.dataSets).toEqual([{ name: "C", values: 2, entries: [{ variable: "v", kind: "text", value: "x" }] }]);
  });

  it("解码变量/数据集预算；缺预算时不假装有上限", () => {
    const view = decodeVariablesState({
      defs: [],
      dataSets: [],
      active: null,
      budget: { maxCsvBytes: 8388608, maxDataSets: 1024, maxValuesPerSet: 512, maxVariables: 256 }
    });
    expect(view?.budget).toEqual({
      maxCsvBytes: 8388608,
      maxDataSets: 1024,
      maxValuesPerSet: 512,
      maxVariables: 256
    });
    // 结构异常的值折成 0（= 不预检），不把 undefined/NaN 透传进面板。
    const broken = decodeVariablesState({ defs: [], dataSets: [], budget: { maxCsvBytes: "big" } });
    expect(broken?.budget).toEqual({ maxCsvBytes: 0, maxDataSets: 0, maxValuesPerSet: 0, maxVariables: 0 });
  });

  it("像素变量保留方式/对齐/裁切（整份替换时必须原样带回）", () => {
    const view = decodeVariablesState({
      defs: [
        // 上游把选项展平在 def 上（`kind_json` 与 `name/layer` 合并）。
        { name: "封面", layer: 5, type: "pixelReplacement", method: "fill", align: "topLeft", clip: true },
        { name: "缺省", layer: 6, type: "pixelReplacement" }
      ],
      dataSets: [],
      active: null
    });
    expect(view?.defs[0]).toEqual({
      name: "封面", layer: 5, kind: "pixelReplacement", method: "fill", align: "topLeft", clip: true
    });
    // 内核没给就不猜：缺省选项不出现在视图里，重发时也不覆盖内核默认。
    expect(view?.defs[1]).toEqual({ name: "缺省", layer: 6, kind: "pixelReplacement" });
  });

  it("CSV 报告与数据集导出都要求内核给出真实报告", () => {
    expect(decodeCsvImport({ imported: 2, skipped: [{ column: "多余", reason: "没有同名变量" }] }))
      .toEqual({ imported: 2, skipped: [{ column: "多余", reason: "没有同名变量" }] });
    expect(decodeCsvImport({ skipped: [] })).toBeNull();
    expect(decodeExportedFiles({ files: [{ name: "第一组", fileName: "第一组.png", bytes: 3, data: "AAA" }] }))
      .toEqual([{ name: "第一组", fileName: "第一组.png", bytes: 3, data: "AAA" }]);
    expect(decodeExportedFiles({ items: [] })).toBeNull();
  });
});

describe("前台批处理与脚本", () => {
  it("解码逐文件报告与取消状态", () => {
    const view = decodeBatchProgress({
      mode: "batch",
      total: 2,
      completed: 1,
      remaining: 1,
      running: false,
      cancelled: true,
      outputBytes: 512,
      results: [
        { file: "a.png", ok: true, output: "a_out.png", bytes: 256 },
        { file: "b.png", ok: false, error: "不支持的输入" },
        "坏结果"
      ]
    });
    expect(view?.cancelled).toBe(true);
    expect(view?.results).toEqual([
      { file: "a.png", ok: true, error: null, output: "a_out.png", bytes: 256 },
      { file: "b.png", ok: false, error: "不支持的输入", output: null, bytes: null }
    ]);
    // 缺 mode 的空状态仍可用（内核在队列不存在时返回它）。
    expect(decodeBatchProgress({ cancelled: false })?.results).toEqual([]);
    expect(decodeBatchProgress(null)).toBeNull();
  });

  it("队列 id 只接受正整数，避免把 0/缺省当队列", () => {
    expect(decodeQueueId({ queue: 7 })).toBe(7);
    expect(decodeQueueId({ queue: 0 })).toBeNull();
    expect(decodeQueueId({ queue: -1 })).toBeNull();
    expect(decodeQueueId({ queue: 1.5 })).toBeNull();
    expect(decodeQueueId({})).toBeNull();
  });

  it("脚本报告保留失败步骤的错误，并附带预检", () => {
    const view = decodeScriptReport({
      ok: false,
      preflight: { steps: [{ step: 0, id: "edit.undo", playable: true }], playable: true },
      results: [
        { step: 0, id: "edit.undo", result: {} },
        { step: 1, id: "image.adjust", error: "没有活动图层" }
      ]
    });
    expect(view?.ok).toBe(false);
    expect(view?.preflight?.playable).toBe(true);
    expect(view?.results.at(-1)).toEqual({ step: 1, id: "image.adjust", error: "没有活动图层" });
    expect(decodeScriptReport({ results: [] })).toBeNull();
  });
});
