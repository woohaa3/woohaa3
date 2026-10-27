/**
 * 分组批量执行服务测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 1.1-1.4 / design D4/D5）。
 *
 * 非渲染回归：只测纯逻辑——预览无副作用、草稿/目录/模型规则、输入快照与逐请求复核、同组提交锁
 * 与跨组叶子预占、异常隔离、结果摘要与释放。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskCatalog, ServerCanvas } from "@woohaa3/contracts";
import { catalogFixture } from "./test-support/fixtures.js";
import { createGroupRunService, categorizeSkipReason, belongsToGroup } from "./group-run-service.js";
import type { CatalogState } from "../../contracts.js";
import type { SubmitInput, SubmitOutcome } from "./submit-coordinator.js";

/** 每个用例独立的 modelKey，避免草稿/目录互相污染。 */
const IMAGE_MODEL = "img-default";

function canvas(nodes: Array<{ id: string; type: string; parentId?: string }>, nodeData: Record<string, unknown> = {}): ServerCanvas {
  return {
    id: "c1",
    title: "测试",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: 0, y: 0 },
        ...(node.parentId ? { parentId: node.parentId } : {})
      })),
      edges: [],
      updatedAt: "2026-10-16T00:00:00.000Z"
    },
    nodeData: nodeData as never,
    assets: [],
    jobs: [],
    updatedAt: "2026-10-16T00:00:00.000Z"
  };
}

function catalog(models: Array<{ modelKey: string; modelType?: "image" | "language"; promptRequirement?: "required" | "optional" | "none" }>): CanvasTaskCatalog {
  return catalogFixture(models.map((model) => ({
    modelKey: model.modelKey,
    modelType: model.modelType ?? "image",
    ...(model.promptRequirement ? { promptRequirement: model.promptRequirement } : {})
  })), { image: IMAGE_MODEL });
}

const READY_CATALOG = catalog([{ modelKey: IMAGE_MODEL }]);
const READY: CatalogState = { status: "ready", catalog: READY_CATALOG };

const GROUP = [
  { id: "g", type: "group" },
  { id: "a", type: "image", parentId: "g" },
  { id: "b", type: "image", parentId: "g" }
];

function service(overrides: Partial<Parameters<typeof createGroupRunService>[0]> = {}) {
  const submitted: string[] = [];
  const summaries: Array<{ accepted: string[]; skipped: unknown[]; failed: unknown[] }> = [];
  const defaultSubmit = async (input: SubmitInput): Promise<SubmitOutcome> => {
    submitted.push(input.nodeId);
    return { ok: true, runId: `run-${input.nodeId}`, jobId: `job-${input.nodeId}` };
  };
  const run = createGroupRunService({
    canvasId: () => "c1",
    getCanvas: () => canvas(GROUP),
    catalogState: () => READY,
    isWritable: () => true,
    submit: defaultSubmit,
    onSummary: (summary) => { summaries.push(summary); },
    ...overrides
  });
  return { run, submitted, summaries };
}

