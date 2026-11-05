/**
 * 「查看生成溯源」解析链路测试（change: l0-generation-provenance）。
 *
 * 覆盖：nodeData.activeRunId / outputAssetId → assets[].provenance.runId →
 * jobs[] 中 runId 匹配项的 taskId；不可溯源时不出现菜单项；无 tasks.inspect 时静默隐藏。
 */
import { describe, expect, it } from "vitest";
import { CANVAS_MENU_SECTION, type StoredJob } from "@woohaa3/contracts";
import type { Context } from "@deepseek-ai/cordis";
import {
  GENERATION_TRACE_MENU_ID,
  GENERATION_TRACE_MENU_LABEL,
  generationTraceMenuItems,
  openGenerationTrace,
  registerGenerationTraceMenu,
  resolveGenerationTraceTarget,
  resolveTraceRunId,
  type GenerationTraceDialogPayload,
  type GenerationTraceTarget
} from "./generation-trace.js";
import { canvasFixture, imageAsset, NOW } from "./test-support/fixtures.js";
import type { ContextMenuContext } from "../../contracts.js";

const NODE_ID = "img-1";

function job(overrides: Partial<StoredJob> & { runId: string; taskId: string }): StoredJob {
  return {
    id: `job-${overrides.runId}`,
    nodeId: NODE_ID,
    status: "success",
    updatedAt: NOW,
    ...overrides
  };
}

function menuContext(nodeId: string | null, extra: Partial<ContextMenuContext> = {}): ContextMenuContext {
  return { nodeId, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 }, writable: true, ...extra };
}

describe("resolveTraceRunId", () => {
  it("activeRunId 是最近一次 run，优先于资产 provenance", () => {
    const canvas = canvasFixture({
      nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-2", outputAssetId: "asset-1" } }],
      assets: [imageAsset({ id: "asset-1", provenance: { runId: "run-1" } })]
    });
    expect(resolveTraceRunId(canvas, NODE_ID)).toBe("run-2");
  });

  it("没有 activeRunId 时回退产物 provenance.runId", () => {
    const canvas = canvasFixture({
      nodes: [{ id: NODE_ID, type: "image", data: { outputAssetId: "asset-1" } }],
      assets: [imageAsset({ id: "asset-1", provenance: { runId: "run-1" } })]
    });
    expect(resolveTraceRunId(canvas, NODE_ID)).toBe("run-1");
  });

  it("上传素材等没有 provenance 的资产返回 null", () => {
    const canvas = canvasFixture({
      nodes: [{ id: NODE_ID, type: "image", data: { outputAssetId: "asset-upload" } }],
      assets: [imageAsset({ id: "asset-upload" })]
    });
    expect(resolveTraceRunId(canvas, NODE_ID)).toBeNull();
  });
});

describe("resolveGenerationTraceTarget", () => {
  it("按 runId 匹配 jobs 得到 taskId 作为 taskKey", () => {
    const canvas = {
      ...canvasFixture({
        nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }]
      }),
      jobs: [job({ runId: "run-1", taskId: "task-upstream-1" })]
    };
    expect(resolveGenerationTraceTarget(canvas, NODE_ID)).toEqual({
      canvasId: canvas.id,
      nodeId: NODE_ID,
      taskKey: "task-upstream-1"
    });
  });

  it("只有产物、没有 run/job 时回退 canvasId + nodeId（不带 taskKey）", () => {
    const canvas = {
      ...canvasFixture({
        nodes: [{ id: NODE_ID, type: "image", data: { outputAssetId: "asset-upload" } }],
        assets: [imageAsset({ id: "asset-upload" })]
      }),
      jobs: []
    };
    expect(resolveGenerationTraceTarget(canvas, NODE_ID)).toEqual({ canvasId: canvas.id, nodeId: NODE_ID });
  });

  it("runId 存在但 jobs 无匹配项时同样回退筛选", () => {
    const canvas = {
      ...canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-9" } }] }),
      jobs: [job({ runId: "run-1", taskId: "task-old" })]
    };
    const target = resolveGenerationTraceTarget(canvas, NODE_ID);
    expect(target).toEqual({ canvasId: canvas.id, nodeId: NODE_ID });
    expect(target).not.toHaveProperty("taskKey");
  });

  it("既无产物也无 run 的节点不可溯源", () => {
    const canvas = canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { title: "空节点" } }] });
    expect(resolveGenerationTraceTarget(canvas, NODE_ID)).toBeNull();
  });

  it("节点不存在或画布未就绪时返回 null", () => {
    const canvas = canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }] });
    expect(resolveGenerationTraceTarget(canvas, "missing")).toBeNull();
    expect(resolveGenerationTraceTarget(null, NODE_ID)).toBeNull();
  });

  it("jobs 中 runId 匹配但 nodeId 不属于该节点时不误用", () => {
    const canvas = {
      ...canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }] }),
      jobs: [job({ runId: "run-1", taskId: "task-other-node", nodeId: "other" })]
    };
    expect(resolveGenerationTraceTarget(canvas, NODE_ID)).not.toHaveProperty("taskKey");
  });
});

