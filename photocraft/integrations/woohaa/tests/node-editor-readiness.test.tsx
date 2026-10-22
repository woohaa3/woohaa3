/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NodeEditorReadiness } from "../src/node-editor-readiness.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("anchors readiness to visible image nodes, offers recovery and disappears when ready", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const manage = vi.fn(), retry = vi.fn();
  const runtime = { subscribeViewport: () => () => {}, viewportVersion: () => 0, nodeScreenRect: (id: string) => id === "image" ? { left: 50, top: 70, width: 220, height: 160 } : null };
  const props = { runtime, nodeIds: ["image", "offscreen"], activeNodeId: "image", onSelect: vi.fn(), onManage: manage, onRetry: retry };
  await act(async () => root.render(<NodeEditorReadiness {...props} activeNodeId={null} readiness={{ phase: "loading", label: "准备中", tip: "" }} />));
  expect(container.childElementCount).toBe(0);
  await act(async () => root.render(<NodeEditorReadiness {...props} readiness={{ phase: "missing", label: "编辑组件未安装", tip: "图片仍可查看" }} />));
  expect(container.querySelectorAll("[data-readiness-node]")).toHaveLength(1);
  expect(container.querySelector("[data-readiness-node]")?.getAttribute("style")).toContain("50px");
  expect(container.querySelector("[data-loading]")).toBeNull();
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "安装组件")!.click());
  expect(manage).toHaveBeenCalledOnce();
  await act(async () => root.render(<NodeEditorReadiness {...props} readiness={{ phase: "loading", label: "正在下载编辑器…", tip: "准备完成后可编辑" }} />));
  expect(container.querySelector("[data-loading]")).not.toBeNull();
  await act(async () => root.render(<NodeEditorReadiness {...props} readiness={{ phase: "failed", label: "编辑器准备失败", tip: "连接失败" }} />));
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "重试")!.click());
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => root.render(<NodeEditorReadiness {...props} readiness={{ phase: "ready", label: "", tip: "" }} />));
  expect(container.childElementCount).toBe(0);
  act(() => root.unmount()); container.remove();
});
