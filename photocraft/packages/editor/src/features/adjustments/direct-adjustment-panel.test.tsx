/** @vitest-environment jsdom */
// 只验证入口可见性、参数走同一份草稿与确认/取消时序；不采集渲染结果。
import { act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorResult } from "../../editor-wasm.js";
import { DirectAdjustmentPanel } from "./direct-adjustment-panel.js";
import { AdvancedAdjustmentPanel } from "./panels.js";
import { ADJUSTMENT_LABELS, defaultAdjustmentParams, PARAMETERLESS_KINDS } from "./tool-parameters.js";

// 曲线弹层只验证参数与图形数据，不测 Radix 定位。
vi.mock("../../ui/Popover.js", () => ({
  Popover: ({ open, trigger, children, onOpenChange }: { open: boolean; trigger: ReactElement; children: ReactElement; onOpenChange: (open: boolean) => void }) => (
    <>{cloneElement(trigger, { onClick: () => onOpenChange(!open) })}{open ? children : null}</>
  )
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function setup(targets: unknown) {
  const session = {
    directAdjustmentTargets: vi.fn((): EditorResult<unknown> => ({ ok: true, value: targets })),
    beginDirectAdjustment: vi.fn((_target: string, _params: unknown, _layer?: number): EditorResult<unknown> => ({ ok: true, value: { mode: "pixels" } })),
    previewDirectAdjustment: vi.fn((_params: unknown): EditorResult<unknown> => ({ ok: true, value: { mode: "pixels" } })),
    commitDirectAdjustment: vi.fn((): EditorResult<unknown> => ({ ok: true, value: {} })),
    cancelDirectAdjustment: vi.fn()
  };
  // 内核样条端口：返回一条与本地直线采样不同的斜坡，用来区分「读内核」与「自己算」。
  const curveGeometry = vi.fn((_points: readonly [number, number][]): EditorResult<number[]> =>
    ({ ok: true, value: Array.from({ length: 256 }, (_, index) => 255 - index) }));
  const endpoint = {
    features: { adjustments: session },
    curveGeometry,
    snapshot: () => ({ view: { document: { layers: [{ id: 3, name: "背景", kind: "raster" }], activeLayerId: 3 } } })
  };
  const onApply = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <DirectAdjustmentPanel endpoint={endpoint as unknown as EditorWorkspaceController} readonly={false} foreground="#336699" onApply={onApply} />
  ));
  const target = (value: string) => act(() => {
    const node = container.querySelector("select")!;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const range = (label: string, value: number) => act(() => {
    const node = [...container.querySelectorAll<HTMLInputElement>('input[type="range"]')]
      .find((input) => input.parentElement?.textContent?.startsWith(label))!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, String(value));
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const checkbox = (label: string) => {
    const node = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.startsWith(label))!;
    act(() => node.click());
  };
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text)!;
  return { container, session, onApply, curveGeometry, target, range, checkbox, button };
}

it("只渲染内核报告的入口，首次改动才开始草稿", () => {
  const { container, session, onApply, range, button } = setup({
    kinds: ["brightnessContrast", "invert"],
    commands: ["image.autoTone"],
    allKinds: ["brightnessContrast", "invert", "colorLookup"],
    allCommands: ["image.autoTone"]
  });
  const options = [...container.querySelectorAll("option")].map((option) => option.textContent);
  expect(options).toEqual(["亮度/对比度", "反相", "自动色调"]);
  expect(options).not.toContain("颜色查找");
  expect(session.beginDirectAdjustment).not.toHaveBeenCalled();
  expect(button("确认调整").disabled).toBe(true);

  range("亮度", 40);
  expect(session.beginDirectAdjustment).toHaveBeenCalledOnce();
  const [target, params] = session.beginDirectAdjustment.mock.calls[0]!;
  expect(target).toBe("brightnessContrast");
  expect(params).toMatchObject({ brightness: 40 });
  expect(onApply).toHaveBeenCalledOnce();
  // 之后的改动走预览，不再起始新草稿。
  range("对比度", 20);
  expect(session.previewDirectAdjustment).toHaveBeenCalledWith({ brightness: 40, contrast: 20 });
  expect(session.beginDirectAdjustment).toHaveBeenCalledOnce();
  expect(button("确认调整").disabled).toBe(false);

  act(() => button("确认调整").click());
  expect(session.commitDirectAdjustment).toHaveBeenCalledOnce();
  expect(button("确认调整").disabled).toBe(true);
});

it("预览失败保留提示并让草稿不可确认", () => {
  const { container, session, button, range } = setup({
    kinds: ["brightnessContrast"],
    commands: [],
    allKinds: ["brightnessContrast"],
    allCommands: []
  });
  range("亮度", 10);
  session.previewDirectAdjustment.mockReturnValue({ ok: false, code: "command-failed", message: "亮度参数无效" });
  range("亮度", 20);
  expect(container.textContent).toContain("亮度参数无效");
  // 失败不重复起始草稿，也不悄悄确认。
  expect(session.beginDirectAdjustment).toHaveBeenCalledOnce();
  expect(session.commitDirectAdjustment).not.toHaveBeenCalled();
  act(() => button("取消调整").click());
  expect(session.cancelDirectAdjustment).toHaveBeenCalledOnce();
});

it("确认失败保留提示，取消恢复且不改文档", () => {
  const { container, session, button, range } = setup({
    kinds: ["brightnessContrast"],
    commands: [],
    allKinds: ["brightnessContrast"],
    allCommands: []
  });
  range("亮度", 10);
  session.commitDirectAdjustment.mockReturnValue({ ok: false, code: "command-failed", message: "参数无效" });
  act(() => button("确认调整").click());
  expect(container.textContent).toContain("参数无效");
  // 确认失败仍停留在草稿里，不能被当成已提交。
  expect(button("确认调整").disabled).toBe(false);

  act(() => button("取消调整").click());
  expect(session.cancelDirectAdjustment).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("参数无效");
});

it("没有开放目标时给出说明而不是菜单占位", () => {
  const { container } = setup({ kinds: [], commands: [], allKinds: ["curves"], allCommands: [] });
  expect(container.querySelector("[data-direct-adjustment]")).not.toBeNull();
  expect(container.textContent).toContain("运行时尚未开放任何直接调整命令");
  // 一个可点的入口都没有。
  expect(container.querySelectorAll("option")).toHaveLength(0);
});

it("结构非法的目标清单不显示半截入口", () => {
  const { container } = setup({ kinds: ["brightnessContrast"] });
  expect(container.querySelector("[data-direct-adjustment]")).toBeNull();
});

it("无参数调整有显式起点，不能靠滑杆才能开始", () => {
  const { container, session, onApply, target, button } = setup({
    kinds: ["brightnessContrast", "invert"],
    commands: ["image.autoTone"],
    allKinds: ["brightnessContrast", "invert"],
    allCommands: ["image.autoTone"]
  });
  target("invert");
  expect(container.textContent).toContain("反相没有参数");
  act(() => button("应用调整").click());
  expect(session.beginDirectAdjustment).toHaveBeenCalledWith("invert", {}, undefined);
  expect(onApply).toHaveBeenCalled();
  expect(button("确认调整").disabled).toBe(false);
  act(() => button("取消调整").click());
  expect(session.cancelDirectAdjustment).toHaveBeenCalledOnce();
});

it("无参数命令同样可以开始并确认", () => {
  const { container, session, onApply, target, button } = setup({
    kinds: ["brightnessContrast"],
    commands: ["image.autoTone", "image.adjustments.desaturate"],
    allKinds: ["brightnessContrast"],
    allCommands: ["image.autoTone", "image.adjustments.desaturate"]
  });
  // 有参数的类型不出现「应用调整」。
  expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "应用调整")).toBe(false);
  target("image.adjustments.desaturate");
  act(() => button("应用调整").click());
  expect(session.beginDirectAdjustment).toHaveBeenCalledWith("image.adjustments.desaturate", {}, undefined);
  expect(onApply).toHaveBeenCalled();
  expect(button("确认调整").disabled).toBe(false);
  act(() => button("确认调整").click());
  expect(session.commitDirectAdjustment).toHaveBeenCalledOnce();
  // 确认后重新收起起点按钮。
  expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "应用调整")).toBe(true);
});

