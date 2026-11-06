/**
 * ModelExecutionHost 删除节点回归
 * （change: fix-delete-node-crash-and-white-screen）。
 *
 * 锁定的缺陷：`ModelExecutionHost` 部分 hook 曾位于 `if (!context) return null` **之后**。
 * 节点被删除后 `context` 变 `null`，早期返回跳过后续 hook，React 抛
 * 「Rendered fewer hooks than expected」，整棵 React 树被卸载 → 页面白屏。
 *
 * 这里挂载**生产** `ModelExecutionHost`，把选中节点从规范 store 中删除（等价于用户删除节点），
 * 断言：不抛错、面板消失、页面其它内容仍可渲染。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelExecutionHost } from "./model-execution-host.js";
import { createModelDraftStore } from "./model-draft.js";
import { nodeDraftStore } from "./drafts.js";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import { catalogFixture, canvasFixture } from "./test-support/fixtures.js";
import { ModelInteractionService } from "../../services/model-interaction-service.js";
import { DialogService } from "../../services/dialogs/service.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { CatalogState, TaskCatalogService } from "../../contracts.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NODE_ID = "video-node";

/** 只读目录替身：状态由测试给定，`load()` 不改变状态。 */
class StubCatalogService implements TaskCatalogService {
  private listeners = new Set<() => void>();
  private state: CatalogState;

  constructor(catalog: CanvasTaskCatalog) {
    this.state = { status: "ready", catalog };
  }

  getState = (): CatalogState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  load = async (): Promise<void> => undefined;
  invalidate = (): void => undefined;
}

const CATALOG = catalogFixture([
  { modelKey: "video-model", modelType: "video", interaction: { id: "test-panel", version: 1 } }
]);

let root: Root | null = null;

function canvasWithVideoNode() {
  return canvasFixture({ nodes: [{ id: NODE_ID, type: "video", data: { prompt: "镜头缓推" } }] });
}

function canvasWithoutVideoNode() {
  return canvasFixture({
    nodes: [
      { id: "other-node", type: "image", data: { prompt: "另一张图" } }
    ]
  });
}

function registryWithPanel(): ModelInteractionService {
  const registry = new ModelInteractionService();
  registry.register({
    id: "test-panel",
    version: 1,
    owner: "test",
    Panel: () => <div data-testid="video-panel">视频面板</div>
  });
  return registry;
}

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<>{node}</>);
  });
  return container;
}

beforeEach(() => {
  nodeDraftStore.clearAll();
  woohaa3CanvasStore.getState().hydrate(canvasWithVideoNode());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  nodeDraftStore.clearAll();
  document.body.innerHTML = "";
});

describe("ModelExecutionHost 提示词归属", () => {
  it("uses the page coordinator and surfaces its rejection without remounting or losing drafts", async () => {
    let panel: ModelPanelProps | undefined;
    const submit = vi.fn(async () => ({ ok: false as const, error: "shot-image-version-stale" }));
    const run = vi.fn();
    const registry = new ModelInteractionService();
    registry.register({ id: "test-panel", version: 1, owner: "test", Panel: props => { panel = props; return <output>{props.draft.prompt}</output>; } });
    const container = await mount(<ModelExecutionHost canvasId="canvas-1" selectedNodeId={NODE_ID} session={{} as never}
      runClient={{ run, cancel: vi.fn() } as never} writable dialogs={new DialogService()} catalog={new StubCatalogService(CATALOG)}
      registry={registry} draftStore={createModelDraftStore()} submitCoordinator={{ submit, cancel: vi.fn() }} />);
    await act(async () => { panel!.patchDraft({ prompt: "preserved draft" }); });
    await act(async () => { await panel!.submit({ prompt: "preserved draft", parameters: {} }); });
    expect(submit).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
    expect(container.textContent).toContain("shot-image-version-stale");
    expect(panel!.draft.prompt).toBe("preserved draft");
  });
});

describe("ModelExecutionHost 选中节点被删除", () => {
  it("节点删除后收起面板且不抛 fewer-hooks 错误", async () => {
    const container = await mount(
      <ModelExecutionHost
        canvasId="canvas-1"
        selectedNodeId={NODE_ID}
        session={{} as never}
        runClient={{} as never}
        writable
        dialogs={new DialogService()}
        catalog={new StubCatalogService(CATALOG)}
        registry={registryWithPanel()}
        draftStore={createModelDraftStore()}
      />
    );
    expect(container.querySelector(".node-execution-dock")).not.toBeNull();
    expect(container.querySelector('[data-testid="video-panel"]')).not.toBeNull();

    // 删除节点：规范画布中不再存在该节点（等价于用户删除视频节点）。
    await act(async () => {
      woohaa3CanvasStore.getState().hydrate(canvasWithoutVideoNode());
    });

    // 修复前这里抛 "Rendered fewer hooks than expected"，整页白屏。
    expect(container.querySelector(".node-execution-dock")).toBeNull();
    expect(document.body.textContent).not.toContain("Rendered fewer hooks");
  });

  it("删除后重新 hydrate 回原节点可恢复渲染（无残留状态）", async () => {
    const container = await mount(
      <ModelExecutionHost
        canvasId="canvas-1"
        selectedNodeId={NODE_ID}
        session={{} as never}
        runClient={{} as never}
        writable
        dialogs={new DialogService()}
        catalog={new StubCatalogService(CATALOG)}
        registry={registryWithPanel()}
        draftStore={createModelDraftStore()}
      />
    );
    await act(async () => {
      woohaa3CanvasStore.getState().hydrate(canvasWithoutVideoNode());
    });
    expect(container.querySelector('[data-testid="video-panel"]')).toBeNull();

    await act(async () => {
      woohaa3CanvasStore.getState().hydrate(canvasWithVideoNode());
    });
    expect(container.querySelector('[data-testid="video-panel"]')).not.toBeNull();
  });
});

