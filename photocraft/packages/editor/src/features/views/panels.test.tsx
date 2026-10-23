/** @vitest-environment jsdom */
// 只验证面板读取内核数据、按端口可用性渲染与失败提示；不采集像素或截图。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { ViewWorkspacePanel } from "./panels.js";
import { activePlacement, consumePlacement, resetPlacementForTests } from "./placement.js";
import { publishHover, resetHoverForTests } from "./hover.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); resetPlacementForTests(); resetHoverForTests(); });

const aids = {
  rulers: false, grid: true, gridStep: [18, 18], gridSubdivisions: 2, guides: true, lockGuides: false,
  smartGuides: true, snap: { document: true, guides: true, grid: false, layers: true, selection: false },
  suspend: false, units: "px", rotation: 0, navigator: false, sideBySide: false, activeView: "view-1",
  views: [{ id: "view-1", label: "视图 1", zoom: 1, offset: [0, 0], rotation: 0, active: true }], maxViews: 4,
};

const snapshot = {
  // 文档身份是可选的（旧运行时没有它）：默认夹具不带，专门用例在下面单独验证守卫回传。
  scope: { view: "session", guides: "document", rulerOrigin: "document", samplers: "session+project", count: "document", notes: "document" },
  guides: {
 horizontal: [], vertical: [30], colors: [], visible: true, locked: false },
  rulerOrigin: [4, 6], units: "px",
  unitOptions: ["px", "in", "cm", "mm", "pt", "pc", "%"],
  snapTargets: ["document", "guides", "grid", "layers", "selection"], maxViews: 4,
  documentSize: [120, 90], rotation: 0,
  transform: { zoom: 1, offset: [0, 0], rotation: 0, valid: true },
  projected: { origin: [0, 0], center: [60, 45] },
  samplers: [{ index: 0, position: [10, 20] }],
  measurement: {
    scale: { pixelLength: 1, logicalLength: 1, units: "pixels", describe: "1 pixels = 1.0000 pixels" },
    ruler: null,
    count: { total: 2, activeGroup: 0, groups: [{ name: "瑕疵", color: [1, 0, 0], markerSize: 1, labelSize: 8, visible: true, count: 2, points: [[1, 2], [3, 4]] }] },
    logRows: 1,
  },
  notes: [{ index: 0, author: "美术", text: "补光", color: [1, 1, 0.51], position: [4, 5], open: true }],
};

function makeController(features: { views?: Record<string, unknown> } = {}, extra: Record<string, unknown> = {}) {
  return {
    viewAids: vi.fn(() => ({ ok: true, value: aids })),
    setViewAids: vi.fn((patch: Record<string, unknown>) => ({
      ok: true,
      // 模拟真实内核：吸附目标逐键保持，缩放/平移/旋转落到**活动视图**上，然后整体回传。
      value: {
        ...aids, ...patch,
        snap: patch.snap ? { ...aids.snap, ...(patch.snap as object) } : aids.snap,
        views: aids.views.map((view) => view.active ? {
          ...view,
          ...(typeof patch.zoom === "number" ? { zoom: patch.zoom } : {}),
          ...(Array.isArray(patch.offset) ? { offset: patch.offset } : {}),
          ...(typeof patch.rotation === "number" ? { rotation: patch.rotation } : {}),
        } : view),
      },
    })),
    guideCommand: vi.fn(() => ({ ok: true, value: {} })),
    snapPoint: vi.fn(() => ({ ok: true, value: { point: [0, 0], lines: [] } })),
    features: { views: features.views },
    ...extra,
  } as unknown as EditorWorkspaceController;
}

function viewsPort(overrides: Record<string, unknown> = {}) {
  return {
    viewSnapshot: vi.fn(() => ({ ok: true, value: snapshot })),
    viewCommand: vi.fn(() => ({ ok: true, value: {} })),
    viewRead: vi.fn((id: string) => id === "view.colorSamplers.list"
      ? { ok: true, value: { max: 10, samplers: [{ index: 0, number: 1, position: [10, 20], rgb: [12, 34, 56], cmyk: [0, 0, 0, 100] }] } }
      : id === "measurementLog.export"
        ? { ok: true, value: { csv: "id,L,units\n7,12,mm\n", rows: 1 } }
        : { ok: true, value: { rows: [{ id: 7, values: { L: 12, units: "mm" } }], columns: ["L", "units"] } }),
    guideLayoutCommand: vi.fn(() => ({ ok: true, value: {} })),
    ...overrides,
  };
}

