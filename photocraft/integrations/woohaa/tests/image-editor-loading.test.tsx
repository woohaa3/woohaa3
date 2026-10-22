/** @vitest-environment jsdom */
// 仅测试动态界面模块失败/重试，不加载内核或执行渲染。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditorWorkspace } from "../src/image-editor-overlay.js";
import type { ProjectEditorPort } from "../src/project-editor-pane.js";
import { bindingOf, storeWith } from "../src/test-support/document-workspace-harness.js";
const loading = vi.hoisted(() => ({ attempts: 0 }));
vi.mock("@woohaa3/frontend/plugin-api", async (importOriginal) => ({ ...(await importOriginal<object>()), FocusHeader: () => null }));
vi.mock("../src/project-editor-pane.js", () => {
  loading.attempts++;
  if (loading.attempts === 1) throw new Error("模拟界面模块下载失败");
  return { ProjectEditorPane: () => <div data-loaded-editor="true" /> };
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
it("模块下载失败保留图片工作区并提供重试，重试后挂载编辑界面", async () => {
  const store = storeWith();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={() => undefined} onCloseDocument={() => undefined} />));
  expect(container.textContent).toContain("图片编辑界面加载失败");
  expect(container.querySelector("img,canvas")).toBeNull();
  expect(container.querySelector("[data-loaded-editor]")).toBeNull();
  await act(async () => {
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("重试加载"));
    retry!.click();
  });
  expect(loading.attempts).toBe(2);
  expect(container.querySelector("[data-loaded-editor]")).not.toBeNull();
});

it("活动绑定切换文档时不保留旧界面实例", async () => {
  const first = storeWith();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={first} projectPort={{} as ProjectEditorPort} onActivateDocument={() => undefined} onCloseDocument={() => undefined} />));
  expect(container.querySelector("[data-loaded-editor]")).not.toBeNull();
  await act(async () => first.update({ active: bindingOf({ documentId: "doc-2", name: "另一个" }) }));
  expect(container.querySelector("[data-loaded-editor]")).not.toBeNull();
  expect(container.querySelectorAll("[data-loaded-editor]")).toHaveLength(1);
});
