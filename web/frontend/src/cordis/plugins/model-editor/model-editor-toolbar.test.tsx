/**
 * 模型编辑右侧工具栏组件测试
 * （change: add-model-editor-gizmo-shot-capture，任务 2.3）。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ModelEditorToolbar } from "./model-editor-toolbar.js";
import { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import type { ModelCamera } from "@woohaa3/contracts";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function camera(overrides: Partial<ModelCamera> = {}): ModelCamera {
  return { id: "cam-a", name: "镜头 1", order: 0, azimuth: 0.3, elevation: Math.PI / 4, distance: 6, aspect: "16:9", ...overrides };
}

function makeSession(initial: ModelCamera[] = [], writable = true) {
  let cameras = [...initial];
  const session = new ModelEditorSession({
    readCameras: () => cameras,
    isWritable: () => writable,
    submitCameras: (_nodeId, next) => {
      cameras = [...next];
      return true;
    }
  });
  return { session, setCameras: (next: ModelCamera[]) => { cameras = [...next]; } };
}

function render(element: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(element));
  return el;
}

describe("ModelEditorToolbar", () => {
  it("explicit captureEnabled=false omits capture while retaining composition fields", () => {
    const { session } = makeSession([camera()]); session.enter("m1"); session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable captureEnabled={false} onAddCamera={() => undefined} onCapture={() => { throw new Error("unexpected capture"); }} />);
    expect(document.body.textContent).not.toContain("截图");
    expect(document.body.textContent).toContain("仰角");
  });
  it("未进入编辑（nodeId 为 null）时不渲染", () => {
    const { session } = makeSession();
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.querySelector(".model-editor")).toBeNull();
  });

  it("进入编辑后直接显示镜头面板（无模型 tab）", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.querySelector(".model-editor")).not.toBeNull();
    // 已移除模型 tab：不再有 tablist / tab 按钮。
    expect(document.querySelector(".model-editor__tabs")).toBeNull();
    expect(document.querySelector(".model-editor__tab")).toBeNull();
    expect(document.querySelector('[data-model-editor-tool="camera"]')).not.toBeNull();
    expect(document.body.textContent).toContain("镜头 1");
  });

  it("镜头模式显示空态、pose 文本与截图按钮", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.body.textContent).toContain("镜头 1");
    // 动态仰角读数（默认 45°）与距离标签。
    expect(document.body.textContent).toContain("仰角 45°");
    expect(document.body.textContent).toContain("距离");
    expect(document.querySelector(".model-editor__capture-button")).not.toBeNull();
  });

  it("空镜头列表显示空态提示", () => {
    const { session } = makeSession([]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.body.textContent).toContain("还没有镜头");
  });

  it("只读会话禁用添加/删除/截图", () => {
    const { session } = makeSession([camera()], false);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable={false} onAddCamera={() => undefined} onCapture={() => undefined} />);
    const addButton = document.querySelector(".model-editor__add") as HTMLButtonElement;
    const removeButton = document.querySelector(".model-editor__camera-remove") as HTMLButtonElement;
    const captureButton = document.querySelector(".model-editor__capture-button") as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(removeButton.disabled).toBe(true);
    expect(captureButton.disabled).toBe(true);
  });

  it("历史只读：即使会话可写也禁用镜头 CRUD/焦点/重置/截图并显示提示（change: 对齐 xyflow-bevy 历史只读浏览）", () => {
    const { session } = makeSession([camera({ focusOffset: { x: 1, y: 2, z: 3 } })]);
    session.enter("m1");
    session.setToolMode("camera");
    render(
      <ModelEditorToolbar session={session} writable readOnly onAddCamera={() => undefined} onCapture={() => undefined} />
    );
    expect(document.querySelector("[data-read-only='true']")).not.toBeNull();
    expect(document.body.textContent).toContain("历史浏览中");
    expect((document.querySelector(".model-editor__add") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector(".model-editor__camera-remove") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('input[aria-label="注视点 x"]') as HTMLInputElement).disabled).toBe(true);
    expect((document.querySelector(".model-editor__reset") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector(".model-editor__capture-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renderer not-ready 时也禁用动作", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(
      <ModelEditorToolbar session={session} writable rendererReady={false} onAddCamera={() => undefined} onCapture={() => undefined} />
    );
    expect((document.querySelector(".model-editor__add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("点击添加镜头触发回调", () => {
    const { session } = makeSession([]);
    session.enter("m1");
    session.setToolMode("camera");
    let added = 0;
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => { added += 1; }} onCapture={() => undefined} />);
    act(() => (document.querySelector(".model-editor__add") as HTMLButtonElement).click());
    expect(added).toBe(1);
  });

  it("工具栏不渲染角落取景框，也不在右侧面板渲染截图 img", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.querySelector(".model-camera-viewfinder")).toBeNull();
    expect(document.querySelector(".model-editor__preview")).toBeNull();
  });

  it("busy 时截图按钮显示处理中并禁用", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    session.setCapturePhase("uploading");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    const button = document.querySelector(".model-editor__capture-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("处理中");
  });

  it("镜头模式显示焦点 X/Y/Z 字段、重命名与重置（change: 模型编辑 gizmo 焦点）", () => {
    const { session } = makeSession([camera({ focusOffset: { x: 1, y: 2, z: 3 } })]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    expect(document.querySelector("[data-model-editor-focus]")).not.toBeNull();
    const labels = Array.from(document.querySelectorAll(".model-editor__focus-axis span")).map((el) => el.textContent);
    expect(labels).toEqual(["X", "Y", "Z"]);
    expect(document.querySelector(".model-editor__rename input")).not.toBeNull();
    expect(document.querySelector(".model-editor__reset")).not.toBeNull();
    const xInput = document.querySelector('input[aria-label="注视点 x"]') as HTMLInputElement;
    expect(xInput.value).toBe("1");
  });

  it("编辑焦点字段提交一次 modelCameras patch（含 focusOffset）", () => {
    const { session } = makeSession([camera({ id: "cam-a", focusOffset: { x: 0, y: 0, z: 0 } })]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    const yInput = document.querySelector('input[aria-label="注视点 y"]') as HTMLInputElement;
    // 模拟输入：onChange 更新草稿，onBlur 提交一次。
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(yInput, "5");
      yInput.dispatchEvent(new Event("input", { bubbles: true }));
      yInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(session.selectedCamera()!.focusOffset).toEqual({ x: 0, y: 5, z: 0 });
  });

  it("只读会话禁用焦点字段/重命名/重置", () => {
    const { session } = makeSession([camera()], false);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable={false} onAddCamera={() => undefined} onCapture={() => undefined} />);
    const xInput = document.querySelector('input[aria-label="注视点 x"]') as HTMLInputElement;
    const rename = document.querySelector(".model-editor__rename input") as HTMLInputElement;
    const reset = document.querySelector(".model-editor__reset") as HTMLButtonElement;
    expect(xInput.disabled).toBe(true);
    expect(rename.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });

  it("重置按钮使用 defaultDistance 并清空 focusOffset", () => {
    const { session } = makeSession([camera({ focusOffset: { x: 1, y: 1, z: 1 } })]);
    session.enter("m1");
    session.setToolMode("camera");
    render(
      <ModelEditorToolbar session={session} writable defaultDistance={4} onAddCamera={() => undefined} onCapture={() => undefined} />
    );
    act(() => (document.querySelector(".model-editor__reset") as HTMLButtonElement).click());
    expect(session.selectedCamera()!.focusOffset).toBeUndefined();
    expect(session.selectedCamera()!.azimuth).toBe(0);
    expect(session.selectedCamera()!.distance).toBe(4);
  });

  it("显示方位/距离/画幅受控字段并提交（change: fix-model-focus-navigation-and-camera-parity）", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    const azimuth = document.querySelector('input[aria-label="镜头方位角"]') as HTMLInputElement;
    const distance = document.querySelector('input[aria-label="镜头距离"]') as HTMLInputElement;
    const aspect = document.querySelector('select[aria-label="镜头画幅"]') as HTMLSelectElement;
    expect(azimuth).not.toBeNull();
    expect(distance).not.toBeNull();
    expect(aspect).not.toBeNull();
    expect(aspect.value).toBe("16:9");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(distance, "8");
      distance.dispatchEvent(new Event("input", { bubbles: true }));
      distance.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(session.selectedCamera()!.distance).toBe(8);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(aspect, "1:1");
      aspect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(session.selectedCamera()!.aspect).toBe("1:1");
  });

  it("显示镜头 MCP 控制指引并带画布/节点身份", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    render(
      <ModelEditorToolbar
        session={session}
        writable
        canvasId="canvas-a"
        onAddCamera={() => undefined}
        onCapture={() => undefined}
      />
    );
    const guide = document.querySelector('[data-model-editor-mcp-guide="true"]');
    expect(guide).not.toBeNull();
    const text = guide!.textContent ?? "";
    expect(text).toContain("get_model_cameras");
    expect(text).toContain("create_model_camera");
    expect(text).toContain("set_model_camera");
    expect(text).toContain("canvas-a");
    expect(text).toContain("m1");
  });

  it("指引标识当前选中镜头并在切换后更新", () => {
    const { session } = makeSession([
      camera({ id: "cam-a", name: "正面", order: 0 }),
      camera({ id: "cam-b", name: "蚂蚁视角", order: 1 })
    ]);
    session.enter("m1");
    session.selectCamera("cam-a");
    render(
      <ModelEditorToolbar session={session} writable canvasId="canvas-a" onAddCamera={() => undefined} onCapture={() => undefined} />
    );
    let text = document.querySelector('[data-model-editor-mcp-guide="true"]')!.textContent ?? "";
    expect(text).toContain("cam-a（正面）");
    expect(text).toContain("cam-b（蚂蚁视角）");
    expect(text).toContain("当前选中镜头：cam-a");

    act(() => session.selectCamera("cam-b"));
    text = document.querySelector('[data-model-editor-mcp-guide="true"]')!.textContent ?? "";
    expect(text).toContain("当前选中镜头：cam-b");
    expect(text).not.toContain("当前选中镜头：cam-a");
  });

  it("点击复制指引写入剪贴板并反馈", async () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    const copied: string[] = [];
    render(
      <ModelEditorToolbar
        session={session}
        writable
        canvasId="canvas-a"
        copyText={async (value) => {
          copied.push(value);
          return true;
        }}
        onAddCamera={() => undefined}
        onCapture={() => undefined}
      />
    );
    const button = document.querySelector(".model-editor__mcp-guide-copy") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("get_model_cameras");
    expect(button.textContent).toContain("已复制");
  });

  it("历史只读时仍显示指引但写动作禁用", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    render(
      <ModelEditorToolbar
        session={session}
        writable
        readOnly
        canvasId="canvas-a"
        onAddCamera={() => undefined}
        onCapture={() => undefined}
      />
    );
    expect(document.querySelector('[data-model-editor-mcp-guide="true"]')).not.toBeNull();
    expect((document.querySelector(".model-editor__add") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector(".model-editor__mcp-guide-copy") as HTMLButtonElement).disabled).toBe(false);
  });

  it("显示仰角受控字段并提交，越界钳制（change: add-shot-camera-elevation-control）", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    const elevation = document.querySelector('input[aria-label="镜头仰角"]') as HTMLInputElement;
    expect(elevation).not.toBeNull();
    expect(elevation.value).toBe("45"); // 默认 45°

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(elevation, "-30");
      elevation.dispatchEvent(new Event("input", { bubbles: true }));
      elevation.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(session.selectedCamera()!.elevation).toBeCloseTo(-Math.PI / 6, 6);

    // 越界输入被钳到 +90°。
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(elevation, "180");
      elevation.dispatchEvent(new Event("input", { bubbles: true }));
      elevation.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(session.selectedCamera()!.elevation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("仰角工具出现在镜头工具组中（change: add-shot-camera-elevation-control）", () => {
    const { session } = makeSession([camera()]);
    session.enter("m1");
    session.setToolMode("camera");
    render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} />);
    const tools = Array.from(document.querySelectorAll(".model-editor__tool")).map((node) => node.textContent);
    expect(tools).toContain("仰角");
  });
});

it("片场镜头页在镜头控件之后渲染生成入口（change: 2026-10-18-simplify-model-focus-panel）", () => {
  const { session } = makeSession([camera()]); session.enter("m1");
  render(<ModelEditorToolbar session={session} writable onAddCamera={() => undefined} onCapture={() => undefined} renderGenerate={() => <textarea defaultValue="保留构思" />} />);
  const cameras = document.querySelector(".model-editor__cameras-header")!;
  const draft = document.querySelector("textarea")!;
  // 生成入口不再包在可折叠的「镜头与截图」里：普通模型聚焦已移除整套镜头工具。
  expect(document.querySelector(".model-editor__camera-settings")).toBeNull();
  expect(cameras.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(draft.value).toBe("保留构思");
});

it("构图呈现复用参数与截图，省略镜头集合和生成入口", () => {
  const { session } = makeSession([camera()]);
  session.enter("m1");
  render(<ModelEditorToolbar session={session} writable presentation="composition" onAddCamera={() => undefined} onCapture={() => undefined} renderGenerate={() => <textarea />} />);
  expect(document.querySelector(".model-editor__cameras-header")).toBeNull();
  expect(document.querySelector(".model-editor__camera-list")).toBeNull();
  expect(document.querySelector(".model-editor__rename")).toBeNull();
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.querySelector('[data-model-editor-mcp-guide="true"]')).toBeNull();
  expect(document.querySelector('input[aria-label="镜头方位角"]')).not.toBeNull();
  expect(document.querySelector(".model-editor__capture-button")).not.toBeNull();
});
