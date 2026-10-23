/** @vitest-environment jsdom */
// 只验证面板的 DOM、参数和调用顺序；真实像素与历史语义在 Rust 侧。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RetouchPanel } from "./panels.js";
import { DEFAULT_REGION_OPTIONS, DEFAULT_RETOUCH_OPTIONS, type CloneSourceState, type RetouchOptions } from "./tool-parameters.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

const CLONES: CloneSourceState = {
  active: 0,
  slots: [
    { index: 0, source: [12, 14], anchor: [2, 3], offset: [10, 11], layer: 1, width: 200, height: 100, linked: true, rotation: 30, flipH: false, flipV: true },
    { index: 1, source: null, anchor: null, offset: null, layer: null, width: 100, height: 100, linked: false, rotation: 0, flipH: false, flipV: false },
    { index: 2, source: null, anchor: null, offset: null, layer: null, width: 100, height: 100, linked: false, rotation: 0, flipH: false, flipV: false },
    { index: 3, source: null, anchor: null, offset: null, layer: null, width: 100, height: 100, linked: false, rotation: 0, flipH: false, flipV: false },
    { index: 4, source: null, anchor: null, offset: null, layer: null, width: 100, height: 100, linked: false, rotation: 0, flipH: false, flipV: false }
  ],
  overlay: { show: true, opacity: 100, clipped: true, autoHide: true, invert: false, blend: "normal" }
};

function harness(tool: string, options: Partial<RetouchOptions> = {}, extra: { samplePoint?: [number, number]; onTool?: (id: string) => void; redEye?: [number, number][] } = {}) {
  let current = { ...DEFAULT_RETOUCH_OPTIONS, ...options };
  const setRetouchOptions = vi.fn((patch: Partial<RetouchOptions>) => {
    current = { ...current, ...patch };
    return current;
  });
  const retouch = {
    retouchOptions: () => current,
    setRetouchOptions,
    retouchHistorySources: () => ({
      ok: true as const,
      value: [
        { index: 0, label: "打开", current: false, available: false },
        { index: 1, label: "画笔", current: true, available: true }
      ]
    }),
    selectHistorySource: vi.fn(),
    cloneSources: () => ({ ok: true as const, value: CLONES }),
    selectCloneSource: vi.fn(),
    setCloneSource: vi.fn(),
    resetCloneSourceTransform: vi.fn(),
    setCloneOverlay: vi.fn(),
    beginRetouchRegion: vi.fn(() => ({ ok: true as const, value: { changed: true } })),
    commitRetouchRegion: vi.fn(() => ({ ok: true as const })),
    cancelRetouchRegion: vi.fn(),
    markRedEye: vi.fn(() => ({ ok: true as const, value: [[12, 10]] })),
    clearRedEye: vi.fn(() => 0),
    redEyePoints: vi.fn(() => extra.redEye ?? ([] as [number, number][]))
  };
  const controller = { features: { retouch }, patternLibrary: () => ({ ok: true as const, value: { presets: [], patternPresets: [{ id: "weave", name: "织物", width: 8, height: 8 }] } }) };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onSample = vi.fn();
  const onAligned = vi.fn();
  act(() => root!.render(
    <RetouchPanel readonly={false} tool={tool} controller={controller as never}
      onSample={onSample} samplePoint={extra.samplePoint ?? null} aligned onAligned={onAligned}
      {...(extra.onTool ? { onTool: extra.onTool } : {})} />
  ));
  return { container, retouch, setRetouchOptions, onSample, onAligned };
}

const label = (container: HTMLElement, text: string) => [...container.querySelectorAll("label")]
  .find((entry) => entry.textContent?.includes(text)) as HTMLElement | undefined;

/** React 受控输入用内部 value tracker 去重，必须走原生 setter 才会触发 onChange。 */
const setValue = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};

it("海绵面板只提供增/减饱和，并把选择写进域会话选项", () => {
  const { container, setRetouchOptions } = harness("paint.sponge");
  const select = label(container, "模式")!.querySelector("select")!;
  expect([...select.options].map((option) => option.value)).toEqual(["desaturate", "saturate"]);
  expect(select.value).toBe("desaturate");
  act(() => setValue(select, "saturate"));
  expect(setRetouchOptions).toHaveBeenCalledWith({ spongeMode: "saturate" });
  // 混合模式不是海绵参数：面板不提供它，也不把 normal 送进内核。
  expect(label(container, "混合")).toBeUndefined();
});

