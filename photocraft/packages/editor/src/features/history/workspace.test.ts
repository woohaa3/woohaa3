import { describe, expect, it } from "vitest";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { createSession } from "./workspace.js";

/**
 * 历史/动作/数据驱动域会话的草稿归属与确认门
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 锁定本域自己的契约：写入过活动草稿门禁、清理默认**不带确认**、脚本中途失败不伪装成功、
 * 只读查询不产生写操作、端口缺失给出可读失败。真实历史/字节/CSS 语义在 Rust 侧
 * （`tests_workflows.rs`）。
 */

function view(name: string, revision = 1): EditorViewModel {
  return {
    hasDocument: true,
    sessionActiveIndex: 0,
    document: {
    channelTarget: { kind: "composite" },

      name,
      width: 8,
      height: 6,
      mode: "rgb-u8",
      depthBits: 8,
      activeLayerId: 1,
      selectedLayerIds: [1],
      hasSelection: false,
      editTarget: "pixels",
      maskView: null,
      transformFrame: null,
      selectionOutline: [],
      selectionFrame: null,
      canUndo: false,
      canRedo: false,
      revision,
      history: ["打开"],
      redoHistory: [],
      layers: []
    }
  };
}

const HISTORY_STATE = {
  entries: ["打开", "画笔"],
  redo: [],
  current: 1,
  canUndo: true,
  canRedo: false,
  snapshots: [{ id: 2, name: "基线", activeLayer: 1 }],
  epoch: "0123456789abcdef"
};

const ACTIONS_STATE = {
  actions: [{ name: "两步", steps: 1 }],
  recording: null,
  detail: null,
  preflight: null,
  budget: { maxActions: 256, maxStepsPerAction: 2048, maxAtnBytes: 8388608 }
};

const VARIABLES_STATE = {
  defs: [{ name: "可见性", layer: 1, type: "visibility" }],
  dataSets: [{ name: "第一组", values: [{ variable: "可见性", kind: "visibility", value: true }] }],
  active: null
};

const BATCH_PROGRESS = {
  mode: "batch",
  total: 1,
  completed: 1,
  remaining: 0,
  running: false,
  cancelled: false,
  outputBytes: 8,
  results: [{ file: "a.png", ok: true, output: "a_out.png", bytes: 8 }]
};

