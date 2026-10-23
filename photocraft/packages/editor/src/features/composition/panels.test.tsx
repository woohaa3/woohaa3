/** @vitest-environment jsdom */
// 只验证面板事件与参数编译结果；像素合成由内核 Rust 测试覆盖。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { ComposePanel, CompositionWorkflowPanel } from "./panels.js";
import { compositionOverlayState, resetCompositionOverlay } from "./overlay-store.js";
import { identityWarpMesh, moveMeshPoint } from "./warp-mesh.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** 按可见文字点按钮：面板上的入口就是文字，避免测试依赖内部 data 属性。 */
function clickButton(container: HTMLElement, text: string): void {
  const entry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  if (!entry) throw new Error(`没有找到按钮「${text}」`);
  act(() => entry.click());
}
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

const manifest = [
  { id: "crop", group: "crop", label: "裁剪…", command: "image.crop", allowed: true, reason: null },
  { id: "perspectiveCrop", group: "crop", label: "透视裁剪…", command: "image.perspectiveCrop", allowed: false, reason: "尚未接通能力白名单" },
  { id: "revealAll", group: "trim", label: "显示全部", command: "image.crop", allowed: true, reason: null },
  { id: "fill", group: "fill", label: "填充…", command: "edit.fill", allowed: true, reason: null },
  { id: "stroke", group: "fill", label: "描边…", command: "edit.stroke", allowed: false, reason: "尚未接通能力白名单" },
  { id: "photomerge", group: "photo", label: "Photomerge…", command: "file.automate.photomerge", allowed: false, reason: "该能力需要宿主本地文件夹端口，内核不直接写盘" }
];

function setup(manifestValue: unknown = manifest, extra: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const beginCompose = vi.fn(() => ({ ok: true as const, value: { width: 20, height: 10 } }));
  const updateCompose = vi.fn(() => ({ ok: true as const, value: { width: 20, height: 10 } }));
  const commitCompose = vi.fn(() => ({ ok: true as const, value: { hasDocument: true } }));
  const cancelCompose = vi.fn();
  const workflowManifest = vi.fn(() => ({ ok: true as const, value: manifestValue }));
  const runWorkflow = vi.fn((_id: string, _params: Record<string, unknown>) => ({ ok: true as const, value: { hasDocument: true } }));
  // 视图模型只提供构图面板需要的 `transformFrame`：变形网格框就是目标图层的角点框。
  const transformFrame = { value: [6, 6, 46, 36] as [number, number, number, number] | null };
  const currentView = vi.fn(() => ({ hasDocument: true, document: { transformFrame: transformFrame.value }, sessionActiveIndex: 0 }));
  const controller = {
    beginCompose, updateCompose, commitCompose, cancelCompose, currentView,
    features: { composition: { workflowManifest, runWorkflow } },
    ...extra
  } as unknown as EditorWorkspaceController;
  const renderCompose = (readonly = false) => act(() => root.render(
    <ComposePanel controller={controller} readonly={readonly} width={40} height={30} />
  ));
  const renderWorkflows = (groups: readonly string[], readonly = false) => act(() => root.render(
    <CompositionWorkflowPanel controller={controller} readonly={readonly} groups={groups} />
  ));
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text)!;
  /** 工作流下拉（面板自身的选择器），不与表单字段的下拉混用。 */
  const workflowSelect = () => container.querySelector<HTMLSelectElement>("section[aria-label='构图工作流'] > label > select")!;
  const select = (index: number) => container.querySelectorAll<HTMLSelectElement>("select")[index]!;
  const choose = (index: number, value: string) => {
    const target = select(index);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const number = (index: number, value: string) => {
    const target = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[index]!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const check = (index: number) => act(() => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!.click());
  return { container, currentView, transformFrame, beginCompose, updateCompose, commitCompose, cancelCompose, workflowManifest, runWorkflow, renderCompose, renderWorkflows, button, choose, number, check, workflowSelect };
}

it("裁剪面板：预览提交裁剪参数，确认/取消各自结算草稿", () => {
  const { beginCompose, commitCompose, cancelCompose, renderCompose, button, check } = setup();
  renderCompose();
  expect(button("确认").disabled).toBe(true);
  check(0); // 删除裁剪像素 → false
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledWith("image.crop", {
    x: 0, y: 0, width: 40, height: 30, deleteCroppedPixels: false, contentAware: false, resample: "bicubic"
  });
  expect(button("确认").disabled).toBe(false);
  act(() => button("确认").click());
  expect(commitCompose).toHaveBeenCalledOnce();
  expect(button("确认").disabled).toBe(true);
  act(() => button("预览").click());
  act(() => button("取消").click());
  expect(cancelCompose).toHaveBeenCalledOnce();
});

it("比例预设把裁剪框收成合比例的框，拉直角度只在非零时进入参数", () => {
  const { beginCompose, renderCompose, button, choose, number } = setup();
  renderCompose();
  choose(1, "1:1"); // 比例选 1:1
  number(4, "5"); // 拉直 5°（X、Y、宽、高之后的第五个数字输入）
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledWith("image.crop", {
    x: 5, y: 0, width: 30, height: 30, angle: 5, deleteCroppedPixels: true, contentAware: false, resample: "bicubic"
  });
});

it("非法输入就地提示且不提交；预览后的修改走 updateCompose", () => {
  const { container, beginCompose, updateCompose, renderCompose, button, number, choose } = setup();
  renderCompose();
  number(2, "0"); // 宽 0
  act(() => button("预览").click());
  expect(container.textContent).toContain("至少为 1 像素");
  expect(beginCompose).not.toHaveBeenCalled();
  number(2, "20");
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledOnce();
  choose(0, "image.imageSize");
  act(() => button("预览").click());
  expect(updateCompose).toHaveBeenCalledWith({ resolution: 72, resample: "bicubic" });
});

it("图像尺寸面板：只改分辨率时按内核语义传出", () => {
  const { beginCompose, renderCompose, button } = setup();
  renderCompose();
  const target = document.querySelectorAll<HTMLSelectElement>("select")[0]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, "image.imageSize");
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledWith("image.imageSize", { resolution: 72, resample: "bicubic" });
});