it("减淡/加深提供范围与曝光，越界输入被钳制而不是原样送出", () => {
  const { container, setRetouchOptions } = harness("paint.dodge", { toneRange: "highlights", exposure: 70 });
  const range = label(container, "范围")!.querySelector("select")!;
  expect([...range.options].map((option) => option.value)).toEqual(["shadows", "midtones", "highlights"]);
  expect(range.value).toBe("highlights");
  const exposure = label(container, "曝光")!.querySelector("input")!;
  expect(exposure.value).toBe("70");
  act(() => setValue(exposure, "400"));
  expect(setRetouchOptions).toHaveBeenLastCalledWith({ exposure: 100 });
});

it("图案图章列出图案库来源并保留「图案面板当前图案」的空值", () => {
  const { container, setRetouchOptions } = harness("paint.patternStamp");
  const select = label(container, "图案")!.querySelector("select")!;
  expect([...select.options].map((option) => option.value)).toEqual(["", "weave"]);
  act(() => setValue(select, "weave"));
  expect(setRetouchOptions).toHaveBeenCalledWith({ patternId: "weave" });
  expect(label(container, "缩放 %")).toBeDefined();
  expect(label(container, "对齐源坐标")).toBeDefined();
});

it("历史画笔列出历史源、禁用不含该图层的状态并记住选择", () => {
  const { container, setRetouchOptions, retouch } = harness("paint.historyBrush", { historyState: 1 });
  const select = label(container, "历史源")!.querySelector("select")!;
  const options = [...select.options];
  expect(options.map((option) => option.value)).toEqual(["0", "1"]);
  expect(options[0].disabled).toBe(true);
  expect(options[1].textContent).toContain("（当前）");
  act(() => setValue(select, "0"));
  expect(setRetouchOptions).toHaveBeenCalledWith({ historyState: 0 });
  expect(retouch.selectHistorySource).toHaveBeenCalledWith(0);
});

it("仿制工具显示五槽位、变换与叠加，改动通过域命令而不是本地状态", () => {
  const { container, retouch } = harness("paint.cloneStamp", {}, { samplePoint: [12, 14] });
  const slots = container.querySelectorAll('[aria-label="仿制源槽位"] button');
  expect(slots).toHaveLength(5);
  act(() => (slots[1] as HTMLButtonElement).click());
  expect(retouch.selectCloneSource).toHaveBeenCalledWith(1);
  const width = label(container, "宽 %")!.querySelector("input")!;
  expect(width.value).toBe("200");
  act(() => setValue(width, "250"));
  expect(retouch.setCloneSource).toHaveBeenCalledWith(0, { width: 250 });
  act(() => (label(container, "水平翻转")!.querySelector("input") as HTMLInputElement).click());
  expect(retouch.setCloneSource).toHaveBeenCalledWith(0, { flipH: true });
  act(() => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "重置变换")!.click());
  expect(retouch.resetCloneSourceTransform).toHaveBeenCalledWith(0);
  act(() => (label(container, "反相")!.querySelector("input") as HTMLInputElement).click());
  expect(retouch.setCloneOverlay).toHaveBeenCalledWith({ invert: true });
  expect(container.textContent).toContain("源 (12, 14)");
});

it("区域修饰在没有偏移/位置时拒绝开始，补齐后先算候选再确认", () => {
  // 区域命令由共享上下文栏的下拉决定（`tool`），面板不再另存一个选择器：画布手势与面板
  // 必须读同一个命令，否则画布拖动会走错路径。
  const { container, retouch } = harness("paint.patch");
  const region = container.querySelector('[data-region-group="true"]')!;
  expect(region.textContent).toContain("拖动偏移");
  const begin = [...region.querySelectorAll("button")].find((entry) => entry.textContent === "计算候选") as HTMLButtonElement;
  expect(begin.disabled).toBe(true);
  const offsetX = [...region.querySelectorAll("label")].find((entry) => entry.textContent?.includes("偏移 X"))!.querySelector("input")!;
  act(() => setValue(offsetX, "12"));
  act(() => begin.click());
  expect(retouch.beginRetouchRegion).toHaveBeenCalledWith("paint.patch", expect.objectContaining({ offset: [12, 0] }));
  const confirm = [...region.querySelectorAll("button")].find((entry) => entry.textContent === "确认") as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  act(() => confirm.click());
  expect(retouch.commitRetouchRegion).toHaveBeenCalled();
  const cancel = [...region.querySelectorAll("button")].find((entry) => entry.textContent === "取消") as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  expect(DEFAULT_REGION_OPTIONS.structure).toBe(4);
});