describe("preview（任务 1.2/design D4）", () => {
  it("统计可提交数量并给出跳过类别，不发请求", () => {
    const { run, submitted } = service({
      getCanvas: () => canvas(
        [...GROUP, { id: "c", type: "image", parentId: "g" }],
        { a: { prompt: "画一只猫" }, b: { prompt: "画一只狗" } }
      )
    });
    const preview = run.preview("g");
    expect(preview.enabled).toBe(true);
    expect(preview.count).toBe(2);
    expect(preview.skipped.map((entry) => entry.nodeId)).toEqual(["c"]);
    expect(preview.skipped[0]!.category).toBe("input-missing");
    expect(submitted).toEqual([]);
  });

  it("画布未加载、只读、目录未就绪时禁用并给出真实原因", () => {
    expect(service({ getCanvas: () => null }).run.preview("g")).toMatchObject({ count: 0, enabled: false, reason: "作品尚未加载" });
    expect(service({ isWritable: () => false }).run.preview("g")).toMatchObject({ count: 0, enabled: false });
    expect(service({ catalogState: () => ({ status: "loading" }) }).run.preview("g").reason).toContain("任务目录尚未加载");
    expect(service({ catalogState: () => ({ status: "error", error: "boom" }) }).run.preview("g").reason).toContain("任务目录加载失败");
  });

  it("N 为 0 时区分「成员均在运行中」与「配置不足」", () => {
    const data = { a: { prompt: "x" }, b: { prompt: "y" } };
    const allRunning = service({ getCanvas: () => canvas(GROUP, data), isBusy: () => true });
    expect(allRunning.run.preview("g").reason).toBe("成员均在运行中");
    const noConfig = service({ getCanvas: () => canvas(GROUP, {}) });
    expect(noConfig.run.preview("g").reason).toContain("没有可提交的任务");
    const noMembers = service({ getCanvas: () => canvas([{ id: "g", type: "group" }]) });
    expect(noMembers.run.preview("g").reason).toBe("分组内没有可执行成员");
  });

  it("递归展开嵌套组并复用统一运行态", () => {
    const nested = [
      { id: "g", type: "group" },
      { id: "inner", type: "group", parentId: "g" },
      { id: "a", type: "image", parentId: "inner" },
      { id: "b", type: "image", parentId: "g" }
    ];
    const { run } = service({
      getCanvas: () => canvas(nested, { a: { prompt: "x" }, b: { prompt: "y" } }),
      isBusy: (nodeId) => nodeId === "b"
    });
    const preview = run.preview("g");
    expect(preview.count).toBe(1);
    expect(preview.skipped).toEqual([{ nodeId: "b", category: "running", reason: "成员已在执行中" }]);
  });

  it("未显式选模型时回落到目录默认；明确下线的模型被排除且原因可见", () => {
    const ok = service({ getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }) });
    expect(ok.run.preview("g").count).toBe(2);

    const offline = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "x", parameters: { model: "retired" } }, b: { prompt: "y" } })
    });
    const preview = offline.run.preview("g");
    expect(preview.count).toBe(1);
    const skip = preview.skipped.find((entry) => entry.nodeId === "a")!;
    expect(skip.category).toBe("model-unavailable");
    expect(skip.reason).toContain("retired");
  });

  it("optional/none 提示词模型允许无 prompt 提交，required 排除", () => {
    const optionalCatalog = catalog([
      { modelKey: IMAGE_MODEL, promptRequirement: "optional" },
      { modelKey: "img-none", promptRequirement: "none" }
    ]);
    const optional = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "" }, b: { prompt: "" } }),
      catalogState: () => ({ status: "ready", catalog: optionalCatalog })
    });
    expect(optional.run.preview("g").count).toBe(2);

    const required = service({ getCanvas: () => canvas(GROUP, { a: { prompt: "" }, b: { prompt: "y" } }) });
    const preview = required.run.preview("g");
    expect(preview.count).toBe(1);
    expect(preview.skipped[0]!.nodeId).toBe("a");
    expect(preview.skipped[0]!.category).toBe("input-missing");
  });

  it("草稿按 {nodeId, modelKey} 分区覆盖规范值", () => {
    const { run } = service({
      getCanvas: () => canvas(GROUP, {}),
      readDraft: (nodeId, modelKey) => (nodeId === "a" && modelKey === IMAGE_MODEL ? { prompt: "草稿" } : undefined)
    });
    const preview = run.preview("g");
    expect(preview.count).toBe(1);
    expect(preview.skipped[0]!.nodeId).toBe("b");
  });
});

