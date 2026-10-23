/** @vitest-environment jsdom */
/**
 * 滤镜面板交互回归（U46–U49）。
 *
 * 面板只经 `controller.features.filters` 走草稿通道：这里用一个最小端口替身验证
 * 「输入即预览 / 切滤镜先取消 / 一条历史只在确认时产生」以及图内控件（组合、控制点、平面、
 * 约束线）确实把几何写回参数。像素与内核语义在 Rust 侧，本测试不渲染画布。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { FilterPanel } from "./panels.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

const param = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
  key, kind, min: null, max: null, default: null, choices: [], ...extra
});

const CATALOGUE = {
  filters: [
    {
      id: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "simple",
      usesColours: false, needsMap: false,
      params: [param("radius", "number", { min: 0.1, max: 1000, default: 1 })]
    },
    {
      id: "filter.sharpen.unsharpMask", label: "USM 锐化", category: "锐化", kind: "simple",
      usesColours: false, needsMap: false,
      params: [
        param("amount", "number", { min: 1, max: 500, default: 50 }),
        param("radius", "number", { min: 0.1, max: 1000, default: 1 }),
        param("threshold", "number", { min: 0, max: 255, default: 0 })
      ]
    },
    {
      id: "filter.blurGallery.irisBlur", label: "光圈模糊", category: "模糊画廊", kind: "blurGallery",
      usesColours: false, needsMap: false,
      params: [
        param("blur", "number", { min: 0, max: 500, default: 15 }),
        param("centerX", "number", { min: 0, max: 1, default: 0.5 }),
        param("centerY", "number", { min: 0, max: 1, default: 0.5 }),
        param("pins", "resource")
      ]
    },
    {
      // 旋转模糊的控制点模糊量是角度（`blurAngle`），不是像素半径。
      id: "filter.blurGallery.spinBlur", label: "旋转模糊", category: "模糊画廊", kind: "blurGallery",
      usesColours: false, needsMap: false,
      params: [
        param("blurAngle", "number", { min: 0, max: 360, default: 15 }),
        param("centerX", "number", { min: 0, max: 1, default: 0.5 }),
        param("centerY", "number", { min: 0, max: 1, default: 0.5 }),
        param("pins", "resource")
      ]
    },
    {
      // 移轴模糊没有 `pins`：几何是中心/角度/焦点带，面板不该写回控制点。
      id: "filter.blurGallery.tiltShift", label: "移轴模糊", category: "模糊画廊", kind: "blurGallery",
      usesColours: false, needsMap: false,
      params: [
        param("blur", "number", { min: 0, max: 500, default: 15 }),
        param("centerX", "number", { min: 0, max: 1, default: 0.5 }),
        param("centerY", "number", { min: 0, max: 1, default: 0.5 }),
        param("angle", "number", { min: -90, max: 90, default: 0 }),
        param("focus", "number", { min: 0, max: 1, default: 0.1 }),
        param("transition", "number", { min: 0.01, max: 1, default: 0.15 })
      ]
    },
    {
      // 路径模糊的图内几何是 `paths`，不是 `pins`。
      id: "filter.blurGallery.pathBlur", label: "路径模糊", category: "模糊画廊", kind: "blurGallery",
      usesColours: false, needsMap: false,
      params: [
        param("speed", "number", { min: 0, max: 500, default: 50 }),
        param("taper", "number", { min: 0, max: 100, default: 0 }),
        param("startX", "number", { min: 0, max: 1, default: 0.2 }),
        param("startY", "number", { min: 0, max: 1, default: 0.5 }),
        param("endX", "number", { min: 0, max: 1, default: 0.8 }),
        param("endY", "number", { min: 0, max: 1, default: 0.5 }),
        param("paths", "resource")
      ]
    },
    {
      id: "filter.other.custom", label: "自定", category: "其他", kind: "simple",
      usesColours: false, needsMap: false,
      params: [param("kernel", "resource"), param("scale", "number", { min: 1, max: 9999, default: 1 })]
    },
    {
      id: "filter.vanishingPoint", label: "消失点…", category: "摄影", kind: "vanishingPoint",
      usesColours: false, needsMap: false,
      params: [
        param("planes", "resource"),
        param("focalLength", "number", { min: 0, max: 100000, default: 0 }),
        param("clone", "resource"),
        param("paste", "resource")
      ]
    },
    {
      id: "filter.lensCorrection", label: "镜头校正", category: "摄影", kind: "lens",
      usesColours: false, needsMap: false,
      params: [
        param("profile", "choice", { choices: ["none", "auto", "generic"], default: "none" }),
        param("scale", "number", { min: 50, max: 150, default: 100 }),
        param("straighten", "resource")
      ]
    },
    {
      id: "filter.adaptiveWideAngle", label: "自适应广角", category: "摄影", kind: "lens",
      usesColours: false, needsMap: false,
      params: [param("scale", "number", { min: 50, max: 150, default: 100 }), param("constraints", "resource")]
    },
    {
      id: "filter.filterGallery", label: "滤镜库…", category: "滤镜库", kind: "galleryStack",
      usesColours: false, needsMap: false,
      params: [param("foreground", "color", { default: "#000000" }), param("background", "color", { default: "#000000" })]
    },
    {
      id: "filter.render.flame", label: "火焰…", category: "渲染", kind: "simple",
      usesColours: false, needsMap: false,
      params: [
        param("flameType", "choice", { choices: ["oneFlame", "multipleFlames", "candleLight"], default: "oneFlame" }),
        param("intensity", "number", { min: 0, max: 100, default: 50 }),
        param("path", "resource")
      ]
    },
    {
      id: "filter.cameraRaw", label: "Camera Raw 滤镜…", category: "摄影", kind: "cameraRaw",
      usesColours: false, needsMap: false,
      params: [
        param("exposure", "number", { min: -5, max: 5, default: 0 }),
        param("pointCurve", "resource"),
        param("pointCurveRed", "resource"),
        param("curveSplits", "resource"),
        param("hslHue", "resource"),
        param("hslSat", "resource"),
        param("hslLum", "resource"),
        param("gradeShadows", "resource"),
        param("gradeGlobal", "resource")
      ]
    },
    {
      id: "filter.render.lightingEffects", label: "光照效果…", category: "渲染", kind: "simple",
      usesColours: false, needsMap: false,
      params: [
        param("intensity", "number", { min: -100, max: 100, default: 75 }),
        param("lights", "resource")
      ]
    },
    {
      // 位移图来源只能从已打开文档取；`mapLayer` 是**该文档内**的图层 id。
      id: "filter.distort.displace", label: "置换", category: "扭曲", kind: "simple",
      usesColours: false, needsMap: true,
      params: [
        param("horizontal", "number", { min: 0, max: 200, default: 6 }),
        param("vertical", "number", { min: 0, max: 200, default: 6 }),
        param("mapDocument", "resource"),
        param("mapLayer", "resource")
      ]
    },
    {
      // 切变的形状是 `points` 曲线；`amount` 只是没有曲线时的缺省生成参数。
      id: "filter.distort.shear", label: "切变…", category: "扭曲", kind: "simple",
      usesColours: false, needsMap: false,
      params: [
        param("amount", "number", { min: -100, max: 100, default: 0 }),
        param("undefinedAreas", "choice", { choices: ["wrap", "repeat"], default: "wrap" }),
        param("points", "resource")
      ]
    }
  ],
  gallery: {
    categories: ["Artistic", "Texture"],
    filters: [
      { key: "cutout", name: "剪贴画", category: "Artistic", command: "filter.gallery.cutout",
        params: [param("numberOfLevels", "integer", { min: 2, max: 8, default: 4 })] },
      { key: "filmGrain", name: "胶片颗粒", category: "Texture", command: "filter.gallery.filmGrain",
        params: [param("grain", "number", { min: 0, max: 20, default: 4 })] },
      // 画廊里唯一的 resource 参数：光晕颜色必须有自己的控件。
      { key: "neonGlow", name: "霓虹光晕", category: "Artistic", command: "filter.gallery.neonGlow",
        params: [
          param("glowSize", "number", { min: -24, max: 24, default: 5 }),
          param("glowColor", "resource")
        ] }
    ]
  },
  limits: { maxEffects: 32, maxPins: 16, maxPlanes: 8, maxParams: 96, maxResourcePoints: 64, seedMax: 4294967295 }
};

const DEFAULT_STACK = [{ filter: "cutout", params: { numberOfLevels: 4 }, visible: true }];

function setup(options: { last?: boolean; draft?: Record<string, unknown>; sources?: unknown; noMapPort?: boolean; layers?: unknown; noLayerPort?: boolean; paths?: unknown; noPathPort?: boolean } = {}) {
  const beginnings: { id: string; params: Record<string, unknown> }[] = [];
  const updates: Record<string, unknown>[] = [];
  // 面板对「开始」和「更新」传的是同一份参数；断言只关心最后一次送进内核的输入。
  const applied: Record<string, unknown>[] = [];
  const port = {
    beginFilter: vi.fn((id: string, params: Record<string, unknown>) => {
      beginnings.push({ id, params });
      applied.push({ ...params });
      return { ok: true as const, value: { filter: id, label: id, category: "", kind: "simple", layer: 1, params } };
    }),
    updateFilter: vi.fn((params: Record<string, unknown>) => {
      updates.push({ ...params });
      applied.push({ ...params });
      return { ok: true as const, value: { filter: beginnings.at(-1)?.id ?? "", label: "", category: "", kind: "simple", layer: 1, params } };
    }),
    commitFilter: vi.fn(() => ({ ok: true as const, value: {} })),
    cancelFilter: vi.fn(() => undefined),
    filterCatalogue: vi.fn(() => ({ ok: true as const, value: structuredClone(CATALOGUE) })),
    filterLast: vi.fn(() => options.last === false
      ? { ok: true as const, value: { available: false as const, reason: "还没有可重复的滤镜" } }
      : { ok: true as const, value: { available: true as const, filter: "filter.sharpen.unsharpMask", label: "USM 锐化", params: { amount: 200, radius: 3, threshold: 8 } } }),
    repeatLastFilter: vi.fn(() => {
      beginnings.push({ id: "filter.sharpen.unsharpMask", params: { amount: 200, radius: 3, threshold: 8 } });
      return { ok: true as const, value: { filter: "filter.sharpen.unsharpMask", label: "USM 锐化", category: "锐化", kind: "simple", layer: 1, params: { amount: 200, radius: 3, threshold: 8 } } };
    }),
    filterDraftState: vi.fn(() => ({ ok: true as const, value: options.draft ?? null })),
    filterNormalizePoint: vi.fn(() => ({ ok: true as const, value: [0.5, 0.5] as [number, number] })),
    filterGalleryDefaultStack: vi.fn(() => ({ ok: true as const, value: DEFAULT_STACK })),
    filterMapSources: vi.fn(() => options.sources === undefined
      ? {
          ok: true as const,
          value: [
            { index: 0, name: "底图.pcraft", width: 1000, height: 500, active: true, layers: [{ id: 1, name: "图层 1" }] },
            {
              index: 1,
              name: "位移图.pcraft",
              width: 800,
              height: 600,
              active: false,
              layers: [{ id: 7, name: "位移层" }, { id: 8, name: "细节层" }]
            }
          ]
        }
      : options.sources),
    filterLayerSources: vi.fn(() => options.layers === undefined
      ? { ok: true as const, value: [{ id: 1, name: "图层 1", active: true, width: 1000, height: 500 }, { id: 2, name: "图层 2", active: false, width: 400, height: 300 }] }
      : options.layers),
    filterPathSources: vi.fn(() => options.paths === undefined
      ? { ok: true as const, value: { paths: ["路径 1", "路径 2"], hasWorkPath: true } }
      : options.paths),
    hasFilter: vi.fn(() => false)
  };
  // 旧 glue 没有位移图来源端口：面板必须明确说不可用，而不是画一个空下拉框。
  if (options.noMapPort) delete (port as { filterMapSources?: unknown }).filterMapSources;
  // 旧 glue 也可能没有粘贴图层来源端口：面板要说明只能走剪贴板，而不是画空下拉。
  if (options.noLayerPort) delete (port as { filterLayerSources?: unknown }).filterLayerSources;
  if (options.noPathPort) delete (port as { filterPathSources?: unknown }).filterPathSources;
  // 面板的可用性判定读宿主顶层端口，真正调用走同一域的会话对象。
  // `currentView()` 给出文档尺寸：图内几何（透视平面、约束线）用文档像素。
  const currentView = () => ({
    hasDocument: true,
    sessionActiveIndex: 0,
    document: { width: 1000, height: 500, revision: 1, layers: [] }
  });
  const controller = { ...port, currentView, features: { filters: port } } as unknown as EditorWorkspaceController & typeof port;
  const onChanged = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () => act(() => root!.render(<FilterPanel controller={controller} readonly={false} onChanged={onChanged} />));
  render();
  // jsdom 里 React 会在实例上装 value tracker；必须用元素自己原型的 setter 才能让
  // React 认为值真的变了（否则 change 回调拿到的还是旧值）。
  const setNative = (node: HTMLInputElement | HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")!.set!;
    setter.call(node, value);
  };
  const chooseIn = (node: HTMLSelectElement, value: string) => act(() => {
    setNative(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  /** 选中某条命令：只有「滤镜」下拉同时列出所有命令。 */
  const selectFilter = (value: string) => {
    const node = [...container.querySelectorAll("select")]
      .find((candidate) => [...candidate.options].some((option) => option.value === "filter.filterGallery"))
      ?? [...container.querySelectorAll("select")].at(-1)!;
    chooseIn(node as HTMLSelectElement, value);
  };
  const paramInput = (key: string) => container.querySelector<HTMLInputElement>(`[data-filter-param="${key}"] input[type="number"]`);
  const setParam = (key: string, value: number) => act(() => {
    const input = paramInput(key);
    if (!input) throw new Error(`缺少参数 ${key}`);
    setNative(input, String(value));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith(label))!;
  return { container, controller, port, beginnings, updates, applied, onChanged, render, selectFilter, setParam, paramInput, chooseIn, setNative, button };
}