it("红眼用域会话里的共享位置标记，标记后从同一入口开始候选", () => {
  const marks: (readonly [number, number])[] = [];
  const beginRedEye = vi.fn(() => ({ ok: true as const, value: { changed: true } }));
  const retouch = {
    retouchOptions: () => DEFAULT_RETOUCH_OPTIONS,
    setRetouchOptions: vi.fn((patch: Partial<RetouchOptions>) => ({ ...DEFAULT_RETOUCH_OPTIONS, ...patch })),
    markRedEye: vi.fn((point: { x: number; y: number }) => {
      marks.push([Math.round(point.x), Math.round(point.y)]);
      return { ok: true as const, value: marks };
    }),
    redEyePoints: () => [...marks],
    clearRedEye: vi.fn(() => { marks.length = 0; return 0; }),
    beginRedEye,
    beginRetouchRegion: vi.fn(() => ({ ok: true as const, value: { changed: true } })),
    commitRetouchRegion: vi.fn(() => ({ ok: true as const })),
    cancelRetouchRegion: vi.fn()
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <RetouchPanel readonly={false} tool="paint.redEye" controller={{ features: { retouch } } as never}
      onSample={vi.fn()} samplePoint={[14, 16]} aligned onAligned={vi.fn()} />
  ));
  const region = container.querySelector('[data-region-group="true"]')!;
  expect(region.getAttribute("data-region-retouch")).toBe("paint.redEye");
  const add = [...region.querySelectorAll("button")].find((entry) => entry.textContent === "用采样点添加红眼") as HTMLButtonElement;
  act(() => add.click());
  // 位置进的是域会话（画布单击走同一条路径），不是面板私有数组。
  expect(retouch.markRedEye).toHaveBeenCalledWith({ x: 14, y: 16 });
  expect(region.textContent).toContain("已标记 1 处");
  const begin = [...region.querySelectorAll("button")].find((entry) => entry.textContent === "计算候选") as HTMLButtonElement;
  act(() => begin.click());
  // 有 beginRedEye 端口时用它（位置已交域会话），不再重复传 points。
  expect(beginRedEye).toHaveBeenCalledWith({ redEyePupilSize: 50, redEyeDarken: 50 });
  expect(retouch.beginRetouchRegion).not.toHaveBeenCalled();
});

it("仿制源命令被拒绝时显示原因，不静默装作已生效", () => {
  const { container, retouch } = harness("paint.cloneStamp", {}, { samplePoint: [12, 14] });
  // 内核拒绝（这里是落笔期间改工具状态）：面板必须把原因显示出来。
  (retouch.setCloneSource as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
    ok: false as const, code: "command-failed", message: "请先结束或取消当前修饰笔迹"
  });
  const width = label(container, "宽 %")!.querySelector("input")!;
  act(() => setValue(width, "250"));
  expect(container.textContent).toContain("请先结束或取消当前修饰笔迹");
  // 下一次成功的命令清掉上一次的失败提示。
  (retouch.setCloneSource as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ ok: true as const, value: {} });
  act(() => setValue(width, "260"));
  expect(container.textContent).not.toContain("请先结束或取消当前修饰笔迹");
});

it("混色下拉只发合法值；叠加不支持的混合模式由会话拒绝并提示", () => {
  const { container, retouch } = harness("paint.cloneStamp", {}, { samplePoint: [12, 14] });
  const blend = label(container, "混合")!.querySelector("select")!;
  expect([...blend.options].map((option) => option.value)).toEqual(["normal", "darken", "lighten", "difference"]);
  act(() => setValue(blend, "darken"));
  expect(retouch.setCloneOverlay).toHaveBeenCalledWith({ blend: "darken" });
  (retouch.setCloneOverlay as unknown as { mockReturnValue: (value: unknown) => void }).mockReturnValue({
    ok: false as const, code: "invalid-params", message: "叠加混合模式 multiply 不受支持（normal|darken|lighten|difference）"
  });
  act(() => setValue(blend, "lighten"));
  expect(container.textContent).toContain("叠加混合模式 multiply 不受支持");
});