function render(controller: EditorWorkspaceController, readonly = false) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ViewWorkspacePanel controller={controller} readonly={readonly} revision={3} onChanged={vi.fn()} />));
  return container;
}

const click = (element: Element) => act(() => (element as HTMLElement).click());
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);

/** 面板调用过的只读命令 id（`viewRead` 的第一个参数）。 */
function viewsReadIds(controller: EditorWorkspaceController): string[] {
  const views = controller.features?.views as { viewRead?: { mock?: { calls: unknown[][] } } } | undefined;
  return (views?.viewRead?.mock?.calls ?? []).map((call) => String(call[0]));
}

describe("视图与分析面板只渲染内核数据", () => {
  it("辅助页显示吸附开关并写回会话偏好", () => {
    const controller = makeController();
    const container = render(controller);
    expect(container.querySelector('[data-view-aids="true"]')).not.toBeNull();
    const grid = container.querySelector<HTMLInputElement>('[data-view-aids="true"] input[type="checkbox"]:nth-of-type(1)');
    expect(grid).not.toBeNull();
    const rulers = [...container.querySelectorAll('input[type="checkbox"]')][0] as HTMLInputElement;
    click(rulers);
    expect(controller.setViewAids).toHaveBeenCalledWith({ rulers: true });
  });

  it("参考线页逐条列出内核位置，并按索引删除", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "参考线")!);
    const list = container.querySelector('[data-guide-list="vertical"]')!;
    expect(list.textContent).toContain("V1");
    expect(list.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("30");
    click(button(list as HTMLElement, "删除")!);
    expect(controller.guideCommand).toHaveBeenCalledWith("view.deleteGuide", { orientation: "vertical", index: 0 });
  });

  it("参考线数值编辑走失焦提交并合并成一步历史", () => {
    const views = viewsPort();
    let moved = 30;
    views.viewSnapshot = vi.fn(() => ({ ok: true, value: { ...snapshot, guides: { ...snapshot.guides, vertical: [moved] } } }));
    const controller = makeController({ views });
    (controller.guideCommand as ReturnType<typeof vi.fn>).mockImplementation((_id: string, params: { position?: number }) => {
      if (params?.position !== undefined) moved = params.position;
      return { ok: true, value: {} };
    });
    const container = render(controller);
    click(button(container, "参考线")!);
    const input = container.querySelector<HTMLInputElement>('[data-guide-list="vertical"] input[type="number"]')!;
    // 逐键输入不立刻写文档：中间态不是一次有效编辑。
    type(input, "4");
    type(input, "45");
    expect(controller.guideCommand).not.toHaveBeenCalled();
    blur(input);
    expect(controller.guideCommand).toHaveBeenCalledOnce();
    expect(controller.guideCommand).toHaveBeenCalledWith("view.moveGuide", {
      orientation: "vertical", index: 0, position: 45, coalesce: "view.moveGuide:vertical:0",
    });
    // 值没变（快照已回到 45）不产生多余历史。
    blur(input);
    expect(controller.guideCommand).toHaveBeenCalledOnce();
  });

  it("Info 页读数来自取样点与测量日志，不自己算像素", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    const readout = container.querySelector('[data-analysis-readout="true"]')!;
    expect(readout.textContent).toContain("120 × 90");
    expect(readout.textContent).toContain("1 pixels = 1.0000 pixels");
    const samplers = container.querySelector('[data-sampler-list="true"]')!;
    expect(samplers.textContent).toContain("12, 34, 56");
    const log = container.querySelector('[data-measurement-log="true"]')!;
    expect(log.textContent).toContain("L: 12");
  });

  it("计数与注释页显示文档数据并保留只读禁用", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller, true);
    click(button(container, "计数")!);
    expect(container.querySelector('[data-count-groups="true"]')!.textContent).toContain("瑕疵");
    expect(button(container, "添加标记")!.hasAttribute("disabled")).toBe(true);
    click(button(container, "注释")!);
    expect(container.querySelector('[data-note-list="true"]')!.textContent).toContain("补光");
    expect(button(container, "添加注释")!.hasAttribute("disabled")).toBe(true);
  });

  it("缺少本域写入口时隐藏可写控件而不是渲染假入口", () => {
    const controller = makeController({}, { guideCommand: undefined });
    const container = render(controller);
    expect(container.querySelector('[data-guide-editor="true"]')).toBeNull();
    click(button(container, "计数")!);
    expect(container.querySelector('[data-count="true"]')).toBeNull();
  });

  it("缺少布局端口时布局页整体不渲染，避免只能看的假入口", () => {
    const controller = makeController({ views: viewsPort({ guideLayoutCommand: undefined }) });
    const container = render(controller);
    click(button(container, "布局")!);
    expect(container.querySelector('[data-guide-layout="true"]')).toBeNull();
  });

  it("布局页把列/行/间距/边距按内核参数形状提交", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "布局")!);
    click(button(container, "生成参考线")!);
    expect(controller.features.views.guideLayoutCommand).toHaveBeenCalledWith("view.newGuideLayout", {
      columns: 2,
      rows: 2,
      width: 0,
      height: 0,
      gutter: 10,
      rowGutter: 10,
      margin: [0, 0, 0, 0],
      clearExisting: false,
      centerColumns: false,
    });
  });

  it("内核快照不可用时仍可用会话偏好，并明确提示缺少读数", () => {
    const controller = makeController({
      views: viewsPort({ viewSnapshot: vi.fn(() => ({ ok: false, code: "command-failed", message: "内核状态不可用" })) }),
    });
    const container = render(controller);
    click(button(container, "导航")!);
    // 导航页的数据来自视图辅助（会话），快照缺失不影响旋转与多视图。
    const navigation = container.querySelector('[data-view-navigation="true"]')!;
    expect(navigation.textContent).toContain("视图 1");
    expect(navigation.textContent).toContain("当前旋转 0°");
    click(button(container, "Info")!);
    expect(container.querySelector('[data-analysis="true"]')!.textContent).toContain("打开文档后显示读数");
  });
});