function harness(options: { blocked?: boolean; handle?: boolean; play?: () => EditorResult<unknown>; conditional?: () => EditorResult<unknown>; sampleFailure?: () => EditorResult<unknown>; loadWarnings?: string[] } = {}) {
  const writes: number[] = [];
  const calls: Array<{ feature: string; params: unknown }> = [];
  const state = { view: view("art") };
  const ok = <T,>(value: T): EditorResult<T> => ({ ok: true, value });
  const history = {
    historyState: () => { calls.push({ feature: "historyState", params: null }); return ok(HISTORY_STATE); },
    newSnapshot: (params: unknown) => { calls.push({ feature: "newSnapshot", params }); return ok({}); },
    selectSnapshot: (params: unknown) => { calls.push({ feature: "selectSnapshot", params }); return ok({}); },
    renameSnapshot: (params: unknown) => { calls.push({ feature: "renameSnapshot", params }); return ok({}); },
    deleteSnapshot: (params: unknown) => { calls.push({ feature: "deleteSnapshot", params }); return ok({}); },
    deleteState: (params: unknown) => { calls.push({ feature: "deleteState", params }); return ok({}); },
    newDocumentFromHistory: (params: unknown) => {
      calls.push({ feature: "newDocumentFromHistory", params });
      return ok({ result: { document: 1, name: (params as { name?: string }).name ?? "派生" } });
    },
    purgePlan: (what: string) => {
      calls.push({ feature: "purgePlan", params: what });
      return ok({ command: `edit.purge.${what}`, scope: "当前文档的可撤销记录", bytes: 512, available: true, reason: null, recoverable: false });
    },
    sampleHistory: (params: unknown) => {
      calls.push({ feature: "sampleHistory", params });
      if (options.sampleFailure) return options.sampleFailure();
      const base = { epoch: "0123456789abcdef", state: 0, label: "打开", live: false, width: 4, height: 2, sources: 2 };
      // `preview: false` 时内核不返回像素；替身也必须照这个形状回，否则「只校验」会被
      // 取样解码器判成结构非法。
      return ok((params as { preview?: boolean }).preview === false ? base : { ...base, pixels: "AAAAAA==" });
    },
    purge: (what: string, params: unknown) => { calls.push({ feature: "purge", params: { what, params } }); return ok({}); },
    actionsState: (params: unknown) => { calls.push({ feature: "actionsState", params }); return ok(ACTIONS_STATE); },
    actionShortcuts: () => ok({ bindings: [{ action: "两步", shortcut: "F4", binding: "actions.play:两步" }] }),
    startRecording: (params: unknown) => { calls.push({ feature: "startRecording", params }); return ok({}); },
    stopRecording: (params: unknown) => { calls.push({ feature: "stopRecording", params }); return ok({}); },
    playAction: (params: unknown) => { calls.push({ feature: "playAction", params }); return options.play ? options.play() : ok({}); },
    actionCommand: (id: string, params: unknown) => {
      calls.push({ feature: `actionCommand:${id}`, params });
      if (id === "actions.conditional") {
        if (options.conditional) return options.conditional();
        // 与上游一致：条件成立时把命中的分支名写回 `played`。
        const then = (params as { then?: unknown }).then;
        return ok({ if: (params as { if?: unknown }).if, holds: true, played: typeof then === "string" ? then : null });
      }
      return ok({});
    },
    loadActions: (params: unknown) => {
      calls.push({ feature: "loadActions", params });
      return ok({ unsupported: [], actions: ["两步"], warnings: options.loadWarnings ?? [] });
    },
    saveActions: (params: unknown) => { calls.push({ feature: "saveActions", params }); return ok({ data: "AQID" }); },
    variablesState: () => ok(VARIABLES_STATE),
    defineVariables: (params: unknown) => { calls.push({ feature: "defineVariables", params }); return ok({}); },
    setDataSets: (params: unknown) => { calls.push({ feature: "setDataSets", params }); return ok({}); },
    importDataSets: (params: unknown, text: string) => {
      calls.push({ feature: "importDataSets", params: { params, text } });
      return ok({ imported: 1, skipped: [{ column: "多余", reason: "没有同名变量" }] });
    },
    exportDataSetsCsv: () => ok({ text: "名称,可见性\n第一组,true\n", dataSets: 1 }),
    applyDataSet: (params: unknown) => { calls.push({ feature: "applyDataSet", params }); return ok({}); },
    exportDataSetsAsFiles: (params: unknown) => {
      calls.push({ feature: "exportDataSetsAsFiles", params });
      return ok({ files: [{ name: "第一组", fileName: "第一组.png", bytes: 3, data: "AQID" }] });
    },
    beginBatch: (params: unknown) => { calls.push({ feature: "beginBatch", params }); return ok({ queue: 3 }); },
    // 队列 id 由 `beginBatch` 返回；替身只关心「面板把同一个 id 交给后续调用」，
    // 因此在会话层测试里不重复读它。
    stepBatch: (queue: number) => { expect(queue).toBe(3); return ok(BATCH_PROGRESS); },
    cancelBatch: (queue: number) => { expect(queue).toBe(3); return ok({ ...BATCH_PROGRESS, cancelled: true }); },
    finishBatch: (queue: number) => { expect(queue).toBe(3); return ok(BATCH_PROGRESS); },
    takeBatchFile: (queue: number, index: number) => {
      expect([queue, index]).toEqual([3, 0]);
      return ok({ file: "a.png", output: "a_out.png", data: "AQID" });
    },
    batchState: (queue: number) => { expect(queue).toBe(3); return ok(BATCH_PROGRESS); },
    runScript: (params: unknown) => {
      calls.push({ feature: "runScript", params });
      return ok({
        ok: false,
        preflight: { steps: [{ step: 0, id: "edit.undo", playable: true }], playable: true },
        results: [{ step: 0, id: "edit.undo" }, { step: 1, id: "image.adjust", error: "没有活动图层" }]
      });
    }
  };
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    get handle() { return (options.handle === false ? null : { features: { history }, saveProject: () => ok(new Uint8Array([1, 2, 3])), closeDocument: () => ok({}) }) as never; },
    get view() { return state.view; },
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => options.blocked === true,
    blockingDraft: () => (options.blocked
      ? { ok: false, code: "draft-pending", message: "有未结算的笔迹" }
      : null),
    unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未加载" }),
    fail: <T,>(failure: never) => failure as unknown as EditorResult<T>,
    afterWrite: () => { writes.push(1); return ok(state.view); }
  };
  return { session: createSession(() => context), calls, writes };
}