it("铅笔曲线写 256 级映射并保持铅笔模式，点曲线读内核样条", () => {
  const { session, curveGeometry, target, checkbox } = setup({
    kinds: ["curves"],
    commands: [],
    allKinds: ["curves"],
    allCommands: []
  });
  target("curves");
  // 点曲线图形来自内核端口，而不是本地直线采样。
  expect(curveGeometry).toHaveBeenCalled();
  checkbox("铅笔曲线");
  const [, params] = session.beginDirectAdjustment.mock.calls.at(-1)!;
  expect(params).toMatchObject({ pencil: true });
  // 映射来自内核样条端口（测试里是 255→0 的反向斜坡），不是本地直线近似。
  const initial = (params as { points: number[] }).points;
  expect(initial).toHaveLength(256);
  expect(initial[0]).toBe(255);
  expect(initial[255]).toBe(0);
  // 切回点曲线：控制点数组 + pencil=false，不是 256 级映射。
  checkbox("铅笔曲线");
  const [points] = session.previewDirectAdjustment.mock.calls.at(-1)!;
  expect(points).toMatchObject({ pencil: false });
  expect(Array.isArray((points as Record<string, unknown>).points)).toBe(true);
  expect(((points as Record<string, unknown>).points as unknown[]).length).toBeLessThan(256);
});

