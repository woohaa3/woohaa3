/**
 * 生成面板「图片 / 视频」切换：置灰条件与点击行为
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NodeTypeSwitch, retypeBlockReason } from "./node-type-switch.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  document.body.innerHTML = "";
});

function render(props: Parameters<typeof NodeTypeSwitch>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => { root.render(<NodeTypeSwitch {...props} />); });
  return container;
}

const options = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".node-type-switch__option")];

describe("retypeBlockReason", () => {
  it("空节点可写时可以切换", () => {
    expect(retypeBlockReason({ taskKind: "image-generation", taskStatus: "idle" }, true)).toBeNull();
    expect(retypeBlockReason(undefined, true)).toBeNull();
  });

  it("只读、已有结果、已有内容、任务在途都给出原因", () => {
    expect(retypeBlockReason({}, false)).toContain("只读");
    expect(retypeBlockReason({ outputAssetId: "a1" }, true)).toContain("已有结果");
    expect(retypeBlockReason({ mediaContent: { kind: "image" } as never }, true)).toContain("已有内容");
    for (const status of ["pending", "queued", "processing", "running"] as const) {
      expect(retypeBlockReason({ taskStatus: status as never }, true), status).toContain("正在生成");
    }
    // 失败/取消/成功都算空闲：失败的空节点仍可切换。
    expect(retypeBlockReason({ taskStatus: "failed" }, true)).toBeNull();
  });
});

describe("NodeTypeSwitch", () => {
  it("当前项高亮；点另一项发出切换", () => {
    const onSwitch = vi.fn();
    const container = render({ current: "image", blockedReason: null, onSwitch });
    const [image, video] = options(container);
    expect(image!.dataset.active).toBe("true");
    expect(video!.dataset.active).toBeUndefined();
    act(() => { video!.click(); });
    expect(onSwitch).toHaveBeenCalledWith("video");
    act(() => { image!.click(); });
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("不可切换时另一项置灰、点击无效，并在容器上说明原因", () => {
    const onSwitch = vi.fn();
    const container = render({ current: "image", blockedReason: "已有结果的节点不能切换类型，请新建节点", onSwitch });
    const [image, video] = options(container);
    expect(video!.getAttribute("aria-disabled")).toBe("true");
    expect(image!.getAttribute("aria-disabled")).toBeNull();
    act(() => { video!.click(); });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(container.querySelector(".node-type-switch")!.getAttribute("title")).toContain("已有结果");
  });

  it("视频节点上当前项是「视频」", () => {
    const container = render({ current: "video", blockedReason: null, onSwitch: vi.fn() });
    expect(options(container)[1]!.dataset.active).toBe("true");
  });
});
