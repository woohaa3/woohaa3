/**
 * DialogSurface adapter（change: adopt-radix-lucide-canvas-ui，任务 2.5 / 6.1 / 6.2）。
 *
 * 断言底层 contract：
 * - `DialogSurfaceRoot` 受控 open 与 modal/non-modal；
 * - Escape / outside 只发一次 close request，adapter 不保存业务 stack；
 * - dismissible=false / busy 时 adapter 不回请求关闭；
 * - AlertDialogSurface 默认不响应 Escape（显式选择语义）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AlertDialogSurface,
  DialogSurface,
  DialogSurfaceRoot,
  useDialogSurfaceContext
} from "./DialogSurface.js";

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

/** 在 Host Root 内渲染共享 DialogSurface（模拟 DialogHost 的每层结构）。 */
function HostedDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal?: boolean;
  dismissible?: boolean;
  busy?: boolean;
  alert?: boolean;
}) {
  return (
    <DialogSurfaceRoot
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal ?? true}
      dismissible={props.dismissible ?? true}
      busy={props.busy ?? false}
    >
      {props.alert ? (
        <AlertDialogSurface
          className="dlg dlg--alert dlg--sm"
          ariaLabel="确认"
          busy={props.busy}
        >
          <button type="button">确认</button>
        </AlertDialogSurface>
      ) : (
        <DialogSurface className="dlg dlg--standard dlg--md" ariaLabel="设置" busy={props.busy}>
          <button type="button">主要</button>
        </DialogSurface>
      )}
    </DialogSurfaceRoot>
  );
}

describe("DialogSurface adapter（任务 2.5 / 6.1）", () => {
  it("受控 open 渲染 modal dialog 与可访问名", () => {
    const { container } = render(<HostedDialog open onOpenChange={() => undefined} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("设置");
    expect(dialog.className).toContain("dlg--standard");
  });

  it("open=false 不渲染 content", () => {
    const { container } = render(<HostedDialog open={false} onOpenChange={() => undefined} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Escape 产生一次 close request（adapter 不自行关闭）", () => {
    const onOpenChange = vi.fn();
    const { container } = render(<HostedDialog open onOpenChange={onOpenChange} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // adapter 只发请求：open 仍由外部受控。
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("dismissible=false 时 Escape 不产生 close request", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <HostedDialog open onOpenChange={onOpenChange} dismissible={false} />
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("busy 时 Escape 不产生 close request", () => {
    const onOpenChange = vi.fn();
    const { container } = render(<HostedDialog open onOpenChange={onOpenChange} busy />);
    const dialog = container.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog.className).toContain("dlg--busy");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
  });

  it("non-modal 父层：不暴露 modal 语义", () => {
    const { container } = render(<HostedDialog open onOpenChange={() => undefined} modal={false} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).not.toBe("true");
  });

  it("父层从 top 退化为非 top 时不重挂内容（嵌套确认保留草稿）", () => {
    // 回归：change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2。
    // Radix Root 的 modal 变化会重挂子树；父弹窗必须保留同一 input 节点与输入值。
    function Layer({ top }: { top: boolean }) {
      return (
        <DialogSurfaceRoot open onOpenChange={() => undefined} modal={top}>
          <DialogSurface className="dlg dlg--standard" ariaLabel="设置">
            <input data-testid="draft" defaultValue="ws://relay.local" />
          </DialogSurface>
        </DialogSurfaceRoot>
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.add(root);
    act(() => {
      root.render(<Layer top />);
    });
    const before = container.querySelector('[data-testid="draft"]');
    (before as HTMLElement).dataset.probe = "same";
    act(() => {
      root.render(<Layer top={false} />);
    });
    const after = container.querySelector('[data-testid="draft"]');
    expect(after).toBe(before);
    expect((after as HTMLElement).dataset.probe).toBe("same");
    expect((after as HTMLInputElement).value).toBe("ws://relay.local");
    // 非 top 层不宣称 modal 语义（由 Host inert/aria-hidden 隔离）。
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).not.toBe("true");
  });

  it("父层与子层各自持有独立 surface（nested stack）", () => {
    const { container } = render(
      <>
        <DialogSurfaceRoot open onOpenChange={() => undefined} modal={false}>
          <DialogSurface className="dlg dlg--standard" ariaLabel="父">
            <span>父内容</span>
          </DialogSurface>
        </DialogSurfaceRoot>
        <DialogSurfaceRoot open onOpenChange={() => undefined} modal>
          <DialogSurface className="dlg dlg--standard" ariaLabel="子">
            <span>子内容</span>
          </DialogSurface>
        </DialogSurfaceRoot>
      </>
    );
    const dialogs = container.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    expect(container.textContent).toContain("父内容");
    expect(container.textContent).toContain("子内容");
  });
});

describe("AlertDialogSurface（任务 6.2）", () => {
  it("Host 内 Escape 作为一次 close request 交给 Host policy", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <HostedDialog open onOpenChange={onOpenChange} alert />
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.className).toContain("dlg--alert");
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissible=false 时 Escape 不产生 close request", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <HostedDialog open onOpenChange={onOpenChange} alert dismissible={false} />
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("standalone 渲染（Showcase/静态）", () => {
  function StandaloneProbe() {
    const context = useDialogSurfaceContext();
    return <span data-testid="standalone">{context ? "hosted" : "standalone"}</span>;
  }

  it("无 Host context 时退化为静态 dialog markup", () => {
    const { container } = render(
      <>
        <DialogSurface className="dlg dlg--standard dlg--md" ariaLabel="独立">
          <span>独立内容</span>
        </DialogSurface>
        <StandaloneProbe />
      </>
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector("[data-testid='standalone']")?.textContent).toBe("standalone");
  });
});
