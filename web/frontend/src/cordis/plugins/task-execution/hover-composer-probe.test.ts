/**
 * 「添加到对话框」胶囊排障探针：读数与三个判据
 * （`hover-composer-probe.ts` 的注释解释了为什么要分辨过期 / 矩形来源 / 原点分叉）。
 *
 * 这里只测**读数**这一半：探针的判据本身必须可信，否则排障时会先怀疑探针。
 * rAF 采样循环不在这里覆盖（jsdom 里没有 canvas，`nodeScreenRect` 已是桩）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasRuntimeService } from "../../contracts.js";

const hovered = { nodeId: null as string | null };

vi.mock("../../services/hover-store.js", () => ({
  hoverNodeStore: { getSnapshot: () => hovered }
}));

const { installHoverComposerProbe } = await import("./hover-composer-probe.js");

type Probe = {
  snapshot: () => Record<string, unknown> | null;
  health: () => { errors: number; lastError: string | null };
};

/**
 * 放一个胶囊。
 *
 * jsdom 不做布局，`getBoundingClientRect` 恒为 0 —— 只写内联样式探针读到的是全 0。
 * 这里把真实浏览器会给出的外框直接桩上，测的才是探针的比较逻辑本身。
 */
const plantPill = (nodeId: string, style: { left: number; top: number; width: number; height: number }) => {
  const element = document.createElement("div");
  element.className = "hover-composer";
  element.dataset.nodeId = nodeId;
  element.getBoundingClientRect = () => ({ ...style, right: style.left + style.width, bottom: style.top + style.height, x: style.left, y: style.top, toJSON: () => style } as DOMRect);
  document.body.appendChild(element);
  return element;
};

/** 给探针用的最小运行时：卡片矩形 400×300 在 (100, 50)，与既有组件测试同一组数字。 */
function runtime(overrides: Partial<CanvasRuntimeService> = {}): CanvasRuntimeService {
  return {
    nodeScreenRect: () => ({ left: 100, top: 50, width: 400, height: 300 }),
    nodePresentationScreenRect: () => null,
    controller: () => ({ viewport: () => ({ x: 0, y: 0, zoom: 1 }) }),
    ...overrides
  } as unknown as CanvasRuntimeService;
}

function mount(rt: CanvasRuntimeService): Probe {
  installHoverComposerProbe(rt);
  const probe = (globalThis as unknown as { __hoverComposerProbe?: Probe }).__hoverComposerProbe;
  expect(probe).toBeDefined();
  return probe!;
}

afterEach(() => {
  (globalThis as unknown as { __hoverComposerProbe?: Probe }).__hoverComposerProbe = undefined;
  document.body.innerHTML = "";
  hovered.nodeId = null;
});

describe("胶囊错位探针", () => {
  it("胶囊与重算矩形一致时 delta 全为 0（没有过期问题）", () => {
    // hoverComposerBox：卡片下方外侧 8px，左右与卡片对齐 → top = 50 + 300 + 8
    plantPill("img", { left: 100, top: 358, width: 400, height: 44 });
    const sample = mount(runtime()).snapshot() as {
      delta: { left: number; top: number; width: number; height: number };
      expected: { top: number };
    };
    expect(sample.expected.top).toBe(358);
    expect(sample.delta).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it("胶囊停在旧位置时 delta 指出偏移量（过期假设的判据）", () => {
    // 卡片已经移到 (260, 120)，胶囊还画在 100/358 —— 就是「没跟着重渲染」的样子。
    plantPill("img", { left: 100, top: 358, width: 400, height: 44 });
    const sample = mount(runtime({
      nodeScreenRect: () => ({ left: 260, top: 120, width: 400, height: 300 })
    })).snapshot() as { delta: { left: number; top: number } };
    // 期望位置 left = 260，胶囊还在 100 → 100 - 260；top = 120 + 300 + 8 = 428，胶囊还在 358。
    expect(sample.delta.left).toBe(-160);
    expect(sample.delta.top).toBe(-70);
  });

  it("呈现矩形与本体矩形不同时报 presentationDelta（矩形来源假设的判据）", () => {
    plantPill("img", { left: 100, top: 358, width: 400, height: 44 });
    const sample = mount(runtime({
      nodePresentationScreenRect: () => ({ left: 90, top: 40, width: 420, height: 320 })
    })).snapshot() as { presentationDelta: { left: number; top: number; width: number; height: number } };
    expect(sample.presentationDelta).toEqual({ left: -10, top: -10, width: 20, height: 20 });
  });

  it("canvas 与父容器原点不一致时报 originDelta（原点分叉假设的判据）", () => {
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.id = "bevy-canvas";
    host.appendChild(canvas);
    document.body.appendChild(host);
    // jsdom 没有布局：显式给出两个不同的外框来模拟「渲染端取父容器、worldToClient 取自身」。
    canvas.getBoundingClientRect = () => ({ left: 4, top: 0, width: 1000, height: 800 } as DOMRect);
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 } as DOMRect);
    plantPill("img", { left: 100, top: 358, width: 400, height: 44 });

    const sample = mount(runtime()).snapshot() as { originDelta: { left: number; top: number } };
    expect(sample.originDelta).toEqual({ left: 4, top: 0 });
  });

  it("读数抛错时计数，空表不会被误读成「没有错位」", () => {
    plantPill("img", { left: 100, top: 358, width: 400, height: 44 });
    const probe = mount(runtime({
      nodeScreenRect: () => { throw new TypeError("boom"); }
    }));
    const sample = probe.snapshot() as { delta: unknown; expected: unknown };
    expect(sample.expected).toBeNull();
    expect(sample.delta).toBeNull();
    expect(probe.health().errors).toBe(1);
    expect(probe.health().lastError).toContain("boom");
  });
});
