/** @vitest-environment jsdom */
// 只验证工具栏分组的结构与禁用门禁；不创建渲染上下文或截图。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EditorToolRail, PHOTO_TOOLS } from "../../photo-editor-chrome.js";
import { VECTOR_TOOLS } from "./vector-tools.js";

vi.mock("../../ui/Popover.js", () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div data-group-menu>{children}</div> : null),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 12 个矢量工具必须收进「形状 / 钢笔 / 路径」三个组，而不是平铺在竖排工具栏里。
 *
 * 这条测试挡的是两类只有接进共享工具栏才会暴露的错：组内成员漏登记（工具点不到），
 * 以及主按钮与成员不一致（点了「形状」却选到钢笔）。
 */
it("矢量工具在工具栏合并为三个组，成员与 VECTOR_TOOLS 一致", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onTool = vi.fn();
  try {
    act(() => root.render(
      <EditorToolRail tool="move" onTool={onTool} readonly={false} color="#000000" onColor={vi.fn()} />,
    ));
    // 三组的主按钮标签 = 各组第一个工具的标签。
    const heads = [...new Set(VECTOR_TOOLS.map(tool => tool.group))]
      .map(group => VECTOR_TOOLS.find(tool => tool.group === group)!);
    const rail = container.querySelector(".photo-editor__toolrail")!;
    const buttons = [...rail.querySelectorAll<HTMLButtonElement>("button[aria-label]")];
    for (const head of heads) {
      expect(buttons.some(button => button.getAttribute("aria-label") === (head.group === "pen" ? "钢笔" : head.label))).toBe(true);
    }
    // 非组头的矢量工具**不**单独出现在工具栏上（否则 12 个工具会挤满竖排）。
    for (const tool of VECTOR_TOOLS.filter(tool => !heads.some(head => head.id === tool.id))) {
      expect(buttons.some(button => button.getAttribute("aria-label") === tool.label)).toBe(false);
    }
    // 组内成员必须都能被点到：展开第一组后逐个校验标签，并确认回调拿到对应 id。
    act(() => rail.querySelector<HTMLButtonElement>(`button[aria-label="${heads[0]!.label}"]`)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    ));
    const menu = container.querySelector("[data-group-menu]");
    expect(menu).not.toBeNull();
    const members = PHOTO_TOOLS.filter(entry => VECTOR_TOOLS.some(tool => tool.group === heads[0]!.group && tool.id === entry.id));
    const menuButtons = [...menu!.querySelectorAll<HTMLButtonElement>("button")];
    expect(menuButtons.map(button => button.textContent?.replace(/[A-Z]$/, ""))).toEqual(members.map(member => member.label));
    act(() => menuButtons.at(-1)!.click());
    expect(onTool).toHaveBeenLastCalledWith(members.at(-1)!.id);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("只读时矢量工具组的主按钮禁用，长按与右键都不展开", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onTool = vi.fn();
  try {
    act(() => root.render(
      <EditorToolRail tool="move" onTool={onTool} readonly color="#000000" onColor={vi.fn()} />,
    ));
    const head = VECTOR_TOOLS.find(tool => tool.group === "shape")!;
    const button = container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail button[aria-label="${head.label}"]`)!;
    expect(button.disabled).toBe(true);
    act(() => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    act(() => vi.advanceTimersByTime(400));
    act(() => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(container.querySelector("[data-group-menu]")).toBeNull();
    act(() => button.click());
    expect(onTool).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
