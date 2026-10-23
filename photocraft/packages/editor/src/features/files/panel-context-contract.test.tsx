/**
 * 外壳只读信号契约回归（change: 2026-10-22-add-photocraft-file-workflows，U01）。
 *
 * 真实缺陷：共享外壳曾用 `locked = … || !documentView` 一个布尔既表示「只读/忙碌」，
 * 又表示「没有文档」，再把 `readonly={locked}` 传给各域面板。新建文档**只在没有文档时**
 * 成立，于是新建表单在唯一可用的状态下被整片禁用，有文档时又被槽位规则拒绝——两态都不可用。
 *
 * 修复把语义拆开：
 * - `locked`：当前文档不可写（含没有文档），给操作当前文档的面板；
 * - `readonly`：真正不可写（只读/关闭/忙碌/过渡/导出/模态），**不含没有文档**，给新建入口。
 *
 * 这里只断言 `FeaturePanelContext` 的契约形状与 files 域的取用，不重复面板像素级用例。
 */
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { sections } from "./sections.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function mount(context: Record<string, unknown>, index = 0) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<>{sections[index]!.render(context as never)}</>));
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.includes(label));
  return { container, button };
}

describe("外壳只读信号与新建入口", () => {
  const controller = { features: { files: { createDocument: vi.fn() } }, ensureEditor: vi.fn(async () => ({ ok: true, value: {} })) } as unknown as EditorWorkspaceController;

  it("没有文档时 locked 为 true 但 readonly 为 false：新建入口必须可用", () => {
    // 这正是真实外壳在首启（尚未打开任何文档）时的组合。
    const { container, button } = mount({ controller, locked: true, readonly: false, documentView: null });
    expect(button("新建")).toBeTruthy();
    expect(button("新建")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("独立文档槽位");
  });

  it("真正只读时 readonly 为 true：新建入口禁用", () => {
    const { button } = mount({ controller, locked: true, readonly: true, documentView: null });
    expect(button("新建")!.disabled).toBe(true);
  });

  it("已有文档时给出槽位原因，而不是让用户点击后吃内核拒绝", () => {
    const { container, button } = mount({
      controller,
      locked: false,
      readonly: false,
      documentView: { width: 640, height: 480 }
    });
    expect(button("新建")!.disabled).toBe(true);
    expect(container.textContent).toContain("独立文档槽位");
  });

  it("操作当前文档的面板继续用 locked（没有文档时禁用）", () => {
    // filesCopy / filesFileInfo 依赖当前文档：没有文档时应当禁用，与新建的语义不同。
    const { button: copy } = mount({ controller, locked: true, readonly: false, documentView: null }, 1);
    expect(copy("复制")?.disabled ?? true).toBe(true);
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    const { button: info } = mount({ controller, locked: true, readonly: false, documentView: null }, 2);
    expect(info("读取")?.disabled ?? true).toBe(true);
  });
});
