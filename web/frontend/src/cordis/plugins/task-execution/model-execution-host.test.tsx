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
import { catalogFixture, canvasFixture, imageAsset } from "./test-support/fixtures.js";
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
describe("ModelExecutionHost 图片/视频切换（已有结果的节点新建关联节点）", () => {
  const IMAGE_NODE = "image-node";

  async function mountSwitchHost(submitCommands: ReturnType<typeof vi.fn>, selectNode: ReturnType<typeof vi.fn>) {
    woohaa3CanvasStore.getState().hydrate(canvasFixture({
      nodes: [{ id: IMAGE_NODE, type: "image", data: { outputAssetId: "asset-1", taskStatus: "successed" } }],
      assets: [imageAsset({ id: "asset-1" })]
    }));
    const models = catalogFixture([
      { modelKey: "image-model", modelType: "image", interaction: { id: "switch-panel", version: 1 } },
      { modelKey: "video-model", modelType: "video", interaction: { id: "switch-panel", version: 1 } }
    ]);
    const registry = new ModelInteractionService();
    registry.register({ id: "switch-panel", version: 1, owner: "test", Panel: (props) => <div>{props.renderers?.typeSwitch?.()}</div> });
    return mount(
      <ModelExecutionHost
        canvasId="canvas-test"
        selectedNodeId={IMAGE_NODE}
        session={{ isWritable: () => true, submitCommands } as never}
        runtime={{ controller: () => ({ selectNode }), subscribeViewport: () => () => undefined, subscribeScene: () => () => undefined } as never}
        runClient={{} as never}
        writable
        dialogs={new DialogService()}
        catalog={new StubCatalogService(models)}
        registry={registry}
        draftStore={createModelDraftStore()}
      />
    );
  }

  const clickVideo = async (container: HTMLElement) => {
    const video = [...container.querySelectorAll<HTMLElement>(".node-type-switch__option")].find((button) => button.textContent === "视频")!;
    await act(async () => { video.click(); });
  };

  it("等服务端确认之后才选中新节点（提前选中会让面板读到规范画布里还没有的节点而闪报错）", async () => {
    let confirm: (value: { state: string; error: string | null }) => void = () => undefined;
    const settled = new Promise<{ state: string; error: string | null }>((resolve) => { confirm = resolve; });
    const submitCommands = vi.fn(() => ({ ok: true as const, handle: { settled } }));
    const selectNode = vi.fn(() => true);
    const container = await mountSwitchHost(submitCommands, selectNode);

    await clickVideo(container);
    expect(submitCommands).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(submitCommands.mock.calls[0]);
    expect(sent).toContain("node.add");
    expect(sent).toContain(IMAGE_NODE);
    expect(selectNode).not.toHaveBeenCalled();

    await act(async () => { confirm({ state: "committed", error: null }); await settled; });
    expect(selectNode).toHaveBeenCalledTimes(1);
  });

  it("服务端拒绝时不选中，并把原因显示出来", async () => {
    const settled = Promise.resolve({ state: "rejected", error: "输入连接已变化" });
    const submitCommands = vi.fn(() => ({ ok: true as const, handle: { settled } }));
    const selectNode = vi.fn(() => true);
    const container = await mountSwitchHost(submitCommands, selectNode);

    await clickVideo(container);
    await act(async () => { await settled; });
    expect(selectNode).not.toHaveBeenCalled();
    expect(container.textContent).toContain("输入连接已变化");
  });
});

/**
 * 目录里没有该节点类型的模型时的空态面板。
 *
 * 锁定的缺陷（截图反馈）：空态沿用 760 宽度上限，在画布上留下一条几乎空白的深色横条；
 * 原因又落进两列栅格的右侧控件列，文字从卡片中线才开始，看起来像一条错位的提示条。
 */
describe("目录没有该类型模型时的空态面板", () => {
  it("原因占整列，并由窄空态卡片承载而不是铺满面板宽度", async () => {
    woohaa3CanvasStore.getState().hydrate(canvasFixture({ nodes: [{ id: "audio-node", type: "audio" }] }));
    const container = await mount(
      <ModelExecutionHost
        canvasId="canvas-1"
        selectedNodeId="audio-node"
        session={{} as never}
        runClient={{} as never}
        writable
        dialogs={new DialogService()}
        // 目录可用，但只有图片模型：音频节点没有任何可执行模型。
        catalog={new StubCatalogService(catalogFixture([{ modelKey: "image-model", modelType: "image" }]))}
        registry={registryWithPanel()}
        draftStore={createModelDraftStore()}
      />
    );
    const panel = container.querySelector(".mc-panel--catalog-fallback");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("该节点没有可用模型");
    expect(panel!.querySelector(".mc-panel__grid-control")!.closest(".mc-panel__grid-item--untitled")).not.toBeNull();
  });
});
