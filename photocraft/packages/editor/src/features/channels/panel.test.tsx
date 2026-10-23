/** @vitest-environment jsdom */
// 仅验证通道面板的 DOM 事件与命令参数；不采集渲染、不截图。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { ApplyImagePanel, CalculationsPanel, ChannelPanel } from "./panels.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THUMBNAIL = { ok: true as const, value: { width: 2, height: 2, pixels: new Uint8Array(16) } };

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    composite: "RGB",
    compositeVisible: true,
    colors: [
      { index: 0, name: "Red", visible: true, reference: { color: 0 } },
      { index: 1, name: "Green", visible: true, reference: { color: 1 } },
      { index: 2, name: "Blue", visible: true, reference: { color: 2 } }
    ],
    alpha: [
      { index: 0, name: "Alpha 1", visible: true, kind: "alpha", color: [1, 0, 0], opacity: 0.5, indicates: "maskedAreas", spot: null },
      { index: 1, name: "专色绿", visible: false, kind: "spot", color: [0, 1, 0], opacity: 0.5, indicates: "maskedAreas", spot: { color: [0, 1, 0], solidity: 0.6 } }
    ],
    target: { kind: "composite" },
    documents: [
      { index: 0, name: "art", width: 8, height: 6, grayscale: false, sameSize: true, active: true, colorNames: ["Red", "Green", "Blue"], alpha: [{ index: 0, name: "Alpha 1", kind: "alpha" }, { index: 1, name: "专色绿", kind: "spot" }] },
      { index: 1, name: "art_R", width: 8, height: 6, grayscale: true, sameSize: true, active: false, colorNames: ["Gray"], alpha: [] },
      { index: 2, name: "art_G", width: 8, height: 6, grayscale: true, sameSize: true, active: false, colorNames: ["Gray"], alpha: [] },
      { index: 3, name: "art_B", width: 8, height: 6, grayscale: true, sameSize: true, active: false, colorNames: ["Gray"], alpha: [] }
    ],
    documentId: 7,
    revision: 3,
    maxOpenDocuments: 8,
    spotCount: 1,
    hasSelection: true,
    quickMask: null,
    ...overrides
  };
}

function setup(kind: "channels" | "applyImage" | "calculations", options: { snapshot?: unknown; readonly?: boolean; hasSelection?: boolean; preview?: unknown; command?: unknown } = {}) {
  // 快照与修订可变：用于验证「预览之后文档又被写入」的过期候选门禁。
  let currentSnapshot: unknown = options.snapshot ?? snapshot();
  let currentRevision = 3;
  const channels = {
    channelSnapshot: vi.fn(() => ({ ok: true as const, value: currentSnapshot })),
    channelThumbnail: vi.fn(() => THUMBNAIL),
    channelViewPreview: vi.fn(() => THUMBNAIL),
    previewChannelCommand: vi.fn(() => options.preview ?? { ok: true as const, value: { preview: THUMBNAIL.value, summary: { revisionChanged: true, channels: { alpha: [] }, documents: 1 } } }),
    channelCommand: vi.fn(() => options.command ?? { ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } })
  };
  const dispatch = vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: 0 } }));
  const controller = { features: { channels }, dispatch } as unknown as EditorWorkspaceController;
  const onChanged = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (readonly = options.readonly ?? false, revision = currentRevision) => act(() => root.render(
    kind === "channels"
      ? <ChannelPanel controller={controller} readonly={readonly} revision={revision} hasSelection={options.hasSelection ?? true} onChanged={onChanged} />
      : kind === "applyImage"
        ? <ApplyImagePanel controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} />
        : <CalculationsPanel controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} />
  ));
  // jsdom 没有 canvas 实现；缩略图写入走空实现，断言只看 DOM 与命令参数。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render();
  const row = (code: string) => container.querySelector<HTMLElement>(`[data-channel-row="${code}"]`)!;
  const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes(label))!;
  const update = (next: unknown, revision = currentRevision) => {
    currentSnapshot = next;
    currentRevision = revision;
    render(options.readonly ?? false, revision);
  };
  return { container, root, channels, dispatch, onChanged, render, row, button, update };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function track(root: Root) {
  cleanup = () => act(() => root.unmount());
  return root;
}

