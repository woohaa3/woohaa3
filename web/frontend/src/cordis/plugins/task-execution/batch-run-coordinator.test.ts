/**
 * group 批量运行协调器测试（change: add-canvas-node-grouping，任务 3.3/3.4）。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { collectGroupLeafDescendants, createBatchRunner, resolveCatalogModelKey, resolveGroupRunLeaves, type BatchRunLeaf } from "./batch-run-coordinator.js";
import type { SubmitInput, SubmitOutcome } from "./submit-coordinator.js";

const catalog = { available: true, models: [] } as unknown as CanvasTaskCatalog;

function input(): Omit<SubmitInput, "nodeId"> {
  return { modelKey: "m1", prompt: "p", parameters: {}, catalog, expectedModelType: "image" as never };
}

describe("collectGroupLeafDescendants", () => {
  it("递归展开非 group 后代（parentId 是唯一事实源）", () => {
    const nodes = [
      { id: "g1", type: "group" },
      { id: "g2", type: "group", parentId: "g1" },
      { id: "a", type: "image", parentId: "g2" },
      { id: "b", type: "text", parentId: "g1" },
      { id: "outside", type: "image" }
    ];
    expect(collectGroupLeafDescendants(nodes, "g1").sort()).toEqual(["a", "b"]);
  });

  it("无成员时返回空数组", () => {
    expect(collectGroupLeafDescendants([{ id: "g", type: "group" }], "g")).toEqual([]);
  });

  it("parent 环不导致无限循环", () => {
    const nodes = [
      { id: "g1", type: "group", parentId: "g2" },
      { id: "g2", type: "group", parentId: "g1" },
      { id: "a", type: "image", parentId: "g1" }
    ];
    expect(collectGroupLeafDescendants(nodes, "g1")).toEqual(["a"]);
  });
});

describe("resolveGroupRunLeaves（任务 3.4）", () => {
  const deps = {
    panelKindForNodeType: (nodeType: string) => (nodeType === "image" ? "image-generation" : null),
    modelTypeForPanelKind: () => "image" as never,
    catalog
  };
  const canvas = {
    document: {
      nodes: [
        { id: "g", type: "group" },
        { id: "ready", type: "image", parentId: "g" },
        { id: "noprompt", type: "image", parentId: "g" },
        { id: "pending", type: "image", parentId: "g" },
        { id: "notask", type: "text", parentId: "g" }
      ]
    },
    nodeData: {
      ready: { prompt: "画一只猫", parameters: { model: "m1" } },
      noprompt: { parameters: { model: "m1" } },
      pending: { prompt: "x", parameters: { model: "m1" }, taskStatus: "running" },
      notask: { prompt: "y", parameters: { model: "m1" } }
    }
  };

  it("按可运行/pending 分类，group 自身不出现在结果", () => {
    const leaves = resolveGroupRunLeaves(canvas, "g", deps);
    expect(leaves.map((leaf) => leaf.nodeId).sort()).toEqual(["noprompt", "notask", "pending", "ready"]);
    expect(leaves.some((leaf) => leaf.nodeId === "g")).toBe(false);
    const ready = leaves.find((leaf) => leaf.nodeId === "ready")!;
    expect(ready.runnable).toBe(true);
    expect(ready.input).toMatchObject({ modelKey: "m1", prompt: "画一只猫" });
    expect(leaves.find((leaf) => leaf.nodeId === "noprompt")!.runnable).toBe(false);
    expect(leaves.find((leaf) => leaf.nodeId === "pending")!.pending).toBe(true);
    expect(leaves.find((leaf) => leaf.nodeId === "notask")!.runnable).toBe(false);
  });

  it("无 nodeData 的叶子判定为不可运行", () => {
    const leaves = resolveGroupRunLeaves({ document: { nodes: [{ id: "g", type: "group" }, { id: "x", type: "image", parentId: "g" }] }, nodeData: {} }, "g", deps);
    expect(leaves[0]!.runnable).toBe(false);
  });
});

describe("resolveGroupRunLeaves 草稿合并与默认模型（change: fix-group-and-marquee-preview）", () => {
  const deps = {
    panelKindForNodeType: (nodeType: string) => (nodeType === "image" ? "image-generation" : null),
    modelTypeForPanelKind: () => "image" as never,
    catalog
  };
  /** group 下两个成员，canonical nodeData 都还没有 prompt/parameters（刚写好、没单独跑过）。 */
  const canvas = {
    document: {
      nodes: [
        { id: "g", type: "group" },
        { id: "a", type: "image", parentId: "g" },
        { id: "b", type: "image", parentId: "g" }
      ]
    },
    nodeData: {}
  };

  it("只有规范 nodeData 时不可运行（回归：点运行毫无反应）", () => {
    const leaves = resolveGroupRunLeaves(canvas, "g", deps);
    expect(leaves.every((leaf) => !leaf.runnable)).toBe(true);
  });

  it("合并未提交草稿后判为可运行，且快照带上草稿 prompt", () => {
    const leaves = resolveGroupRunLeaves(
      { document: canvas.document, nodeData: { a: { parameters: { model: "m1" } } } },
      "g",
      {
        ...deps,
        readDraft: (nodeId, modelKey) => (nodeId === "a" && modelKey === "m1" ? { prompt: "画一只猫" } : undefined)
      }
    );
    const a = leaves.find((leaf) => leaf.nodeId === "a")!;
    expect(a.runnable).toBe(true);
    expect(a.input).toMatchObject({ modelKey: "m1", prompt: "画一只猫" });
    // provider-side parameters 仍带上 model。
    expect(a.input!.parameters).toMatchObject({ model: "m1" });
    // 没有草稿的成员仍不可运行。
    expect(leaves.find((leaf) => leaf.nodeId === "b")!.runnable).toBe(false);
  });

  it("草稿严格要求按模型分区读取（无模型分区不再被读到）", () => {
    // 该模型分区有草稿：应使用它。
    const partitioned = resolveGroupRunLeaves(
      { document: canvas.document, nodeData: { a: { parameters: { model: "m1" } } } },
      "g",
      {
        ...deps,
        readDraft: (nodeId, modelKey) =>
          nodeId === "a" && modelKey === "m1" ? { prompt: "分区草稿" } : undefined
      }
    );
    expect(partitioned.find((leaf) => leaf.nodeId === "a")!.input).toMatchObject({ prompt: "分区草稿" });
    // change: 2026-10-07-remove-residual-compatibility —— 无模型分区（modelKey 为空）不再被读取。
    const legacy = resolveGroupRunLeaves(
      { document: canvas.document, nodeData: { a: { parameters: { model: "m1" } } } },
      "g",
      { ...deps, readDraft: (_nodeId, modelKey) => (modelKey === "" ? { prompt: "旧分区" } : undefined) }
    );
    const a = legacy.find((leaf) => leaf.nodeId === "a")!;
    // 没有按 `m1` 分区的草稿、也没有规范 prompt → 不可运行。
    expect(a.runnable).toBe(false);
  });

  it("草稿的 prompt 覆盖规范值，草稿 parameters 覆盖规范 parameters", () => {
    const withCanonical = {
      document: canvas.document,
      nodeData: { a: { prompt: "旧提示词", parameters: { model: "m-old", steps: 1 } } }
    };
    const leaves = resolveGroupRunLeaves(withCanonical, "g", {
      ...deps,
      readDraft: () => ({ prompt: "新提示词", parameters: { steps: 2 } })
    });
    const a = leaves.find((leaf) => leaf.nodeId === "a")!;
    // 模型身份来自规范值（未被草稿覆盖），prompt 与同名字段被草稿覆盖。
    expect(a.input).toMatchObject({ modelKey: "m-old", prompt: "新提示词" });
    // 规范的其它参数保留，草稿只覆盖同名字段。
    expect(a.input!.parameters).toMatchObject({ model: "m-old", steps: 2 });
  });

  it("未显式选模型时回落到目录默认模型（与单节点面板一致）", () => {
    const leaves = resolveGroupRunLeaves(
      { document: canvas.document, nodeData: { a: { prompt: "p" } } },
      "g",
      { ...deps, resolveModel: (_kind, candidate) => candidate || "default-model" }
    );
    const a = leaves.find((leaf) => leaf.nodeId === "a")!;
    expect(a.runnable).toBe(true);
    expect(a.input).toMatchObject({ modelKey: "default-model" });
  });
});

