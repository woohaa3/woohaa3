/** @vitest-environment jsdom */
/**
 * U17–U24 面板接线回归。
 *
 * 锁定三件容易回归的事：①入口走**本域会话**（`controller.features.selections`）而不是要求共享
 * 控制器新增方法；②重挂载后认领内核里已有的草稿，不再 `begin` 撞统一门禁；③最后一次输入非法
 * 时确认按钮禁用，不会提交上一份成功候选。像素语义在 Rust 侧测试。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { ColorGrowPanel, ColorRangeSamplesPanel, LayerMaskPanel, LineSelectionPanel, MagneticLassoPanel, NamedSelectionPanel, QuickMaskPanel, RefineEdgeWorkspace, SmartSelectPanel } from "./workflow-panels.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Result = { ok: true; value: unknown } | { ok: false; code: string; message: string };

function ok(value: unknown = null): Result { return { ok: true, value }; }

/** 只装配本域会话的控制器替身：共享控制器方法表没有这些入口。 */
function fakeController(session: Record<string, unknown>, allowed: readonly string[] = []) {
  const controller = {
    features: { selections: session },
    snapshot: () => ({
      view: { hasDocument: true, document: { revision: 1 }, sessionActiveIndex: 0 },
      commands: new Map(allowed.map((id) => [id, { allowed: true, enabled: true }]))
    })
  };
  return controller as unknown as EditorWorkspaceController;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}
function unmount() { act(() => root?.unmount()); container?.remove(); root = null; container = null; }
afterEach(unmount);

function button(text: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes(text));
  if (!found) throw new Error(`missing button: ${text}`);
  return found as HTMLButtonElement;
}