describe("runGroup 输入快照（任务 1.3/design D4）", () => {
  it("冻结起始成员与输入，后续新增成员不纳入本批", async () => {
    let current = canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } });
    const { run, submitted } = service({ getCanvas: () => current });
    const pending = run.runGroup("g");
    // 提交开始后新增成员：本批不应包含 c。
    current = canvas([...GROUP, { id: "c", type: "image", parentId: "g" }], { a: { prompt: "x" }, b: { prompt: "y" }, c: { prompt: "z" } });
    const summary = await pending;
    expect(summary.accepted.sort()).toEqual(["a", "b"]);
    expect(submitted.sort()).toEqual(["a", "b"]);
  });

  it("提交使用冻结的输入快照（模型与参数），不读冻结后新增草稿", async () => {
    const inputs: SubmitInput[] = [];
    let draftPrompt = "第一次";
    const { run } = service({
      getCanvas: () => canvas(GROUP, {}),
      readDraft: () => ({ prompt: draftPrompt }),
      submit: async (input) => { inputs.push(input); return { ok: true, runId: "r", jobId: "j" }; }
    });
    const pending = run.runGroup("g");
    draftPrompt = "第二次";
    await pending;
    expect(inputs.map((input) => input.prompt)).toEqual(["第一次", "第一次"]);
  });

  it("请求前复核：成员被移出分组后计为跳过", async () => {
    let current = canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } });
    const { run, submitted } = service({
      getCanvas: () => current,
      submit: async (input) => {
        // 第一次请求前把 b 移出分组。
        if (input.nodeId === "a") current = canvas([{ id: "g", type: "group" }, { id: "a", type: "image", parentId: "g" }, { id: "b", type: "image" }], { a: { prompt: "x" }, b: { prompt: "y" } });
        submitted.push(input.nodeId);
        return { ok: true, runId: "r", jobId: "j" };
      }
    });
    const summary = await run.runGroup("g");
    expect(summary.accepted).toEqual(["a"]);
    expect(summary.skipped).toEqual([{ nodeId: "b", reason: "成员已移出该分组（已跳过）" }]);
    expect(summary.failed).toEqual([]);
  });

  it("切画布后停止发出剩余请求并计为跳过", async () => {
    let canvasId = "c1";
    const { run, submitted } = service({
      canvasId: () => canvasId,
      getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }),
      submit: async (input) => {
        submitted.push(input.nodeId);
        canvasId = "c2";
        return { ok: true, runId: "r", jobId: "j" };
      }
    });
    const summary = await run.runGroup("g");
    expect(submitted).toEqual(["a"]);
    expect(summary.skipped).toEqual([{ nodeId: "b", reason: "画布已切换（已跳过）" }]);
  });

  it("无合法成员时不发请求，并把真实原因写入摘要", async () => {
    const { run, submitted, summaries } = service({ getCanvas: () => canvas(GROUP, {}) });
    const summary = await run.runGroup("g");
    expect(submitted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.skipped.map((entry) => entry.nodeId).sort()).toEqual(["a", "b"]);
    expect(summary.skipped.every((entry) => entry.reason.includes("提示词"))).toBe(true);
    expect(summaries).toHaveLength(1);
  });

  it("分组内无成员时摘要说明没有可执行成员", async () => {
    const { run, submitted } = service({ getCanvas: () => canvas([{ id: "g", type: "group" }]) });
    const summary = await run.runGroup("g");
    expect(submitted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.skipped).toEqual([{ nodeId: "g", reason: "没有可提交的成员" }]);
  });
});

