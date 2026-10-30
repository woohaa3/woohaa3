/**
 * 生成溯源正文（共享展示组件）渲染测试
 * （change: 生成溯源改为画布内浮窗）。
 *
 * 该组件同时服务独立任务监控页详情与画布内浮窗：这里断言「与页面一致的正文语义」
 * （默认展开、降噪、缩略图放大、返回画布入口）与浮窗特有的显式加载/失败状态。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskExecutionDetail } from "@woohaa3/contracts";
import { TaskTraceBody } from "./task-trace-body.js";

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

function detail(overrides: Partial<TaskExecutionDetail> = {}): TaskExecutionDetail {
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
  } as TaskExecutionDetail;
}

function renderBody(props: Partial<Parameters<typeof TaskTraceBody>[0]> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(
      <TaskTraceBody
        detail={props.detail ?? null}
        error={props.error ?? null}
        loading={props.loading ?? false}
        {...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {})}
        {...(props.resolveMediaUrl ? { resolveMediaUrl: props.resolveMediaUrl } : {})}
        {...(props.onOpenCanvas ? { onOpenCanvas: props.onOpenCanvas } : {})}
      />
    );
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("TaskTraceBody", () => {
  it("请求摘要与技术信息默认展开（与独立页面详情一致）", () => {
    const container = renderBody({
      detail: detail({
        request: { prompt: "画一只猫", parameters: { size: "1024x1024" }, inputs: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", assetId: "asset-1" }] },
        upstreamTaskId: "upstream-task-42"
      })
    });
    expect(buttonByText(container, "请求摘要")!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".task-monitor__prompt")!.textContent).toContain("画一只猫");
    expect(buttonByText(container, "技术信息")!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("上游任务号");
    expect(container.querySelector(".task-trace__ref")!.getAttribute("title")).toBe("asset-1");
  });

  it("产物显示所在后端与定位符；没有 locator 的后端退回实际键", () => {
    const located = renderBody({
      detail: detail({
        state: "succeeded",
        result: {
          mediaKind: "image",
          storageKey: "generation-outputs/a.png",
          size: 3,
          checksum: "abc",
          location: {
            backendId: "server",
            key: "media/generation-outputs/a.png",
            locator: "media://server/media/generation-outputs/a.png"
          }
        }
      })
    });
    // 一行定位符就够了：它同时表达「哪个后端 + 什么键」。
    expect(located.textContent).toContain("产物定位符");
    expect(located.textContent).toContain("media://server/media/generation-outputs/a.png");
    // 不再单独列后端 / 实际键 / 存储键，避免同一个事实说三遍。
    expect(located.textContent).not.toContain("实际键");
    expect(located.textContent).not.toContain("所在后端");

    // 旧宿主没有 location：退回存储键，面板不出现空白。
    const plain = renderBody({
      detail: detail({
        state: "succeeded",
        result: { mediaKind: "image", storageKey: "generation-outputs/a.png", size: 3, checksum: "abc" }
      })
    });
    expect(plain.textContent).toContain("产物定位符");
    expect(plain.textContent).toContain("generation-outputs/a.png");
  });

  it("技术信息把编号翻译成人话：同值的任务/运行合并，画布与节点带可读标题", () => {
    const container = renderBody({
      detail: detail({
        taskKey: "run-1",
        runId: "run-1",
        canvasId: "canvas-1",
        canvasTitle: "初始画布",
        nodeId: "asset-text-1",
        nodeTitle: "文生图"
      })
    });
    expect(container.textContent).toContain("任务 / 运行");
    expect(container.textContent).toContain("画布「初始画布」");
    expect(container.textContent).toContain("节点「文生图」");
    expect(container.textContent).toContain("日常不需要关注");
    // 同一个值不再显示两行（过去 taskKey/runId 相同时会重复）。
    expect((container.textContent?.match(/run-1/g) ?? []).length).toBe(1);
  });

  it("「复制全部」一次复制带标签的编号清单", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { writes.push(value); } }
    });
    const container = renderBody({
      detail: detail({
        upstreamTaskId: "upstream-42",
        canvasId: "canvas-1",
        nodeId: "node-1",
        result: { mediaKind: "image", storageKey: "generation-outputs/a.png" }
      })
    });
    const button = container.querySelector<HTMLButtonElement>("button[aria-label='复制全部技术信息']");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("上游任务号: upstream-42");
    expect(writes[0]).toContain("任务 / 运行: task-1");
    expect(writes[0]).toContain("画布 ID: canvas-1");
    expect(writes[0]).toContain("产物定位符: generation-outputs/a.png");
  });

  it("参考输入有媒体地址时出缩略图，没地址时退化为文本", () => {
    const withMedia = renderBody({
      detail: detail({
        request: {
          prompt: "p",
          parameters: {},
          inputs: [
            { role: "reference_image", mediaKind: "image", mediaType: "image/png", assetId: "asset-1", storageKey: "media/ref-1.png" },
            { role: "mask", mediaKind: "image", mediaType: "image/png", assetId: "asset-2" }
          ]
        }
      }),
      resolveMediaUrl: (key) => `/api/media/${key}`
    });
    const thumbs = [...withMedia.querySelectorAll(".task-trace__ref-thumb img")];
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.getAttribute("src")).toBe("/api/media/media/ref-1.png");
    // 没有 storageKey 的输入不编造图片，明确显示无预览。
    expect(withMedia.querySelectorAll(".task-trace__ref")[1]!.textContent).toContain("无预览");

    // 宿主没提供 media 解析能力时整体退化为文本，不出坏图。
    const noMedia = renderBody({
      detail: detail({
        request: {
          prompt: "p",
          parameters: {},
          inputs: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", storageKey: "media/ref-1.png" }]
        }
      })
    });
    expect(noMedia.querySelectorAll(".task-trace__ref-thumb img")).toHaveLength(0);
  });

  it("详情带 canvasId 时媒体地址带画布提示（参考输入与结果同一口径）", () => {
    const calls: Array<[string, string | undefined]> = [];
    const container = renderBody({
      detail: detail({
        canvasId: "canvas-1",
        state: "succeeded",
        request: {
          prompt: "p",
          parameters: {},
          inputs: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", assetId: "asset-1", storageKey: "media/ref-1.png" }]
        },
        result: { mediaKind: "image", storageKey: "media/out.png", durationSeconds: 4 }
      }),
      resolveMediaUrl: (key, canvasId) => {
        calls.push([key, canvasId]);
        return `/api/media/${key}?canvas=${canvasId}`;
      }
    });
    expect(container.querySelector(".task-trace__ref-thumb img")!.getAttribute("src")).toBe("/api/media/media/ref-1.png?canvas=canvas-1");
    expect(container.querySelector(".task-monitor__thumb img")!.getAttribute("src")).toBe("/api/media/media/out.png?canvas=canvas-1");
    expect(calls).toContainEqual(["media/ref-1.png", "canvas-1"]);
    expect(calls).toContainEqual(["media/out.png", "canvas-1"]);
  });

  it("结果图默认缩略图，点击在正文内放大/收起", () => {
    const container = renderBody({
      detail: detail({ state: "succeeded", result: { mediaKind: "image", storageKey: "media/out.png", durationSeconds: 4 } }),
      resolveMediaUrl: (key) => `/media/${key}`
    });
    expect(container.querySelector(".task-monitor__result")!.getAttribute("data-zoomed")).toBeNull();
    act(() => (container.querySelector(".task-monitor__thumb") as HTMLButtonElement).click());
    expect(container.querySelector(".task-monitor__result")!.getAttribute("data-zoomed")).toBe("true");
    expect(container.textContent).toContain("缩小预览");
  });

  it("显式加载/失败状态：不静默空白", () => {
    const loading = renderBody({ loading: true });
    expect(loading.querySelector("[role='status']")!.textContent).toContain("正在加载详情…");

    const failed = renderBody({ error: "读取失败", detail: null });
    expect(failed.querySelector("[role='alert']")!.textContent).toContain("读取失败");
  });

  it("「返回画布」只在传入 onOpenCanvas 且详情带 canvasId 时出现", () => {
    const opened: Array<{ canvasId: string; nodeId?: string }> = [];
    const withCanvas = renderBody({
      detail: detail({ canvasId: "canvas-1", nodeId: "node-9" }),
      onOpenCanvas: (input) => opened.push(input)
    });
    const back = buttonByText(withCanvas, "返回画布")!;
    expect(back).toBeTruthy();
    expect(back.className).toContain("ui-button--primary");
    act(() => back.click());
    expect(opened).toEqual([{ canvasId: "canvas-1", nodeId: "node-9" }]);

    // 画布内浮窗不传 onOpenCanvas：入口不出现（已经在画布上）。
    expect(buttonByText(renderBody({ detail: detail({ canvasId: "canvas-1" }) }), "返回画布")).toBeUndefined();
    expect(buttonByText(renderBody({ detail: detail(), onOpenCanvas: () => undefined }), "返回画布")).toBeUndefined();
  });
});