it("磁性套索预览走本域会话，最后一次输入非法时禁止确认", () => {
  let active = false;
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginMagneticLasso: vi.fn(() => { active = true; return ok({ bounds: [10, 10, 30, 30], outline: [], invalid: false }); }),
    updateMagneticLasso: vi.fn(() => ok({ bounds: [10, 10, 30, 30], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => { active = false; return ok({ cancelled: true }); })
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  expect(container!.querySelector("[data-magnetic-lasso]")?.getAttribute("data-magnetic-lasso")).toBe("idle");

  act(() => button("预览追踪").click());
  expect(session.beginMagneticLasso).toHaveBeenCalledTimes(1);
  expect(container!.querySelector("[data-magnetic-lasso]")?.getAttribute("data-magnetic-lasso")).toBe("draft");
  expect(container!.textContent).toContain("候选 10, 10, 30, 30");
  expect(button("确认").disabled).toBe(false);

  // 锚点不足：拒绝并禁用确认，不提交上一份成功候选。
  const textarea = container!.querySelector("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "1,1");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button("重新追踪").click());
  expect(button("确认").disabled).toBe(true);
  act(() => button("确认").click());
  expect(session.commitSelectionDraft).not.toHaveBeenCalled();
  expect(active).toBe(true);
});

it("多边形套索模式把锚点当边界提交，不做边缘追踪", () => {
  const begin = vi.fn((_params: Record<string, unknown>) => ok({ bounds: [2, 2, 38, 28], outline: [], invalid: false }));
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginMagneticLasso: begin,
    updateMagneticLasso: vi.fn(() => ok({})),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  const polygon = Array.from(container!.querySelectorAll('input[type="checkbox"]')).find((entry) => entry.parentElement?.textContent?.includes("多边形套索"))! as HTMLInputElement;
  act(() => polygon.click());
  expect(polygon.checked).toBe(true);
  expect(container!.textContent).toContain("多边形套索");
  act(() => button("预览多边形").click());
  expect(begin).toHaveBeenCalledTimes(1);
  const params = begin.mock.calls[0]![0];
  expect(params).toMatchObject({ trace: false });
  expect(params).not.toHaveProperty("width");
  expect(session.commitSelectionDraft).not.toHaveBeenCalled();
});

it("回退锚点按新序列重新追踪；闭合完成追踪后一次确认", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginMagneticLasso: vi.fn(() => ok({ bounds: [10, 10, 30, 30], outline: [], invalid: false })),
    updateMagneticLasso: vi.fn(() => ok({ bounds: [10, 10, 20, 20], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  const anchors = () => (container!.querySelector("textarea") as HTMLTextAreaElement).value;
  expect(anchors().split("\n")).toHaveLength(4);

  // 回退最后一个锚点：仍可闭合，因此直接按新序列重新追踪。
  act(() => button("回退锚点").click());
  expect(anchors().split("\n")).toHaveLength(3);
  expect(session.beginMagneticLasso).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("候选 10, 10, 30, 30");

  // 回退到不足三个：标记不可确认，但保留已有草稿不取消。
  act(() => button("回退锚点").click());
  expect(anchors().split("\n")).toHaveLength(2);
  expect(session.cancelSelectionDraft).not.toHaveBeenCalled();
  expect(container!.textContent).toContain("锚点不足三个");
  expect(button("确认").disabled).toBe(true);

  // 闭合完成：补齐后追踪并提交一次。
  act(() => {
    const textarea = container!.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "10,10\n40,10\n40,40");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button("闭合完成").click());
  expect(session.updateMagneticLasso).toHaveBeenCalledTimes(1);
  expect(session.commitSelectionDraft).toHaveBeenCalledTimes(1);
  expect(container!.querySelector("[data-magnetic-lasso]")?.getAttribute("data-magnetic-lasso")).toBe("idle");
});

it("重挂载后认领内核里已有的同类草稿，不再 begin 撞统一门禁", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: true, kind: "magnetic", document: 1, revision: 4, bounds: [2, 3, 4, 5], maskBounds: null, invalid: false })),
    beginMagneticLasso: vi.fn(() => ok({})),
    updateMagneticLasso: vi.fn(() => ok({})),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  expect(container!.querySelector("[data-magnetic-lasso]")?.getAttribute("data-magnetic-lasso")).toBe("draft");
  expect(button("确认").disabled).toBe(false);
  // 其它种类草稿不属于本面板，不能抢确认。
  expect(session.beginMagneticLasso).not.toHaveBeenCalled();
});

it("过期归属的草稿只读可取消：不能确认、不能继续追踪", () => {
  const session = {
    // 草稿还在，但 `stale` 说明它属于别的活动文档（切标签/父子回写后）。
    draftState: vi.fn(() => ok({ active: true, kind: "magnetic", document: 1, revision: 4, stale: true, bounds: [2, 3, 4, 5], maskBounds: null, invalid: false })),
    beginMagneticLasso: vi.fn(() => ok({})),
    updateMagneticLasso: vi.fn(() => ok({})),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  expect(container!.textContent).toContain("这份草稿属于之前的文档");
  expect(button("确认").disabled).toBe(true);
  // 也不允许用旧锚点再生成一份写进当前文档的候选。
  act(() => button("重新追踪").click());
  expect(session.updateMagneticLasso).not.toHaveBeenCalled();
  expect(session.beginMagneticLasso).not.toHaveBeenCalled();
  // 取消仍然可用：它只丢掉过期现场。
  act(() => button("取消").click());
  expect(session.cancelSelectionDraft).toHaveBeenCalledTimes(1);
});

it("磁性套索把内核追踪出的真实轮廓画出来，而不只是包围盒", () => {
  const outline = [[7, 3, 10, 3], [5, 4, 7, 4], [10, 4, 12, 4]];
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok(outline)),
    beginMagneticLasso: vi.fn(() => ok({ bounds: [3, 3, 28, 22], invalid: false })),
    updateMagneticLasso: vi.fn(() => ok({ bounds: [3, 3, 28, 22], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  // 预览前没有候选，也没有预览图。
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
  act(() => button("预览追踪").click());
  expect(session.draftOutline).toHaveBeenCalled();
  const svg = container!.querySelector("[data-draft-outline]");
  expect(svg?.getAttribute("data-draft-outline")).toBe("3");
  // 段就是内核给的 `[x0,y0,x1,y1]`，不做二次拟合。
  expect(Array.from(svg!.querySelectorAll("line")).map((line) => [
    line.getAttribute("x1"), line.getAttribute("y1"), line.getAttribute("x2"), line.getAttribute("y2")
  ])).toEqual(outline.map((segment) => segment.map(String)));
  // 取消后预览图必须消失，避免留下过期候选。
  act(() => button("取消").click());
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
});

it("轮廓段数过多时只画前 N 段并说明截断，不假装预览是全部", () => {
  const many = Array.from({ length: 700 }, (_, index) => [index % 20, Math.floor(index / 20), (index % 20) + 1, Math.floor(index / 20)]);
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok(many)),
    beginMagneticLasso: vi.fn(() => ok({ bounds: [0, 1, 20, 35], invalid: false })),
    updateMagneticLasso: vi.fn(() => ok({ bounds: [0, 1, 20, 35], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<MagneticLassoPanel controller={fakeController(session)} readonly={false} canvas={{ width: 100, height: 80 }} onChanged={() => undefined} />);
  act(() => button("预览追踪").click());
  // 段数如实上报 700，实际只画 600——过细的选区不把面板拖死，也不谎报"这就是全部"。
  expect(container!.querySelector("[data-draft-outline]")?.getAttribute("data-draft-outline")).toBe("700");
  expect(container!.querySelectorAll("[data-draft-outline] line").length).toBe(600);
  expect(container!.textContent).toContain("轮廓共 700 段，预览只画前 600 段");
});

it("传统分割把候选轮廓画出来（可见可修改的实际 mask，不只给包围盒）", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok([[2, 2, 8, 2], [8, 2, 8, 8]])),
    beginSmartSelect: vi.fn((_kind: string, _params: Record<string, unknown>) => ok({ bounds: [2, 2, 8, 8], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  const allowed = ["select.object", "select.sky", "select.focusArea", "layer.removeBackground"];
  mount(<SmartSelectPanel controller={fakeController(session, allowed)} readonly={false} onChanged={() => undefined} />);
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
  act(() => button("预览候选").click());
  expect(container!.querySelector("[data-draft-outline]")?.getAttribute("data-draft-outline")).toBe("2");
  act(() => button("取消").click());
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
});

it("U21 采样区域与各类参数真的送到内核（不是只摆控件）", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginSmartSelect: vi.fn((_kind: string, _params: Record<string, unknown>) => ok({ bounds: [2, 2, 8, 8], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  const allowed = ["select.object", "select.subject", "select.sky", "select.focusArea", "layer.removeBackground"];
  mount(<SmartSelectPanel controller={fakeController(session, allowed)} readonly={false} onChanged={() => undefined} />);
  const lastParams = () => session.beginSmartSelect.mock.lastCall![1];
  const lastKind = () => session.beginSmartSelect.mock.lastCall![0];
  const section = () => container!.querySelector("[data-smart-select]") as HTMLElement;
  const numberInput = (label: string) => {
    const row = Array.from(section().querySelectorAll("label"))
      .find((entry) => entry.textContent?.startsWith(label)) as HTMLLabelElement | undefined;
    if (!row) throw new Error(`missing label: ${label}`);
    return row.querySelector("input") as HTMLInputElement;
  };
  const selectOf = (label: string) => {
    const row = Array.from(section().querySelectorAll("label"))
      .find((entry) => entry.textContent?.startsWith(label)) as HTMLLabelElement | undefined;
    if (!row) throw new Error(`missing label: ${label}`);
    return row.querySelector("select") as HTMLSelectElement;
  };
  const choose = (element: HTMLSelectElement, value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const setNumber = (element: HTMLInputElement, value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // 文案在"预览候选 / 重新预览"之间切换：取第一个非取消/确认的按钮，避免依赖具体措辞。
  const previewClick = () => act(() => {
    const target = Array.from(section().querySelectorAll("button"))
      .find((entry) => /预览/.test(entry.textContent ?? ""));
    if (!target) throw new Error("missing preview button");
    (target as HTMLButtonElement).click();
  });

  // 1) 对象选择：取样点
  setNumber(numberInput("取样点 X"), "12");
  setNumber(numberInput("取样点 Y"), "20");
  previewClick();
  expect(lastKind()).toBe("object");
  expect(lastParams()).toMatchObject({ point: [12, 20], mode: "replace", sampleAllLayers: true });
  expect(lastParams()).not.toHaveProperty("rect");
  // 已在候选状态：改参数后直接"更新预览"就必须生效，不能要求先取消。
  expect(section().textContent).toContain("更新预览");
  expect(numberInput("取样点 X").disabled).toBe(false);

  // 2) 对象选择：矩形采样区域（上游两种都收，结果不同）
  choose(selectOf("采样区域"), "rect");
  setNumber(numberInput("区域 X"), "5");
  setNumber(numberInput("区域 Y"), "6");
  setNumber(numberInput("区域宽"), "30");
  setNumber(numberInput("区域高"), "40");
  previewClick();
  expect(lastParams()).toMatchObject({ rect: [5, 6, 30, 40] });
  // 重算前必须先丢掉旧候选，否则统一草稿门禁会拒绝第二次 begin。
  expect(session.cancelSelectionDraft).toHaveBeenCalled();
  expect(lastParams()).not.toHaveProperty("point");
  // 采样层可关：对象默认采样所有层，关掉后必须随之改变。
  act(() => (Array.from(section().querySelectorAll("label"))
    .find((entry) => entry.textContent?.includes("采样所有可见层"))!
    .querySelector("input") as HTMLInputElement).click());
  previewClick();
  expect(lastParams()).toMatchObject({ sampleAllLayers: false });
  // 3) 天空：阈值与软化
  choose(selectOf("方式"), "sky");
  setNumber(numberInput("阈值"), "80");
  setNumber(numberInput("软化"), "20");
  previewClick();
  expect(lastKind()).toBe("sky");
  expect(lastParams()).toMatchObject({ threshold: 80, softness: 20 });
  expect(lastParams()).not.toHaveProperty("point");
  // 4) 焦点区域：range / noise（此前完全没有暴露，等于拿不到这两个参数）
  choose(selectOf("方式"), "focusArea");
  setNumber(numberInput("范围"), "0.25");
  setNumber(numberInput("噪点"), "0.5");
  previewClick();
  expect(lastKind()).toBe("focusArea");
  expect(lastParams()).toMatchObject({ range: 0.25, noise: 0.5 });
  // 5) 移除背景：采样层由上游固定为当前层（面板不给选项），且不要求输出目标
  choose(selectOf("方式"), "removeBackground");
  expect(section().textContent).not.toContain("采样所有可见层");
  previewClick();
  expect(lastKind()).toBe("removeBackground");
  expect(lastParams()).toMatchObject({ sampleAllLayers: false, refine: true });
  expect(lastParams()).not.toHaveProperty("output");
});

it("U21 切到非对象种类后不再携带矩形采样区域", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginSmartSelect: vi.fn((_kind: string, _params: Record<string, unknown>) => ok({ bounds: [2, 2, 8, 8], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  const allowed = ["select.object", "select.sky", "select.focusArea"];
  mount(<SmartSelectPanel controller={fakeController(session, allowed)} readonly={false} onChanged={() => undefined} />);
  const section = () => container!.querySelector("[data-smart-select]") as HTMLElement;
  const selectOf = (label: string) => {
    const row = Array.from(section().querySelectorAll("label"))
      .find((entry) => entry.textContent?.startsWith(label)) as HTMLLabelElement;
    return row.querySelector("select") as HTMLSelectElement;
  };
  const choose = (element: HTMLSelectElement, value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const previewClick = () => act(() => {
    const target = Array.from(section().querySelectorAll("button"))
      .find((entry) => /预览/.test(entry.textContent ?? ""));
    if (!target) throw new Error("missing preview button");
    (target as HTMLButtonElement).click();
  });
  choose(selectOf("采样区域"), "rect");
  // 切走后"采样区域"控件消失，不能残留 rect 让内核按旧矩形分割。
  choose(selectOf("方式"), "sky");
  expect(section().textContent).not.toContain("采样区域");
  previewClick();
  expect(session.beginSmartSelect.mock.lastCall![1]).not.toHaveProperty("rect");
});

it("传统分割只列出运行时真正允许的种类：入口跟随能力表，不硬编码版本支持面", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginSmartSelect: vi.fn(() => ok({ bounds: [0, 0, 4, 4], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  // 用"主体"当被关闭的样本：它如今默认开放，所以这里刻意只喂不含它的命令表。
  const allowedWithoutSubject = ["select.object", "select.sky", "select.focusArea", "layer.removeBackground"];
  mount(<SmartSelectPanel controller={fakeController(session, allowedWithoutSubject)} readonly={false} onChanged={() => undefined} />);
  // 只取"方式"这一个下拉：面板里还有组合模式与输出两个 select。
  const kinds = () => Array.from(
    container!.querySelector("[data-smart-select] select")!.querySelectorAll("option")
  ).map((option) => (option as HTMLOptionElement).value);
  // 不渲染"能点但一定失败"的入口。
  expect(kinds()).not.toContain("subject");
  expect(kinds()).toEqual(["object", "sky", "focusArea", "removeBackground"]);
  unmount();

  // 能力门打开后同一面板自动多出"主体"，无需再改 UI（U21 交付后的真实状态）。
  mount(<SmartSelectPanel controller={fakeController(session, [...allowedWithoutSubject, "select.subject"])} readonly={false} onChanged={() => undefined} />);
  expect(kinds()).toContain("subject");
});

/**
 * 有状态的快速蒙版会话替身：`draftState()` 反映真实进出，而不是恒为 `active:false`。
 *
 * 面板现在每次渲染都按内核真值显示（Q 键路径进入后也要立刻反映），假会话必须同样有状态，
 * 否则测的就不是"面板跟随草稿"这件事。
 */
function quickMaskSession(options: { startActive?: boolean; overlay?: unknown } = {}) {
  let active = options.startActive ?? false;
  let strokes = 0;
  return {
    isActive: () => active,
    draftState: vi.fn(() => ok(active
      ? { active: true, kind: "quickMask", document: 1, revision: 1, stale: false,
          draft: { strokes, quickMask: true, ...(options.overlay ? { overlay: options.overlay } : {}) } }
      : { active: false })),
    beginQuickMask: vi.fn(() => { active = true; strokes = 0; return ok({ quickMask: true }); }),
    paintQuickMask: vi.fn((_params: Record<string, unknown>) => { strokes += 1; return ok({ strokes, quickMask: true }); }),
    exitQuickMask: vi.fn((_cancel: boolean) => { active = false; strokes = 0; return ok({}); })
  };
}

it("快速蒙版退出与取消分别走转选区与恢复基线", () => {
  const session = quickMaskSession();
  mount(<QuickMaskPanel controller={fakeController(session)} readonly={false} onChanged={() => undefined} />);
  act(() => button("进入快速蒙版").click());
  expect(session.beginQuickMask).toHaveBeenCalledTimes(1);
  act(() => button("画入临时通道").click());
  expect(session.paintQuickMask).toHaveBeenCalledTimes(1);
  // 笔数取内核报的真值（每画一次 +1），不是面板自己累加的本地计数。
  expect(container!.textContent).toContain("临时笔迹 1 笔");
  act(() => button("退出并转为选区").click());
  expect(session.exitQuickMask).toHaveBeenLastCalledWith(false);
});

it("按颜色扩大也把真实候选轮廓画出来（Grow 与 Similar 的差别在形状上）", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok([[2, 2, 6, 2], [6, 2, 6, 6]])),
    beginColorGrow: vi.fn((_similar: boolean, _params: Record<string, unknown>) => ok({ bounds: [2, 2, 6, 6], invalid: false })),
    updateColorGrow: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [2, 2, 6, 6], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<ColorGrowPanel controller={fakeController(session)} readonly={false} hasSelection onChanged={() => undefined} />);
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
  act(() => button("预览").click());
  expect(container!.querySelector("[data-draft-outline]")?.getAttribute("data-draft-outline")).toBe("2");
  // 取消后不留过期候选图。
  act(() => button("取消").click());
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
  expect(session.cancelSelectionDraft).toHaveBeenCalledTimes(1);
});

it("色彩范围与选择并遮住也把真实候选轮廓画出来（不只给包围盒）", () => {
  const colorRange = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok([[0, 0, 4, 0], [4, 0, 4, 4]])),
    beginColorRange: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 4, 4], invalid: false })),
    updateColorRange: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 4, 4], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<ColorRangeSamplesPanel controller={fakeController(colorRange)} readonly={false} onChanged={() => undefined} />);
  expect(container!.querySelector("[data-draft-outline]")).toBeNull();
  act(() => {
    const select = container!.querySelector("select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "reds");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button("预览").click());
  expect(container!.querySelector("[data-draft-outline]")?.getAttribute("data-draft-outline")).toBe("2");
  unmount();

  const refine = {
    draftState: vi.fn(() => ok({ active: false })),
    draftOutline: vi.fn(() => ok([[1, 1, 3, 1]])),
    beginRefineEdge: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [1, 1, 3, 3], invalid: false })),
    updateRefineEdge: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [1, 1, 3, 3], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<RefineEdgeWorkspace controller={fakeController(refine)} readonly={false} hasSelection onChanged={() => undefined} />);
  act(() => button("预览边缘").click());
  expect(container!.querySelector("[data-draft-outline]")?.getAttribute("data-draft-outline")).toBe("1");
});

it("快速蒙版把内核真实的覆盖色/不透明度/着色侧显示出来（覆盖色查看）", () => {
  const session = quickMaskSession({ startActive: true, overlay: { color: "#ff0000", opacity: 0.5, indicates: "maskedAreas" } });
  mount(<QuickMaskPanel controller={fakeController(session)} readonly={false} onChanged={() => undefined} />);
  // 已在内核里打开的草稿重挂载后必须显示它的真实叠色，而不是等用户再点一次进入。
  const hint = container!.querySelector("[data-quick-mask-overlay]");
  expect(hint?.getAttribute("data-quick-mask-overlay")).toBe("#ff0000");
  expect(hint?.textContent).toContain("着色遮住的一侧");
  expect(hint?.textContent).toContain("50%");
  // 退出后不再显示过期叠色。
  act(() => button("退出并转为选区").click());
  expect(container!.querySelector("[data-quick-mask-overlay]")).toBeNull();
});

it("Q 键（外界）进入快速蒙版后，面板下一次渲染就跟随同一草稿", () => {
  const session = quickMaskSession();
  const controller = fakeController(session);
  // 父级重渲染（外壳在预览刷新时会这样）用新的元素引用，与真实装配一致。
  const render = () => act(() => root!.render(
    <QuickMaskPanel controller={controller} readonly={false} onChanged={() => undefined} />
  ));
  mount(<QuickMaskPanel controller={controller} readonly={false} onChanged={() => undefined} />);
  expect(container!.querySelector("[data-quick-mask]")?.getAttribute("data-quick-mask")).toBe("idle");
  // 快捷键走的是同一域会话，不经过面板：面板不能只有挂载时读一次草稿。
  act(() => { session.beginQuickMask(); });
  render();
  expect(container!.querySelector("[data-quick-mask]")?.getAttribute("data-quick-mask")).toBe("active");
  // 再按一次 Q 是"确认退出"，面板要跟着回到 idle，而不是停留在 active 让用户再点一次。
  act(() => { session.exitQuickMask(false); });
  render();
  expect(container!.querySelector("[data-quick-mask]")?.getAttribute("data-quick-mask")).toBe("idle");
});

it("快速蒙版只给黑白两档笔迹，并把选中的那一档交给内核", () => {
  const session = quickMaskSession();
  mount(<QuickMaskPanel controller={fakeController(session)} readonly={false} onChanged={() => undefined} />);
  act(() => button("进入快速蒙版").click());
  const select = container!.querySelector("[data-quick-mask] select") as HTMLSelectElement;
  // U20 要求"临时黑白画笔"：不是任意颜色选择器，只有黑/白两档。
  expect(Array.from(select.options).map((option) => option.value)).toEqual(["#ffffff", "#000000"]);
  expect(select.value).toBe("#ffffff");
  act(() => button("画入临时通道").click());
  expect(session.paintQuickMask.mock.lastCall![0]).toMatchObject({ color: "#ffffff", target: "quickMask" });

  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "#000000");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button("画入临时通道").click());
  expect(session.paintQuickMask.mock.lastCall![0]).toMatchObject({ color: "#000000" });
});

it("选择并遮住把修边笔迹并入预览参数，取消恢复基线", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginRefineEdge: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    updateRefineEdge: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<RefineEdgeWorkspace controller={fakeController(session)} readonly={false} hasSelection onChanged={() => undefined} />);
  act(() => button("预览边缘").click());
  expect(session.beginRefineEdge).toHaveBeenCalledTimes(1);
  const first = session.beginRefineEdge.mock.calls[0]![0];
  expect(first).toMatchObject({ smartRadius: true, output: "selection" });
  act(() => button("前景修边笔").click());
  expect(session.updateRefineEdge).toHaveBeenCalledTimes(1);
  const second = session.updateRefineEdge.mock.calls[0]![0];
  expect(second.refineStrokes).toEqual([{ points: [[0, 0]], mode: "add", size: 20 }]);
  act(() => button("取消").click());
  expect(session.cancelSelectionDraft).toHaveBeenCalledTimes(1);
});

it("U23 勾选净化颜色时如实提示输出被升级，并把 decontaminate/amount 送进内核", () => {
  // 上游 `refine_edge`：净化颜色要新像素，会把 selection / layerMask 改成 newLayerWithMask。
  // 面板若不提示，用户选了"选区"却得到新图层 + 空选区，会以为输出设置没生效。
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginRefineEdge: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    updateRefineEdge: vi.fn(() => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<RefineEdgeWorkspace controller={fakeController(session)} readonly={false} hasSelection onChanged={() => undefined} />);
  const section = () => container!.querySelector("[data-refine-workspace]") as HTMLElement;
  // 默认：选区输出、未开净化 → 不提示升级。
  expect(section().getAttribute("data-refine-workspace")).toBe("selection");
  expect(container!.querySelector("[data-refine-output-upgraded]")).toBeNull();

  const decon = Array.from(container!.querySelectorAll("label"))
    .find((label) => label.textContent?.includes("净化颜色"))!.querySelector("input")!;
  act(() => decon.click());
  // 提示必须点名真实输出（新图层含蒙版），而不是含糊地说"输出会变"。
  const hint = container!.querySelector("[data-refine-output-upgraded]") as HTMLElement;
  expect(hint.getAttribute("data-refine-output-upgraded")).toBe("newLayerWithMask");
  expect(hint.textContent).toContain("新图层（含蒙版）");
  expect(hint.textContent).toContain("选区");
  // 下拉框仍是用户所选（不偷偷改控件）。
  expect(section().getAttribute("data-refine-workspace")).toBe("selection");

  act(() => button("预览边缘").click());
  // 面板只如实转发用户所选输出 + 净化开关；升级由内核完成，不在前端伪造。
  expect(session.beginRefineEdge.mock.calls[0]![0]).toMatchObject({ output: "selection", decontaminate: true, amount: 100 });
});

it("旧运行时缺本域入口时整块不渲染，而不是渲染出点了会崩的面板", () => {
  // design D11：测试替身/旧宿主可能只装配部分能力。面板必须做存在性检查后**不渲染**，
  // 不能先画出来再在点击时抛 `not a function`。这里逐块验证"缺一个入口就整块消失"。
  const partial = { draftState: vi.fn(() => ok({ active: false })) };
  const perPanel: [string, React.ReactElement][] = [
    ["U17", <LineSelectionPanel controller={fakeController(partial)} readonly={false} canvas={{ width: 40, height: 30 }} onChanged={() => undefined} />],
    ["U18", <MagneticLassoPanel controller={fakeController(partial)} readonly={false} canvas={{ width: 40, height: 30 }} onChanged={() => undefined} />],
    ["U19", <NamedSelectionPanel controller={fakeController(partial)} readonly={false} hasSelection onChanged={() => undefined} />],
    ["U19", <ColorGrowPanel controller={fakeController(partial)} readonly={false} hasSelection onChanged={() => undefined} />],
    ["U20", <QuickMaskPanel controller={fakeController(partial)} readonly={false} onChanged={() => undefined} />],
    ["U21", <SmartSelectPanel controller={fakeController(partial)} readonly={false} onChanged={() => undefined} />],
    ["U22", <ColorRangeSamplesPanel controller={fakeController(partial)} readonly={false} onChanged={() => undefined} />],
    ["U23", <RefineEdgeWorkspace controller={fakeController(partial)} readonly={false} hasSelection onChanged={() => undefined} />]
  ];
  for (const [id, element] of perPanel) {
    const host = mount(element);
    expect(host.textContent, id).toBe("");
    unmount();
  }
  // 完全没有 features.selections 时同样不渲染（不是抛错）。
  const bare = { snapshot: () => ({ view: { hasDocument: true }, commands: new Map() }) } as unknown as EditorWorkspaceController;
  const host = mount(<LineSelectionPanel controller={bare} readonly={false} canvas={{ width: 40, height: 30 }} onChanged={() => undefined} />);
  expect(host.textContent).toBe("");
});

it("蒙版属性区分「目标图层已删除」与「没有蒙版」，不把拒绝说成空状态", () => {
  // 目标层被删掉时内核拒绝读取；面板必须显示原因，而不是渲染成"当前图层没有像素蒙版"。
  const deleted = {
    layerMaskProperties: vi.fn(() => ({ ok: false as const, code: "command-failed", message: "命令 layer.layerMask.edit 被拒绝：目标图层已不存在" })),
    editLayerMask: vi.fn(() => ok({})),
    viewLayerMask: vi.fn(() => ok({}))
  };
  const controller = {
    ...fakeController(deleted),
    dispatch: vi.fn(() => ok(null))
  } as unknown as EditorWorkspaceController;
  mount(<LayerMaskPanel controller={controller} readonly={false} layer={7} onChanged={() => undefined} />);
  expect(container!.textContent).toContain("目标图层已不存在");
  expect(container!.textContent).not.toContain("当前图层没有像素蒙版");

  // 正常但无蒙版：走空状态文案，不带错误。
  const empty = {
    layerMaskProperties: vi.fn(() => ok({
    channelTarget: { kind: "composite" },
 layer: 7, mask: null, view: null, editTarget: "pixels" })),
    editLayerMask: vi.fn(() => ok({})),
    viewLayerMask: vi.fn(() => ok({}))
  };
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  const plain = { ...fakeController(empty), dispatch: vi.fn(() => ok(null)) } as unknown as EditorWorkspaceController;
  mount(<LayerMaskPanel controller={plain} readonly={false} layer={7} onChanged={() => undefined} />);
  expect(container!.textContent).toContain("当前图层没有像素蒙版");
});

it("色彩范围的色调区间只在高光/中间调/阴影出现，并按预设编译成对应 tonalRange", () => {
  const session = {
    draftState: vi.fn(() => ok({ active: false })),
    beginColorRange: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 10, 10], invalid: false })),
    updateColorRange: vi.fn((_params: Record<string, unknown>) => ok({ bounds: [0, 0, 10, 10], invalid: false })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true }))
  };
  mount(<ColorRangeSamplesPanel controller={fakeController(session)} readonly={false} onChanged={() => undefined} />);

  const preset = () => container!.querySelector("select")!;
  const choose = (value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(preset(), value);
    preset().dispatchEvent(new Event("change", { bubbles: true }));
  });

  // 「红色」这类色相预设没有色调区间：不渲染控件，也不上交 tonalRange。
  choose("reds");
  expect(container!.querySelector("[data-color-range-tonal]")).toBeNull();
  act(() => button("预览").click());
  expect(session.beginColorRange).toHaveBeenCalledTimes(1);
  expect(session.beginColorRange.mock.calls[0]![0]).not.toHaveProperty("tonalRange");

  // 阴影：单电平控件，提交数字而不是数组。首次预览后会话已 active，走 update。
  choose("shadows");
  expect(container!.querySelector("[data-color-range-tonal]")?.getAttribute("data-color-range-tonal")).toBe("shadows");
  act(() => button("更新预览").click());
  expect(session.updateColorRange.mock.lastCall![0]).toEqual(expect.objectContaining({ select: "shadows", tonalRange: 65 }));

  // 中间调：区间控件，提交 [low, high]。
  choose("midtones");
  expect(container!.querySelector("[data-color-range-tonal]")?.getAttribute("data-color-range-tonal")).toBe("midtones");
  act(() => button("更新预览").click());
  expect(session.updateColorRange.mock.lastCall![0]).toEqual(expect.objectContaining({ select: "midtones", tonalRange: [105, 150] }));
});