it("图像尺寸面板：百分比 + 保持打印尺寸，打印尺寸按所选单位显示", () => {
  const { container, beginCompose, renderCompose, button, number, check, choose } = setup();
  renderCompose();
  const target = document.querySelectorAll<HTMLSelectElement>("select")[0]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, "image.imageSize");
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // 字段顺序：宽、高、百分比、分辨率。
  number(2, "50");
  number(3, "144");
  check(0);
  // 40 px @144 ppi ≈ 0.28 in；切到毫米按同一分辨率换算。
  expect(container.textContent).toContain("0.28");
  choose(1, "mm");
  expect(container.textContent).toContain("7.06");
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledWith("image.imageSize", {
    percent: 50, resolution: 144, keepPrintSize: true, resample: "bicubic"
  });
});

it("画布尺寸面板：相对增减使用锚点与扩展颜色", () => {
  const { container, beginCompose, renderCompose, button, check, choose } = setup();
  renderCompose();
  const target = document.querySelectorAll<HTMLSelectElement>("select")[0]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, "image.canvasSize");
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  check(0); // 相对当前尺寸
  choose(1, "bottomRight");
  choose(2, "#ffffff");
  const width = document.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(width, "-10");
    width.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button("预览").click());
  // 相对模式下未填的一边是「不增减」，不再沿用文档尺寸。
  expect(beginCompose).toHaveBeenCalledWith("image.canvasSize", {
    width: -10, height: 0, relative: true, anchor: "bottomRight", extensionColor: "#ffffff"
  });
  // 草稿打开期间输入被禁用；取消后关掉相对模式，回到绝对尺寸输入。
  expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.disabled).toBe(true);
  act(() => button("取消").click());
  const relativeBox = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!;
  act(() => relativeBox.click());
  expect(relativeBox.checked).toBe(false);
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenLastCalledWith("image.canvasSize", expect.objectContaining({ width: 40, height: 30, relative: false }));
});