/** 触发一个受控输入的值变更（React 需要 setter 而不是直接改 value）。 */
function type(element: Element, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 失焦提交（参考线/标记尺寸/注释写回都合并成一步历史，只在失焦或回车时落盘）。 */
function blur(element: Element) {
  // React 18 把 `onBlur` 代理到 `focusout`，只派发 `blur` 不会触发提交。
  act(() => { element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
}

describe("U71 单位、细分与吸附目标逐项写回", () => {
  it("单位下拉、细分数量与每个吸附开关各自成为一次会话偏好写入", () => {
    const controller = makeController();
    const container = render(controller);
    const units = container.querySelector<HTMLSelectElement>('[data-view-aids="true"] select')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(units, "mm");
      units.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(controller.setViewAids).toHaveBeenCalledWith({ units: "mm" });

    const subdivision = container.querySelector<HTMLInputElement>('[data-view-aids="true"] input[type="number"]')!;
    type(subdivision, "4");
    expect(controller.setViewAids).toHaveBeenCalledWith({ gridSubdivisions: 4 });

    // 五个吸附目标是独立的键，界面不能合成一个开关。
    const snapCheckbox = (text: string) => {
      const label = [...container.querySelectorAll('[data-view-aids="true"] label')]
        .find((entry) => entry.textContent?.includes(text))!;
      return label.querySelector("input")!;
    };
    click(snapCheckbox("网格吸附"));
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ snap: { grid: true } });
    // 已勾选的目标准确写回 false，而不是重复提交 true。
    click(snapCheckbox("文档吸附"));
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ snap: { document: false } });
    click(snapCheckbox("选区吸附"));
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ snap: { selection: true } });
    click(snapCheckbox("智能参考线"));
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ smartGuides: false });
  });
});