it("渐变映射添加站点不与末站点重复位置", () => {
  const { session, target, button } = setup({
    kinds: ["gradientMap"],
    commands: [],
    allKinds: ["gradientMap"],
    allCommands: []
  });
  target("gradientMap");
  // 默认站点是 0 和 1；直接追加 1 会与末站点重复，内核要求位置严格递增。
  act(() => button("添加站点").click());
  const [, params] = session.beginDirectAdjustment.mock.calls.at(-1)!;
  const stops = (params as { stops: Array<[number, string]> }).stops;
  expect(stops.map(([position]) => position)).toEqual([0, 0.5, 1]);
  expect(stops[1]![1]).toBe("#808080");
});

it("色阶分通道与吸管复用同一草稿", () => {
  const { container, session, target, range, button } = setup({
    kinds: ["levels"],
    commands: [],
    allKinds: ["levels"],
    allCommands: []
  });
  target("levels");
  range("输出白场", 200);
  expect(session.beginDirectAdjustment).toHaveBeenCalledWith("levels", expect.objectContaining({ outWhite: 200 }), undefined);
  // 切换到红通道后只写该通道，不动总参数。
  const channel = [...container.querySelectorAll("select")].find((node) => node.textContent?.includes("红"))!;
  act(() => {
    channel.value = "red";
    channel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  range("输入黑场", 20);
  expect(session.previewDirectAdjustment).toHaveBeenLastCalledWith({ red: expect.objectContaining({ inBlack: 20 }) });
  // 吸管用前景色作为取样色（#336699 → 0–1）。
  act(() => button("设黑场").click());
  expect(session.previewDirectAdjustment).toHaveBeenLastCalledWith({
    eyedropper: { point: "black", color: [0x33 / 255, 0x66 / 255, 0x99 / 255] }
  });
});

it("匹配颜色可从内核报告的其它文档选来源，来源随参数一起提交", () => {
  const { container, session, target, range } = setup({
    kinds: [],
    commands: ["image.adjustments.matchColor"],
    allKinds: ["curves"],
    allCommands: ["image.adjustments.matchColor"],
    documents: [
      { index: 0, name: "参考图", width: 64, height: 48, active: false },
      { index: 1, name: "当前图", width: 32, height: 24, active: true }
    ]
  });
  target("image.adjustments.matchColor");
  // 来源下拉只列其它文档，并含「当前图像」这一项（不写 source）。
  const sourceSelect = [...container.querySelectorAll("select")]
    .find((node) => node.parentElement?.textContent?.startsWith("来源图像"))!;
  const options = [...sourceSelect.querySelectorAll("option")].map((option) => option.textContent);
  expect(options).toEqual(["当前图像", "参考图（64×48）"]);
  act(() => {
    sourceSelect.value = "0";
    sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(session.beginDirectAdjustment).toHaveBeenCalledWith(
    "image.adjustments.matchColor",
    expect.objectContaining({ source: 0 }),
    undefined
  );
  // 之后调参数沿用同一来源。
  range("颜色强度", 150);
  expect(session.previewDirectAdjustment).toHaveBeenLastCalledWith(expect.objectContaining({ source: 0, intensity: 150 }));
  // 换回「当前图像」必须显式清除来源键，否则内核仍按上一份来源统计。
  act(() => {
    sourceSelect.value = "";
    sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(session.previewDirectAdjustment).toHaveBeenLastCalledWith(expect.objectContaining({ source: null }));
  // 没有跨文档来源时「来源使用来源选区」不起作用（内核只对 source 生效），必须禁用而不是假装可点。
  const sourceSelection = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith("来源使用来源选区"))!
    .querySelector("input")!;
  expect(sourceSelection.disabled).toBe(true);
});

it("打开第二份图像后来源下拉跟着内核报告更新，不用重开面板", () => {
  // 目标清单里带着会话文档：只在挂载时取一次会让来源列表停在旧会话上。
  let documents = [{ index: 0, name: "第一张", width: 8, height: 8, active: true }];
  const session = {
    directAdjustmentTargets: vi.fn((): EditorResult<unknown> => ({
      ok: true,
      value: {
        kinds: [],
        commands: ["image.adjustments.matchColor"],
        allKinds: ["curves"],
        allCommands: ["image.adjustments.matchColor"],
        documents
      }
    })),
    beginDirectAdjustment: vi.fn((_target: string, _params: unknown, _layer?: number): EditorResult<unknown> => ({ ok: true, value: { mode: "pixels" } })),
    previewDirectAdjustment: vi.fn((_params: unknown): EditorResult<unknown> => ({ ok: true, value: { mode: "pixels" } })),
    commitDirectAdjustment: vi.fn((): EditorResult<unknown> => ({ ok: true, value: {} })),
    cancelDirectAdjustment: vi.fn()
  };
  let snapshot = { view: { document: { layers: [{ id: 3, name: "背景", kind: "raster" }], activeLayerId: 3 }, documents: 1 } };
  const endpoint = {
    features: { adjustments: session },
    curveGeometry: vi.fn((): EditorResult<number[]> => ({ ok: true, value: [] })),
    snapshot: () => snapshot
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () => act(() => root.render(
    <DirectAdjustmentPanel endpoint={endpoint as unknown as EditorWorkspaceController} readonly={false} foreground="#336699" onApply={() => {}} />
  ));
  render();
  const sourceSelect = () => [...container.querySelectorAll("select")]
    .find((node) => node.parentElement?.textContent?.startsWith("来源图像")) ?? null;
  expect(sourceSelect(), "只有一份文档时没有来源下拉").toBeNull();

  act(() => {
    const node = container.querySelector("select")!;
    node.value = "image.adjustments.matchColor";
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // 打开第二份图像：编辑器发布新快照，面板必须重取来源清单。
  documents = [
    { index: 0, name: "第一张", width: 8, height: 8, active: false },
    { index: 1, name: "第二张", width: 16, height: 12, active: true }
  ];
  snapshot = { view: { document: { layers: [{ id: 3, name: "背景", kind: "raster" }], activeLayerId: 3 }, documents: 2 } };
  render();
  const options = [...sourceSelect()!.querySelectorAll("option")].map((option) => option.textContent);
  expect(options).toEqual(["当前图像", "第一张（8×8）"]);
  expect(session.directAdjustmentTargets.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("只有一份文档时不显示来源下拉，匹配颜色按本图统计", () => {
  const { container, session, target } = setup({
    kinds: [],
    commands: ["image.adjustments.matchColor"],
    allKinds: ["curves"],
    allCommands: ["image.adjustments.matchColor"],
    documents: [{ index: 0, name: "唯一", width: 16, height: 16, active: true }]
  });
  target("image.adjustments.matchColor");
  const labels = [...container.querySelectorAll("label")].map((node) => node.textContent);
  expect(labels.some((text) => text?.startsWith("来源图像"))).toBe(false);
  expect(container.textContent).toContain("只打开了一份图像");
  expect(session.beginDirectAdjustment).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------- 调整层参数编辑（U43）

function setupLayer(kind: string, params: Record<string, unknown>) {
  const dispatch = vi.fn((_command: string, _payload?: unknown): EditorResult<unknown> => ({ ok: true, value: {} }));
  const endpoint = {
    snapshot: () => ({
      view: {
        document: {
          layers: [{ id: 7, name: "调整", kind: "adjustment", adjustment: kind, adjustmentParams: params }],
          activeLayerId: 7
        }
      }
    }),
    dispatch,
    curveGeometry: () => ({ ok: true as const, value: Array.from({ length: 256 }, (_, index) => index) })
  };
  const onApply = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <AdvancedAdjustmentPanel endpoint={endpoint as unknown as EditorWorkspaceController} readonly={false} onApply={onApply} />
  ));
  return { container, dispatch, onApply };
}

it("已发布的新调整层都能渲染自己的参数控件并写回 layer.setAdjustment", () => {
  // 每个已发布类型必须真的可编辑：有参数的给出能写回 `layer.setAdjustment` 的控件，
  // 无参数的（反相）给出明确说明而不是死控件；LUT 等范围外类型不渲染半截控件。
  for (const kind of Object.keys(ADJUSTMENT_LABELS) as Array<keyof typeof ADJUSTMENT_LABELS>) {
    const { container, dispatch } = setupLayer(kind, defaultAdjustmentParams(kind));
    const section = container.querySelector("[data-advanced-adjustment]");
    expect(section, kind).not.toBeNull();
    expect(section?.getAttribute("data-advanced-adjustment")).toBe(kind);
    expect(container.textContent, kind).toContain(ADJUSTMENT_LABELS[kind]);
    if (PARAMETERLESS_KINDS.includes(kind)) {
      // 无参数类型没有可写回的字段；面板必须解释清楚，不能留一个点了没反应的控件。
      expect(container.querySelectorAll("input").length, kind).toBe(0);
      expect(container.textContent, kind).toContain("没有参数");
      act(() => root.unmount());
      document.body.innerHTML = "";
      continue;
    }
    // 通道下拉之类的纯视图切换不写回，所以逐个尝试参数控件，直到真的产生一次写回。
    const controls = [...container.querySelectorAll<HTMLElement>("input, button")];
    expect(controls.length, `${kind} 至少给出一个参数控件`).toBeGreaterThan(0);
    for (const control of controls) {
      act(() => {
        if (control instanceof HTMLInputElement && control.type === "range") {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, "10");
          control.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (control instanceof HTMLInputElement && control.type === "checkbox") {
          control.click();
        } else if (control instanceof HTMLInputElement) {
          // 小数步长的参数用 number 输入（见 `Range`），值走同一套 `onChange`。
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, "1.5");
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          control.dispatchEvent(new Event("click", { bubbles: true }));
        }
      });
      if (dispatch.mock.calls.some(([command]) => command === "layer.setAdjustment")) break;
    }
    expect(
      dispatch.mock.calls.some(([command]) => command === "layer.setAdjustment"),
      `${kind} 的控件操作必须写回 layer.setAdjustment`
    ).toBe(true);
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
  // 范围外类型（LUT）不渲染可编辑控件。
  const { container } = setupLayer("colorLookup", {});
  expect(container.querySelector("[data-advanced-adjustment]")).toBeNull();
});