describe("提交锁与跨组预占（任务 1.3/design D5）", () => {
  it("同组并发触发只有一个批次，且提交中可查询", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitted: string[] = [];
    const { run } = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }),
      submit: async (input) => { submitted.push(input.nodeId); await gate; return { ok: true, runId: "r", jobId: "j" }; }
    });
    const first = run.runGroup("g");
    expect(run.isSubmitting("g")).toBe(true);
    const second = await run.runGroup("g");
    expect(second.accepted).toEqual([]);
    expect(second.skipped).toEqual([]);
    release();
    await first;
    expect(run.isSubmitting("g")).toBe(false);
    // 每个成员只提交一次。
    expect(submitted.sort()).toEqual(["a", "b"]);
  });

  it("嵌套组交叠时共享叶子预占，同一叶子不重复提交", async () => {
    const shared = [
      { id: "g", type: "group" },
      { id: "inner", type: "group", parentId: "g" },
      { id: "a", type: "image", parentId: "inner" },
      { id: "b", type: "image", parentId: "g" }
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitted: string[] = [];
    const { run } = service({
      getCanvas: () => canvas(shared, { a: { prompt: "x" }, b: { prompt: "y" } }),
      submit: async (input) => { submitted.push(input.nodeId); await gate; return { ok: true, runId: "r", jobId: "j" }; }
    });
    const parent = run.runGroup("g");
    const child = run.runGroup("inner");
    release();
    const [parentSummary, childSummary] = await Promise.all([parent, child]);
    // a 只被父组或子组提交一次，另一个批次把它计为跳过。
    expect(submitted.filter((id) => id === "a")).toHaveLength(1);
    const totalAccepted = parentSummary.accepted.length + childSummary.accepted.length;
    expect(totalAccepted + childSummary.skipped.length + parentSummary.skipped.length).toBeGreaterThan(2);
  });

  it("统一运行态阻止重复提交，不依赖滞后的 canonical", async () => {
    const busy = new Set<string>();
    const submitted: string[] = [];
    const { run } = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }),
      isBusy: (nodeId) => busy.has(nodeId),
      submit: async (input) => {
        // 提交后立刻把成员标为运行中（模拟活动状态先于 canonical 回流）。
        busy.add(input.nodeId);
        submitted.push(input.nodeId);
        return { ok: true, runId: "r", jobId: "j" };
      }
    });
    await run.runGroup("g");
    // 第二批不应重复提交仍在运行的成员。
    const second = await run.runGroup("g");
    expect(second.accepted).toEqual([]);
    expect(second.skipped.map((entry) => entry.reason)).toEqual(["成员已在执行中", "成员已在执行中"]);
    expect(submitted.sort()).toEqual(["a", "b"]);
  });
});

describe("异常隔离与清理（任务 1.4/design D5）", () => {
  it("单项抛错计入 failed 并继续其它合法成员，最终释放锁", async () => {
    const submitted: string[] = [];
    const { run } = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }),
      submit: async (input) => {
        submitted.push(input.nodeId);
        if (input.nodeId === "a") throw new Error("网络异常");
        return { ok: true, runId: "r", jobId: "j" };
      }
    });
    const summary = await run.runGroup("g");
    expect(submitted).toEqual(["a", "b"]);
    expect(summary.failed).toEqual([{ nodeId: "a", error: "网络异常" }]);
    expect(summary.accepted).toEqual(["b"]);
    expect(run.isSubmitting("g")).toBe(false);
    // 释放后仍可再次提交。
    const again = await run.runGroup("g");
    expect(again.accepted).toEqual(["b"]);
  });

  it("提交被拒绝计入 failed，不阻断其它成员", async () => {
    const { run } = service({
      getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }),
      submit: async (input): Promise<SubmitOutcome> =>
        input.nodeId === "a" ? { ok: false, error: "服务端拒绝" } : { ok: true, runId: "r", jobId: "j" }
    });
    const summary = await run.runGroup("g");
    expect(summary.accepted).toEqual(["b"]);
    expect(summary.failed).toEqual([{ nodeId: "a", error: "服务端拒绝" }]);
  });

  it("只读时整批跳过且不发请求", async () => {
    const { run, submitted } = service({ isWritable: () => false, getCanvas: () => canvas(GROUP, { a: { prompt: "x" } }) });
    const summary = await run.runGroup("g");
    expect(submitted).toEqual([]);
    expect(summary.skipped).toEqual([{ nodeId: "g", reason: "当前会话不可写（画布只读）" }]);
  });

  it("dispose 清理锁与预占，后续不再发起", async () => {
    const { run, submitted } = service({ getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }) });
    run.dispose();
    const summary = await run.runGroup("g");
    expect(submitted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(run.isSubmitting("g")).toBe(false);
  });

  it("订阅在状态变化时触发，退订后不再触发", async () => {
    const { run } = service({ getCanvas: () => canvas(GROUP, { a: { prompt: "x" }, b: { prompt: "y" } }) });
    let count = 0;
    const off = run.subscribe(() => { count += 1; });
    await run.runGroup("g");
    expect(count).toBeGreaterThan(0);
    const after = count;
    off();
    await run.runGroup("g");
    expect(count).toBe(after);
  });
});