/**
 * 视频参数 schema 门禁（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * N05 / N09 的失败输入（缺 aspectRatio、缺 resolution、时长越界）都必须在这里被拦下，
 * 且默认值要真的进入 submit 快照，而不是只显示在控件上。
 */
function videoCatalog(options: {
  required?: string[];
  defaults?: Record<string, unknown>;
} = {}) {
  return catalogFixture([
    {
      modelKey: "video-model",
      modelType: "video",
      interaction: { id: "test-panel", version: 1 },
      inputSchema: {
        type: "object",
        required: options.required ?? ["prompt", "aspectRatio", "resolution", "durationSeconds"],
        properties: {
          prompt: { type: "string", title: "提示词" },
          aspectRatio: { type: "string", title: "比例", enum: ["16:9", "9:16", "1:1"] },
          resolution: { type: "string", title: "分辨率", enum: ["720p", "1080p", "2k"] },
          durationSeconds: { type: "number", title: "时长", minimum: 5, maximum: 12, unit: "秒" }
        }
      },
      defaultInput: options.defaults ?? {}
    }
  ]);
}

async function mountVideoHost(catalog: CanvasTaskCatalog, submit: ReturnType<typeof vi.fn>) {
  let panel: ModelPanelProps | undefined;
  const registry = new ModelInteractionService();
  registry.register({
    id: "test-panel",
    version: 1,
    owner: "test",
    Panel: (props) => {
      panel = props;
      return <output>{props.blockingReasons?.join("；")}</output>;
    }
  });
  await mount(
    <ModelExecutionHost
      canvasId="canvas-1"
      selectedNodeId={NODE_ID}
      session={{} as never}
      runClient={{} as never}
      writable
      dialogs={new DialogService()}
      catalog={new StubCatalogService(catalog)}
      registry={registry}
      draftStore={createModelDraftStore()}
      submitCoordinator={{ submit, cancel: vi.fn() }}
    />
  );
  if (!panel) throw new Error("未渲染视频面板");
  return panel;
}

describe("ModelExecutionHost 视频参数门禁", () => {
  it("缺 aspectRatio 时拒绝提交且不调用协调器", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, runId: "r", jobId: "j" }));
    const panel = await mountVideoHost(videoCatalog(), submit);
    let outcome: Awaited<ReturnType<ModelPanelProps["submit"]>> | undefined;
    await act(async () => {
      outcome = await panel.submit({
        prompt: "一段动画",
        parameters: { resolution: "720p", durationSeconds: 5 }
      });
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome !== undefined && !outcome.ok ? outcome.error : "").toContain(
      "缺少必填参数「比例」（aspectRatio）"
    );
    expect(panel.blockingReasons?.join("；")).toContain("缺少必填参数「比例」");
    expect(submit).not.toHaveBeenCalled();
  });

  it("缺 resolution 时拒绝提交", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, runId: "r", jobId: "j" }));
    const panel = await mountVideoHost(videoCatalog(), submit);
    await act(async () => {
      await panel.submit({
        prompt: "一段动画",
        parameters: { aspectRatio: "16:9", durationSeconds: 5 }
      });
    });
    expect(panel.blockingReasons?.join("；")).toContain("缺少必填参数「分辨率」（resolution）");
    expect(submit).not.toHaveBeenCalled();
  });

  it("时长越界时拒绝提交并显示范围", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, runId: "r", jobId: "j" }));
    const panel = await mountVideoHost(videoCatalog(), submit);
    let outcome: Awaited<ReturnType<ModelPanelProps["submit"]>> | undefined;
    await act(async () => {
      outcome = await panel.submit({
        prompt: "一段动画",
        parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 13 }
      });
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome !== undefined && !outcome.ok ? outcome.error : "").toContain("时长不能大于 12秒");
    expect(submit).not.toHaveBeenCalled();
  });

  it("提交快照包含模型默认值", async () => {
    const submit = vi.fn(async (_input: { parameters: Record<string, unknown> }) => ({
      ok: true as const,
      runId: "r",
      jobId: "j"
    }));
    const panel = await mountVideoHost(
      videoCatalog({ defaults: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 } }),
      submit
    );
    await act(async () => {
      await panel.submit({ prompt: "一段动画", parameters: {} });
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 }
    });
  });
});

describe("ModelExecutionHost 未提交视频节点", () => {
  it("从未提交的视频节点向 Panel 标记 unsubmitted", async () => {
    const panel = await mountVideoHost(
      videoCatalog({ defaults: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 } }),
      vi.fn(async () => ({ ok: true as const, runId: "r", jobId: "j" }))
    );
    expect(panel.unsubmitted).toBe(true);
  });
});