it("通道面板按快照渲染行，点击行切换目标、眼睛切换显隐", () => {
  const { container, root, channels, onChanged, row } = setup("channels");
  track(root);
  expect(container.querySelectorAll("[data-channel-row]").length).toBe(6);
  expect(row("alpha:1").dataset.channelKind).toBe("spot");
  expect(container.querySelector<HTMLElement>('[data-channel-eye="alpha:1"]')!.dataset.visible).toBe("false");
  act(() => row("alpha:0").querySelector<HTMLButtonElement>(".photo-editor__channel-target")!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.target", { channel: { alpha: 0 } });
  act(() => container.querySelector<HTMLElement>('[data-channel-eye="alpha:1"]')!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.setVisible", { channel: { alpha: 1 }, visible: true });
  // 成功一次写操作后刷新画布一次。
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it("通道面板的行操作编译成明确参数：排序、复制、选项、专色合并、删除", () => {
  const { root, channels, row } = setup("channels");
  track(root);
  const alphaRow = row("alpha:0");
  act(() => alphaRow.querySelector<HTMLButtonElement>('[title="下移通道"]')!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.move", { channel: { alpha: 0 }, to: 1 });
  // 首个通道不能上移。
  expect(alphaRow.querySelector<HTMLButtonElement>('[title="上移通道"]')!.disabled).toBe(true);
  act(() => alphaRow.querySelector<HTMLButtonElement>('[title="复制通道"]')!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.duplicate", { channel: { alpha: 0 } });
  act(() => row("alpha:1").querySelector<HTMLButtonElement>('[title="把专色通道并入像素"]')!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.mergeSpot", { channel: { alpha: 1 } });
  act(() => row("alpha:1").querySelector<HTMLButtonElement>('[title="删除通道"]')!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.delete", { channel: { alpha: 1 } });
  // 末行不能下移（边界按行位置判断）。
  expect(row("alpha:1").querySelector<HTMLButtonElement>('[title="下移通道"]')!.disabled).toBe(true);
});

it("改名与通道选项是显式表单，取消不落命令", () => {
  const { container, root, channels, row } = setup("channels");
  track(root);
  act(() => row("alpha:0").querySelector<HTMLButtonElement>('[title="重命名通道"]')!.click());
  const rename = container.querySelector<HTMLElement>("[data-channel-rename]")!;
  const input = rename.querySelector("input")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "新名字");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => rename.querySelectorAll("button")[0]!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.rename", { channel: { alpha: 0 }, name: "新名字" });
  // 取消不写命令。
  act(() => row("alpha:0").querySelector<HTMLButtonElement>('[title="通道选项"]')!.click());
  const options = container.querySelector<HTMLElement>("[data-channel-options]")!;
  const calls = channels.channelCommand.mock.calls.length;
  act(() => options.querySelectorAll("button")[1]!.click());
  expect(channels.channelCommand.mock.calls.length).toBe(calls);
  expect(container.querySelector("[data-channel-options]")).toBeNull();
});

it("新建 Alpha/专色通道只在参数合法时发送，选区填充需要活动选区", () => {
  const { container, root, channels } = setup("channels", { hasSelection: false });
  track(root);
  const alphaForm = container.querySelector<HTMLElement>('[data-channel-create="alpha"]')!;
  const createAlpha = Array.from(alphaForm.querySelectorAll<HTMLButtonElement>("button")).at(-1)!;
  act(() => createAlpha.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.new", { fill: "black", indicates: "masked", color: "#ff0000", opacity: 100 });
  // 没有选区时「用选区填充」不可勾选，也不会发送 true。
  const spotForm = container.querySelector<HTMLElement>('[data-channel-create="spot"]')!;
  expect(spotForm.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  act(() => Array.from(spotForm.querySelectorAll<HTMLButtonElement>("button")).at(-1)!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.newSpot", { color: "#00ff00", solidity: 0, fromSelection: false });
});

it("拆分与合并核对模式所需的文档数；合并参数带上所选文档", () => {
  const { container, root, channels } = setup("channels");
  track(root);
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("拆分为灰度文档"))!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.split", { closeOriginal: true });
  // 合并只合成 RGB：CMYK/Lab 属于多色彩管理与印刷分色，面板不得提供这两个模式。
  const split = container.querySelector<HTMLElement>(".photo-editor__channel-split")!;
  expect(split.textContent).toContain("模式 RGB");
  expect(split.querySelector("select")).toBeNull();
  const mergeButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "合并通道")!;
  // 默认没有勾选任何灰度文档 → RGB 需要 3 个，按钮禁用。
  expect(mergeButton().disabled).toBe(true);
  const checks = container.querySelectorAll<HTMLInputElement>(".photo-editor__channel-split input[type=checkbox]");
  // 第一个是「拆分后关闭原文档」，其后是每个可合并文档。
  for (const index of [1, 2, 3]) act(() => checks[index]!.click());
  expect(mergeButton().disabled).toBe(false);
  act(() => mergeButton().click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("channel.merge", { mode: "rgb", documents: [1, 2, 3] });
});

it("载入选区/存储选区走共享 dispatch，亮度选区走本域命令", () => {
  const { container, root, dispatch, channels } = setup("channels", { snapshot: snapshot({ target: { kind: "alpha", index: 1 } }) });
  track(root);
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("载入通道为选区"))!.click());
  expect(dispatch).toHaveBeenLastCalledWith("select.loadSelection", { channel: { alpha: 1 } });
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("存储选区为通道"))!.click());
  expect(dispatch).toHaveBeenLastCalledWith("select.saveSelection", { channel: "new", operation: "new" });
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("载入亮度选区"))!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("select.loadLuminosity", null);
});

it("图层蒙版目标没有面板行：载入选区被禁用而不是猜一个引用", () => {
  const { container, root } = setup("channels", { snapshot: snapshot({ target: { kind: "layerMask", index: null } }) });
  track(root);
  const load = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("载入通道为选区"))!;
  expect(load.disabled).toBe(true);
});

it("只读时写操作禁用，读取与查看仍然可用", () => {
  const { container, root, channels, row } = setup("channels", { readonly: true });
  track(root);
  expect(channels.channelSnapshot).toHaveBeenCalled();
  expect(channels.channelThumbnail).toHaveBeenCalled();
  // 通道目标、新建、拆分合并等写入入口全部禁用。
  for (const element of container.querySelectorAll<HTMLButtonElement>("[data-channel-row] button, [data-channel-create] button, .photo-editor__channel-split button, .photo-editor__channel-actions button")) {
    // 「查看通道视图」只是读取，保持可用。
    if (element.textContent?.includes("通道视图")) continue;
    expect(element.disabled).toBe(true);
  }
  expect(row("alpha:0").querySelector<HTMLButtonElement>(".photo-editor__channel-target")!.disabled).toBe(true);
  // 眼睛不渲染成 button（span），只读时点击也不落命令。
  act(() => container.querySelector<HTMLElement>('[data-channel-eye="alpha:0"]')!.click());
  expect(channels.channelCommand).not.toHaveBeenCalled();
});

it("快照非法或读取失败时显示原因，不渲染半截行", () => {
  const { container, root } = setup("channels", { snapshot: { composite: "RGB" } });
  track(root);
  expect(container.querySelector("[data-channel-row]")).toBeNull();
  expect(container.textContent).toContain("通道快照结构非法");
});

it("应用图像：蒙版选项来自活动文档，不跟着来源文档下拉走", () => {
  const { container, root } = setup("applyImage");
  track(root);
  const documents = Array.from(container.querySelectorAll("select"))[0]!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(documents, "1");
    documents.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const mask = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.startsWith("蒙版"))!.querySelector("select")!;
  const values = Array.from(mask.querySelectorAll("option")).map((option) => option.value);
  // 蒙版来源不带 document，上游按活动文档解析，因此选项是活动文档的 Alpha，而不是灰度来源的通道。
  expect(values).toEqual(["", "composite", "color:0", "color:1", "color:2", "alpha:0", "alpha:1"]);
});

it("应用图像：参数改动使旧预览失效，确认前必须重新预览", () => {
  const { container, root, channels } = setup("applyImage");
  track(root);
  const preview = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "预览")!;
  const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "确认")!;
  expect(confirm.disabled).toBe(true);
  act(() => preview.click());
  expect(channels.previewChannelCommand).toHaveBeenLastCalledWith("image.applyImage", expect.objectContaining({ source: { document: 0, channel: "composite" }, blending: "multiply", opacity: 100 }), 192);
  expect(confirm.disabled).toBe(false);
  // 改不透明度后旧候选立即失效。
  const opacity = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.startsWith("不透明度"))!.querySelector("input")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(opacity, "40");
    opacity.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(confirm.disabled).toBe(true);
  act(() => preview.click());
  expect(channels.previewChannelCommand).toHaveBeenLastCalledWith("image.applyImage", expect.objectContaining({ opacity: 40 }), 192);
  act(() => confirm.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("image.applyImage", expect.objectContaining({ opacity: 40 }));
  // 失效后的预览不能直接拿旧像素确认；确认后候选清空，需要重新预览。
  expect(container.querySelector("[data-channel-candidate]")).toBeNull();
});

