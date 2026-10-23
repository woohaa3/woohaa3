/** @vitest-environment jsdom */
// 只验证映射绘制、插补与只读；不采集 SVG 渲染结果。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CurveMapEditor } from "./curve-map-editor.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const identity = () => Array.from({ length: 256 }, (_, index) => index);

function setup(readonly = false) {
  const change = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CurveMapEditor map={identity()} readonly={readonly} onChange={change} />));
  const svg = container.querySelector("svg")!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 255, height: 255 }) as DOMRect;
  const captured = new Set<number>();
  svg.setPointerCapture = vi.fn((id: number) => captured.add(id));
  svg.hasPointerCapture = (id: number) => captured.has(id);
  svg.releasePointerCapture = vi.fn((id: number) => captured.delete(id));
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 255 - y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => svg.dispatchEvent(event));
  };
  return { container, change, send };
}

it("拖动在两个采样列之间线性补齐，不留下没画到的空洞", () => {
  const { change, send } = setup();
  send("pointerdown", 10, 200);
  const first = change.mock.calls.at(-1)![0] as number[];
  expect(first[10]).toBe(200);
  expect(first).toHaveLength(256);

  // 从 (10,200) 拖到 (20,100)：中间每一列都要写，且按比例插补。
  send("pointermove", 20, 100);
  const second = change.mock.calls.at(-1)![0] as number[];
  expect(second[10]).toBe(200);
  expect(second[20]).toBe(100);
  expect(second[15]).toBe(150);
  // 未触及的列保持原值。
  expect(second[100]).toBe(100);
});

it("只读时不发任何改动", () => {
  const { change, send } = setup(true);
  send("pointerdown", 40, 40);
  send("pointermove", 80, 80);
  send("pointerup", 80, 80);
  expect(change).not.toHaveBeenCalled();
});

it("松开指针后不再跟随移动，取消同样结束本次绘制", () => {
  const { change, send } = setup();
  send("pointerdown", 30, 30);
  send("pointerup", 30, 30);
  change.mockClear();
  send("pointermove", 90, 90);
  expect(change).not.toHaveBeenCalled();

  send("pointerdown", 50, 50);
  send("pointercancel", 60, 60);
  change.mockClear();
  send("pointermove", 70, 70);
  expect(change).not.toHaveBeenCalled();
});
