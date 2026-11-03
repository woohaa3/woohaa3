/**
 * 生成面板「图片 / 视频」切换：随时可切，空节点改类型，有结果的节点新建关联节点
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NodeTypeSwitch } from "./node-type-switch.js";
import { buildLinkedNodeCommands, planNodeTypeSwitch, type NodeTypeSwitchPlan } from "./switch-node-type.js";

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

describe("planNodeTypeSwitch", () => {
  it("空节点原地改类型；失败的空节点也可以", () => {
    expect(planNodeTypeSwitch({ taskKind: "image-generation", taskStatus: "idle" }, true)).toEqual({ kind: "retype" });
    expect(planNodeTypeSwitch(undefined, true)).toEqual({ kind: "retype" });
    expect(planNodeTypeSwitch({ taskStatus: "failed" }, true)).toEqual({ kind: "retype" });
  });

  it("已有图/视频/内容的节点：新建关联节点（随时可切）", () => {
    expect(planNodeTypeSwitch({ outputAssetId: "a1" }, true)).toEqual({ kind: "create" });
    expect(planNodeTypeSwitch({ mediaContent: { kind: "image" } as never }, true)).toEqual({ kind: "create" });
    // 有结果时即使正在重新生成，也只是新建一个关联节点，不受影响。
    expect(planNodeTypeSwitch({ outputAssetId: "a1", taskStatus: "processing" }, true)).toEqual({ kind: "create" });
  });

  it("只读，或空节点正在生成：不可切换并给出原因", () => {
    expect(planNodeTypeSwitch({ outputAssetId: "a1" }, false)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("只读") });
    for (const status of ["pending", "queued", "processing", "running"] as const) {
      expect(planNodeTypeSwitch({ taskStatus: status as never }, true), status).toMatchObject({ kind: "blocked", reason: expect.stringContaining("正在生成") });
    }
  });
});

describe("NodeTypeSwitch", () => {
  const retype: NodeTypeSwitchPlan = { kind: "retype" };

  it("当前项高亮；点另一项发出切换", () => {
    const onSwitch = vi.fn();
    const container = render({ current: "image", plan: retype, onSwitch });
    const [image, video] = options(container);
    expect(image!.dataset.active).toBe("true");
    expect(video!.dataset.active).toBeUndefined();
    act(() => { video!.click(); });
    expect(onSwitch).toHaveBeenCalledWith("video");
    act(() => { image!.click(); });
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("要新建关联节点时，悬停说明讲清楚会发生什么，并且仍可点", () => {
    const onSwitch = vi.fn();
    const container = render({ current: "image", plan: { kind: "create" }, onSwitch });
    const video = options(container)[1]!;
    expect(video.getAttribute("title")).toContain("新建一个视频节点");
    expect(video.getAttribute("aria-disabled")).toBeNull();
    act(() => { video.click(); });
    expect(onSwitch).toHaveBeenCalledWith("video");
  });

  it("不可切换时另一项置灰、点击无效，并说明原因", () => {
    const onSwitch = vi.fn();
    const container = render({ current: "image", plan: { kind: "blocked", reason: "正在生成，暂时不能切换类型" }, onSwitch });
    const [image, video] = options(container);
    expect(video!.getAttribute("aria-disabled")).toBe("true");
    expect(video!.getAttribute("title")).toContain("正在生成");
    expect(image!.getAttribute("aria-disabled")).toBeNull();
    act(() => { video!.click(); });
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("视频节点上当前项是「视频」，另一项提示新建图片节点", () => {
    const container = render({ current: "video", plan: { kind: "create" }, onSwitch: vi.fn() });
    expect(options(container)[1]!.dataset.active).toBe("true");
    expect(options(container)[0]!.getAttribute("title")).toContain("新建一个图片节点");
  });
});

describe("buildLinkedNodeCommands", () => {
  const nodes = [{ id: "img", type: "image", position: { x: 100, y: 40 }, width: 248, height: 232 }];

  it("在源节点右侧新建视频节点，连线并把源图设为参考输入", () => {
    const built = buildLinkedNodeCommands({ sourceNodeId: "img", nextType: "video", nodes, nodeData: { img: { outputAssetId: "a1" } } as never });
    expect(built).not.toBeNull();
    const add = built!.commands[0] as { type: string; node: { id: string; type: string; position: { x: number; y: number } }; nodeData?: { taskKind?: string; inputMapping?: Array<{ sourceNodeId: string }> }; connect?: { fromNodeId: string } };
    expect(add.type).toBe("node.add");
    expect(add.node.type).toBe("video");
    expect(add.node.id).toBe(built!.nodeId);
    // 源节点 x=100 宽 248，间距 120 → 468；与源节点顶端对齐。
    expect(add.node.position).toEqual({ x: 468, y: 40 });
    expect(add.connect?.fromNodeId).toBe("img");
    expect(add.nodeData?.taskKind).toBe("video-generation");
    expect(add.nodeData?.inputMapping?.[0]?.sourceNodeId).toBe("img");
  });

  it("找不到源节点返回 null", () => {
    expect(buildLinkedNodeCommands({ sourceNodeId: "gone", nextType: "video", nodes, nodeData: {} })).toBeNull();
  });
});
