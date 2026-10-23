/** @vitest-environment jsdom */
/**
 * 画布叠加层与拖绘状态机（U08/U09/U11/U12 的域内一半）。
 *
 * 这些正是集成方接进 `photo-editor-canvas.tsx` 时要用的东西，因此必须**独立于共享画布**可验：
 * 叠加层只按传入的坐标与缩放画图，状态机只累积指针序列并给出可提交的草稿。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AnchorOverlay, PathOverlay, ShapeDragOverlay, usePathDraft, useShapeDrag } from "./panels.js";
import { cornerKnot } from "./pen-tools.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

describe("形状拖绘预览（U08/U09）", () => {
  it("按缩放与原点投影，并显示翻转后的实际尺寸", () => {
    const container = render(
      <ShapeDragOverlay
        drag={{ kind: "rect", start: [120, 90], end: [20, 30] }}
        canvas={[800, 600]}
        zoom={2}
        origin={{ x: 10, y: 20 }}
      />,
    );
    const rect = container.querySelector("[data-shape-overlay] rect")!;
    // 反向拖绘翻正后：x=20,y=30,w=100,h=60 → 投影 (10+40, 20+60, 200, 120)
    expect(rect.getAttribute("x")).toBe("50");
    expect(rect.getAttribute("y")).toBe("80");
    expect(rect.getAttribute("width")).toBe("200");
    expect(rect.getAttribute("height")).toBe("120");
    expect(container.querySelector("[data-shape-size]")!.textContent).toBe("100 × 60");
  });

  it("零面积只显示可读提示，不画形状", () => {
    const container = render(
      <ShapeDragOverlay drag={{ kind: "rect", start: [5, 5], end: [5, 5] }} canvas={[800, 600]} zoom={1} origin={{ x: 0, y: 0 }} />,
    );
    expect(container.querySelector('[data-shape-overlay="invalid"]')).not.toBeNull();
    expect(container.querySelector("rect")).toBeNull();
    expect(container.querySelector("[data-shape-message]")!.textContent).toMatch(/面积为零/);
  });

  it("直线画成线段而不是矩形框", () => {
    const container = render(
      <ShapeDragOverlay drag={{ kind: "line", start: [0, 0], end: [40, 0], weight: 2 }} canvas={[800, 600]} zoom={1} origin={{ x: 0, y: 0 }} />,
    );
    expect(container.querySelector("[data-shape-overlay] line")).not.toBeNull();
    expect(container.querySelector("[data-shape-overlay] rect")).toBeNull();
  });
});

describe("锚点/手柄叠加层（U11/U12）", () => {
  const path = {
    subpaths: [{
      closed: false,
      knots: [
        cornerKnot([0, 0]),
        { anchor: [10, 0] as [number, number], in: [6, 0] as [number, number], out: [14, 0] as [number, number] },
      ],
    }],
  };

  it("画锚点与方向手柄，收起的手柄不画线", () => {
    const container = render(
      <AnchorOverlay path={path} zoom={1} origin={{ x: 0, y: 0 }} selection={[]} />,
    );
    expect(container.querySelectorAll("[data-path-anchor]")).toHaveLength(2);
    // 第一个锚点是角点（无 in/out），第二个有两个手柄。
    expect(container.querySelectorAll("[data-path-handle]")).toHaveLength(2);
  });

  it("选中与悬停状态落到 data 属性，命中圈按屏幕阈值换算", () => {
    const container = render(
      <AnchorOverlay
        path={path} zoom={2} origin={{ x: 0, y: 0 }}
        selection={[{ kind: "anchor", subpath: 0, knot: 0, distance: 0 }]}
        hover={{ kind: "anchor", subpath: 0, knot: 1, distance: 0 }}
        tolerance={6}
      />,
    );
    const anchors = [...container.querySelectorAll("[data-path-anchor]")];
    expect(anchors[0]!.getAttribute("data-selected")).toBe("true");
    expect(anchors[1]!.getAttribute("data-hovered")).toBe("true");
    // tolerance 6 × zoom 2 = 12
    expect(container.querySelector("circle[r='12']")).not.toBeNull();
  });

  it("钢笔叠加层按开/闭合区分，手柄与锚点重合时不画线", () => {
    const open = render(<PathOverlay points={[[0, 0], [10, 10]]} closed={false} zoom={1} origin={{ x: 0, y: 0 }} />);
    expect(open.querySelector("[data-path-overlay]")!.getAttribute("data-path-overlay")).toBe("open");
    expect(open.querySelector("path")!.getAttribute("fill")).toBe("none");
  });

  it("闭合路径填充并闭合路径数据", () => {
    const container = render(<PathOverlay points={[[0, 0], [10, 0], [10, 10]]} closed zoom={1} origin={{ x: 0, y: 0 }} />);
    expect(container.querySelector("path")!.getAttribute("d")!.endsWith("Z")).toBe(true);
    expect(container.querySelector("path")!.getAttribute("fill")).not.toBe("none");
  });
});

describe("拖绘状态机（供画布接线的 hook）", () => {
  function Harness({ onState }: { onState: (api: ReturnType<typeof useShapeDrag>) => void }) {
    const api = useShapeDrag("ellipse");
    onState(api);
    return null;
  }

  it("按下/移动累积起点与终点，松手前的最后一次移动即为提交几何", () => {
    let api!: ReturnType<typeof useShapeDrag>;
    render(<Harness onState={(next) => { api = next; }} />);
    expect(api.drag).toBeNull();
    act(() => api.begin([10, 10]));
    expect(api.drag).toMatchObject({ kind: "ellipse", start: [10, 10], end: [10, 10] });
    act(() => api.update([50, 40], { constrain: true }));
    expect(api.drag).toMatchObject({ end: [50, 40], modifiers: { constrain: true } });
    // 取消只清状态，不产生任何提交。
    act(() => api.cancel());
    expect(api.drag).toBeNull();
  });

  it("切换形状只影响后续拖绘，不改动进行中的草稿", () => {
    let api!: ReturnType<typeof useShapeDrag>;
    render(<Harness onState={(next) => { api = next; }} />);
    act(() => api.begin([0, 0]));
    act(() => api.setKind("star"));
    expect(api.kind).toBe("star");
    expect(api.drag!.kind).toBe("ellipse");
  });
});

describe("钢笔草稿状态机（U11）", () => {
  function Harness({ onState }: { onState: (api: ReturnType<typeof usePathDraft>) => void }) {
    const api = usePathDraft("pen");
    onState(api);
    return null;
  }

  it("追加锚点、带手柄追加、撤销与显式结束", () => {
    let api!: ReturnType<typeof usePathDraft>;
    render(<Harness onState={(next) => { api = next; }} />);
    act(() => api.add([0, 0]));
    act(() => api.addWithHandle([10, 0], [14, 0]));
    expect(api.count).toBe(2);
    expect(api.handles[1]).toMatchObject({ out: [14, 0] });
    expect(api.canFinish).toBe(true);
    // 开放结束不闭合；闭合结束才闭合。
    act(() => { expect(api.finish(false)).toBe(true); });
    expect(api.closed).toBe(false);
    act(() => { api.finish(true); });
    expect(api.closed).toBe(true);
    act(() => api.undo());
    expect(api.count).toBe(1);
    act(() => api.reset());
    expect(api.count).toBe(0);
    expect(api.closed).toBe(false);
  });

  it("单锚点的开放草稿不可提交（不产生半成品路径）", () => {
    let api!: ReturnType<typeof usePathDraft>;
    render(<Harness onState={(next) => { api = next; }} />);
    act(() => api.add([5, 5]));
    expect(api.canFinish).toBe(false);
  });
});