describe("resolveCatalogModelKey（change: fix-group-and-marquee-preview）", () => {
  const model = (key: string, type: string) => ({ modelKey: key, modelType: type }) as never;
  const taskCatalog = {
    available: true,
    models: [model("img-default", "image"), model("img-alt", "image"), model("txt-1", "language")],
    defaultModels: { image: "img-default" }
  } as never;

  it("合法显式选择原样保留", () => {
    expect(resolveCatalogModelKey(taskCatalog, "image", "img-alt")).toBe("img-alt");
  });

  it("非法或空选择回落到 defaultModels", () => {
    expect(resolveCatalogModelKey(taskCatalog, "image", "nope")).toBe("img-default");
    expect(resolveCatalogModelKey(taskCatalog, "image", "")).toBe("img-default");
  });

  it("defaultModels 不合法时回落到该类型第一个模型", () => {
    const catalog = { available: true, models: [model("txt-1", "language")], defaultModels: { language: "missing" } } as never;
    expect(resolveCatalogModelKey(catalog, "language", "")).toBe("txt-1");
  });

  it("目录不可用时原样退回显式值（由提交预检报错）", () => {
    const catalog = { available: false, models: [], defaultModels: {} } as never;
    expect(resolveCatalogModelKey(catalog, "image", "user-pick")).toBe("user-pick");
  });
});

