/**
 * 宿主默认图片查看工作区的渲染冒烟测试（change: default-image-focus-viewer）。
 *
 * 只验证呈现骨架：有会话时渲出公共标题栏与取景控件；无会话时不占位。
 * 真实画面来自 Bevy 主画布，这里不采集像素。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { ImageViewerWorkspace } from "./image-viewer-workspace.js";
import type { ImageViewerSession } from "./session.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  act(() => { root?.unmount(); });
  root = null;
  await runtime?.dispose();
  runtime = null;
  document.body.innerHTML = "";
});

/** 最小会话替身：只提供工作区渲染读取的成员。 */
function fakeSession(state: Partial<ReturnType<ImageViewerSession["state"]>> = {}) {
  return {
    subscribe: () => () => undefined,
    revisionState: () => 0,
    state: () => ({
      nodeId: "n1", loading: false, error: null, width: 1600, height: 900,
      viewport: { x: 0, y: 0, zoom: 0.5 }, fitted: true, ...state
    }),
    zoomAround: vi.fn(),
    fitWindow: vi.fn(),
    actualSize: vi.fn(),
    panBy: vi.fn(),
    setRect: vi.fn()
  } as unknown as ImageViewerSession;
}

async function mount(node: React.ReactNode, options: { focus?: { nodeId: string } | null } = {}) {
  const slots = new SlotRegistry();
  const navigation = new CanvasNavigationStore();
  // 导航只接受已注册 adapter 的聚焦目标（生产由 canvas-runtime 注册）。
  navigation.setFocusAdapter({
    apply: () => ({ ok: true }),
    isFocused: () => options.focus != null,
    isTargetValid: () => true
  });
  if (options.focus) navigation.enterNodeFocus({ nodeId: options.focus.nodeId, kind: "image" });
  const runtimeService = {
    subscribeFocusContentRect: () => () => undefined,
    setFocusContentRect: () => undefined
  };
  runtime = await startFrontendRuntime({
    installPlatform: (ctx) => {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("canvasNavigation" as never, navigation as never);
      ctx.provide("canvasRuntime" as never, runtimeService as never);
    },
    plugins: []
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RuntimeProvider runtime={runtime!}>{node}</RuntimeProvider>);
  });
  return host;
}

describe("图片查看工作区", () => {
  it("有会话时渲出标题栏与取景控件，并显示源尺寸与缩放读数", async () => {
    const host = await mount(
      <ImageViewerWorkspace getSession={() => fakeSession()} nodeId="n1" />,
      { focus: { nodeId: "n1" } }
    );
    expect(host.querySelector("[data-image-viewer]")).not.toBeNull();
    expect(host.textContent).toContain("1600×900 · 50%");
    expect(host.textContent).toContain("适应窗口");
    expect(host.textContent).toContain("100%");
    // 公共标题栏的返回/历史入口由 FocusHeader 提供（唯一 owner）。
    expect(host.textContent).toContain("返回");
    expect(host.textContent).toContain("历史");
  });

  it("无会话时不渲染任何内容（退出后不留占位）", async () => {
    const host = await mount(<ImageViewerWorkspace getSession={() => null} nodeId="n1" />);
    expect(host.querySelector("[data-image-viewer]")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("加载中显示进度提示；失败时显示可读原因", async () => {
    const loadingHost = await mount(
      <ImageViewerWorkspace getSession={() => fakeSession({ loading: true, width: 0, height: 0 })} nodeId="n1" />,
      { focus: { nodeId: "n1" } }
    );
    expect(loadingHost.textContent).toContain("图片加载中");

    const errorHost = await mount(
      <ImageViewerWorkspace getSession={() => fakeSession({ error: "图片加载失败（HTTP 404）。" })} nodeId="n1" />,
      { focus: { nodeId: "n1" } }
    );
    expect(errorHost.textContent).toContain("图片加载失败（HTTP 404）。");
  });
});