describe("U73 取样、测量、计数与注释的真实写入参数", () => {
  it("取样点按坐标增删，走统一写入口而不是只读列表", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    const numbers = [...container.querySelectorAll<HTMLInputElement>('[data-analysis="true"] input[type="number"]')];
    type(numbers[0]!, "30");
    type(numbers[1]!, "40");
    click(button(container, "添加取样点")!);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("view.colorSamplers.add", { x: 30, y: 40 });
    click(button(container, "删除")!);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("view.colorSamplers.delete", { index: 0 });
  });

  it("标尺测量提交起终点，记录与删除走文档命令", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    const numbers = [...container.querySelectorAll<HTMLInputElement>('[data-analysis="true"] input[type="number"]')];
    // 取样 X/Y、像素长度、逻辑长度之后是起点 X/Y 与终点 X/Y。
    type(numbers[4]!, "12");
    type(numbers[5]!, "34");
    click(button(container, "测量")!);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("image.analysis.rulerTool", {
      start: [12, 34],
      end: [0, 0],
    });
    click(button(container, "记录测量")!);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("image.analysis.recordMeasurements", { source: "ruler" });
    // 取样点行也有「删除」，这里只点测量日志那一行。
    const logRow = container.querySelector('[data-measurement-log="true"] li')!;
    click(button(logRow as HTMLElement, "删除")!);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("measurementLog.delete", { rows: [7] });
  });

  it("计数分组支持改名之外的显示/尺寸/设为当前/删组", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "计数")!);
    const row = container.querySelector('[data-count-groups="true"] li')!;
    click(row.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.setGroup", { group: 0, visible: false });
    type(row.querySelector<HTMLInputElement>('input[type="number"]')!, "3");
    blur(row.querySelector<HTMLInputElement>('input[type="number"]')!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.setGroup", {
      group: 0, markerSize: 3, coalesce: "count.setGroup:0:markerSize",
    });
    click(button(container, "设为当前")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.setGroup", { group: 0, active: true });
    click(button(container, "删组")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.deleteGroup", { group: 0 });
    click(button(container, "清除全部标记")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.clear", { group: "all" });
  });

  it("注释按作者/文本失焦提交并合并历史，新增后清空文本草稿", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "注释")!);
    const row = container.querySelector('[data-note-list="true"] li')!;
    type(row.querySelector('input')!, "设计");
    expect(controller.features.views.viewCommand).not.toHaveBeenCalled();
    blur(row.querySelector("input")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("notes.set", {
      index: 0, author: "设计", coalesce: "notes.set:0:author",
    });
    type(row.querySelector("textarea")!, "这里偏亮");
    blur(row.querySelector("textarea")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("notes.set", {
      index: 0, text: "这里偏亮", coalesce: "notes.set:0:text",
    });
    const draftText = [...container.querySelectorAll("textarea")].at(-1)!;
    type(draftText, "新注释");
    click(button(container, "添加注释")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("notes.add", { x: 0, y: 0, author: "", text: "新注释" });
    expect(draftText.value).toBe("");
  });

  it("导航页的旋转、视图切换与关闭都只改会话取景", () => {    const controller = makeController();
    const container = render(controller);
    click(button(container, "导航")!);
    type(container.querySelector('[data-view-navigation="true"] input[type="number"]')!, "45");
    click(button(container, "应用旋转")!);
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ rotation: 45 });
    click(button(container, "复位视图")!);
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ rotation: "reset" });
    click(button(container, "新建视图")!);
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ viewAction: "new" });
    // 唯一视图的「关闭」必须禁用：不给自己造一个空视图列表。
    expect(button(container, "关闭")!.hasAttribute("disabled")).toBe(true);
    const navigatorLabel = [...container.querySelectorAll('[data-view-navigation="true"] label')]
      .find((entry) => entry.textContent?.includes("显示 Navigator"))!;
    click(navigatorLabel.querySelector("input")!);
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ navigator: true });
  });

  it("Navigator 没有容器尺寸时只画可视区左上角，不画假取景框", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "导航")!);
    const navigatorLabel = [...container.querySelectorAll('[data-view-navigation="true"] label')]
      .find((entry) => entry.textContent?.includes("显示 Navigator"))!;
    click(navigatorLabel.querySelector("input")!);
    const map = container.querySelector("[data-navigator]")!;
    // 容器尺寸是共享画布的状态，面板拿不到；此时不能画一个「整幅都可见」的框。
    expect(map.querySelector("[data-navigator-frame]")).toBeNull();
    expect(map.querySelector("[data-navigator-origin]")).not.toBeNull();
    expect(map.textContent).toContain("可视区左上角");
  });
});

