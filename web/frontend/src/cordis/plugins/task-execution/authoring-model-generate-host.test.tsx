/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import { AuthoringModelGenerateHost } from "./authoring-model-generate-host.js";
import { AuthoringModelGeneratePanel } from "./authoring-model-generate-panel.js";

const mocks = vi.hoisted(() => ({ state: {} as { canvas?: unknown }, submit: vi.fn(() => ({ ok: true, handle: { settled: Promise.resolve({ state: "accepted" }) } })), writable: true }));
vi.mock("../../react.js", () => ({ useService: () => ({ isWritable: () => mocks.writable, submitCommands: mocks.submit }) }));
vi.mock("./use-task-state.js", () => ({ useCanvasStoreState: () => mocks.state }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; mocks.submit.mockClear(); mocks.writable = true; });

function Generate(props: AuthoringGenerationProps) {
  return <>{props.renderers?.references?.()}<textarea aria-label="提示词" /></>;
}

it("3D 生成入口可选择图片、通过画布命令连接和移除；只读时禁用添加", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("cv", "2026-10-13T00:00:00Z");
  canvas.document.nodes.push(
    { id: "model", type: "model3d", position: { x: 0, y: 0 } },
    { id: "image", type: "image", position: { x: 200, y: 0 } },
    { id: "video", type: "video", position: { x: 400, y: 0 } }
  );
  canvas.nodeData.image = { title: "造型参考", outputAssetId: "asset" };
  canvas.assets.push({ id: "asset", title: "参考图", source: "generated", mediaKind: "image", status: "ready", createdAt: "2026-10-13T00:00:00Z", url: "/api/media/reference.png", metadata: { storageKey: "reference.png", contentType: "image/png" } });
  mocks.state = { canvas };
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = (writable = true) => root.render(<AuthoringModelGenerateHost canvasId="cv" nodeId="model" mode="model3d" writable={writable} render={Generate} />);
  await act(async () => render());
  const add = container.querySelector<HTMLButtonElement>('[data-role="add"]')!;
  expect(add).not.toBeNull();
  await act(async () => add.click());
  const options = document.querySelectorAll<HTMLButtonElement>('.ref-picker [role="option"]');
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toContain("造型参考");
  await act(async () => options[0].click());
  expect(JSON.stringify(mocks.submit.mock.calls)).toContain('"source":"image","target":"model"');

  canvas.document.edges.push({ id: "ref-edge", source: "image", target: "model", data: {} });
  canvas.nodeData.model = { inputMapping: [{ sourceNodeId: "image", slotId: "slot", role: "reference_image", sortKey: "0" }] };
  await act(async () => render());
  expect(container.querySelector('.ref-tile[data-slot-id="slot"] img')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="reference-remove"]')!.click());
  expect(JSON.stringify(mocks.submit.mock.calls)).toContain("ref-edge");
  await act(async () => render(false));
  expect(add.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="reference-remove"]')!.disabled).toBe(true);
});

it("合并入口在同一次激活里装配真实 composer 与参考图 renderer，目标节点身份不变", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("cv", "2026-10-13T00:00:00Z");
  canvas.document.nodes.push(
    { id: "model", type: "model3d", position: { x: 0, y: 0 } },
    { id: "image", type: "image", position: { x: 200, y: 0 } }
  );
  canvas.nodeData.image = { title: "造型参考", outputAssetId: "asset" };
  canvas.assets.push({ id: "asset", title: "参考图", source: "generated", mediaKind: "image", status: "ready", createdAt: "2026-10-13T00:00:00Z", url: "/api/media/reference.png", metadata: { storageKey: "reference.png", contentType: "image/png" } });
  mocks.state = { canvas };
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  // 合并入口静态引入 composer：渲染即得到真实面板，不再有「包装 → composer」第二层等待。
  await act(async () => {
    root.render(<AuthoringModelGeneratePanel canvasId="cv" nodeId="model" mode="model3d" writable />);
  });
  const panel = container.querySelector('[data-testid="authoring-generate"]');
  expect(panel).not.toBeNull();
  expect(panel?.querySelector("textarea")).not.toBeNull();
  // 参考图 renderer 由包装注入到真实 composer 的同一目标节点。
  const add = container.querySelector<HTMLButtonElement>('[data-role="add"]');
  expect(add).not.toBeNull();
  await act(async () => add!.click());
  const options = document.querySelectorAll<HTMLButtonElement>('.ref-picker [role="option"]');
  expect(options).toHaveLength(1);
  await act(async () => options[0]!.click());
  expect(JSON.stringify(mocks.submit.mock.calls)).toContain('"source":"image","target":"model"');
});
