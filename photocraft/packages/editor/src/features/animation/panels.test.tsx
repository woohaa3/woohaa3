/**
 * 动画域面板回归（U77）。
 *
 * 用替身控制器覆盖：草稿门禁（写入被阻、导航放行）、播放不新增历史、失败保留现场、
 * 交付计划与 GIF 下载，以及无 codec 端口时禁用视频入口并给出原因。
 * 不加载真实 wasm、不采集渲染。
 */
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelinePanel } from "./panels.js";
import { animationCodecPort, setAnimationCodecPort } from "./codec.js";
import { decodeFrameImages } from "./frame-decoder.js";
import type { AnimationCodecPort } from "@woohaa3/photocraft-protocol";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Failure = { ok: false; code: string; message: string };

const VIEW = { hasDocument: true, document: { name: "art", width: 8, height: 8, activeLayerId: 1, revision: 1 } };

/** 记录调用的域会话替身（与 `controller.features.animation` 同形）。 */
function fakeController(options: {
  blocked?: Failure;
  historyAdded?: number;
  timeline?: boolean;
  videoLayers?: boolean;
  hasOriginal?: boolean;
  flush?: Record<string, unknown>;
  budget?: { maxFrames?: number; maxCumulativeFramePixels?: number; maxDecodeBytes?: number };
} = {}) {
  const calls: string[] = [];
  let timeline = options.timeline === false
    ? null
    : { fps: 24, duration: 3, current: 0, workStart: 0, workEnd: 3, time: 0 };
  // 默认有一个活动视频层（`VIEW.document.activeLayerId` 指向它），帧编辑才可用。
  const videoLayers = options.videoLayers === false
    ? []
    : [{ layerId: 1, name: "Video", frames: 3, fps: 24, showAltered: true, hasOriginal: options.hasOriginal === true }];
  const blocked = options.blocked;
  const write = <T,>(name: string, value: T) => {
    if (blocked) return blocked;
    calls.push(name);
    return { ok: true as const, value };
  };
  const animation = {
    timelineInfo: () => ({
      ok: true as const,
      value: {
        timeline,
        budget: {
          maxFrames: options.budget?.maxFrames ?? 120,
          maxCumulativeFramePixels: options.budget?.maxCumulativeFramePixels ?? 16_777_216,
          maxDecodeBytes: options.budget?.maxDecodeBytes ?? 134_217_728,
          maxDeliveryBytes: 134_217_728,
          maxFps: 1000
        },
        videoLayers
      }
    }),
    createTimeline: () => write("createTimeline", VIEW),
    setTimelineProps: (params: Record<string, unknown>) => write(`setTimelineProps:${JSON.stringify(params)}`, VIEW),
    deleteTimeline: () => write("deleteTimeline", VIEW),
    navigateTimeline: (id: string, params: { frame?: number }) => {
      calls.push(`navigate:${id}:${params.frame ?? ""}`);
      const current = params.frame ?? ((timeline?.current as number) ?? 0) + 1;
      if (timeline) timeline = { ...timeline, current };
      return { ok: true as const, value: { result: null, historyAdded: options.historyAdded ?? 0, view: VIEW } };
    },
    videoLayerCommand: (id: string, params: Record<string, unknown>) => write(`video:${id}:${JSON.stringify(params)}`, VIEW),
    importFrames: (request: { width: number; height: number; frameCount: number; pixels: Uint8Array }) => {
      calls.push(`import:${request.frameCount}:${request.pixels.length}`);
      if (blocked) return blocked;
      return { ok: true as const, value: { imported: { layer: 1, frames: request.frameCount, width: request.width, height: request.height, fps: 24, duration: request.frameCount }, view: VIEW } };
    },
    deliveryPlan: () => (blocked ? blocked : { ok: true as const, value: { frames: 3, width: 8, height: 8, fpsMillis: 42, frameBytes: 256, totalBytes: 768 } }),
    renderFrame: (frame: number) => (blocked ? blocked : { ok: true as const, value: new Uint8Array(8 * 8 * 4).fill(frame) }),
    renderAnimationGif: () => (blocked ? blocked : { ok: true as const, value: new Uint8Array([71, 73, 70, 56]) }),
    flushVideoFrames: () => {
      calls.push("flushVideoFrames");
      return blocked ? blocked : { ok: true as const, value: { flushed: options.flush ?? { written: false, reason: "unchanged" } } };
    }
  };
  const controller = {
    features: { animation },
    currentView: () => VIEW,
    dispatch: (id: string) => { calls.push(`dispatch:${id}`); return { ok: true as const, value: VIEW }; },
    fail: (failure: Failure) => failure,
    unavailable: () => ({ ok: false as const, code: "no-document", message: "未加载" }),
    afterWrite: () => ({ ok: true as const, value: VIEW })
  };
  return { calls, controller };
}