it("USM 三个参数都在，改动任一参数都会重新预览", () => {
  const { beginnings, updates, onChanged, selectFilter, setParam, paramInput } = setup();
  selectFilter("filter.sharpen.unsharpMask");
  for (const key of ["amount", "radius", "threshold"]) expect(paramInput(key)).not.toBeNull();
  setParam("radius", 3);
  expect(beginnings.at(-1)!.id).toBe("filter.sharpen.unsharpMask");
  expect(beginnings.at(-1)!.params).toMatchObject({ radius: 3, amount: 50, threshold: 0 });
  setParam("threshold", 12);
  expect(updates.at(-1)).toMatchObject({ radius: 3, threshold: 12 });
  expect(onChanged).toHaveBeenCalled();
});

it("切滤镜先取消当前草稿，再按新滤镜默认值开始", () => {
  const { port, beginnings, selectFilter, setParam } = setup();
  setParam("radius", 2);
  expect(beginnings).toHaveLength(1);
  selectFilter("filter.sharpen.unsharpMask");
  expect(port.cancelFilter).toHaveBeenCalledOnce();
  setParam("amount", 120);
  expect(beginnings.at(-1)).toMatchObject({ id: "filter.sharpen.unsharpMask", params: { amount: 120, radius: 1 } });
});