const names = (calls: Array<{ feature: string }>) => calls.map((call) => call.feature);

describe("历史域会话", () => {
  it("只读查询不产生写操作", () => {
    const { session, writes, calls } = harness();
    expect(session.historyState().ok).toBe(true);
    expect(session.actionsState().ok).toBe(true);
    expect(session.variablesState().ok).toBe(true);
    expect(session.actionShortcuts().ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(names(calls)).toEqual(["historyState", "actionsState"]);
  });

  it("自历史新建交出独立工程字节并关掉内核文档，不把活动文档留给宿主标签", () => {
    // 内核 `history.newDocument` 会切走活动文档；若就这么留着，下一次保存会把派生内容写回
    // 源节点。域会话必须先取字节、再关闭派生文档，然后刷新源文档视图。
    const { session, calls, writes } = harness();
    const created = session.newDocumentFromHistory({ name: "派生" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.name).toBe("派生");
    expect([...created.value.bytes]).toEqual([1, 2, 3]);
    expect(names(calls)).toContain("newDocumentFromHistory");
    expect(writes).toHaveLength(1);
  });

  it("活动草稿阻止自历史新建", () => {
    const { session, writes } = harness({ blocked: true });
    const created = session.newDocumentFromHistory({});
    expect(created.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("内容写入走一次 afterWrite", () => {
    const { session, writes } = harness();
    session.newSnapshot({ name: "基线" });
    session.selectSnapshot(2);
    session.applyDataSet({ name: "第一组", images: {} });
    session.playAction("两步");
    expect(writes).toHaveLength(4);
  });

  it("播放中途失败仍然刷新，但如实上报失败步骤", () => {
    const { session } = harness();
    // 替身默认返回成功且没有 failed，因此这里是成功路径的对照。
    expect(session.playAction("两步").ok).toBe(true);

    const failing = harness({
      play: () => ({ ok: true, value: { action: "半步失败", ran: 1, failed: { step: 1, id: "image.adjust", error: "没有活动图层" } } })
    });
    const failed = failing.session.playAction("半步失败");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.message).toContain("第 2 步");
      expect(failed.message).toContain("image.adjust");
      expect(failed.message).toContain("没有活动图层");
    }
    // 已完成的步骤已经提交：仍要刷新视图。
    expect(failing.writes).toHaveLength(1);
  });

  it("测试条件走写入路径并报出命中分支", () => {
    const { session, writes, calls } = harness();
    const result = session.testCondition({ if: "always", then: "两步", else: null });
    expect(result).toEqual({ ok: true, value: { holds: true, played: "两步", failed: null } });
    expect(calls.at(-1)).toEqual({
      feature: "actionCommand:actions.conditional",
      params: { if: "always", then: "两步", else: null }
    });
    expect(writes).toHaveLength(1);

    // 分支失败要如实上报，不能因为条件成立就当成功。
    const broken = harness({
      conditional: () => ({ ok: true, value: { if: "always", holds: true, played: "两步", failed: { step: 0, error: "没有活动图层" } } })
    });
    const failed = broken.session.testCondition({ if: "always", then: "两步", else: null });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toContain("没有活动图层");
  });

  it("活动草稿阻止测试条件（它会播放分支）", () => {
    const { session, calls } = harness({ blocked: true });
    expect(session.testCondition({ if: "always", then: "两步" }).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("活动草稿阻止一切内容写入，但不阻止只读查询", () => {
    const { session, writes, calls } = harness({ blocked: true });
    expect(session.newSnapshot({}).ok).toBe(false);
    expect(session.applyDataSet({ name: "第一组" }).ok).toBe(false);
    expect(session.playAction("两步").ok).toBe(false);
    expect(session.purge("undo", true).ok).toBe(false);
    expect(session.runScript({ steps: [] }).ok).toBe(false);
    expect(writes).toHaveLength(0);
    // 只读仍可用：界面必须先能看到历史再决定是否写。
    expect(session.historyState().ok).toBe(true);
    expect(names(calls)).toEqual(["historyState"]);
  });

  it("清理默认不确认：域会话不替调用方补 confirm", () => {
    const { session, calls, writes } = harness();
    session.purge("undo");
    expect(calls.at(-1)).toEqual({ feature: "purge", params: { what: "undo", params: { confirm: false } } });
    session.purge("undo", true);
    expect(calls.at(-1)).toEqual({ feature: "purge", params: { what: "undo", params: { confirm: true } } });
    expect(writes).toHaveLength(2);
  });

  it("未知清理范围在本地拒绝，不发内核请求", () => {
    const { session, calls } = harness();
    const plan = session.purgePlan("everything");
    expect(plan.ok).toBe(false);
    expect(session.purge("everything", true).ok).toBe(false);
    expect(names(calls)).toEqual([]);
  });

  it("清理范围解码只接受不可恢复的说明", () => {
    const { session } = harness();
    expect(session.purgePlan("clipboard")).toEqual({
      ok: true,
      value: {
        command: "edit.purge.clipboard", scope: "当前文档的可撤销记录", bytes: 512,
        recoverable: false, available: true, reason: null, approximate: false
      }
    });
  });

  it("历史源取样把取源时的 epoch 原样送回内核（只读，不刷新视图）", () => {
    const { session, calls, writes } = harness();
    const result = session.sampleHistory({ epoch: "0123456789abcdef", state: 0, maxSide: 64 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ state: 0, live: false, width: 4, height: 2 });
      expect(result.value.epoch).toBe("0123456789abcdef");
    }
    expect(calls.at(-1)).toEqual({
      feature: "sampleHistory",
      params: { epoch: "0123456789abcdef", state: 0, maxSide: 64 }
    });
    // 取样是读取路径：不写文档、不推进修订、不触发 afterWrite。
    expect(writes).toHaveLength(0);
  });

  it("检查源可用只送 preview:false，返回没有像素的校验结果", () => {
    // 历史画笔落笔前问「还能用吗」：与取样同一套内核校验，但不合成缩略图。
    const { session, calls, writes } = harness();
    const result = session.checkHistorySource({ epoch: "0123456789abcdef", state: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ epoch: "0123456789abcdef", state: 0, label: "打开", live: false, width: 4, height: 2, sources: 2 });
      expect("pixels" in result.value).toBe(false);
    }
    expect(calls.at(-1)).toEqual({
      feature: "sampleHistory",
      params: { epoch: "0123456789abcdef", state: 0, preview: false }
    });
    expect(writes).toHaveLength(0);
  });

  it("失效的历史源如实报错，不返回别的状态的像素", () => {
    const { session } = harness({
      sampleFailure: () => ({ ok: false, code: "command-failed", message: "历史源已失效（取源时为 a，当前为 b）" })
    });
    const result = session.sampleHistory({ epoch: "a", state: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("已失效");
  });

  it("脚本中途失败保留已成功步骤的刷新，但如实返回失败", () => {
    const { session, writes } = harness();
    const result = session.runScript({ steps: [["edit.undo", {}], ["image.adjust", {}]] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("没有活动图层");
    // 已成功的步骤已提交并刷新：不能因为后面失败就假装什么都没发生。
    expect(writes).toHaveLength(1);
  });

  it("ATN 导入必须有未知步骤报告，导出必须有字节与被跳过步骤", () => {
    const { session } = harness();
    expect(session.loadActions({ data: "AQID" })).toEqual({
      ok: true,
      value: { unsupported: [], actions: ["两步"], warnings: [] }
    });
    // `skipped` 必须往上传：跳过导出会真的丢步骤，界面需要它才能如实说明。
    expect(session.saveActions()).toEqual({ ok: true, value: { data: "AQID", skipped: [] } });
  });

  it("ATN 解析警告往上传：导入成功不等于文件被完整读入", () => {
    // 上游把「N 个尾部字节被忽略」当**警告**而不是失败：文件能导入，但内容可能少了东西。
    // 丢掉 `warnings` 等于宣称完整读入，因此必须原样带到界面。
    const { session } = harness({ loadWarnings: ["4 trailing bytes ignored"] });
    expect(session.loadActions({ data: "AQID" })).toEqual({
      ok: true,
      value: { unsupported: [], actions: ["两步"], warnings: ["4 trailing bytes ignored"] }
    });
    // 缺这个键（老运行时/精简宿主）按「没有警告」处理，不能因此判结构非法。
    const { session: plain } = harness();
    expect(plain.loadActions({ data: "AQID" })).toMatchObject({ ok: true, value: { warnings: [] } });
  });

  it("CSV 与数据集往返只交出文本/字节，不写文件", () => {
    const { session, calls, writes } = harness();
    expect(session.importDataSets("名称,可见性\n第一组,true\n").ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      feature: "importDataSets",
      params: { params: {}, text: "名称,可见性\n第一组,true\n" }
    });
    expect(session.exportDataSetsCsv()).toEqual({ ok: true, value: { text: "名称,可见性\n第一组,true\n", dataSets: 1 } });
    const files = session.exportDataSetsAsFiles({ format: "png" });
    expect(files.ok && files.value[0]).toMatchObject({ fileName: "第一组.png", bytes: 3 });
    // CSV 导入已经在内核里写过数据集；导出不写。
    expect(writes).toHaveLength(1);
  });

  it("删除数据集走整份替换，原样带回其余取值并刷新视图", () => {
    // `image.variables.dataSets` 没有单项删除：重发全集时必须做到「除了删掉的那条，其余一字不改」。
    // 这也是 `setDataSets` 端口存在的唯一理由——漏接它就只有「应用」可以用。
    const { session, calls, writes } = harness();
    const rest = [{ name: "B", values: [{ variable: "showTitle", kind: "visibility", value: false }] }];
    expect(session.setDataSets(rest).ok).toBe(true);
    expect(calls.at(-1)).toEqual({ feature: "setDataSets", params: { dataSets: rest } });
    // 数据集是文档内容：写入后必须刷新视图，否则列表里还显示已删掉的那条。
    expect(writes).toHaveLength(1);
  });

  it("批处理队列：规划返回 id，其余步骤透传", () => {
    const { session, calls } = harness();
    expect(session.beginBatch({ mode: "batch", input: [] })).toEqual({ ok: true, value: 3 });
    expect(session.stepBatch(3).ok).toBe(true);
    expect(session.cancelBatch(3).ok).toBe(true);
    expect(session.finishBatch(3).ok).toBe(true);
    expect(session.batchState(3).ok).toBe(true);
    expect(session.takeBatchFile(3, 0)).toEqual({
      ok: true,
      value: { file: "a.png", output: "a_out.png", data: "AQID" }
    });
    expect(names(calls)).toEqual(["beginBatch"]);
  });

  it("端口缺失时给出可读失败，而不是抛错", () => {
    const { session } = harness({ handle: false });
    for (const result of [
      session.historyState(),
      session.actionsState(),
      session.variablesState(),
      session.beginBatch({ mode: "batch" })
    ]) {
      expect(result.ok).toBe(false);
    }
    expect(session.runScript({ steps: [] }).ok).toBe(false);
  });
});