it("裁边面板：四边开关与依据进入参数", () => {
  const { beginCompose, renderCompose, button, check, choose } = setup();
  renderCompose();
  const target = document.querySelectorAll<HTMLSelectElement>("select")[0]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, "image.trim");
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  choose(1, "topLeft");
  check(0); // 取消上边
  act(() => button("预览").click());
  expect(beginCompose).toHaveBeenCalledWith("image.trim", { basedOn: "topLeft", top: false, bottom: true, left: true, right: true });
});

it("整图操作按清单能力启用：未接通时禁用并给出原因", () => {
  const { container, runWorkflow, renderCompose, button } = setup([
    ...manifest,
    { id: "rotateArbitrary", group: "trim", label: "任意角度旋转…", command: "image.rotation.arbitrary", allowed: true, reason: null }
  ]);
  renderCompose();
  const reveal = button("显示全部");
  expect(reveal.disabled).toBe(false);
  act(() => reveal.click());
  expect(runWorkflow).toHaveBeenCalledWith("revealAll", {});
  const perspective = container.querySelector<HTMLButtonElement>('[data-composition-workflows], section[aria-label="构图"]')!;
  expect(perspective).not.toBeNull();
  // 透视裁剪未开放：按钮禁用并显示内核原因。
  expect(button("裁剪到四角").disabled).toBe(true);
  expect(container.textContent).toContain("尚未接通能力白名单");
});

it("工作流面板只列请求的分组，禁用项显示具体原因", () => {
  const { container, renderWorkflows, workflowSelect } = setup();
  renderWorkflows(["fill", "photo"]);
  const options = [...workflowSelect().querySelectorAll<HTMLOptionElement>("option")];
  expect(options.map((option) => option.value)).toEqual(["fill", "stroke", "photomerge"]);
  expect(options[1]!.disabled).toBe(true);
  expect(options[1]!.textContent).toContain("尚未接通能力白名单");
  expect(options[2]!.textContent).toContain("宿主本地文件夹端口");
  // 清单结构非法或没有该分组时不渲染空壳。
  renderWorkflows(["structure"]);
  expect(container.querySelector("[data-composition-workflows]")).toBeNull();
});

it("工作流面板执行已开放入口，参数由纯函数编译", () => {
  const { runWorkflow, renderWorkflows, button } = setup();
  renderWorkflows(["fill"]);
  act(() => button("执行").click());
  // 复选框字段显式带上初始值（false 也是「用户可见状态」，不靠内核默认）。
  expect(runWorkflow).toHaveBeenCalledWith("fill", { contents: "color", color: "#3366cc", preserveTransparency: false });
});

it("只读时禁用预览与执行，但保留能力说明", () => {
  const { beginCompose, runWorkflow, renderCompose, renderWorkflows, button } = setup();
  renderCompose(true);
  expect(button("预览").disabled).toBe(true);
  act(() => button("预览").click());
  expect(beginCompose).not.toHaveBeenCalled();
  renderWorkflows(["fill"], true);
  expect(button("执行").disabled).toBe(true);
  act(() => button("执行").click());
  expect(runWorkflow).not.toHaveBeenCalled();
});

it("工作流表单按入口渲染字段：变形样式与弯曲进入参数", () => {
  const { container, runWorkflow, renderWorkflows, button } = setup([
    { id: "warp", group: "transform", label: "变形…", command: "edit.transform.warp", allowed: true, reason: null }
  ]);
  renderWorkflows(["transform"]);
  const form = container.querySelector("[data-workflow-form='warp']")!;
  expect(form).not.toBeNull();
  act(() => button("执行").click());
  // 默认样式 arc + 弯曲 50% + 未勾选垂直方向。
  expect(runWorkflow).toHaveBeenCalledWith("warp", { style: "arc", bend: 50, vertical: false });
});