it("确认只提交一次，取消不发写入", () => {
  const { port, button, setParam } = setup();
  setParam("radius", 2);
  act(() => button("确认").click());
  expect(port.commitFilter).toHaveBeenCalledOnce();
  // 提交后「取消」不再可用，不会对已提交结果再发一次取消。
  act(() => button("取消").click());
  expect(port.cancelFilter).not.toHaveBeenCalled();
  // 重新开始一份草稿再取消，只取消不提交。
  setParam("radius", 5);
  act(() => button("取消").click());
  expect(port.cancelFilter).toHaveBeenCalledOnce();
  expect(port.commitFilter).toHaveBeenCalledOnce();
});

it("面板重挂载后回读内核草稿，不用默认值覆盖已确认前的输入", () => {
  const first = setup();
  act(() => first.button("取消").click());
  // 第二个面板挂载时内核仍有草稿：参数与几何都要从内核回执恢复。
  const draft = { filter: "filter.blurGallery.irisBlur", label: "光圈模糊", category: "模糊画廊", kind: "blurGallery", layer: 1, params: { blur: 40, centerX: 0.25, centerY: 0.75, pins: [{ x: 0.25, y: 0.75, blur: 40 }] } };
  const second = setup({ draft });
  expect(second.paramInput("blur")!.value).toBe("40");
  expect(second.container.querySelector("[data-filter-pins]")?.getAttribute("data-filter-pins")).toBe("1");
  // 直接确认写回的是内核里那份输入，不是面板初值。
  act(() => second.button("确认").click());
  expect(second.port.commitFilter).toHaveBeenCalledOnce();
  expect(second.port.updateFilter).not.toHaveBeenCalled();
});

it("重复上次按钮用回执参数重建草稿；没有上次时禁用", () => {
  const first = setup();
  act(() => first.button("重复上次").click());
  expect(first.port.repeatLastFilter).toHaveBeenCalledOnce();
  expect(first.beginnings.at(-1)!.params).toMatchObject({ amount: 200, radius: 3, threshold: 8 });
  // 重复后参数面板显示的是同一份规范参数。
  expect(first.paramInput("amount")!.value).toBe("200");
  act(() => first.button("取消").click());

  const second = setup({ last: false });
  expect(second.button("重复上次").disabled).toBe(true);
});