describe("openGenerationTrace", () => {
  const target: GenerationTraceTarget = { canvasId: "canvas-1", nodeId: NODE_ID, taskKey: "task-upstream-1" };

  it("有 taskKey 时在画布内打开浮窗，不导航页面", () => {
    const opened: GenerationTraceDialogPayload[] = [];
    const paged: GenerationTraceTarget[] = [];
    expect(
      openGenerationTrace(target, {
        openDialog: (payload) => {
          opened.push(payload);
          return true;
        },
        openPage: (value) => paged.push(value)
      })
    ).toBe("dialog");
    expect(opened).toEqual([{ taskKey: "task-upstream-1", canvasId: "canvas-1", nodeId: NODE_ID }]);
    expect(paged).toEqual([]);
  });

  it("解析不到 taskKey 时回退任务监控页筛选（降级路径保留）", () => {
    const opened: GenerationTraceDialogPayload[] = [];
    const paged: GenerationTraceTarget[] = [];
    expect(
      openGenerationTrace(
        { canvasId: "canvas-1", nodeId: NODE_ID },
        {
          openDialog: (payload) => {
            opened.push(payload);
            return true;
          },
          openPage: (value) => paged.push(value)
        }
      )
    ).toBe("page");
    expect(opened).toEqual([]);
    expect(paged).toEqual([{ canvasId: "canvas-1", nodeId: NODE_ID }]);
  });

  it("浮窗打开失败（未注册/校验拒绝）时同样回退页面，不留空白", () => {
    const paged: GenerationTraceTarget[] = [];
    expect(openGenerationTrace(target, { openDialog: () => false, openPage: (value) => paged.push(value) })).toBe("page");
    expect(paged).toEqual([target]);
  });

  it("不可溯源（target 为 null）时什么都不做", () => {
    expect(openGenerationTrace(null, { openDialog: () => true, openPage: () => undefined })).toBe("none");
  });
});

describe("registerGenerationTraceMenu 选择派发", () => {
  function contribution(deps: { openTraceDialog?: (payload: GenerationTraceDialogPayload) => boolean; openTrace: (target: GenerationTraceTarget) => void }) {
    let captured: { onSelect?: (itemId: string, context: ContextMenuContext) => void } = {};
    const ctx = {
      slots: {
        register: (_slot: string, entry: typeof captured) => {
          captured = entry;
          return () => undefined;
        }
      }
    } as unknown as Context;
    const canvas = {
      ...canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }] }),
      jobs: [job({ runId: "run-1", taskId: "task-upstream-1" })]
    };
    registerGenerationTraceMenu(ctx, { owner: "task-execution", getCanvas: () => canvas, canInspect: () => true, ...deps });
    return captured;
  }

  it("有任务号时打开画布内浮窗（不调页面导航）", () => {
    const dialogs: GenerationTraceDialogPayload[] = [];
    const pages: GenerationTraceTarget[] = [];
    contribution({ openTraceDialog: (payload) => (dialogs.push(payload), true), openTrace: (target) => pages.push(target) })
      .onSelect?.(GENERATION_TRACE_MENU_ID, menuContext(NODE_ID));
    expect(dialogs).toEqual([{ taskKey: "task-upstream-1", canvasId: expect.any(String), nodeId: NODE_ID }]);
    expect(pages).toEqual([]);
  });

  it("无浮窗能力时回退页面（无 taskKey 入口不打开浮窗）", () => {
    const pages: GenerationTraceTarget[] = [];
    contribution({ openTrace: (target) => pages.push(target) })
      .onSelect?.(GENERATION_TRACE_MENU_ID, menuContext(NODE_ID));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ canvasId: expect.any(String), nodeId: NODE_ID, taskKey: "task-upstream-1" });
  });

  it("hidden 传入后菜单项为空（接线段把发行形态的隐藏清单接上了）", () => {
    let captured: { items?: (context: ContextMenuContext) => unknown[] } = {};
    const ctx = {
      slots: {
        register: (_slot: string, entry: typeof captured) => {
          captured = entry;
          return () => undefined;
        }
      }
    } as unknown as Context;
    const canvas = canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }] });
    registerGenerationTraceMenu(ctx, {
      owner: "task-execution",
      getCanvas: () => canvas,
      canInspect: () => true,
      hidden: () => true,
      openTrace: () => undefined
    });
    expect(captured.items?.(menuContext(NODE_ID))).toHaveLength(0);
  });
});

describe("generationTraceMenuItems", () => {
  const traceable = canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: { activeRunId: "run-1" } }] });

  it("可溯源且有 tasks.inspect 时出现菜单项（其他操作 section，排在编辑动作前）", () => {
    const items = generationTraceMenuItems({ canvas: traceable, context: menuContext(NODE_ID), canInspect: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: GENERATION_TRACE_MENU_ID,
      label: GENERATION_TRACE_MENU_LABEL,
      section: CANVAS_MENU_SECTION.other,
      order: 10
    });
    expect(items[0]).not.toHaveProperty("disabled");
  });

  it("无 tasks.inspect 时静默隐藏（与「查看任务」一致）", () => {
    expect(generationTraceMenuItems({ canvas: traceable, context: menuContext(NODE_ID), canInspect: false })).toEqual([]);
  });

  it("不可溯源节点不出现菜单项", () => {
    const canvas = canvasFixture({ nodes: [{ id: NODE_ID, type: "image", data: {} }] });
    expect(generationTraceMenuItems({ canvas, context: menuContext(NODE_ID), canInspect: true })).toEqual([]);
  });

  it("空白处右键与拉线创建不出现菜单项", () => {
    expect(generationTraceMenuItems({ canvas: traceable, context: menuContext(null), canInspect: true })).toEqual([]);
    const connectFrom = menuContext(NODE_ID, { connectFrom: { nodeId: "src", nodeType: "image" } });
    expect(generationTraceMenuItems({ canvas: traceable, context: connectFrom, canInspect: true })).toEqual([]);
  });

  it("发行形态点名隐藏时不出现菜单项（四喜清单），缺省不隐藏", () => {
    expect(
      generationTraceMenuItems({ canvas: traceable, context: menuContext(NODE_ID), canInspect: true, hidden: true })
    ).toEqual([]);
    expect(
      generationTraceMenuItems({ canvas: traceable, context: menuContext(NODE_ID), canInspect: true })
    ).toHaveLength(1);
  });
});