it("未开放的入口在表单里也禁用，并显示内核原因", () => {
  const { container, runWorkflow, renderWorkflows, button } = setup([
    { id: "newArtboard", group: "structure", label: "新建画板…", command: "layer.new.artboard", allowed: false, reason: "尚未接通能力白名单" }
  ]);
  renderWorkflows(["structure"]);
  expect(container.textContent).toContain("尚未接通能力白名单");
  expect(button("执行").disabled).toBe(true);
  act(() => button("执行").click());
  expect(runWorkflow).not.toHaveBeenCalled();
});

it("透视变形用专用表单：非法四角禁用，合法时提交 quad", () => {
  const { container, runWorkflow, renderWorkflows, button } = setup([
    { id: "perspectiveWarp", group: "transform", label: "透视变形…", command: "edit.perspectiveWarp", allowed: true, reason: null }
  ]);
  renderWorkflows(["transform"]);
  expect(container.querySelector("[data-workflow-form='perspectiveWarp']")).not.toBeNull();
  const numbers = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
  expect(numbers.length).toBe(8); // 四角 × 两轴
  act(() => button("应用透视变形").click());
  expect(runWorkflow).toHaveBeenCalledWith("perspectiveWarp", {
    quad: [[0, 0], [100, 0], [100, 100], [0, 100]]
  });
  // 把右上角拖到对角另一侧 → 自交，按钮禁用。
  const input = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[2]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "-50");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("应用透视变形").disabled).toBe(true);
});

it("操控变形用专用表单：增删钉点并把 at/to 交给编译函数", () => {
  const { container, runWorkflow, renderWorkflows, button } = setup([
    { id: "puppetWarp", group: "transform", label: "操控变形…", command: "edit.puppetWarp", allowed: true, reason: null }
  ]);
  renderWorkflows(["transform"]);
  expect(container.querySelector("[data-workflow-form='puppetWarp']")).not.toBeNull();
  // 默认一个钉点，删除按钮禁用。
  expect(button("删除钉点").disabled).toBe(true);
  act(() => button("添加钉点").click());
  expect(container.querySelectorAll("[data-workflow-form='puppetWarp'] .photo-editor__option-hint").length).toBeGreaterThan(1);
  act(() => button("应用操控变形").click());
  const call = runWorkflow.mock.calls.at(-1)!;
  expect(call[0]).toBe("puppetWarp");
  const pins = (call[1] as { pins: { src: number[]; dst: number[] }[] }).pins;
  expect(pins).toHaveLength(2);
  expect(pins[0]).toEqual({ src: [50, 50], dst: [50, 50] });
});

it("选中「变形」时把目标图层框铺成画布网格，并在画布上发布该会话", () => {
  resetCompositionOverlay();
  const { container, renderWorkflows, transformFrame } = setup([
    { id: "warp", group: "transform", label: "变形…", command: "edit.transform.warp", allowed: true, reason: null }
  ]);
  renderWorkflows(["transform"]);
  // 选中「变形」本身不占画布：先给的是预设样式表单。
  expect(compositionOverlayState()).toBeNull();
  clickButton(container, "在画布上编辑网格");
  // 面板的职责是把「目标图层框 + 单位网格」发布给共享画布；叠加层渲染由 overlays.test 覆盖。
  const state = compositionOverlayState();
  expect(state?.active).toBe("warp");
  if (state?.active !== "warp") return;
  expect(state.rect).toEqual(transformFrame.value);
  expect(state.mesh.points).toHaveLength(16);
  // 网格与目标框一一对应：四个角就是图层框的四个角。
  const [x0, y0, x1, y1] = transformFrame.value!;
  expect(state.mesh.points[0]).toEqual([x0, y0]);
  expect(state.mesh.points[15]).toEqual([x1, y1]);

  // 换到没有目标图层框的文档：网格会话必须撤回，不能残留旧框。
  act(() => { transformFrame.value = null; });
  renderWorkflows(["transform"]);
  expect(compositionOverlayState()).toBeNull();
});