it("滤镜库选中即用内核默认组合预览，并可继续加层", () => {
  const { container, selectFilter, button, beginnings, applied, chooseIn } = setup();
  selectFilter("filter.filterGallery");
  expect(container.querySelector("[data-filter-stack]")).not.toBeNull();
  // 画廊没有单值参数，空栈会被内核拒绝：选中就直接用默认组合开始草稿。
  expect(beginnings.at(-1)!.id).toBe("filter.filterGallery");
  expect(applied.at(-1)!.effects).toEqual(DEFAULT_STACK);
  // 草稿回执里的效果栈被还原成面板状态。
  expect(container.querySelectorAll("[data-filter-effect]")).toHaveLength(1);
  // 先在新效果下拉里选「胶片颗粒」，再添加：新层带自己的默认参数，不是空对象。
  const addingSelect = container.querySelector<HTMLSelectElement>("[data-filter-stack-add] select")!;
  chooseIn(addingSelect, "filmGrain");
  act(() => button("添加效果").click());
  const effects = applied.at(-1)!.effects as { filter: string; params: Record<string, unknown> }[];
  expect(effects).toHaveLength(2);
  expect(effects[1]).toMatchObject({ filter: "filmGrain", params: { grain: 4 } });
});

it("模糊画廊控制点写回 pins 与中心", () => {
  const { container, selectFilter, button, applied } = setup();
  selectFilter("filter.blurGallery.irisBlur");
  // 选中即有一个居中的默认控制点（没有控制点就没有几何可调）。
  expect(container.querySelector("[data-filter-pins]")?.getAttribute("data-filter-pins")).toBe("1");
  act(() => button("添加控制点").click());
  const pins = applied.at(-1)!.pins as { x: number; y: number; blur: number }[];
  expect(pins).toHaveLength(2);
  expect(container.querySelector("[data-filter-pins]")?.getAttribute("data-filter-pins")).toBe("2");
  // 改第一个点的 X：中心随之更新，控制点数组仍是唯一几何来源。
  const firstX = container.querySelector<HTMLInputElement>("[data-filter-pin='0'] input[type='number']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(firstX), "value")!.set!;
    setter.call(firstX, "0.25");
    firstX.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(applied.at(-1)).toMatchObject({ centerX: 0.25 });
  expect((applied.at(-1)!.pins as { x: number }[])[0]!.x).toBe(0.25);
});

it("旋转模糊的控制点写 blurAngle，而不是被内核忽略的 blur", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.blurGallery.spinBlur");
  const editor = container.querySelector("[data-filter-pins]")!;
  // 模糊量的字段名与范围都来自命令声明：旋转模糊是 0–360 度。
  expect(editor.getAttribute("data-filter-pin-key")).toBe("blurAngle");
  const amount = container.querySelector<HTMLInputElement>("[data-filter-pin='0'] input[type='range']")!;
  expect(amount.getAttribute("max")).toBe("360");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(amount), "value")!.set!;
    setter.call(amount, "120");
    amount.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const pin = (applied.at(-1)!.pins as Record<string, number>[])[0]!;
  expect(pin.blurAngle).toBe(120);
  // 写 `blur` 会被内核静默忽略，模糊滑块就成了摆设。
  expect(pin).not.toHaveProperty("blur");
});

it("移轴模糊不画控制点编辑，也不发送内核未声明的 pins", () => {
  const { container, selectFilter, setParam, applied } = setup();
  selectFilter("filter.blurGallery.tiltShift");
  // 移轴模糊没有 `pins` 字段：写回它会被内核以「没有参数 pins」拒绝整次草稿。
  expect(container.querySelector("[data-filter-pins]")).toBeNull();
  setParam("blur", 30);
  expect(applied.at(-1)).not.toHaveProperty("pins");
  expect(applied.at(-1)).toMatchObject({ blur: 30, centerX: 0.5, centerY: 0.5 });
});

it("路径模糊编辑 paths（起止点数组），不发送 pins", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.blurGallery.pathBlur");
  expect(container.querySelector("[data-filter-pins]")).toBeNull();
  const editor = container.querySelector("[data-filter-paths]")!;
  // 没有显式 paths 时按起止点兜底出一条路径，与内核的默认一致。
  expect(editor.getAttribute("data-filter-paths")).toBe("1");
  const firstPoint = container.querySelector<HTMLInputElement>("[data-filter-path='0'] input[type='number']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(firstPoint), "value")!.set!;
    setter.call(firstPoint, "0.1");
    firstPoint.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const sent = applied.at(-1)!;
  expect(sent).not.toHaveProperty("pins");
  const paths = sent.paths as { points: [number, number][]; speed: number; taper: number }[];
  expect(paths).toHaveLength(1);
  expect(paths[0]!.points[0]).toEqual([0.1, 0.5]);
  // 首条的起止点同时同步到标量字段，单路径命令两条读法看到的是同一份几何。
  expect(sent).toMatchObject({ startX: 0.1, startY: 0.5, endX: 0.8, endY: 0.5 });
  // 再添加一条路径：数组变长，仍然不含 pins。
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加路径"))!.click());
  expect((applied.at(-1)!.paths as unknown[]).length).toBe(2);
  expect(applied.at(-1)).not.toHaveProperty("pins");
});