describe("categorizeSkipReason / belongsToGroup（任务 1.1）", () => {
  it("把单节点阻止原因归类为跳过类别", () => {
    expect(categorizeSkipReason("成员已在执行中")).toBe("running");
    expect(categorizeSkipReason("模型 m 当前不可用（可能已下线），不会自动替换")).toBe("model-unavailable");
    expect(categorizeSkipReason("节点已不存在")).toBe("not-runnable");
    expect(categorizeSkipReason("请先输入提示词")).toBe("input-missing");
  });

  it("递归祖先链判定归属，防环", () => {
    const nodes = [
      { id: "g", type: "group" },
      { id: "inner", type: "group", parentId: "g" },
      { id: "a", type: "image", parentId: "inner" },
      { id: "loop1", type: "group", parentId: "loop2" },
      { id: "loop2", type: "group", parentId: "loop1" }
    ];
    expect(belongsToGroup(nodes, "a", "g")).toBe(true);
    expect(belongsToGroup(nodes, "a", "inner")).toBe(true);
    expect(belongsToGroup(nodes, "a", "missing")).toBe(false);
    expect(belongsToGroup(nodes, "loop1", "loop2")).toBe(true);
    expect(belongsToGroup(nodes, "loop1", "missing")).toBe(false);
  });
});

it("dispatches mixed media/text independently, freezing text drafts and preserving accepted siblings on failure", async () => {
  const c = canvas([...GROUP, { id: "words", type: "text", parentId: "g" }, { id: "bad", type: "text", parentId: "g" }], { a: { prompt: "image" }, b: { prompt: "image" } });
  const entry = { action: "generate" as const, mode: "text" as const, canvasId: "c1", nodeId: "words", prompt: "unsent draft", model: "assistant-model" };
  const text: string[] = [];
  const f = service({ getCanvas: () => c, textPrecheck: (_canvas, nodeId) => nodeId === "bad" ? { eligible: false, reason: "助手选择失效" } : { eligible: true, input: { canvasId: "c1", entry } },
    submitText: async input => { text.push(input.entry.prompt); return { ok: false, error: "connection revoked" }; } });
  expect(f.run.preview("g")).toMatchObject({ count: 3, skipped: [{ nodeId: "bad" }] });
  const summary = await f.run.runGroup("g");
  expect(summary).toMatchObject({ accepted: ["a", "b"], failed: [{ nodeId: "words" }], skipped: [{ nodeId: "bad" }] });
  expect(text).toEqual(["unsent draft"]);
  expect(f.submitted).toEqual(["a", "b"]);
});

it("text-only groups can submit with no Task language catalog", async () => {
  const c = canvas([{ id: "g", type: "group" }, { id: "words", type: "text", parentId: "g" }]);
  const f = service({ getCanvas: () => c, catalogState: () => ({ status: "loading" }), textPrecheck: () => ({ eligible: true, input: { canvasId: "c1", entry: { action: "generate", mode: "text", canvasId: "c1", nodeId: "words", prompt: "draft" } } }), submitText: async () => ({ ok: true }) });
  expect(f.run.preview("g")).toMatchObject({ enabled: true, count: 1 });
  expect(await f.run.runGroup("g")).toMatchObject({ accepted: ["words"] });
  expect(f.submitted).toEqual([]);
});
