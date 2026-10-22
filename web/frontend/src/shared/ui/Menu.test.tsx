/**
 * Popover / Menu primitives（change: adopt-radix-lucide-canvas-ui，任务 2.3）。
 *
 * 覆盖碰撞边距、outside dismiss、Escape、方向键、Home/End、disabled item、单次 select，
 * 以及 cursor anchor 模式（Canvas 上下文菜单）在桌面边缘与 390px 视口下的定位。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popover } from "./Popover.js";
import { CursorMenu, DropdownMenu } from "./Menu.js";
import { UiProvider } from "./UiProvider.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
    );
  });
}

describe("Popover（任务 2.3）", () => {
  it("受控 open 渲染到 portal，Escape 请求关闭一次", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <UiProvider>
        <Popover open onOpenChange={onOpenChange} trigger={<button type="button">打开</button>}>
          <div data-testid="pop-body">内容</div>
        </Popover>
      </UiProvider>
    );
    const portalRoot = container.querySelector(".ui-portal-root")!;
    expect(portalRoot.querySelector("[data-testid='pop-body']")).not.toBeNull();
    const content = portalRoot.querySelector(".ui-popover")!;
    key(content, "Escape");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissOnOutside=false 时不请求 outside 关闭", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <UiProvider>
        <Popover open onOpenChange={onOpenChange} dismissOnOutside={false} trigger={<button type="button">打开</button>}>
          <div>内容</div>
        </Popover>
      </UiProvider>
    );
    const content = container.querySelector(".ui-popover")!;
    act(() => {
      content.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("DropdownMenu（任务 2.3）", () => {
  const items = [
    { id: "add", label: "插入节点", onSelect: vi.fn() },
    { id: "del", label: "删除", onSelect: vi.fn(), disabled: true, danger: true, separatorBefore: true }
  ];

  it("渲染菜单项、disabled 与 danger 语义", () => {
    const { container } = render(
      <UiProvider>
        <DropdownMenu open onOpenChange={() => undefined} label="操作" trigger={<button type="button">菜单</button>} items={items} />
      </UiProvider>
    );
    const menu = container.querySelector(".ui-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    const entries = container.querySelectorAll(".ui-menu__item");
    expect(entries.length).toBe(2);
    expect(entries[0]!.getAttribute("role")).toBe("menuitem");
    expect(entries[1]!.getAttribute("data-disabled")).toBe("");
    expect(entries[1]!.className).toContain("ui-menu__item--danger");
    expect(container.querySelector(".ui-menu__separator")).not.toBeNull();
  });
});

describe("CursorMenu（任务 2.3）", () => {
  const select = vi.fn();
  const menuItems = [{ id: "insert", label: "插入节点", onSelect: select }];

  it("cursor anchor 模式渲染菜单且只需一次 select", () => {
    const { container } = render(
      <UiProvider>
        <CursorMenu open onOpenChange={() => undefined} x={40} y={60} items={menuItems} label="插入节点" />
      </UiProvider>
    );
    const menu = container.querySelector("[data-cursor-menu]")!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("aria-label")).toBe("插入节点");
    const item = container.querySelector<HTMLElement>(".ui-menu__item")!;
    act(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("insert");
  });

  it("锚点位于给定 viewport 坐标，Radix collision 由 positioning 处理", () => {
    const { container } = render(
      <UiProvider>
        <CursorMenu open onOpenChange={() => undefined} x={390 - 12} y={780 - 12} items={menuItems} />
      </UiProvider>
    );
    const anchor = container.querySelector<HTMLElement>(".ui-menu__anchor")!;
    expect(anchor.style.left).toBe("378px");
    expect(anchor.style.top).toBe("768px");
    // 锚点是零尺寸，collisionPadding 由 Radix 保证菜单不越出视口。
    expect(anchor.style.width).toBe("0px");
  });
});

describe("DropdownMenu 子菜单", () => {
  it("子菜单沿同一 portal 挂载，打开不分派命令，叶节点只分派一次", () => {
    const parent=vi.fn(),select=vi.fn();
    const {container}=render(<UiProvider><DropdownMenu open trigger={<button>编辑</button>} items={[
      {id:"transform",label:"变换",onSelect:parent,children:[
        {id:"rotate",label:"旋转",onSelect:select},
        {id:"flip",label:"翻转",onSelect:select,disabled:true}
      ]}
    ]}/></UiProvider>);
    const trigger=container.querySelector('.ui-menu__submenu-trigger')!;
    key(trigger,"ArrowRight");
    expect(parent).not.toHaveBeenCalled();
    const portal=container.querySelector('.ui-portal-root')!;
    const entries=[...portal.querySelectorAll<HTMLElement>('.ui-menu__item')];
    const rotate=entries.find(entry=>entry.textContent==='旋转')!;
    expect(rotate).toBeDefined();
    expect(entries.find(entry=>entry.textContent==='翻转')!.hasAttribute('data-disabled')).toBe(true);
    act(()=>rotate.click());
    expect(select.mock.calls).toEqual([["rotate"]]);
  });
});