it("自定卷积可编辑 25 项核并写回参数", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.other.custom");
  const editor = container.querySelector("[data-filter-kernel]")!;
  expect(editor.getAttribute("data-filter-kernel")).toBe("25");
  expect(container.querySelectorAll("[data-filter-kernel-cell]")).toHaveLength(25);
  // 默认是恒等核：中心 1，其余 0。没有核时「自定」在内核里就是空操作。
  expect(container.querySelector<HTMLInputElement>("[data-filter-kernel-cell='12']")!.value).toBe("1");
  expect(container.querySelector<HTMLInputElement>("[data-filter-kernel-cell='0']")!.value).toBe("0");
  const cell = container.querySelector<HTMLInputElement>("[data-filter-kernel-cell='6']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cell), "value")!.set!;
    setter.call(cell, "-4");
    cell.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // 第一次改核就开始草稿（不是只在已有草稿上更新）。
  const last = applied.at(-1)!;
  expect(last).toHaveProperty("kernel");
  const kernel = last.kernel as number[];
  expect(kernel).toHaveLength(25);
  expect(kernel[6]).toBe(-4);
  expect(kernel[12]).toBe(1);
  // 恢复恒等核：只有中心非 0。
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("恢复恒等核"))!.click());
  expect((applied.at(-1)!.kernel as number[]).filter((value) => value !== 0)).toEqual([1]);
});

it("路径模糊的起止点标量不重复出现在参数列表里", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.blurGallery.pathBlur");
  // 有 `paths` 时内核只看 paths，标量只是兜底：两条控制同时存在会让改标量静默失效。
  for (const key of ["startX", "startY", "endX", "endY", "speed", "taper"]) {
    expect(container.querySelector(`[data-filter-param="${key}"]`)).toBeNull();
  }
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加路径"))!.click());
  const paths = applied.at(-1)!.paths as { points: [number, number][]; speed: number }[];
  expect(paths).toHaveLength(2);
  // 第二条路径沿用当前速度/锥度作为初值。
  expect(paths[1]!.speed).toBe(50);
  expect(paths[1]!.points).toEqual([[0.2, 0.5], [0.8, 0.5]]);
  // 移除回到一条：至少留一条路径，否则没有几何。
  act(() => [...container.querySelectorAll("button")].filter((node) => node.textContent?.startsWith("移除路径"))[1]!.click());
  expect((applied.at(-1)!.paths as unknown[]).length).toBe(1);
});

it("消失点空平面时给出提示，添加后按文档像素写回四个角点", () => {
  const { container, selectFilter, button, applied } = setup();
  selectFilter("filter.vanishingPoint");
  expect(container.querySelector("[data-filter-planes]")?.getAttribute("data-filter-planes")).toBe("0");
  act(() => button("添加平面").click());
  const planes = applied.at(-1)!.planes as { corners: [number, number][] }[];
  expect(planes).toHaveLength(1);
  expect(planes[0]!.corners).toEqual([[200, 100], [800, 100], [800, 400], [200, 400]]);
  // 改一个角点：写回的是像素坐标，且夹在画布内。
  const first = container.querySelector<HTMLInputElement>("[data-filter-plane='0'] input[type='number']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(first), "value")!.set!;
    setter.call(first, "5000");
    first.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((applied.at(-1)!.planes as { corners: [number, number][] }[])[0]!.corners[0]![0]).toBe(1000);
});

it("镜头校正的拉直线按文档像素添加、编辑与清除", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.lensCorrection");
  const editor = container.querySelector("[data-filter-straighten]")!;
  // 没有拉直线时只给「添加」，不假装已有一条水平线。
  expect(editor.getAttribute("data-filter-straighten")).toBe("none");
  expect(applied).toHaveLength(0);
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加拉直线"))!.click());
  // 默认线贯穿画面中部（画布 1000×500），是「不旋转」的参考。
  expect(applied.at(-1)!.straighten).toEqual([[250, 250], [750, 250]]);
  expect(container.querySelector("[data-filter-straighten]")!.getAttribute("data-filter-straighten")).toBe("set");
  // 改终点 Y：写回的是整数文档像素，并被夹在画布内。
  const input = container.querySelector<HTMLInputElement>("[data-filter-straighten] input[type='number']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, "-40");
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((applied.at(-1)!.straighten as number[][])[0]).toEqual([0, 250]);
  // 清除：删掉字段而不是写 null。
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("清除拉直线"))!.click());
  expect(applied.at(-1)).not.toHaveProperty("straighten");
  expect(container.querySelector("[data-filter-straighten]")!.getAttribute("data-filter-straighten")).toBe("none");
});

it("自适应广角的约束线可添加并按文档像素写回参数", () => {
  const { selectFilter, button, applied } = setup();
  selectFilter("filter.adaptiveWideAngle");
  act(() => button("添加约束线").click());
  const constraints = applied.at(-1)!.constraints as { a: [number, number]; b: [number, number]; orientation: string }[];
  expect(constraints).toEqual([{ a: [100, 250], b: [900, 250], orientation: "horizontal" }]);
});

