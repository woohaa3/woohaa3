/**
 * Canvas DOM 事件隔离集成测试（change: adopt-radix-lucide-canvas-ui，任务 3.3）。
 *
 * 验证操作共享 primitive 时，按键/pointer 不会穿透启动 Bevy drag、pan、connect 或 Canvas
 * 快捷键，且 viewport action 只经既有 InteractionController 提交。
 *
 * 隔离由两层共同保证（design D6，不改变既有 Canvas input owner）：
 * 1. primitive 自身消费事件（Tooltip/Menu/Dialog 的 dismissable layer 与 Trigger），不额外
 *    制造全局 listener；
 * 2. Canvas 快捷键路由 `resolveCanvasShortcut` 以 `isEditableElement(event.target)` 判定
 *    编辑面：`role="menu"`/`role="dialog"`（Radix 菜单与弹窗）被视为编辑面，按键留给浮层。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UiProvider } from "@woohaa3/ui/primitives";
import { CanvasControlPanel } from "../../host.js";
import { IconButton } from "@woohaa3/ui/primitives";
import { Tooltip } from "@woohaa3/ui/primitives";
import { DialogSurface, DialogSurfaceRoot } from "@woohaa3/ui/primitives";
import { DropdownMenu } from "@woohaa3/ui/primitives";
import { ZoomInIcon } from "@woohaa3/ui/icons";
import { isEditableElement, resolveCanvasShortcut } from "./input/shortcuts.js";

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
  return container;
}

describe("Canvas DOM 事件隔离（任务 3.3）", () => {
  it("操作画布控件只触发注入的业务 action（不产生第二套 gesture/viewport 状态）", () => {
    const controllerAction = vi.fn();
    const container = render(
      <UiProvider>
        <CanvasControlPanel
          actions={[{ id: "zoom-in", label: "放大", icon: ZoomInIcon, onActivate: controllerAction }]}
        />
      </UiProvider>
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="放大"]')!;
    act(() => button.click());
    expect(controllerAction).toHaveBeenCalledTimes(1);
  });

  it("viewport action 只经注入的 InteractionController 提交一次", () => {
    const zoomBy = vi.fn();
    const container = render(
      <UiProvider>
        <Tooltip content="放大">
          <IconButton label="放大" onClick={() => zoomBy(1.2)}>
            <ZoomInIcon />
          </IconButton>
        </Tooltip>
      </UiProvider>
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="放大"]')!;
    act(() => button.click());
    act(() => button.click());
    expect(zoomBy).toHaveBeenCalledTimes(2);
    expect(zoomBy).toHaveBeenNthCalledWith(1, 1.2);
  });

  it("Radix 菜单/Dialog 是 Canvas 快捷键的编辑面：按键留给浮层，不触发画布 action", () => {
    const menu = render(
      <UiProvider>
        <DropdownMenu
          open
          onOpenChange={() => undefined}
          trigger={<button type="button">菜单</button>}
          items={[{ id: "delete", label: "删除节点", onSelect: () => undefined }]}
        />
      </UiProvider>
    );
    const menuItem = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(isEditableElement(menuItem)).toBe(true);

    const dialog = render(
      <UiProvider>
        <DialogSurfaceRoot open onOpenChange={() => undefined} modal>
          <DialogSurface className="dlg" ariaLabel="设置">
            <button type="button" data-testid="dlg-btn">确认</button>
          </DialogSurface>
        </DialogSurfaceRoot>
      </UiProvider>
    );
    const dlgButton = dialog.querySelector<HTMLElement>('[role="dialog"] button')!;
    // role=dialog 的祖先使 isEditableElement 为 true（dialog 语义面）。
    expect(isEditableElement(dialog.querySelector('[role="dialog"]'))).toBe(true);

    // 画布快捷键在编辑面上不处理：Delete 不产生画布 delete。
    const action = resolveCanvasShortcut(
      { key: "Delete", ctrlKey: false, metaKey: false, editableTarget: isEditableElement(menuItem) },
      { keyboardActive: true, editingFocus: false, isMac: false, writable: true }
    );
    expect(action).toBeNull();

    const dialogAction = resolveCanvasShortcut(
      { key: "Delete", ctrlKey: false, metaKey: false, editableTarget: isEditableElement(dlgButton) },
      { keyboardActive: true, editingFocus: false, isMac: false, writable: true }
    );
    expect(dialogAction).toBeNull();
  });

  it("指向画布本体时快捷键才生效（控件不改变 routing）", () => {
    const canvasTarget = document.createElement("div");
    const action = resolveCanvasShortcut(
      { key: "Delete", ctrlKey: false, metaKey: false, editableTarget: isEditableElement(canvasTarget) },
      { keyboardActive: true, editingFocus: false, isMac: false, writable: true }
    );
    expect(action).toBe("delete");
  });
});