it("变形网格的双击分割把当前网格当内联 warp 交给内核，并用返回的新网格继续编辑", () => {
  resetCompositionOverlay();
  const nextMesh = identityWarpMesh([6, 6, 46, 36], 2, 1);
  const { container, renderWorkflows, runWorkflow } = setup([
    { id: "warp", group: "transform", label: "变形…", command: "edit.transform.warp", allowed: true, reason: null }
  ]);
  runWorkflow.mockImplementation(((id: string) => id === "splitWarpCrosswise"
    ? { ok: true as const, value: { warp: { mesh: nextMesh } } }
    : { ok: true as const, value: {} }) as never);
  renderWorkflows(["transform"]);
  clickButton(container, "在画布上编辑网格");
  const state = compositionOverlayState();
  if (state?.active !== "warp") { expect.unreachable(); return; }

  act(() => state.onSplit?.([26, 21]));
  const call = runWorkflow.mock.calls.find(([id]) => id === "splitWarpCrosswise")!;
  expect(call[1]).toMatchObject({ at: [26, 21], warp: { style: "custom", bounds: [6, 6, 46, 36] } });
  // `at` 是文档坐标：上游按 warp bounds 反解参数，界面上双击哪里就切哪里。
  const inline = (call[1] as { warp: { mesh: { points: unknown[] } } }).warp;
  expect(inline.mesh.points).toHaveLength(16);

  const after = compositionOverlayState();
  if (after?.active !== "warp") { expect.unreachable(); return; }
  expect(after.mesh.us).toEqual([0, 0.5, 1]);
});

it("网格拖动后由「应用变形」显式提交，提交后网格回到单位网格", () => {
  resetCompositionOverlay();
  const { container, renderWorkflows, runWorkflow } = setup([
    { id: "warp", group: "transform", label: "变形…", command: "edit.transform.warp", allowed: true, reason: null }
  ]);
  renderWorkflows(["transform"]);
  clickButton(container, "在画布上编辑网格");
  const state = compositionOverlayState();
  if (state?.active !== "warp") { expect.unreachable(); return; }

  const apply = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "应用变形")!;
  // 未改动时按钮禁用：不该白写一步历史。
  expect(apply().disabled).toBe(true);

  act(() => state.onMeshChange?.(moveMeshPoint(state.mesh, 5, [30, 0])));
  const moved = compositionOverlayState();
  if (moved?.active !== "warp") { expect.unreachable(); return; }
  expect(moved.mesh.points[5]).toEqual([30, 0]);
  expect(apply().disabled).toBe(false);

  act(() => apply().click());
  const call = runWorkflow.mock.calls.find(([id]) => id === "warp")!;
  expect(call[1]).toMatchObject({ rect: [6, 6, 46, 36] });
  const sent = (call[1] as { mesh: { points: [number, number][] } }).mesh;
  expect(sent.points).toHaveLength(16);
  expect(sent.points[5]).toEqual([30, 0]);
  // 已提交 → 网格重置成单位网格，按钮重新禁用。
  const after = compositionOverlayState();
  if (after?.active !== "warp") { expect.unreachable(); return; }
  expect(after.mesh.points).toEqual(identityWarpMesh([6, 6, 46, 36]).points);
  expect(apply().disabled).toBe(true);
});

it("结构分组的导出按钮：有宿主端口时按类型导出并报告文件名，无端口时禁用并说明原因", async () => {
  const exportCompositionArtifacts = vi.fn(async (kind: "slices" | "artboards") => (kind === "slices"
    ? { ok: true as const, value: { delivered: ["logo.png", "海报_2.png"], written: true } }
    : { ok: true as const, value: { delivered: ["海报_首屏.png"], written: false } }));
  const { container, renderWorkflows, button } = setup(
    [{ id: "listSlices", group: "structure", label: "列出切片", command: "layer.slice.list", allowed: true, reason: null }],
    { canDeliverFiles: () => true, exportCompositionArtifacts }
  );
  renderWorkflows(["structure"]);
  expect(container.querySelector("[data-composition-export='true']")).not.toBeNull();

  await act(async () => button("导出切片").click());
  expect(exportCompositionArtifacts).toHaveBeenCalledWith("slices");
  expect(container.textContent).toContain("已导出 2 个切片：logo.png、海报_2.png");

  // 「仅下载」时如实说明尚未确认写入磁盘，不宣称已落盘。
  await act(async () => button("导出画板").click());
  expect(exportCompositionArtifacts).toHaveBeenLastCalledWith("artboards");
  expect(container.textContent).toContain("已导出 1 个画板：海报_首屏.png（已发起下载，尚未确认写入磁盘）");
});