describe("U70/U73 剩余逐条命令的真实入口", () => {
  it("参考线可以换向（view.editGuide）而不是只能删了重建", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "参考线")!);
    click(button(container.querySelector('[data-guide-list="vertical"]') as HTMLElement, "改水平")!);
    expect(controller.guideCommand).toHaveBeenLastCalledWith("view.editGuide", {
      orientation: "vertical", index: 0, newOrientation: "horizontal", position: 30,
    });
  });

  it("当前分组的标记可移动与逐条删除", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "计数")!);
    const marks = container.querySelector('[data-count-marks="瑕疵"]')!;
    click(button(marks as HTMLElement, "移到草稿点")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.move", {
      index: 0, to: [0, 0],
    });
    click(button(marks as HTMLElement, "删除")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.remove", { index: 0 });
  });

  it("取样点可移动，注释位置可改且失焦合并一步历史", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    click(button(container.querySelector('[data-sampler-list="true"]') as HTMLElement, "移到草稿点")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("view.colorSamplers.move", {
      index: 0, x: 0, y: 0,
    });

    click(button(container, "注释")!);
    const position = container.querySelectorAll<HTMLInputElement>('[data-note-list="true"] li input[type="number"]');
    type(position[0]!, "40");
    blur(position[0]!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("notes.set", {
      index: 0, x: 40, y: 5, coalesce: "notes.set:0:position",
    });
    // 注释放开/收起也是一个可逆的文档字段，不需要重建注释。
    click(button(container, "收起")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("notes.set", { index: 0, open: false });
  });

  it("测量日志可全清并导出真实 CSV 文本", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    click(button(container, "清除测量日志")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("measurementLog.delete", { all: true });
    click(button(container, "导出测量 CSV")!);
    // 不传 path：内核只回文本，写文件是宿主 io 端口的事。
    expect(viewsReadIds(controller)).toContain("measurementLog.export");
    expect(container.querySelector("[data-measurement-csv]")!.textContent).toContain("id,L,units");
  });
});

describe("U70/U73 读数来自内核而不是界面自己算", () => {
  it("参考线颜色读快照、写 view.editGuide；未设色的线用中性默认值", () => {
    const controller = makeController({
      views: viewsPort({
        viewSnapshot: vi.fn(() => ({
          ok: true,
          value: {
            ...snapshot,
            guides: { ...snapshot.guides, vertical: [30, 55], colors: [{ vertical: true, position: 55, rgb: [18, 52, 86] }] },
          },
        })),
      }),
    });
    const container = render(controller);
    click(button(container, "参考线")!);
    const list = container.querySelector('[data-guide-list="vertical"]')!;
    const swatches = [...list.querySelectorAll<HTMLInputElement>("input[type=color]")];
    // 内核只为显式设过色的线存颜色，第二条线读出的就是文档里的值。
    expect(swatches[0]!.value).toBe("#5b9bf3");
    expect(swatches[1]!.value).toBe("#123456");
    type(swatches[1]!, "#ff8800");
    expect(controller.guideCommand).toHaveBeenLastCalledWith("view.editGuide", {
      orientation: "vertical", index: 1, color: "#ff8800", coalesce: "view.editGuide:vertical:1:color",
    });
  });

  it("取样点 CMYK 与画布宽度都来自内核换算端口", () => {
    const controller = makeController({
      views: viewsPort({
        formatLength: vi.fn(() => ({ ok: true, value: { text: "30.48 mm", unit: "mm" } })),
        viewSnapshot: vi.fn(() => ({ ok: true, value: { ...snapshot, units: "mm" } })),
      }),
    });
    const container = render(controller);
    click(button(container, "Info")!);
    const readout = container.querySelector("[data-analysis-readout]")!.textContent!;
    expect(readout).toContain("30.48 mm");
    expect(container.querySelector('[data-sampler-cmyk="0"]')!.textContent).toBe("0/0/0/100");
  });
});

