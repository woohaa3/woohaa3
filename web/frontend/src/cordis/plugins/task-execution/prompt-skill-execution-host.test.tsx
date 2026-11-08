/**
 * 提示词改写 Host 接线的回归测试（change: add-prompt-skill-extension）。
 *
 * 锁定的契约：扩展经 `execution.prompt-skill` 只产出文本，Host 负责
 * - 取首个可用贡献；
 * - 把当前语言模型 / 画布 / 节点身份交给扩展；
 * - 成功后写回草稿（失败时不改草稿，并把原因抛给面板显示）。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptSkillExecutionHost } from "./prompt-skill-execution-host.js";
import { ModelInteractionService } from "../../services/model-interaction-service.js";
import { DialogService } from "../../services/dialogs/service.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { createModelDraftStore } from "./model-draft.js";
import { nodeDraftStore } from "./drafts.js";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import type { SlotsService, SlotName, SlotContribution } from "../../contracts.js";
import type { CatalogState, TaskCatalogService } from "../../contracts.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { catalogFixture, canvasFixture } from "./test-support/fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NODE_ID = "video-node";

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

/** 最小 Slots 替身：只实现本适配层使用的 list / subscribe / version。 */
class FakeSlots implements SlotsService {
  private value = 0;
  private listeners = new Set<() => void>();
  private contributions = new Map<string, unknown[]>();
  register<S extends SlotName>(slot: S, contribution: SlotContribution<S>): () => void {
    const list = this.contributions.get(slot) ?? [];
    list.push(contribution);
    this.contributions.set(slot, list);
    this.value += 1;
    this.listeners.forEach((listener) => listener());
    return () => {
      this.contributions.set(slot, (this.contributions.get(slot) ?? []).filter((entry) => entry !== contribution));
      this.value += 1;
    };
  }
  list<S extends SlotName>(slot: S): ReadonlyArray<SlotContribution<S>> {
    return (this.contributions.get(slot) ?? []) as ReadonlyArray<SlotContribution<S>>;
  }
  subscribe(_slot: SlotName, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  version(): number {
    return this.value;
  }
}

const CATALOG = catalogFixture([
  { modelKey: "video-model", modelType: "video", interaction: { id: "test-panel", version: 1 } },
  { modelKey: "lang-model", modelType: "language", title: "润色模型" }
], { video: "video-model", language: "lang-model" });

let root: Root | null = null;

function canvasWithVideoNode() {
  return canvasFixture({ nodes: [{ id: NODE_ID, type: "video", data: { prompt: "雨夜街道" } }] });
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

function harness(slots: FakeSlots) {
  let panel: ModelPanelProps | undefined;
  const registry = new ModelInteractionService();
  registry.register({
    id: "test-panel",
    version: 1,
    owner: "test",
    Panel: (props) => {
      panel = props;
      return <output>{props.draft.prompt}</output>;
    }
  });
  return {
    panel: () => panel!,
    node: (
      <PromptSkillExecutionHost
        slots={slots}
        canvasId="canvas-1"
        selectedNodeId={NODE_ID}
        session={{} as never}
        runClient={{ run: vi.fn(), cancel: vi.fn() } as never}
        writable
        dialogs={new DialogService()}
        catalog={new StubCatalogService(CATALOG)}
        registry={registry}
        draftStore={createModelDraftStore()}
      />
    )
  };
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

describe("PromptSkillExecutionHost", () => {
  it("把首个可用贡献接到面板，并把语言模型与节点身份交给扩展后写回草稿", async () => {
    const slots = new FakeSlots();
    const rewrite = vi.fn(async () => ({ prompt: "雨夜霓虹街道，湿漉漉的柏油路。" }));
    slots.register("execution.prompt-skill", {
      id: "prompt-skills-rewrite",
      owner: "prompt-skills",
      rewrite
    });
    const view = harness(slots);
    const container = await mount(view.node);
    const skill = view.panel().renderers?.promptSkill;
    expect(skill).toBeTypeOf("function");
    await act(async () => {
      await skill!({ id: "polish", label: "画面细节润色", prompt: "雨夜街道" });
    });
    expect(rewrite).toHaveBeenCalledWith({
      skill: { id: "polish", label: "画面细节润色" },
      prompt: "雨夜街道",
      canvasId: "canvas-1",
      nodeId: NODE_ID,
      taskKind: "video"
    });
    expect(container.querySelector("output")!.textContent).toBe("雨夜霓虹街道，湿漉漉的柏油路。");
  });

  it("扩展返回错误时不改草稿，并把原因抛给面板", async () => {
    const slots = new FakeSlots();
    slots.register("execution.prompt-skill", {
      id: "prompt-skills-rewrite",
      owner: "prompt-skills",
      rewrite: async () => ({ error: "模型没有返回改写后的文本" })
    });
    const view = harness(slots);
    const container = await mount(view.node);
    await act(async () => {
      await expect(
        view.panel().renderers!.promptSkill!({ id: "polish", label: "画面细节润色", prompt: "雨夜街道" })
      ).rejects.toThrow("模型没有返回改写后的文本");
    });
    expect(container.querySelector("output")!.textContent).toBe("雨夜街道");
  });

  it("没有可用贡献时不注入改写回调", async () => {
    const slots = new FakeSlots();
    slots.register("execution.prompt-skill", {
      id: "disabled",
      owner: "prompt-skills",
      available: () => false,
      rewrite: async () => ({ prompt: "不应被调用" })
    });
    const view = harness(slots);
    await mount(view.node);
    expect(view.panel().renderers?.promptSkill).toBeUndefined();
  });
});
