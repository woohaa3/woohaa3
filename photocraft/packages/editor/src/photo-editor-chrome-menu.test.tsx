/** @vitest-environment jsdom */
/**
 * 菜单栏的只读信号回归
 * （change: 2026-10-22-add-photocraft-file-workflows，U01）。
 *
 * 「没有文档」与「真正不可写」是两件事：
 * - 编辑动作在两者任一成立时都必须禁用；
 * - 「新建」只在**没有文档**时才真正有意义，所以它只能受「真正不可写」约束。
 *
 * 外壳用 `locked = panelReadonly || !documentView` 挂菜单栏；若「新建」也沿用它，
 * 就会在唯一该可用的状态下不可点——与面板层修好过的是同一个缺陷的另一条入口。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "./ui/Menu.js";

/** 捕获菜单栏交给下拉菜单的条目定义（避免依赖 portal 与键盘交互）。 */
const captured = vi.hoisted(() => ({ file: [] as MenuItem[] }));

vi.mock("./ui/Menu.js", () => ({
  DropdownMenu: ({ label, items }: { label: string; items: readonly MenuItem[] }) => {
    if (label === "文件") captured.file = [...items];
    return null;
  },
  CursorMenu: () => null
}));

const { EditorMenuBar } = await import("./photo-editor-chrome.js");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  captured.file = [];
});

function renderBar(props: { readonly: boolean; documentlessReadonly?: boolean }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <EditorMenuBar
      commands={new Map()}
      {...props}
      canUndo={false}
      canRedo={false}
      onCommand={() => undefined}
      onApply={() => undefined}
      canSave={false}
      saving={false}
      documents={{ onNewDocument: () => undefined, onOpenFile: () => undefined }}
    />
  ));
  const state = new Map(captured.file.map((item) => [item.id, item.disabled === true]));
  return state;
}

describe("文件菜单的「新建」只受真正只读约束", () => {
  it("没有文档时「新建」仍可用（readonly 含无文档，但真正只读为假）", () => {
    // 无文档但非只读：外壳的 `locked`=true、`panelReadonly`=false。
    const state = renderBar({ readonly: true, documentlessReadonly: false });
    expect(state.get("file.new")).toBe(false);
    // 打开与新建同样不依赖当前存在文档。
    expect(state.get("file.open")).toBe(false);
  });

  it("真正只读时「新建」被禁用", () => {
    const state = renderBar({ readonly: true, documentlessReadonly: true });
    expect(state.get("file.new")).toBe(true);
    expect(state.get("file.open")).toBe(true);
  });

  it("未提供该信号时回退到 readonly（精简宿主行为不变）", () => {
    const state = renderBar({ readonly: true });
    expect(state.get("file.new")).toBe(true);
  });

  it("只读为假时「新建」可用", () => {
    const state = renderBar({ readonly: false, documentlessReadonly: false });
    expect(state.get("file.new")).toBe(false);
  });
});
