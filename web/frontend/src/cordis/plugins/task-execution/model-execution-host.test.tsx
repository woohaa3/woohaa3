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
  it("keeps custom panels ready during active tasks and accepts three clicks before any request resolves", async () => {
    const saved=canvasWithVideoNode(); saved.nodeData[NODE_ID]!.taskStatus="processing";
    woohaa3CanvasStore.getState().hydrate(saved);
    const pending: Array<()=>void>=[];
    const run=vi.fn((input:{runId:string;jobId:string}) => new Promise(resolve=>pending.push(()=>resolve({ok:true,...input}))));
    const started=vi.fn(), registry=new ModelInteractionService();
    registry.register({id:"test-panel",version:1,owner:"test",Panel:props=><button disabled={props.status==="pending"||props.status==="processing"}
      onClick={()=>void props.submit({prompt:"independent",parameters:{}})}>提交</button>});
    const container=await mount(<ModelExecutionHost canvasId="canvas-1" selectedNodeId={NODE_ID} session={{} as never}
      runClient={{run,cancel:vi.fn()} as never} writable dialogs={new DialogService()} catalog={new StubCatalogService(CATALOG)}
      registry={registry} draftStore={createModelDraftStore()} activity={{started,localRejected:vi.fn()}}/>);
    await act(async()=>{const button=container.querySelector("button")!;button.click();button.click();button.click();});
    expect(run).toHaveBeenCalledTimes(3);expect(started).toHaveBeenCalledTimes(3);
    expect(new Set(run.mock.calls.map(([request])=>request.runId)).size).toBe(3);
    expect(container.querySelector("button")!.disabled).toBe(false);
    await act(async()=>{pending.forEach(release=>release());});
  });
  it("自定义面板的按钮和键盘提交各发一次，使用同一宿主实际起点且不在重挂载时重放", async () => {
    const launch = vi.fn(), run = vi.fn(async (input: {runId:string;jobId:string}) => ({ok:true as const,runId:input.runId,jobId:input.jobId}));
    const registry = new ModelInteractionService();
    registry.register({id:"test-panel",version:1,owner:"test",Panel:props=><button type="button" onClick={()=>void props.submit({prompt:"p",parameters:{}})} onKeyDown={event=>{if(event.key==="Enter")void props.submit({prompt:"p",parameters:{}});}}>提交</button>});
    const props={canvasId:"canvas-1",selectedNodeId:NODE_ID,session:{} as never,runClient:{run,cancel:vi.fn()} as never,writable:true,
      dialogs:new DialogService(),catalog:new StubCatalogService(CATALOG),registry,draftStore:createModelDraftStore(),activity:{launch,started:vi.fn(),localRejected:vi.fn()}};
    const container=await mount(<ModelExecutionHost {...props}/>);
    const surface=container.querySelector<HTMLElement>(".node-execution-dock__expanded-body")!;
    surface.getBoundingClientRect=()=>({left:100,top:200,width:300,height:120}) as DOMRect;
    const button=container.querySelector("button")!;
    await act(async()=>{button.click();});
    expect(run).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({phase:"started",nodeId:NODE_ID,origin:{x:250,y:200}});
    await act(async()=>{button.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));});
    expect(run).toHaveBeenCalledTimes(2);
    const started=launch.mock.calls.map(([event])=>event).filter(event=>event.phase==="started");
    expect(started).toHaveLength(2);
    expect(started[0].origin.token).not.toBe(started[1].origin.token);
    await act(async()=>{root!.render(null);});
    await act(async()=>{root!.render(<ModelExecutionHost {...props}/>);});
    expect(run).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(4);
  });
  async function mountPromptHost() {
    woohaa3CanvasStore.getState().hydrate(canvasFixture({ nodes: [
      { id: "empty-node", type: "video" },
      { id: NODE_ID, type: "video", data: { prompt: "镜头缓推" } }
    ] }));
    const models = catalogFixture([
      { modelKey: "model-a", modelType: "video", interaction: { id: "prompt-test", version: 1 } },
      { modelKey: "model-b", modelType: "video", interaction: { id: "prompt-test", version: 1 } }
    ]);
    const registry = new ModelInteractionService();
    let panel: ModelPanelProps;
    registry.register({
      id: "prompt-test", version: 1, owner: "test",
      Panel: (props) => { panel = props; return <output>{props.draft.prompt}</output>; }
    });
    const props = {
      canvasId: "canvas-1", session: {} as never, runClient: {} as never, writable: true,
      dialogs: new DialogService(), catalog: new StubCatalogService(models), registry,
      draftStore: createModelDraftStore()
    };
    const container = await mount(<ModelExecutionHost {...props} selectedNodeId="empty-node" />);
    return {
      container,
      panel: () => panel!,
      select: async (selectedNodeId: string) => {
        await act(async () => { root!.render(<ModelExecutionHost {...props} selectedNodeId={selectedNodeId} />); });
      },
      patch: async (patch: Parameters<ModelPanelProps["patchDraft"]>[0]) => {
        await act(async () => { panel!.patchDraft(patch); });
      }
    };
  }

  it("空节点 → 有提示词节点 → 空节点不串词，也不写入其它节点草稿", async () => {
    const host = await mountPromptHost();
    expect(host.panel().draft.prompt).toBe("");
    await host.select(NODE_ID);
    expect(host.panel().draft.prompt).toBe("镜头缓推");
    await host.patch({ prompt: "未提交的镜头描述" });
    await host.select("empty-node");
    expect(host.container.querySelector("output")?.textContent).toBe("");
    expect(nodeDraftStore.get("empty-node", "model-a")).toBeUndefined();
    await host.select(NODE_ID);
    expect(host.panel().draft.prompt).toBe("未提交的镜头描述");
  });

  it("切换模型始终沿用当前提示词并尊重显式清空", async () => {
    const host = await mountPromptHost();
    await host.select(NODE_ID);
    await host.patch({ parameters: { model: "model-b", duration: 5 } });
    expect(host.panel().draft.prompt).toBe("镜头缓推");
    await host.patch({ prompt: "修改后的提示词" });
    await host.patch({ parameters: { model: "model-a" } });
    expect(host.panel().draft.prompt).toBe("修改后的提示词");
    await host.patch({ prompt: "" });
    await host.patch({ parameters: { model: "model-b" } });
    expect(host.panel().draft.prompt).toBe("");
    await host.select("empty-node");
    expect(host.panel().draft.prompt).toBe("");
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