describe("来源失效不误写目标", () => {
  const withDocument = (id: number) => ({
    viewSnapshot: vi.fn(() => ({ ok: true, value: { ...snapshot, document: { id } } })),
  });

  it("快照带文档身份时，参考线/布局写入都回传同一个目标", () => {
    const controller = makeController({ views: viewsPort(withDocument(41)) });
    const container = render(controller);
    click(button(container, "参考线")!);
    click(button(container.querySelector('[data-guide-list="vertical"]') as HTMLElement, "删除")!);
    expect(controller.guideCommand).toHaveBeenLastCalledWith("view.deleteGuide", {
      orientation: "vertical", index: 0, targetDocument: 41,
    });
    click(button(container, "布局")!);
    click(button(container, "生成参考线")!);
    expect(controller.features.views.guideLayoutCommand).toHaveBeenLastCalledWith(
      "view.newGuideLayout",
      expect.objectContaining({ targetDocument: 41 }),
    );
  });

  it("统一写入口与只读命令也带目标，切标签后旧界面不会读到新文档读数", () => {
    const controller = makeController({ views: viewsPort(withDocument(41)) });
    const container = render(controller);
    click(button(container, "计数")!);
    click(button(button(container, "计数")! && container.querySelector('[data-count-marks="瑕疵"]') as HTMLElement, "删除")!);
    expect(controller.features.views.viewCommand).toHaveBeenLastCalledWith("count.remove", {
      index: 0, targetDocument: 41,
    });
    // 只读读数在 Info 页加载；切页后同样必须带目标文档。
    click(button(container, "Info")!);
    const reads = (controller.features.views.viewRead as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // 首次渲染时快照还没回来，界面先用「不参与守卫」的旧路径；快照到达后必须重新带上目标。
    const lastTarget = (id: string) => [...reads].reverse().find((call) => call[0] === id)?.[1];
    expect(lastTarget("view.colorSamplers.list")).toEqual({ targetDocument: 41 });
    expect(lastTarget("measurementLog.list")).toEqual({ targetDocument: 41 });
  });

  it("快照没有身份时不编造 targetDocument（未重建的旧运行时仍可用）", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "参考线")!);
    click(button(container.querySelector('[data-guide-list="vertical"]') as HTMLElement, "删除")!);
    expect(controller.guideCommand).toHaveBeenLastCalledWith("view.deleteGuide", {
      orientation: "vertical", index: 0,
    });
  });
});

describe("U73 Info 光标读数", () => {
  it("画布还没有读数时显示「—」，不留一个看起来像 0 的值", () => {
    const container = render(makeController({ views: viewsPort() }));
    click(button(container, "Info")!);
    const readout = container.querySelector('[data-info-hover="true"]')!;
    expect(readout.textContent).toContain("—");
  });

  it("读数来自发布的那一份（源坐标 + RGB/CMYK），不是面板自己算", () => {
    const container = render(makeController({ views: viewsPort() }));
    click(button(container, "Info")!);
    act(() => publishHover({
      unit: "px",
      reading: { source: [10.5, 20.5], pixel: [10, 20], rgb: [255, 128, 0], cmyk: [0, 50, 100, 0] },
    }));
    const readout = container.querySelector('[data-info-hover="true"]')!;
    expect(readout.textContent).toContain("10, 20 px");
    expect(readout.textContent).toContain("255, 128, 0");
    expect(readout.textContent).toContain("0/50/100/0");
    // 画布外（null 读数）：面板回到「—」，不继续显示上一个像素。
    act(() => publishHover({ unit: "px", reading: null }));
    expect(container.querySelector('[data-info-hover="true"]')!.textContent).not.toContain("255, 128, 0");
  });
});

describe("U72 多视图取景读数", () => {
  it("取景读数来自内核里的活动视图，界面不自己算比例", () => {
    // 取景读值走控制器 facade（`controller.viewAids`），不是域会话端口。
    const zoomed = { ...aids, views: [
      { id: "view-1", label: "视图 1", zoom: 0.25, offset: [12, -8], rotation: 15, active: true },
    ] };
    const controller = makeController({ views: viewsPort() }, {
      viewAids: vi.fn(() => ({ ok: true, value: zoomed })),
      setViewAids: vi.fn(() => ({ ok: true, value: zoomed })),
    });
    const container = render(controller);
    click(button(container, "导航")!);
    expect(container.textContent).toContain("活动视图 25%");
    expect(container.textContent).toContain("12, -8");
    // 多视图列表也读同一份内核值。
    expect(container.textContent).toContain("25% · 15°");
  });

  it("并排开关只有一个视图时禁用，并说明先新建视图", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "导航")!);
    const toggle = container.querySelector<HTMLInputElement>("[data-view-side-by-side]")!;
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain("并排至少需要两个视图");
    // 禁用时不写会话状态（避免界面发出一个内核会拒绝的请求）。
    expect(controller.setViewAids).not.toHaveBeenLastCalledWith({ sideBySide: true });
  });

  it("两个视图时可以打开并排，写回的是会话开关", () => {
    const twoViews = { ...aids, views: [
      { id: "view-1", label: "视图 1", zoom: 1, offset: [0, 0], rotation: 0, active: true },
      { id: "view-2", label: "视图 2", zoom: 2, offset: [30, 0], rotation: 0, active: false },
    ] };
    const controller = makeController({ views: viewsPort() }, {
      viewAids: vi.fn(() => ({ ok: true, value: twoViews })),
      setViewAids: vi.fn((patch: Record<string, unknown>) => ({ ok: true, value: { ...twoViews, ...patch } })),
    });
    const container = render(controller);
    click(button(container, "导航")!);
    const toggle = container.querySelector<HTMLInputElement>("[data-view-side-by-side]")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    act(() => { toggle.click(); });
    expect(controller.setViewAids).toHaveBeenLastCalledWith({ sideBySide: true });
  });

  it("取景区没有会点了不动的写入按钮", () => {
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "导航")!);
    // 单视图画布的缩放/平移属于宿主视口；面板里放按钮会与状态栏分叉。
    for (const label of ["放大", "缩小", "100%", "取景归位"]) {
      expect(button(container, label)).toBeUndefined();
    }
    expect(container.querySelector("[data-view-zoom]")?.textContent).toContain("活动视图");
  });
});