function render(controller: unknown) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<TimelinePanel controller={controller as never} readonly={false} />));
  const button = (label: string) => [...container.querySelectorAll("button")].find(entry => entry.textContent === label) as HTMLButtonElement | undefined;
  return {
    container,
    button,
    /** 让异步协商（真实端口是 `isConfigSupported`）落定，再断言入口可用性。 */
    settle: async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); },
    cleanup: () => { act(() => root.unmount()); container.remove(); }
  };
}

afterEach(() => { setAnimationCodecPort(null); vi.unstubAllGlobals(); });

describe("时间轴面板", () => {
  it("渲染当前帧与帧率，帧编辑与时间轴写入经域会话", () => {
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      expect(view.container.textContent).toContain("第 1 / 3 帧");
      expect(view.container.textContent).toContain("24 fps");
      act(() => view.button("下一帧")!.click());
      expect(calls.some(call => call.startsWith("navigate:timeline.nextFrame"))).toBe(true);
      act(() => view.button("复制当前帧")!.click());
      expect(calls).toContain('video:layer.videoLayers.duplicateFrame:{}');
      act(() => view.button("应用")!.click());
      expect(calls.some(call => call.startsWith("setTimelineProps:"))).toBe(true);
      act(() => view.button("交付计划")!.click());
      expect(view.container.textContent).toContain("3 帧 · 8×8");
    } finally { view.cleanup(); }
  });

  it("没有时间轴时只提供建立入口", () => {
    const { calls, controller } = fakeController({ timeline: false });
    const view = render(controller);
    try {
      expect(view.button("建立时间轴")).toBeDefined();
      expect(view.button("下一帧")).toBeUndefined();
      act(() => view.button("建立时间轴")!.click());
      expect(calls).toContain("createTimeline");
    } finally { view.cleanup(); }
  });

  it("有视频层但没有时间轴时提示帧栈不可导航，而不是假装完整可用", () => {
    const { controller } = fakeController({ timeline: false });
    const view = render(controller);
    try {
      const note = view.container.querySelector("[data-animation-missing-timeline]");
      expect(note?.textContent).toContain("建立时间轴后才能播放与定位到其它帧");
      // 提示不阻止先建时间轴：这是跨文档粘贴后唯一的恢复路径。
      expect(view.button("建立时间轴")!.disabled).toBe(false);
    } finally { view.cleanup(); }
  });

  it("有时间轴时不再提示缺少时间轴", () => {
    const { controller } = fakeController();
    const view = render(controller);
    try {
      expect(view.container.querySelector("[data-animation-missing-timeline]")).toBeNull();
    } finally { view.cleanup(); }
  });

  it("草稿活动时写入被拒并显示原因，导航仍可用", () => {
    const blocked: Failure = { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
    const { calls, controller } = fakeController({ blocked });
    const view = render(controller);
    try {
      act(() => view.button("复制当前帧")!.click());
      expect(view.container.textContent).toContain("请先结束当前笔迹");
      // 写入没有落到内核。
      expect(calls.some(call => call.startsWith("video:"))).toBe(false);
      // 导航不受草稿门禁影响。
      act(() => view.button("下一帧")!.click());
      expect(calls.some(call => call.startsWith("navigate:timeline.nextFrame"))).toBe(true);
    } finally { view.cleanup(); }
  });

  it("播放发现历史被推进时立即停止并报错", () => {
    vi.useFakeTimers();
    const { controller } = fakeController({ historyAdded: 1 });
    const view = render(controller);
    try {
      act(() => view.button("播放")!.click());
      expect(view.container.textContent).toContain("播放中…");
      act(() => { vi.advanceTimersByTime(100); });
      expect(view.container.textContent).toContain("播放意外新增了历史步骤");
      expect(view.container.textContent).not.toContain("播放中…");
    } finally { view.cleanup(); vi.useRealTimers(); }
  });

  it("播放跨多帧继续：每次导航推进修订不得把播放停掉", () => {
    vi.useFakeTimers();
    // 替身的 `currentView()` 用固定 revision；这里显式模拟「导航推进修订」的真实内核行为。
    let revision = 1;
    const { calls, controller } = fakeController();
    const view = render({
      ...controller,
      currentView: () => ({ ...VIEW, document: { ...VIEW.document, revision } })
    });
    try {
      const navigate = controller.features.animation.navigateTimeline;
      controller.features.animation.navigateTimeline = (id: string, params: { frame?: number }) => {
        revision += 1;
        return navigate(id, params);
      };
      act(() => view.button("播放")!.click());
      act(() => { vi.advanceTimersByTime(300); });
      // 至少走过两帧，且仍在播放（修订号变化不是「切文档」）。
      expect(calls.filter(call => call.startsWith("navigate:timeline.setFrame")).length).toBeGreaterThan(1);
      expect(view.button("停止")).toBeDefined();
    } finally { view.cleanup(); vi.useRealTimers(); }
  });

  it("活动图层不是视频层时帧编辑禁用并提示先选中视频层", () => {
    const { calls, controller } = fakeController({ videoLayers: false });
    const view = render(controller);
    try {
      // 没有视频层时：新建可用，其余帧编辑没有目标。
      expect(view.button("新建空白视频层")!.disabled).toBe(false);
      for (const label of ["插入空白帧", "复制当前帧", "删除当前帧", "栅格化视频层", "显示修帧结果", "恢复原始帧"]) {
        expect(view.button(label)!.disabled, label).toBe(true);
        expect(view.button(label)!.title).toContain("视频图层");
      }
      act(() => view.button("复制当前帧")!.click());
      expect(calls.some(call => call.startsWith("video:"))).toBe(false);
    } finally { view.cleanup(); }
  });

  /**
   * 没有原始素材副本时「恢复原始帧」必须禁用：内核会拒绝（上游实现是「取不到原始素材就写空白帧」，
   * 直接执行会把用户导入的帧清空）。界面禁用与内核拒绝必须同源，都用 `hasOriginal`。
   */
  it("没有原始素材时恢复帧入口禁用并说明，栅格化仍可执行", () => {
    const { calls, controller } = fakeController({ hasOriginal: false });
    const view = render(controller);
    try {
      for (const label of ["恢复原始帧", "恢复全部原始帧"]) {
        expect(view.button(label)!.disabled, label).toBe(true);
        expect(view.button(label)!.title).toContain("没有原始素材");
      }
      // 有原始素材的工程才开放恢复入口。
      expect(view.button("显示修帧结果")!.disabled).toBe(false);
      act(() => view.button("栅格化视频层")!.click());
      expect(calls).toContain("video:layer.videoLayers.rasterize:{}");
      act(() => view.button("显示修帧结果")!.click());
      expect(calls).toContain("video:layer.videoLayers.showAlteredVideo:{}");
    } finally { view.cleanup(); }
  });

  it("有原始素材时恢复帧入口可用", () => {
    const { calls, controller } = fakeController({ hasOriginal: true });
    const view = render(controller);
    try {
      expect(view.button("恢复原始帧")!.disabled).toBe(false);
      act(() => view.button("恢复原始帧")!.click());
      expect(calls).toContain("video:layer.videoLayers.restoreFrame:{}");
    } finally { view.cleanup(); }
  });

  it("视频层列表可切换活动目标，解释素材改的是视频层帧率", () => {
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      const target = view.container.querySelector<HTMLButtonElement>("[data-animation-select-video-layer]")!;
      expect(target).not.toBeNull();
      act(() => target.click());
      expect(calls).toContain("dispatch:layer.select");
      act(() => view.button("解释素材")!.click());
      expect(calls).toContain('video:layer.videoLayers.interpretFootage:{"fps":24}');
    } finally { view.cleanup(); }
  });

  it("工作区范围随「应用」写回，删除时间轴走域会话", () => {
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      act(() => view.button("删除时间轴")!.click());
      expect(calls).toContain("deleteTimeline");
      const starts = view.container.querySelectorAll<HTMLInputElement>('input[type="number"]');
      // 帧率/时长/工作区起/工作区止 都在面板里可编辑。
      expect([...starts].length).toBeGreaterThanOrEqual(4);
    } finally { view.cleanup(); }
  });

  it("写回当前帧给出内核报告（unchanged / 已写回）", () => {
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      act(() => view.button("写回当前帧")!.click());
      expect(calls).toContain("flushVideoFrames");
      expect(view.container.textContent).toContain("当前帧没有需要写回的修改");
      expect(view.container.textContent).not.toContain("已把画布内容写回当前帧");
    } finally { view.cleanup(); }
  });

  /**
   * 「显示原始素材」模式下作画是预览，写回被内核跳过（上游 #3060）。界面必须照内核给的原因
   * 说明，而不能报成「没有需要写回的修改」——否则用户以为已经保存，重开才发现编辑丢了。
   */
  it("原始视图下的编辑不写回时给出内核原因，不谎报「没有要写回的内容」", () => {
    const message = "「显示原始素材」模式下画布上的编辑不会写回帧栈：Video。请先切回「显示修帧结果」再作画或保存。";
    const { controller } = fakeController({ flush: { written: false, reason: "original-view-preview", message } });
    const view = render(controller);
    try {
      act(() => view.button("写回当前帧")!.click());
      expect(view.container.textContent).toContain("显示修帧结果");
      expect(view.container.textContent).not.toContain("当前帧没有需要写回的修改");
    } finally { view.cleanup(); }
  });

  it("草稿未结算时交付被拒，不渲染也不下载", async () => {
    const createObjectURL = vi.fn(() => "blob:gif");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this.download); };
    const blocked: Failure = { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
    try {
      const { controller } = fakeController({ blocked });
      const view = render(controller);
      try {
        act(() => view.button("交付计划")!.click());
        expect(view.container.textContent).toContain("请先结束当前笔迹");
        await act(async () => { view.button("导出动画 GIF")!.click(); await Promise.resolve(); });
        expect(clicked).toEqual([]);
        expect(createObjectURL).not.toHaveBeenCalled();
      } finally { view.cleanup(); }
    } finally { HTMLAnchorElement.prototype.click = originalClick; }
  });

  it("选择超过帧预算的图片帧时在解码前拒绝", async () => {
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[accept^="image/png"]')!;
      const files = Array.from({ length: 121 }, (_, index) => new File([new Uint8Array([index])], `${index}.png`, { type: "image/png" }));
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
      expect(view.container.textContent).toContain("选择的帧数超过上限：121 > 120 帧");
      expect(calls.some(call => call.startsWith("import:"))).toBe(false);
    } finally { view.cleanup(); }
  });

  it("累计像素/解码字节超预算也在解码前拒绝", async () => {
    // 8×8 画布 × 3 帧 = 192 像素 > 100：一个像素都不解码。
    const { calls, controller } = fakeController({ budget: { maxCumulativeFramePixels: 100 } });
    const view = render(controller);
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[accept^="image/png"]')!;
      const files = Array.from({ length: 3 }, (_, index) => new File([new Uint8Array([index])], `${index}.png`, { type: "image/png" }));
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
      expect(view.container.textContent).toContain("累计像素超过上限：192 > 100 像素");
      expect(calls.some(call => call.startsWith("import:"))).toBe(false);
    } finally { view.cleanup(); }
  });

  it("解码字节超预算同样在解码前拒绝", async () => {
    const { calls, controller } = fakeController({ budget: { maxDecodeBytes: 100 } });
    const view = render(controller);
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[accept^="image/png"]')!;
      const files = [new File([new Uint8Array([1])], "a.png", { type: "image/png" })];
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
      expect(view.container.textContent).toContain("解码字节超过上限：256 > 100 字节");
      expect(calls.some(call => call.startsWith("import:"))).toBe(false);
    } finally { view.cleanup(); }
  });

  it("无 codec 端口时视频入口禁用并说明原因，GIF 仍可用且可下载", () => {
    const createObjectURL = vi.fn(() => "blob:gif");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this.download); };

    const { controller } = fakeController();
    const view = render(controller);
    try {
      expect(view.button("导出视频")!.disabled).toBe(true);
      expect(view.container.textContent).toContain("未注册视频编解码端口");
      expect(animationCodecPort()).toBeNull();
      const gif = view.button("导出动画 GIF")!;
      expect(gif.disabled).toBe(false);
      act(() => gif.click());
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clicked).toEqual(["photocraft-animation.gif"]);
      expect(view.container.textContent).toContain("已导出动画 GIF");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:gif");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      view.cleanup();
    }
  });

  it("注册 codec 端口后视频入口可用，编码失败给出端口原因", async () => {
    const encode = vi.fn(async () => ({ ok: false as const, reason: "编码器不可用：缺少 H.264" }));
    const port: AnimationCodecPort = {
      supports: () => ({ supported: true, container: "mp4", codec: "avc1.42001f" }),
      decode: async () => ({ ok: false, reason: "未实现" }),
      encode,
      cancel: vi.fn()
    };
    setAnimationCodecPort(port);
    expect(animationCodecPort()).toBe(port);
    const { controller } = fakeController();
    const view = render(controller);
    try {
      await view.settle();
      const video = view.button("导出视频")!;
      expect(video.disabled).toBe(false);
      await act(async () => { video.click(); await Promise.resolve(); });
      expect(encode).toHaveBeenCalledTimes(1);
      expect(view.container.textContent).toContain("编码器不可用：缺少 H.264");
      // 未注册完整端口（缺 cancel）等于未注册。
      setAnimationCodecPort({ ...port, cancel: undefined } as unknown as AnimationCodecPort);
      expect(animationCodecPort()).toBeNull();
    } finally { view.cleanup(); }
  });

  it("无 codec 端口时视频导入入口禁用并说明原因", () => {
    const { controller } = fakeController();
    const view = render(controller);
    try {
      expect(view.button("导入视频…")!.disabled).toBe(true);
      expect(view.container.textContent).toContain("未注册视频编解码端口");
      expect(view.container.querySelector("[data-animation-video-import]")).not.toBeNull();
    } finally { view.cleanup(); }
  });

  it("协商未完成时视频入口保持禁用，不乐观宣称可用", async () => {
    // 真实宿主用 `VideoEncoder.isConfigSupported`（异步）；结果回来前不能让用户点到入口。
    // 编码与解码并行协商，两个 pending 都要落定。
    const pending: ((value: { supported: true; container: string; codec: string }) => void)[] = [];
    setAnimationCodecPort({
      supports: () => new Promise((done) => { pending.push(done); }),
      decode: async () => ({ ok: false, reason: "不测" }),
      encode: async () => ({ ok: false, reason: "不测" }),
      cancel: vi.fn()
    });
    const { controller } = fakeController();
    const view = render(controller);
    try {
      expect(view.button("导出视频")!.disabled).toBe(true);
      expect(view.container.textContent).toContain("正在协商宿主视频编码能力");
      await act(async () => {
        for (const done of pending) done({ supported: true, container: "mp4", codec: "avc1" });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(view.button("导出视频")!.disabled).toBe(false);
      expect(view.container.textContent).not.toContain("正在协商宿主视频编码能力");
    } finally { view.cleanup(); }
  });

  it("只支持 WebM 的宿主仍可导入/导出，导出使用协商到的容器", async () => {
    const encode = vi.fn(async (_request: { container?: string }) => ({ ok: true as const, container: "webm", bytes: new Uint8Array([1, 2, 3]) }));
    const decode = vi.fn(async () => ({ ok: false as const, reason: "源文件损坏" }));
    const port: AnimationCodecPort = {
      supports: ({ direction, container }) =>
        container === "webm"
          ? { supported: true, container: "webm", codec: direction === "encode" ? "vp9" : "vp9" }
          : { supported: false, reason: `不支持 ${container ?? "未指定容器"}` },
      decode,
      encode,
      cancel: vi.fn()
    };
    setAnimationCodecPort(port);
    const { controller } = fakeController();
    const view = render(controller);
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this.download); };
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:webm"), revokeObjectURL: vi.fn() });
    try {
      await view.settle();
      expect(view.button("导出视频")!.disabled).toBe(false);
      expect(view.button("导入视频…")!.disabled).toBe(false);
      await act(async () => { view.button("导出视频")!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(encode).toHaveBeenCalledTimes(1);
      const request = encode.mock.calls[0]![0] as { container?: string };
      expect(request.container).toBe("webm");
      expect(clicked).toEqual(["photocraft-animation.webm"]);
      expect(view.container.textContent).toContain("已导出 WEBM");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      view.cleanup();
    }
  });

  it("视频导入走宿主端口整段解码，帧数与像素都交给内核", async () => {
    const decode = vi.fn(async () => ({
      ok: true as const,
      width: 8,
      height: 8,
      fps: 12,
      frames: [new Uint8Array(8 * 8 * 4).fill(1), new Uint8Array(8 * 8 * 4).fill(2)]
    }));
    setAnimationCodecPort({
      supports: () => ({ supported: true, container: "mp4", codec: "avc1.42001f" }),
      decode,
      encode: async () => ({ ok: false, reason: "不测" }),
      cancel: vi.fn()
    });
    const { calls, controller } = fakeController();
    const view = render(controller);
    try {
      await view.settle();
      const input = view.container.querySelector<HTMLInputElement>('input[accept^="video/mp4"]')!;
      expect(input.disabled).toBe(false);
      const file = new File([new Uint8Array([0, 0, 0, 8])], "clip.mp4", { type: "video/mp4" });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(decode).toHaveBeenCalledTimes(1);
      expect(calls).toContain(`import:2:${8 * 8 * 4 * 2}`);
      expect(view.container.textContent).toContain("已从视频导入 2 帧");
    } finally { view.cleanup(); }
  });

  it("只读时所有写入入口禁用，读取（交付计划）仍可用", () => {
    const { calls, controller } = fakeController();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<TimelinePanel controller={controller as never} readonly />));
    try {
      const disabled = (label: string) => [...container.querySelectorAll("button")].find(entry => entry.textContent === label) as HTMLButtonElement;
      for (const label of ["上一帧", "下一帧", "播放", "应用", "删除时间轴", "复制当前帧", "导入帧…"]) {
        expect(disabled(label).disabled, label).toBe(true);
      }
      // 交付是只读操作（渲染快照、不写文档），只读时不阻止。
      for (const label of ["交付计划", "导出帧序列", "导出动画 GIF"]) {
        expect(disabled(label).disabled, label).toBe(false);
      }
      act(() => disabled("交付计划").click());
      expect(container.textContent).toContain("3 帧 · 8×8");
      expect(calls.some(call => call.startsWith("video:") || call.startsWith("navigate:"))).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("无 codec 端口时也能导出帧序列（逐帧 PNG）", async () => {
    const createObjectURL = vi.fn(() => "blob:png");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this.download); };
    try {
      const { controller } = fakeController();
      const view = render(controller);
      try {
        expect(animationCodecPort()).toBeNull();
        const button = view.button("导出帧序列")!;
        expect(button.disabled).toBe(false);
        await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
        // jsdom 没有 canvas/OffscreenCanvas：编码失败必须给出帧号原因，且不下载任何文件。
        expect(view.container.textContent).toMatch(/第 \d+ 帧 PNG 编码失败/);
        expect(clicked).toEqual([]);
      } finally { view.cleanup(); }
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it("取消在飞的编码请求后不下载、不报成功", async () => {
    const createObjectURL = vi.fn(() => "blob:mp4");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    let resolve: ((value: { ok: true; container: string; bytes: Uint8Array }) => void) | null = null;
    const cancel = vi.fn();
    const encode = vi.fn(() => new Promise<{ ok: true; container: string; bytes: Uint8Array }>((done) => { resolve = done; }));
    setAnimationCodecPort({
      supports: () => ({ supported: true, container: "mp4", codec: "avc1.42001f" }),
      decode: async () => ({ ok: false, reason: "不测" }),
      encode: encode as unknown as AnimationCodecPort["encode"],
      cancel
    });
    const { controller } = fakeController();
    const view = render(controller);
    try {
      await view.settle();
      act(() => view.button("导出视频")!.click());
      // 在飞时出现「取消」按钮，点了以后端口收到 cancel。
      const cancelButton = view.button("取消");
      expect(cancelButton).toBeDefined();
      act(() => cancelButton!.click());
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(view.container.textContent).toContain("已取消当前的动画交付请求");
      // 晚到的成功结果被丢弃：不下载，也不提示成功。
      await act(async () => {
        resolve?.({ ok: true, container: "mp4", bytes: new Uint8Array([1, 2, 3]) });
        await Promise.resolve();
      });
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(view.container.textContent).not.toContain("已导出 MP4");
    } finally { view.cleanup(); }
  });
});

describe("帧解码", () => {
  it("拒绝空输入与非法尺寸，不抛异常", async () => {
    expect(await decodeFrameImages([], 8, 8)).toEqual({ ok: false, message: "没有选择任何图片帧" });
    expect((await decodeFrameImages([new Blob([])], 0, 8)).ok).toBe(false);
  });
});

describe("时间轴 section 声明", () => {
  it("声明「窗口 ▸ 时间轴」菜单项与高级区域位置", async () => {
    const { sections } = await import("./sections.js");
    expect(sections.map(section => ({ id: section.id, menu: section.menu, placement: section.placement, order: section.order })))
      .toEqual([{ id: "timeline", menu: "窗口", placement: "advanced", order: 12 }]);
  });
});