it("置换滤镜列出已打开文档，选中后写回 mapDocument 而不是本机路径", () => {
  const { container, selectFilter, applied } = setup();
  selectFilter("filter.distort.displace");
  const picker = container.querySelector("[data-filter-map]")!;
  const select = picker.querySelector<HTMLSelectElement>("select")!;
  // 候选就是会话里已打开的文档，没有本机路径选项。
  expect([...select.options].map((option) => option.value)).toEqual(["", "底图.pcraft", "位移图.pcraft"]);
  expect(select.textContent).toContain("800×600");

  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")!.set!;
    setter.call(select, "位移图.pcraft");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(applied.at(-1)!.mapDocument).toBe("位移图.pcraft");
  expect(applied.at(-1)!.mapPath).toBeUndefined();
  expect(picker.getAttribute("data-filter-map")).toBe("位移图.pcraft");

  // 选回占位项：来源被清掉，不会留下上一次的文档名。
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")!.set!;
    setter.call(select, "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(applied.at(-1)!.mapDocument).toBeUndefined();
});

it("位移图来源读取失败时不画半套选择器，给出可读原因", () => {
  const { container, selectFilter } = setup({ sources: { ok: false as const, message: "当前运行时不支持位移图来源" } });
  selectFilter("filter.distort.displace");
  expect(container.querySelector("[data-filter-map]")).toBeNull();
  expect(container.textContent).toContain("当前运行时不支持位移图来源");
});

it("位移图来源可显式刷新，新开的文档才会出现在候选里", () => {
  const first = [{ index: 0, name: "底图.pcraft", width: 1000, height: 500, active: true, layers: [] }];
  const { container, selectFilter, port, button } = setup({ sources: { ok: true as const, value: first } });
  selectFilter("filter.distort.displace");
  const select = () => container.querySelector<HTMLSelectElement>("[data-filter-map] select")!;
  expect([...select().options].map((option) => option.value)).toEqual(["", "底图.pcraft"]);
  // 面板挂载期间又打开了一份文档：不重挂面板也能把新来源读进来。
  port.filterMapSources.mockReturnValue({
    ok: true as const,
    value: [...first, { index: 1, name: "新文档.pcraft", width: 320, height: 240, active: false, layers: [] }]
  } as never);
  act(() => button("刷新来源").click());
  expect([...select().options].map((option) => option.value)).toEqual(["", "底图.pcraft", "新文档.pcraft"]);
});

it("位移图来源端口缺失时说明为什么选不了来源，也不画空下拉框", () => {
  const { container, selectFilter } = setup({ noMapPort: true });
  selectFilter("filter.distort.displace");
  expect(container.querySelector("[data-filter-map]")).toBeNull();
  expect(container.textContent).toContain("位移图来源不可用");
});

it("草稿里的位移图不在候选列表时回落到占位项，并说明该文档已关闭", () => {
  const draft = { filter: "filter.distort.displace", label: "置换", category: "扭曲", kind: "Simple", layer: 1, params: { horizontal: 6, vertical: 6, mapDocument: "已关闭.pcraft" } };
  const { container } = setup({ draft });
  const select = container.querySelector<HTMLSelectElement>("[data-filter-map] select")!;
  expect(select.value).toBe("");
  // 不能让用户以为来源还在：明确说出哪一份文档已经不在了。
  expect(container.querySelector("[data-filter-map]")!.textContent).toContain("已关闭.pcraft");
});

it("Camera Raw 的曲线/HSL/分级控件都在，改动会送进内核", () => {
  const { container, beginnings, updates, selectFilter, setParam } = setup();
  selectFilter("filter.cameraRaw");
  // 标量参数与结构型控件并存：曝光仍是普通滑杆，曲线等由专门编辑器负责。
  expect(container.querySelector("[data-filter-param='exposure']")).not.toBeNull();
  // 四条声明过的曲线通道都要画出来；未声明的通道不画。
  expect([...container.querySelectorAll("[data-filter-curve]")].map((node) => node.getAttribute("data-filter-curve")))
    .toEqual(["pointCurve", "pointCurveRed"]);
  expect(container.querySelectorAll("[data-filter-hsl-channel]")).toHaveLength(3);
  expect([...container.querySelectorAll("[data-filter-grade]")].map((node) => node.getAttribute("data-filter-grade")))
    .toEqual(["gradeShadows", "gradeGlobal"]);
  expect(container.querySelector("[data-filter-curve-splits]")).not.toBeNull();

  setParam("exposure", 1);
  expect(beginnings.at(-1)).toMatchObject({ id: "filter.cameraRaw", params: { exposure: 1 } });

  // 曲线：点「添加点」写出有序的三点曲线；再清空即回到「不调整」。
  const curve = container.querySelector("[data-filter-curve='pointCurve']")!;
  act(() => [...curve.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加点"))!.click());
  expect(updates.at(-1)!.pointCurve).toEqual([[0, 0], [128, 128], [255, 255]]);
  act(() => [...curve.querySelectorAll("button")].find((node) => node.textContent?.startsWith("清空曲线"))!.click());
  expect(updates.at(-1)!.pointCurve).toEqual([]);

  // HSL：8 段滑杆，改第一段写出定长 8 数组。
  const band = container.querySelector("[data-filter-hsl-channel='hslSat']")!;
  const slider = band.querySelector<HTMLInputElement>("input[type='range']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(slider), "value")!.set!;
    setter.call(slider, "-40");
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(updates.at(-1)!.hslSat).toEqual([-40, 0, 0, 0, 0, 0, 0, 0]);

  // 分级转盘：三个滑杆（色相/饱和/明度），改色相写出 {hue,sat,lum}。
  const wheel = container.querySelector("[data-filter-grade='gradeShadows']")!;
  const hue = wheel.querySelector<HTMLInputElement>("input[type='range']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hue), "value")!.set!;
    setter.call(hue, "200");
    hue.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(updates.at(-1)!.gradeShadows).toEqual({ hue: 200, sat: 0, lum: 0 });

  // 分离点：三个数字框，越界被邻居夹住而不是送给内核。
  const splits = [...container.querySelectorAll<HTMLInputElement>("[data-filter-curve-splits] input")];
  expect(splits).toHaveLength(3);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(splits[0]!), "value")!.set!;
    setter.call(splits[0]!, "99");
    splits[0]!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((updates.at(-1)!.curveSplits as number[])[0]).toBe(50);
});

it("Camera Raw 的曲线控件不碰未声明的通道", () => {
  const { container, applied, selectFilter } = setup();
  selectFilter("filter.cameraRaw");
  const curve = container.querySelector("[data-filter-curve='pointCurve']")!;
  act(() => [...curve.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加点"))!.click());
  // 绿通道没有声明：写回时不能凭空多出 pointCurveGreen（内核会以「没有该参数」拒绝）。
  expect(applied.at(-1)).not.toHaveProperty("pointCurveGreen");
});

it("光照效果的光源组可增删，颜色与位置按内核字段写回", () => {
  const { container, applied, selectFilter } = setup();
  selectFilter("filter.render.lightingEffects");
  const lights = container.querySelector("[data-filter-lights]")!;
  // 没有光源时不画空的编辑器（否则用户以为已经有灯）。
  expect(lights.getAttribute("data-filter-lights")).toBe("0");
  act(() => [...lights.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加光源"))!.click());
  const written = applied.at(-1)!.lights as Record<string, unknown>[];
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ kind: "spot", x: 0.25, y: 0.2, intensity: 75, color: [255, 255, 255] });

  // 改强度会重写整组光源（只改目标灯）。
  const slider = container.querySelector("[data-filter-light='0'] input[type='range']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(slider), "value")!.set!;
    setter.call(slider, "0.4");
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((applied.at(-1)!.lights as { x: number }[])[0]!.x).toBe(0.4);

  // 只有一盏时「移除光源」是禁用的：空列表会让内核退回顶层单灯字段。
  const remove = [...container.querySelectorAll("[data-filter-light='0'] button")].find((node) => node.textContent?.startsWith("移除光源")) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);

  // 没有声明 lights 的命令不画光源编辑器。
  selectFilter("filter.sharpen.unsharpMask");
  expect(container.querySelector("[data-filter-lights]")).toBeNull();
});

it("消失点的透视克隆：有平面才出现，加一笔就按文档像素写回", () => {
  const { container, applied, selectFilter } = setup();
  selectFilter("filter.vanishingPoint");
  // 没有平面时不画克隆编辑器（内核会以「先给 planes」拒绝整条命令）。
  expect(container.querySelector("[data-filter-clones]")).toBeNull();
  expect(container.textContent).toContain("先画一个透视平面");

  const plane = container.querySelector("[data-filter-planes]")!;
  act(() => [...plane.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加平面"))!.click());
  const clones = container.querySelector("[data-filter-clones]")!;
  expect(clones.getAttribute("data-filter-clones")).toBe("0");
  act(() => [...clones.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加透视克隆"))!.click());
  // 文档是 1000×500：新笔画落在文档像素上，而不是 0–1 相对值。
  const written = applied.at(-1)!.clone as { source: number[]; points: number[][] }[];
  expect(written).toHaveLength(1);
  expect(written[0]!.source).toEqual([125, 88]);
  expect(written[0]!.points).toHaveLength(2);

  // 改来源 X 会重写整组克隆，另一轴保持不变。
  const sourceX = container.querySelector<HTMLInputElement>("[data-filter-clone='0'] input[type='number']")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sourceX), "value")!.set!;
    setter.call(sourceX, "300");
    sourceX.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const after = applied.at(-1)!.clone as { source: number[] }[];
  expect(after[0]!.source[0]).toBe(300);
  expect(after[0]!.source[1]).toBe(written[0]!.source[1]);

  // 移除后字段消失（不再落笔），而不是留下空数组。
  const removeCloneButton = [...container.querySelectorAll<HTMLButtonElement>("[data-filter-clone='0'] button")]
    .find((node) => node.textContent?.startsWith("移除克隆"))!;
  act(() => removeCloneButton.click());
  expect(applied.at(-1)).not.toHaveProperty("clone");
});

it("消失点的透视粘贴：来源图层来自端口，默认用活动图层", () => {
  const { container, applied, selectFilter, setNative, chooseIn } = setup();
  selectFilter("filter.vanishingPoint");
  // 没有平面时粘贴无处可贴，连编辑器都不画。
  expect(container.querySelector("[data-filter-pastes]")).toBeNull();
  const plane = container.querySelector("[data-filter-planes]")!;
  act(() => [...plane.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加平面"))!.click());
  const pastes = container.querySelector("[data-filter-pastes]")!;
  expect(pastes.getAttribute("data-filter-pastes")).toBe("0");

  act(() => [...pastes.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加粘贴"))!.click());
  const written = applied.at(-1)!.paste as Record<string, unknown>[];
  expect(written).toHaveLength(1);
  // 默认来源是活动图层 1，不是剪贴板：没有剪贴板内容时内核会直接拒绝。
  expect(written[0]).toMatchObject({ plane: 0, layer: 1, at: [0.5, 0.5], width: 0.5 });

  // 切到剪贴板：`layer` 字段必须消失（内核把 null 当非法类型）。
  const source = [...container.querySelectorAll<HTMLSelectElement>("[data-filter-paste='0'] select")][1]!;
  chooseIn(source, "");
  expect((applied.at(-1)!.paste as Record<string, unknown>[])[0]).not.toHaveProperty("layer");

  // 改回指定图层，再调宽度：每次都会重写整组粘贴。
  chooseIn(source, "2");
  expect((applied.at(-1)!.paste as { layer: number }[])[0]!.layer).toBe(2);
  const width = [...container.querySelectorAll<HTMLInputElement>("[data-filter-paste='0'] input[type='range']")].at(-1)!;
  act(() => {
    setNative(width, "0.8");
    width.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((applied.at(-1)!.paste as { width: number }[])[0]!.width).toBe(0.8);

  // 移除后字段消失。
  const remove = [...container.querySelectorAll<HTMLButtonElement>("[data-filter-paste='0'] button")]
    .find((node) => node.textContent?.startsWith("移除粘贴"))!;
  act(() => remove.click());
  expect(applied.at(-1)).not.toHaveProperty("paste");
});

it("粘贴端口缺失时说明只能用剪贴板，不画空下拉", () => {
  const { container, selectFilter } = setup({ noLayerPort: true });
  selectFilter("filter.vanishingPoint");
  act(() => [...container.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加平面"))!.click());
  const pastes = container.querySelector("[data-filter-pastes]")!;
  expect(pastes.textContent).toContain("不提供图层来源");
  // 加一条也仍然可以（走剪贴板），但下拉里没有图层候选。
  act(() => [...pastes.querySelectorAll("button")].find((node) => node.textContent?.startsWith("添加粘贴"))!.click());
  const options = [...container.querySelectorAll<HTMLSelectElement>("[data-filter-paste='0'] select")][1]!;
  expect([...options.options].map((option) => option.textContent)).toEqual(["剪贴板"]);
});

it("火焰的路径选择器：默认跟随工作路径，选了名字就写 path", () => {
  const { container, applied, selectFilter, chooseIn } = setup();
  // 没声明 path 的命令不画路径选择器。
  selectFilter("filter.sharpen.unsharpMask");
  expect(container.querySelector("[data-filter-flame-path]")).toBeNull();

  selectFilter("filter.render.flame");
  const wrapper = container.querySelector("[data-filter-flame-path]")!;
  expect(wrapper.getAttribute("data-filter-flame-path")).toBe("ready");
  const select = wrapper.querySelector("select")!;
  // 默认项跟随工作路径，不写 path 字段。
  expect([...select.options].map((option) => option.value)).toEqual(["", "路径 1", "路径 2"]);
  expect(select.options[0]!.textContent).toContain("工作路径");

  chooseIn(select, "路径 2");
  expect(applied.at(-1)!.path).toBe("路径 2");
  // 选回默认项时字段必须消失，而不是留空串（空串会让内核去找叫空名字的路径）。
  chooseIn(select, "");
  expect(applied.at(-1)).not.toHaveProperty("path");
});

it("路径端口缺失时说明只能跟随默认路径", () => {
  const { container, selectFilter } = setup({ noPathPort: true });
  selectFilter("filter.render.flame");
  const wrapper = container.querySelector("[data-filter-flame-path]")!;
  expect(wrapper.getAttribute("data-filter-flame-path")).toBe("unavailable");
  expect(wrapper.textContent).toContain("不提供路径列表");
  expect(wrapper.querySelector("select")).toBeNull();
});

it("没有工作路径时默认项改成第一条已保存路径", () => {
  const { container, selectFilter } = setup({ paths: { ok: true, value: { paths: ["仅此一条"], hasWorkPath: false } } });
  selectFilter("filter.render.flame");
  const select = container.querySelector<HTMLSelectElement>("[data-filter-flame-path] select")!;
  expect([...select.options].map((option) => option.textContent)).toEqual(["第一条已保存路径（默认）", "仅此一条"]);
});

it("切变面板：没有自定义曲线时显示 amount 生成的缺省曲线，改动即接管", () => {
  const { container, selectFilter, applied, setNative, button } = setup();
  selectFilter("filter.distort.shear");
  const editor = container.querySelector("[data-filter-shear]")!;
  // 未自定义：状态是 `amount`，但仍画出内核会用的三点曲线（用户才知道拖哪一行）。
  expect(editor.getAttribute("data-filter-shear")).toBe("amount");
  expect(editor.querySelectorAll("[data-filter-shear-point]")).toHaveLength(3);
  expect(container.textContent).toContain("amount=0");
  // 「改用 amount」在未自定义时不可点：没有可交还的曲线。
  expect(button("改用 amount").disabled).toBe(true);

  // 拖中间点的位移：写回自定义曲线，amount 不再决定形状。
  const middle = editor.querySelectorAll<HTMLInputElement>("[data-filter-shear-point='1'] input[type='number']")[1]!;
  act(() => {
    setNative(middle, "0.4");
    middle.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(applied.at(-1)!.points).toEqual([[0, 0], [0.5, 0.4], [1, 0]]);
  expect(container.querySelector("[data-filter-shear]")!.getAttribute("data-filter-shear")).toBe("custom");

  // 「改用 amount」把曲线交还：删字段并把 amount 归零，不会跳回旧形状。
  act(() => button("改用 amount").click());
  expect(applied.at(-1)).not.toHaveProperty("points");
  expect(applied.at(-1)!.amount).toBe(0);
});

it("位移图图层：候选来自选中的那份文档，选中后写回 mapLayer", () => {
  const { container, selectFilter, applied, chooseIn } = setup();
  selectFilter("filter.distort.displace");
  const selects = () => [...container.querySelectorAll<HTMLSelectElement>("[data-filter-map] select")];
  const [docSelect, layerSelect] = selects();
  // 没选文档时图层下拉只有「整份文档」一档，且不可点。
  expect([...layerSelect!.options].map((option) => option.value)).toEqual([""]);
  expect(layerSelect!.disabled).toBe(true);

  chooseIn(docSelect!, "位移图.pcraft");
  expect(applied.at(-1)!.mapDocument).toBe("位移图.pcraft");
  expect([...selects()[1]!.options].map((option) => option.value)).toEqual(["", "7", "8"]);
  expect(selects()[1]!.textContent).toContain("位移层");

  chooseIn(selects()[1]!, "8");
  expect(applied.at(-1)!.mapLayer).toBe(8);

  // 换文档必须清掉旧文档的图层号（内核会拿它去新文档里找图层）。
  chooseIn(selects()[0]!, "底图.pcraft");
  expect(applied.at(-1)!.mapLayer).toBeUndefined();
  expect(applied.at(-1)!.mapDocument).toBe("底图.pcraft");

  // 选回「整份文档」删字段而不是写 0（0 会被当成不存在的图层）。
  chooseIn(selects()[0]!, "位移图.pcraft");
  chooseIn(selects()[1]!, "7");
  chooseIn(selects()[1]!, "");
  expect(applied.at(-1)).not.toHaveProperty("mapLayer");
});

it("霓虹光晕的颜色在画廊栈里有控件，改动写回 glowColor", () => {
  const { container, selectFilter, applied, setNative } = setup();
  selectFilter("filter.filterGallery");
  // 把栈里的效果换成霓虹光晕。
  const effectSelect = container.querySelector<HTMLSelectElement>("[data-filter-effect] select")!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(effectSelect), "value")!.set!;
  act(() => {
    setter.call(effectSelect, "neonGlow");
    effectSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const colour = container.querySelector<HTMLInputElement>("[data-gallery-color='glowColor'] input[type='color']")!;
  expect(colour).not.toBeNull();
  act(() => {
    setNative(colour, "#ff0000");
    colour.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const effects = applied.at(-1)!.effects as { filter: string; params: Record<string, unknown> }[];
  expect(effects[0]!.params.glowColor).toBe("#ff0000");
});
