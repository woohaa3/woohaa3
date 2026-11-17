/**
 * 已下线模型的面板：保持常规外观，只阻止生成（用户反馈 2026-11-16）。
 *
 * 回归的缺陷：目录里没有该节点的模型时，Host 原本把整个面板换成一张诊断卡片，
 * 提示词、参考素材、来源与模型、主操作全都不见，看起来像"面板变了"而不是"这个模型暂时不能生成"。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OfflineModelPanel } from "./offline-model-panel.js";
import { catalogFixture } from "./test-support/fixtures.js";

const CATALOG = catalogFixture([
  { modelKey: "video-model", modelType: "video", interaction: { id: "test-panel", version: 1 } }
]);
const REASONS = ["所选模型 removed-model 已从任务目录下线，请重新选择模型"];

let root: Root | null = null;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<>{element}</>); });
  return container;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

describe("OfflineModelPanel", () => {
  it("保留提示词、参考区、来源与模型和主操作，只把生成禁用", async () => {
    const onDraftChange = vi.fn();
    const container = await mount(
      <OfflineModelPanel
        panelKind="video-generation"
        modelKey="removed-model"
        catalogModels={CATALOG.models}
        presentation="compact"
        status="idle"
        prompt="镜头缓推"
        parameters={{}}
        blockingReasons={REASONS}
        readOnly={false}
        renderers={{ modelSelector: () => <output data-testid="model-selector">removed-model</output> }}
        references={<output data-testid="references">图片 1</output>}
        onDraftChange={onDraftChange}
        requestPresentation={() => {}}
      />
    );
    // 常规执行面板仍在：不是诊断卡片。
    expect(container.querySelector('.mc-panel')).not.toBeNull();
    expect(container.querySelector("[data-diagnostic]")).toBeNull();
    expect(container.querySelector('[data-testid="model-selector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="references"]')).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".mc-panel__textarea")?.value).toBe("镜头缓推");
    // 只有一处阻止说明，且主操作真正禁用。
    expect(container.textContent).toContain("已从任务目录下线");
    expect(container.querySelector<HTMLButtonElement>(".mc-panel__send")?.disabled).toBe(true);
  });

  it("面板里改提示词仍写回草稿，不提交任务", async () => {
    const onDraftChange = vi.fn();
    const container = await mount(
      <OfflineModelPanel
        panelKind="video-generation"
        modelKey="removed-model"
        catalogModels={CATALOG.models}
        presentation="compact"
        status="idle"
        prompt=""
        parameters={{}}
        blockingReasons={REASONS}
        readOnly={false}
        renderers={{}}
        onDraftChange={onDraftChange}
        requestPresentation={() => {}}
      />
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(".mc-panel__textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, "新的描述");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onDraftChange).toHaveBeenCalledWith({ prompt: "新的描述" });
  });
});
