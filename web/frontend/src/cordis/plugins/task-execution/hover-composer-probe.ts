/// <reference types="vite/client" />
/**
 * 「添加到对话框」胶囊错位的**只读探针**（仅开发环境）。
 *
 * 背景：胶囊是 DOM 浮层，位置由 `nodeScreenRect` 投影；用户报告它与卡片错位。
 * 三个待验证的假设，靠这同一个探针就能分开（探针不改组件本身，证据因此与被测对象独立）：
 *
 * 1. **过期**：胶囊只订阅视口变化，画布因图片加载 / 拖动 / 资源栏收展改变时它不重排。
 *    判据：`pill`（DOM 实际矩形）与 `expected`（此刻用同一套几何**重算**的矩形）不一致。
 * 2. **矩形来源不同**：胶囊用卡片本体矩形，其它浮层用呈现矩形。
 *    判据：`node` 与 `presentation` 两个矩形有系统性差（内边距 / letterbox / 组徽标）。
 * 3. **坐标系原点分叉**：渲染端按父容器取原点，`worldToClient` 按 canvas 自身取外框。
 *    判据：`originDelta` 非 0，或 canvas 上有被写死的行内像素尺寸
 *    （`fit_canvas_to_parent` 的行为，放大后 rect 会停在旧值）。
 *
 * 控制台用法：
 *
 *     __hoverComposerProbe.dump()      // 表格：Δleft/Δtop 非 0 即过期；originΔ 非 0 即原点分叉
 *     __hoverComposerProbe.snapshot()  // 当前这一刻的完整读数
 *     __hoverComposerProbe.clear()     // 清空已记录的样本
 *
 * 只读：不写画布、不改胶囊、不提交命令；任何异常都被吞掉，不能拖垮悬停交互。
 */
import type { CanvasRuntimeService } from "../../contracts.js";
import { hoverComposerBox, type HoverComposerBox } from "./hover-composer.js";
import { hoverNodeStore } from "../../services/hover-store.js";

type Rect = { left: number; top: number; width: number; height: number };

/** 一条采样：同一时刻把「胶囊实际在哪」与「此刻应该在哪」放在一起。 */
export type HoverComposerProbeSample = {
  at: number;
  /** 胶囊当前的节点（`data-node-id`）；没有胶囊时为 null。 */
  pillNodeId: string | null;
  /** 画布此刻 hover 的节点；与 `pillNodeId` 不同即「目标过期」。 */
  hoveredNodeId: string | null;
  /** 胶囊 DOM 的实际外框（内联 left/top/width/height 的结果）。 */
  pill: Rect | null;
  /** 用当前视口与 `nodeScreenRect` **重算**的矩形 —— 组件此刻本应画成这个位置。 */
  expected: HoverComposerBox | null;
  /** `pill - expected`；接近 0 说明没有过期问题。 */
  delta: Rect | null;
  /** 卡片本体矩形。 */
  node: Rect | null;
  /** 呈现矩形（含内边距 / letterbox / 组徽标）；null 表示运行时没提供或节点不在场景内。 */
  presentation: Rect | null;
  /** `presentation - node`；非 0 即假设 2 成立。 */
  presentationDelta: Rect | null;
  viewport: { x: number; y: number; zoom: number } | null;
  /** canvas 自身的外框（`worldToClient` 用的就是这个）。 */
  canvas: Rect | null;
  /** canvas 父容器（表面）的外框；渲染端取表面原点用的是它。 */
  host: Rect | null;
  /** `canvas - host`；非 0 即两个原点分叉（假设 3）。 */
  originDelta: { left: number; top: number } | null;
  /** canvas 上的行内像素尺寸与 DPR —— 被写死的尺寸会让 rect 停在旧值。 */
  canvasInline: { attrWidth: number | null; attrHeight: number | null; dpr: number } | null;
  window: { innerWidth: number; innerHeight: number; scrollX: number; scrollY: number };
};

const MAX_SAMPLES = 400;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * 读数失败次数与最近一次原因。
 *
 * `read()` 必须吞掉异常，否则探针能拖垮悬停交互；但吞掉之后「表是空的」就分不清是
 * 「没有错位」还是「探针自己坏了」。这两个字段让后者可见。
 */
type ProbeHealth = { errors: number; lastError: string | null };
const health: ProbeHealth = { errors: 0, lastError: null };

function rectOf(element: Element | null): Rect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { left: round(rect.left), top: round(rect.top), width: round(rect.width), height: round(rect.height) };
}

function rectOrNull(rect: { left: number; top: number; width: number; height: number } | null): Rect | null {
  return rect ? { left: round(rect.left), top: round(rect.top), width: round(rect.width), height: round(rect.height) } : null;
}

const deltaOf = (a: Rect, b: Rect): Rect => ({
  left: round(a.left - b.left),
  top: round(a.top - b.top),
  width: round(a.width - b.width),
  height: round(a.height - b.height)
});

/**
 * 读一次当前状态。
 *
 * `expected` 之所以可信：它调用的是组件**同一个** `hoverComposerBox` + `nodeScreenRect`，
 * 但绕开了组件的渲染时机，所以两者的差只可能来自「组件没跟着重渲染」。
 */