describe("createBatchRunner", () => {  function runner(leaves: BatchRunLeaf[], submitted: string[], failOn: Set<string> = new Set()) {
    return createBatchRunner({
      resolveLeaves: () => leaves,
      coordinator: {
        submit: async (i): Promise<SubmitOutcome> => {
          submitted.push(i.nodeId);
          if (failOn.has(i.nodeId)) return { ok: false, error: "服务端拒绝" };
          return { ok: true, runId: `run-${i.nodeId}`, jobId: `job-${i.nodeId}` };
        }
      }
    });
  }

  it("只运行可运行且非 pending 的叶子，汇总 accepted/skipped", async () => {
    const submitted: string[] = [];
    const summary = await runner([
      { nodeId: "a", runnable: true, input: input() },
      { nodeId: "b", runnable: false },
      { nodeId: "c", runnable: true, input: input(), pending: true },
      { nodeId: "d", runnable: true, input: input() }
    ], submitted).runGroup("g");
    expect(submitted).toEqual(["a", "d"]);
    expect(summary.accepted).toEqual(["a", "d"]);
    expect(summary.skipped.map((s) => s.nodeId).sort()).toEqual(["b", "c"]);
    expect(summary.failed).toEqual([]);
  });

  it("单项失败不中断、不回滚已受理项", async () => {
    const submitted: string[] = [];
    const summary = await runner([
      { nodeId: "a", runnable: true, input: input() },
      { nodeId: "b", runnable: true, input: input() },
      { nodeId: "c", runnable: true, input: input() }
    ], submitted, new Set(["b"])).runGroup("g");
    // b 失败但 a 已受理、c 继续提交。
    expect(summary.accepted).toEqual(["a", "c"]);
    expect(summary.failed).toEqual([{ nodeId: "b", error: "服务端拒绝" }]);
  });

  it("全部不可运行时 accepted 与 failed 均为空", async () => {
    const submitted: string[] = [];
    const summary = await runner([{ nodeId: "a", runnable: false }], submitted).runGroup("g");
    expect(submitted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
  });

  it("每个实际提交成员独立产生 started；拒绝成员产生 local-rejection finished（任务 6.4）", async () => {
    const { createSubmitCoordinator } = await import("./submit-coordinator.js");
    const { createEmptyWoohaa3ServerCanvas } = await import("@woohaa3/contracts");
    const canvas = createEmptyWoohaa3ServerCanvas("c1");
    canvas.document.nodes.push({ id: "a", type: "image", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "b", type: "image", position: { x: 100, y: 0 } });
    const modelCatalog = {
      available: true,
      models: [{ modelKey: "m1", modelType: "image" }],
      defaultModels: {}
    } as unknown as CanvasTaskCatalog;

    const started: string[] = [];
    const rejected: string[] = [];
    let seq = 0;
    const coordinator = createSubmitCoordinator({
      store: { getState: () => ({ canvas }) },
      client: {
        run: async (request) =>
          request.nodeId === "b"
            ? { ok: false, error: "拒绝" }
            : { ok: true, runId: request.runId, jobId: request.jobId },
        cancel: async () => ({ ok: true })
      },
      createRunId: () => `run-${seq++}`,
      activity: {
        started: (payload) => started.push(payload.runId),
        localRejected: (payload) => rejected.push(payload.activity.runId)
      }
    });
    const batch = createBatchRunner({
      coordinator,
      resolveLeaves: () => [
        { nodeId: "a", runnable: true, input: { ...input(), catalog: modelCatalog, expectedModelType: "image" as never } },
        { nodeId: "b", runnable: true, input: { ...input(), catalog: modelCatalog, expectedModelType: "image" as never } }
      ]
    });
    const summary = await batch.runGroup("g");
    expect(started).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(summary.accepted).toEqual(["a"]);
    expect(summary.failed.map((f) => f.nodeId)).toEqual(["b"]);

    // 全部跳过：零事件。
    started.length = 0;
    rejected.length = 0;
    const empty = createBatchRunner({ coordinator, resolveLeaves: () => [{ nodeId: "x", runnable: false }] });
    await empty.runGroup("g");
    expect(started).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
