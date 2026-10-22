/**
 * 任务详情侧栏渲染测试（change: l0-generation-provenance + 详情面板信息层级重构）。
 *
 * 覆盖：请求摘要/技术信息默认展开（仍可折叠）、摘要与耗时降噪（缺失项整格不渲染）、
 * 「返回画布」主按钮的出现条件、上游任务号与产物存储键、结果缩略图放大、错误 status/code。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DetailPanel } from "./detail-panel.js";
import type { MonitorItem } from "./monitor-model.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-20T10:00:00.000Z";
const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function item(overrides: Partial<MonitorItem> = {}): MonitorItem {
  return {
    taskKey: "task-1",
    state: "failed",
    providerId: "ark",
    providerName: "Ark",
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: NOW,
    durationMs: 1200,
    recordRevision: 1,
    events: [],
    ...overrides
  };
}

function renderPanel(
  detail: MonitorItem,
  options: {
    onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void;
    onClose?: () => void;
    resolveMediaUrl?: (storageKey: string) => string;
  } = {}
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(
      <DetailPanel
        detail={detail}
        error={null}
        loading={false}
        nowMs={Date.parse(NOW)}
        resolveMediaUrl={options.resolveMediaUrl}
        onClose={options.onClose ?? (() => undefined)}
        onOpenCanvas={options.onOpenCanvas}
        onNavigate={() => undefined}
      />
    );
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("DetailPanel 信息层级", () => {
  it("请求摘要与技术信息默认展开，提示词与参考输入直接可见", () => {
    const container = renderPanel(
      item({
        request: {
          prompt: "画一只猫",
          parameters: { size: "1024x1024" },
          inputs: [
            { role: "reference_image", mediaKind: "image", mediaType: "image/png", assetId: "asset-1" },
            { role: "mask", mediaKind: "image", mediaType: "image/png", storageKey: `sha256-${"a".repeat(64)}` }
          ]
        },
        upstreamTaskId: "upstream-task-42"
      })
    );

    expect(buttonByText(container, "请求摘要")!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".task-monitor__request")).not.toBeNull();
    expect(container.querySelector(".task-monitor__prompt")!.textContent).toContain("画一只猫");
    expect(container.textContent).toContain("1024x1024");
    expect(buttonByText(container, "技术信息")!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("上游任务号");
  });

  it("默认展开的 section 仍可收起再展开", () => {
    const container = renderPanel(item({ request: { prompt: "画一只猫", parameters: {} }, upstreamTaskId: "up-1" }));

    const requestTrigger = buttonByText(container, "请求摘要")!;
    act(() => requestTrigger.click());
    expect(requestTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("画一只猫");

    act(() => requestTrigger.click());
    expect(requestTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("画一只猫");

    const technicalTrigger = buttonByText(container, "技术信息")!;
    act(() => technicalTrigger.click());
    expect(technicalTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("上游任务号");
  });

  it("「返回画布」在主按钮位置出现，携带 nodeId；无 canvasId 时不渲染", () => {
    const opened: Array<{ canvasId: string; nodeId?: string }> = [];
    const withCanvas = renderPanel(item({ canvasId: "canvas-1", nodeId: "node-9" }), {
      onOpenCanvas: (input) => opened.push(input)
    });
    const back = buttonByText(withCanvas, "返回画布")!;
    expect(back).toBeTruthy();
    expect(back.className).toContain("ui-button--primary");
    act(() => back.click());
    expect(opened).toEqual([{ canvasId: "canvas-1", nodeId: "node-9" }]);
    expect(withCanvas.textContent).not.toContain("定位画布");

    const withoutCanvas = renderPanel(item(), { onOpenCanvas: () => undefined });
    expect(buttonByText(withoutCanvas, "返回画布")).toBeUndefined();
  });

  it("技术信息展示上游任务号（可复制），缺失时不渲染该行", () => {
    const withUpstream = renderPanel(item({ upstreamTaskId: "upstream-task-42" }));
    expect(withUpstream.textContent).toContain("上游任务号");
    expect(withUpstream.textContent).toContain("upstream-task-42");
    expect(withUpstream.querySelector("[aria-label='复制上游任务号']")).not.toBeNull();

    const withoutUpstream = renderPanel(item());
    expect(withoutUpstream.textContent).not.toContain("上游任务号");
  });

  it("技术信息展示产物存储键与大小/校验和摘要", () => {
    const container = renderPanel(
      item({
        result: {
          mediaKind: "image",
          storageKey: "media/out-42.png",
          size: 2048,
          checksum: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      })
    );
    expect(container.textContent).toContain("产物存储键");
    expect(container.textContent).toContain("media/out-42.png");
    expect(container.textContent).toContain("大小 2.0KB");
    expect(container.textContent).toContain("校验和 0123456789ab…89abcdef");
    expect(container.querySelector("[aria-label='复制产物存储键']")).not.toBeNull();
  });

  it("顶部摘要降噪：actor/尝试缺失不渲染，单元格不超过 3 列 × 3 行", () => {
    const container = renderPanel(
      item({ timing: { observedAt: NOW } })
    );
    const summary = container.querySelector(".task-monitor__summary:not(.task-monitor__summary--timing)")!;
    expect(summary.textContent).toContain("状态");
    expect(summary.textContent).not.toContain("使用人");
    expect(summary.textContent).not.toContain("尝试");
    expect(summary.children.length).toBeLessThanOrEqual(9);
  });

  it("耗时与时间只渲染后端给出的事实；状态驻留缺失不占位", () => {
    const container = renderPanel(
      item({
        state: "succeeded",
        timing: { observedAt: NOW, admittedAt: NOW, firstStartedAt: NOW, totalMs: 1200, queueMs: 200, executionMs: 1000 }
      })
    );
    const timing = container.querySelector(".task-monitor__summary--timing")!;
    expect(timing.textContent).toContain("总耗时");
    expect(timing.textContent).toContain("1.2s");
    expect(timing.textContent).toContain("200ms");
    expect(timing.textContent).toContain("1.0s");
    expect(timing.textContent).not.toContain("状态驻留");
    expect(timing.textContent).not.toContain("未知");
  });

  it("结果图默认是缩略图，点击在面板内放大/收起", () => {
    const container = renderPanel(
      item({
        state: "succeeded",
        result: { mediaKind: "image", storageKey: "media/out.png", durationSeconds: 4 }
      }),
      { resolveMediaUrl: (key) => `/media/${key}` }
    );
    const result = container.querySelector(".task-monitor__result")!;
    expect(result.getAttribute("data-zoomed")).toBeNull();
    expect(container.querySelector(".task-monitor__thumb")!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/media/media/out.png");
    expect(container.textContent).toContain("放大预览");
    expect(container.textContent).toContain("时长 4s");

    act(() => (container.querySelector(".task-monitor__thumb") as HTMLButtonElement).click());
    expect(container.querySelector(".task-monitor__result")!.getAttribute("data-zoomed")).toBe("true");
    expect(container.querySelector(".task-monitor__thumb")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("缩小预览");

    act(() => (container.querySelector(".task-monitor__thumb") as HTMLButtonElement).click());
    expect(container.querySelector(".task-monitor__result")!.getAttribute("data-zoomed")).toBeNull();
  });

  it("Esc 关闭详情（保留既有键盘行为）", () => {
    let closed = 0;
    const container = renderPanel(item(), { onClose: () => { closed += 1; } });
    const aside = container.querySelector("[data-testid='task-monitor-detail']")!;
    act(() => {
      aside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closed).toBe(1);
  });

  it("错误区以 message 为主，并展示 status / code", () => {
    const container = renderPanel(
      item({
        error: {
          name: "ProviderError",
          message: "上游拒绝请求",
          status: 400,
          code: "InvalidParameter"
        }
      })
    );
    const block = container.querySelector(".task-monitor__error-block")!;
    expect(block.textContent).toContain("上游拒绝请求");
    expect(block.textContent).toContain("上游状态 400");
    expect(block.textContent).toContain("错误码 InvalidParameter");
  });

  it("错误缺 status / code 时只显示 message", () => {
    const container = renderPanel(item({ error: { name: "Error", message: "仅消息" } }));
    const block = container.querySelector(".task-monitor__error-block")!;
    expect(block.textContent).toContain("仅消息");
    expect(block.textContent).not.toContain("上游状态");
    expect(block.textContent).not.toContain("错误码");
  });

  it("参考输入渲染为卡片（角色 / 媒体 / 稳定引用在 title）", () => {
    const container = renderPanel(
      item({
        request: {
          prompt: "画一只猫",
          parameters: {},
          inputs: [
            { role: "reference_image", mediaKind: "image", mediaType: "image/png", assetId: "asset-1" },
            { role: "mask", mediaKind: "image", mediaType: "image/png", storageKey: `sha256-${"a".repeat(64)}` }
          ]
        }
      })
    );
    const rows = [...container.querySelectorAll(".task-trace__ref")];
    expect(rows).toHaveLength(2);
    // 已知角色给中文标签，媒体类型仍然可读。
    expect(rows[0]!.textContent).toContain("参考图");
    expect(rows[0]!.textContent).toContain("image · image/png");
    // 稳定引用挂在 title（卡片正文留给缩略图与角色），长 storageKey 折叠为头尾摘要。
    expect(rows[0]!.getAttribute("title")).toBe("asset-1");
    expect(rows[1]!.getAttribute("title")).toContain("sha256-aaa…");
    expect(rows[1]!.getAttribute("title")).not.toContain("a".repeat(64));
  });

  it("参考输入缺失时不渲染该区块", () => {
    const container = renderPanel(item({ request: { prompt: "p", parameters: {} } }));
    expect(container.querySelector(".task-trace__refs")).toBeNull();
  });
});