describe("U73 画布落点手势", () => {
  it("计数页发起一次性落点请求，消费时按源坐标调用 count.add", () => {
    resetPlacementForTests();
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "计数")!);
    click(button(container, "在画布上放置")!);

    // 按钮只发起请求，不立即写文档（否则会先在 (0,0) 落一个标记）。
    expect(activePlacement()?.label).toContain("计数标记");
    expect(controller.features.views.viewCommand).not.toHaveBeenCalled();

    consumePlacement([33, 44]);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("count.add", { x: 33, y: 44 });
    // 一次性：消费后请求消失，后续点击不再加点。
    expect(activePlacement()).toBeNull();
  });

  it("注释页的落点带上草稿文本，并在消费后清空文本", () => {
    resetPlacementForTests();
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "注释")!);
    const input = [...container.querySelectorAll("input")].find((node) => node.value === "") ?? container.querySelector("textarea");
    if (input) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, "检查这里");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    click(button(container, "在画布上放置")!);
    consumePlacement([7, 8]);
    const call = (controller.features.views.viewCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    expect(call[0]).toBe("notes.add");
    expect(call[1]).toMatchObject({ x: 7, y: 8 });
  });

  it("Info 页的取样点落点入口按源坐标添加，并把数值框同步成该点", () => {
    resetPlacementForTests();
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    click(button(container, "在画布上放置取样点")!);
    expect(activePlacement()?.label).toContain("取样点");
    expect(controller.features.views.viewCommand).not.toHaveBeenCalled();
    consumePlacement([21, 22]);
    expect(controller.features.views.viewCommand).toHaveBeenCalledWith("view.colorSamplers.add", { x: 21, y: 22 });
    // 一次性：消费后不再残留。
    expect(activePlacement()).toBeNull();
  });

  it("标尺落点分两步：第一次只记起点不提交，第二次才测量", () => {
    resetPlacementForTests();
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "Info")!);
    click(button(container, "在画布上取标尺起点")!);
    // 落点回调里有 setState：包在 act 里，否则下一次渲染看不到「已记起点」。
    act(() => { consumePlacement([5, 6]); });
    // 第一次点选只记起点：不能先提交一条 (0,0)→(5,6) 的半成品测量。
    expect(controller.features.views.viewCommand).not.toHaveBeenCalled();

    click(button(container, "在画布上取标尺终点")!);
    act(() => { consumePlacement([60, 80]); });
    const call = (controller.features.views.viewCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    expect(call[0]).toBe("image.analysis.rulerTool");
    expect(call[1]).toEqual({ start: [5, 6], end: [60, 80] });
  });

  it("落点提示可见且可取消，取消后点击不再写入", () => {
    resetPlacementForTests();
    const controller = makeController({ views: viewsPort() });
    const container = render(controller);
    click(button(container, "计数")!);
    click(button(container, "在画布上放置")!);
    expect(container.querySelector("[data-placement-hint]")).not.toBeNull();
    click(button(container, "取消放置")!);
    expect(activePlacement()).toBeNull();
    expect(consumePlacement([1, 1])).toBe(false);
    expect(controller.features.views.viewCommand).not.toHaveBeenCalled();
  });
});