it("结构分组的导出按钮：宿主没有文件端口时禁用，不点下去才失败", () => {
  const { container, renderWorkflows, button } = setup(
    [{ id: "listSlices", group: "structure", label: "列出切片", command: "layer.slice.list", allowed: true, reason: null }],
    { canDeliverFiles: () => false, exportCompositionArtifacts: vi.fn() }
  );
  renderWorkflows(["structure"]);
  expect(button("导出切片").disabled).toBe(true);
  expect(button("导出画板").disabled).toBe(true);
  expect(container.textContent).toContain("当前宿主不支持本地文件保存，导出不可用。");
});

it("结构分组的导出按钮：导出失败把内核/宿主的原始原因报到面板上", async () => {
  const exportCompositionArtifacts = vi.fn(async () => ({ ok: false as const, message: "写入 logo.png 失败" }));
  const { container, renderWorkflows, button } = setup(
    [{ id: "listSlices", group: "structure", label: "列出切片", command: "layer.slice.list", allowed: true, reason: null }],
    { canDeliverFiles: () => true, exportCompositionArtifacts }
  );
  renderWorkflows(["structure"]);
  await act(async () => button("导出切片").click());
  expect(container.textContent).toContain("写入 logo.png 失败");
  expect(container.textContent).not.toContain("已导出");
});

it("画布网格提交后成为「正在编辑的变形」，随后网格分割整链路带上它", () => {
  resetCompositionOverlay();
  const nextWarp = { style: "custom", bounds: [6, 6, 46, 36], mesh: identityWarpMesh([6, 6, 46, 36], 2, 1) };
  const { container, renderWorkflows, runWorkflow, choose, workflowSelect } = setup([
    { id: "warp", group: "transform", label: "变形…", command: "edit.transform.warp", allowed: true, reason: null },
    { id: "warpGrid", group: "transform", label: "网格分割…", command: "edit.transform.warpGrid", allowed: true, reason: null }
  ]);
  runWorkflow.mockImplementation(((id: string) => (id === "warpGrid"
    ? { ok: true as const, value: { warp: nextWarp } }
    : { ok: true as const, value: { changed: true, layer: 3 } })) as never);
  renderWorkflows(["transform"]);

  clickButton(container, "在画布上编辑网格");
  const state = compositionOverlayState();
  if (state?.active !== "warp") { expect.unreachable(); return; }
  act(() => state.onMeshChange?.(moveMeshPoint(state.mesh, 5, [30, 0])));
  clickButton(container, "应用变形");
  const applied = runWorkflow.mock.calls.find(([id]) => id === "warp")!;
  expect((applied[1] as { mesh: { points: [number, number][] } }).mesh.points[5]).toEqual([30, 0]);

  // 换到「网格分割」：表单编译时必须把刚才那份网格作为会话传下去，否则上游会去找智能对象。
  act(() => {
    const target = workflowSelect();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(target, "warpGrid");
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(choose).toBeTypeOf("function");
  clickButton(container, "执行");
  const grid = runWorkflow.mock.calls.find(([id]) => id === "warpGrid")!;
  const warp = (grid[1] as { warp?: { mesh?: { points: unknown[] } } }).warp;
  expect(warp?.mesh?.points).toHaveLength(16);
  expect((warp!.mesh!.points as [number, number][])[5]).toEqual([30, 0]);
});