it("红眼标记退回面板本地时用本地点集开候选，不调用只读域点集的 beginRedEye", () => {
  const beginRedEye = vi.fn(() => ({ ok: true as const, value: { changed: true } }));
  const beginRetouchRegion = vi.fn(() => ({ ok: true as const, value: { changed: true } }));
  const retouch = {
    retouchOptions: () => DEFAULT_RETOUCH_OPTIONS,
    setRetouchOptions: vi.fn((patch: Partial<RetouchOptions>) => ({ ...DEFAULT_RETOUCH_OPTIONS, ...patch })),
    // 只有 beginRedEye、没有 markRedEye：标记只能落在面板本地，这时 beginRedEye 会读到空点集。
    beginRedEye,
    beginRetouchRegion,
    commitRetouchRegion: vi.fn(() => ({ ok: true as const })),
    cancelRetouchRegion: vi.fn()
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <RetouchPanel readonly={false} tool="paint.redEye" controller={{ features: { retouch } } as never}
      onSample={vi.fn()} samplePoint={[14, 16]} aligned onAligned={vi.fn()} />
  ));
  const region = container.querySelector('[data-region-group="true"]')!;
  act(() => [...region.querySelectorAll("button")].find((entry) => entry.textContent === "用采样点添加红眼")!.click());
  expect(region.textContent).toContain("已标记 1 处");
  act(() => [...region.querySelectorAll("button")].find((entry) => entry.textContent === "计算候选")!.click());
  // 位置必须随候选参数一起送出，不能因为走 beginRedEye 而丢掉本地标记。
  expect(beginRedEye).not.toHaveBeenCalled();
  expect(beginRetouchRegion).toHaveBeenCalledWith("paint.redEye", expect.objectContaining({ points: [[14, 16]] }));
});

it("「滤镜 → 修饰工具…」入口能选到全部工具，并走同一个域回调", () => {
  // 真实走查发现的缺口：这个高级面板原先既没有工具选择器、也没有真正布防取样，
  // 用户只能停在默认的「污点修复」，新增的图案图章/历史画笔/移除与区域命令都够不到。
  const onTool = vi.fn();
  const { container } = harness("paint.spotHealing", {}, { onTool });
  const select = label(container, "工具")!.querySelector("select")!;
  const values = [...select.options].map((option) => option.value);
  // 13 项共享下拉 + 仿制图章/修复画笔（工具栏里是独立按钮，面板入口没有工具栏上下文）。
  expect(values).toHaveLength(15);
  expect(values).toEqual(expect.arrayContaining([
    "paint.cloneStamp", "paint.healingBrush", "paint.patternStamp", "paint.historyBrush",
    "paint.remove", "paint.patch", "paint.contentAwareMove", "paint.redEye"
  ]));
  act(() => setValue(select, "paint.patternStamp"));
  expect(onTool).toHaveBeenCalledWith("paint.patternStamp");
});

it("上下文栏入口不重复渲染工具选择器（同一屏只有一个当前工具）", () => {
  const { container } = harness("paint.blur");
  expect(label(container, "工具")).toBeUndefined();
});
it("红眼候选进行中锁住位置编辑，取消后位置仍在（spec 的「保留可恢复输入」）", () => {
  // 真实走查发现：取消候选会把已标记的位置一起清掉，用户得重新点一遍；
  // 而候选进行中又还能「清空位置」，面板显示的点集与候选实际用的点集会对不上。
  const { container, retouch } = harness("paint.redEye", {}, { samplePoint: [5, 5], redEye: [[12, 10]] });
  const group = container.querySelector('[data-region-group="true"]')!;
  const button = (text: string) => [...group.querySelectorAll("button")].find((entry) => entry.textContent === text) as HTMLButtonElement;
  act(() => button("清空位置").click());
  expect(retouch.clearRedEye).toHaveBeenCalled();
  act(() => button("计算候选").click());
  expect(retouch.beginRetouchRegion).toHaveBeenCalled();
  // 候选进行中：位置相关按钮与红眼参数都锁住。
  expect(button("清空位置").disabled).toBe(true);
  expect(button("用采样点添加红眼").disabled).toBe(true);
  act(() => button("取消").click());
  expect(retouch.cancelRetouchRegion).toHaveBeenCalled();
  expect(button("清空位置").disabled).toBe(false);
});