it("应用图像：非法参数只回显原因，工作区不刷新", () => {
  const failure = { ok: false as const, code: "command-failed", message: "unsupported blending `dissolve`" };
  const { container, root, onChanged } = setup("applyImage", { preview: failure });
  track(root);
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "预览")!.click());
  expect(container.querySelector('[data-channel-error="true"]')!.textContent).toBe("unsupported blending `dissolve`");
  expect(onChanged).not.toHaveBeenCalled();
});

it("计算：输出与两源参数一并提交，确认后刷新一次", () => {
  const { container, root, channels, onChanged } = setup("calculations");
  track(root);
  const result = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.startsWith("结果"))!.querySelector("select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(result, "selection");
    result.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "预览")!.click());
  expect(channels.previewChannelCommand).toHaveBeenLastCalledWith("image.calculations", expect.objectContaining({
    source1: { document: 0, channel: "composite" },
    source2: { document: 0, channel: "composite" },
    result: "selection",
    blending: "multiply"
  }), 192);
  act(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === "确认")!.click());
  expect(channels.channelCommand).toHaveBeenLastCalledWith("image.calculations", expect.objectContaining({ result: "selection" }));
  expect(onChanged).toHaveBeenCalledOnce();
});

it("应用图像：预览之后文档被别处写入，旧候选立即失效", () => {
  const { container, root, update } = setup("applyImage");
  track(root);
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const confirm = () => buttons().find((element) => element.textContent === "确认")!;
  act(() => buttons().find((element) => element.textContent === "预览")!.click());
  expect(confirm().disabled).toBe(false);
  // 同一文档修订推进（别处写入）：候选像素已不对应当前内容。
  update(snapshot({ revision: 4 }), 4);
  expect(confirm().disabled).toBe(true);
  expect(container.querySelector("[data-channel-candidate]")).toBeNull();
  // 换文档同样要重新预览，并且表单按新文档重建。
  act(() => buttons().find((element) => element.textContent === "预览")!.click());
  expect(confirm().disabled).toBe(false);
  update(snapshot({ documentId: 9, revision: 1 }), 5);
  expect(confirm().disabled).toBe(true);
});