function read(runtime: CanvasRuntimeService): HoverComposerProbeSample {
  const pillElement = document.querySelector<HTMLElement>(".hover-composer");
  const pillNodeId = pillElement?.dataset.nodeId ?? null;
  const hoveredNodeId = hoverNodeStore.getSnapshot().nodeId;
  const nodeId = pillNodeId ?? hoveredNodeId;
  const canvas = document.getElementById("bevy-canvas") as HTMLCanvasElement | null;
  const host = canvas?.parentElement ?? null;

  let node: Rect | null = null;
  let presentation: Rect | null = null;
  let expected: HoverComposerBox | null = null;
  let viewport: { x: number; y: number; zoom: number } | null = null;
  try {
    if (nodeId) {
      node = rectOrNull(runtime.nodeScreenRect(nodeId));
      presentation = rectOrNull(runtime.nodePresentationScreenRect?.(nodeId) ?? null);
      // 组件只在测到视口尺寸时才做边缘回退，探针保持同样的条件。
      expected = hoverComposerBox(
        runtime.nodeScreenRect(nodeId),
        window.innerWidth > 0 ? { width: window.innerWidth, height: window.innerHeight } : undefined
      );
    }
    viewport = runtime.controller()?.viewport() ?? null;
  } catch (error) {
    // 探针不能影响交互，但失败要留痕：否则空表会被误读成「没有错位」。
    health.errors += 1;
    health.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const pill = rectOf(pillElement);
  const canvasRect = rectOf(canvas);
  const hostRect = rectOf(host);

  return {
    at: Date.now(),
    pillNodeId,
    hoveredNodeId,
    pill,
    expected,
    delta: pill && expected ? deltaOf(pill, expected) : null,
    node,
    presentation,
    presentationDelta: node && presentation ? deltaOf(presentation, node) : null,
    viewport,
    canvas: canvasRect,
    host: hostRect,
    originDelta: canvasRect && hostRect
      ? { left: round(canvasRect.left - hostRect.left), top: round(canvasRect.top - hostRect.top) }
      : null,
    canvasInline: canvas
      ? {
        attrWidth: canvas.getAttribute("width") ? Number(canvas.getAttribute("width")) : null,
        attrHeight: canvas.getAttribute("height") ? Number(canvas.getAttribute("height")) : null,
        dpr: round(window.devicePixelRatio)
      }
      : null,
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    }
  };
}

/**
 * 两条采样是否「值得区分」：只看会改变结论的字段。
 *
 * 逐帧全记会在几百毫秒内把缓冲区冲掉；亚像素抖动也不该占位。
 */
function signatureOf(sample: HoverComposerProbeSample): string {
  return JSON.stringify([
    sample.pillNodeId,
    sample.hoveredNodeId,
    sample.pill,
    sample.expected,
    sample.presentationDelta,
    sample.originDelta,
    sample.canvas,
    sample.viewport
  ]);
}

/** 悬挂探针；返回卸载函数。重复调用复用同一份（StrictMode / 热重载不会叠加两个 rAF）。 */
export function installHoverComposerProbe(runtime: CanvasRuntimeService): () => void {
  if (!import.meta.env.DEV) return () => {};
  const target = globalThis as unknown as { __hoverComposerProbe?: unknown };
  if (target.__hoverComposerProbe) return () => {};

  const samples: HoverComposerProbeSample[] = [];
  let signature = "";
  let frame = 0;
  let active = true;

  const tick = () => {
    if (!active) return;
    frame = requestAnimationFrame(tick);
    try {
      const sample = read(runtime);
      // 既没有胶囊也没有悬停节点：这帧没有可比较的对象，不占位。
      if (!sample.pill && !sample.expected) return;
      const next = signatureOf(sample);
      if (next === signature) return;
      signature = next;
      samples.push(sample);
      if (samples.length > MAX_SAMPLES) samples.shift();
    } catch { /* 探针不能影响画布。 */ }
  };
  frame = requestAnimationFrame(tick);

  const dump = () => {
    const rows = samples.map((sample) => ({
      t: sample.at % 100000,
      pillNode: sample.pillNodeId,
      hovered: sample.hoveredNodeId,
      "Δleft": sample.delta?.left ?? "",
      "Δtop": sample.delta?.top ?? "",
      "Δw": sample.delta?.width ?? "",
      "Δh": sample.delta?.height ?? "",
      "presΔleft": sample.presentationDelta?.left ?? "",
      "originΔl": sample.originDelta?.left ?? "",
      "originΔt": sample.originDelta?.top ?? "",
      zoom: sample.viewport?.zoom ?? "",
      canvasAttr: sample.canvasInline ? `${sample.canvasInline.attrWidth}×${sample.canvasInline.attrHeight}` : ""
    }));
    console.table(rows);
    return rows;
  };

  target.__hoverComposerProbe = {
    snapshot: () => { try { return read(runtime); } catch { return null; } },
    samples: () => samples.slice(),
    /** 探针自身的健康状况：`errors > 0` 时表格不可信，先看 `lastError`。 */
    health: () => ({ ...health }),
    dump,
    clear: () => { samples.length = 0; signature = ""; },
    stop: () => { active = false; cancelAnimationFrame(frame); }
  };

  return () => {
    active = false;
    cancelAnimationFrame(frame);
    if (target.__hoverComposerProbe) delete target.__hoverComposerProbe;
  };
}