it("计算：预览之后修订推进也必须重新预览", () => {
  const { container, root, update } = setup("calculations");
  track(root);
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const confirm = () => buttons().find((element) => element.textContent === "确认")!;
  act(() => buttons().find((element) => element.textContent === "预览")!.click());
  expect(confirm().disabled).toBe(false);
  update(snapshot({ revision: 7 }), 7);
  expect(confirm().disabled).toBe(true);
});

it("旧运行时/未知能力：读取被拒绝时只显示原因，不渲染行也不写入", () => {
  const disabled = { ok: false as const, code: "capability-disabled", message: "首期未开放的功能：channel.panel" };
  const channels = {
    channelSnapshot: vi.fn(() => disabled),
    channelThumbnail: vi.fn(() => THUMBNAIL),
    channelViewPreview: vi.fn(() => THUMBNAIL),
    previewChannelCommand: vi.fn(),
    channelCommand: vi.fn()
  };
  const dispatch = vi.fn();
  const onChanged = vi.fn();
  const controller = { features: { channels }, dispatch } as unknown as EditorWorkspaceController;
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  track(root);
  act(() => root.render(<ChannelPanel controller={controller} readonly={false} revision={3} hasSelection={false} onChanged={onChanged} />));
  expect(container.querySelector("[data-channel-row]")).toBeNull();
  expect(container.textContent).toContain("首期未开放的功能：channel.panel");
  expect(channels.channelCommand).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
});

it("应用图像：目标只列内核支持项，不提供会静默写像素的图层蒙版", () => {
  const { container, root } = setup("applyImage");
  track(root);
  const target = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.startsWith("目标"))!.querySelector("select")!;
  const values = Array.from(target.querySelectorAll("option")).map((option) => option.value);
  expect(values).toEqual(["pixels", "alpha:0", "alpha:1"]);
  expect(values).not.toContain("mask");
});
