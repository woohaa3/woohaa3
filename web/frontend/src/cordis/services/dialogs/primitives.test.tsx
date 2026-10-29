/**
 * Dialog primitives DOM 结构（change: add-frontend-dialog-system，任务 2.1）。
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { AlertDialog } from "@woohaa3/ui/dialogs";
import { MediaDialog } from "@woohaa3/ui/media";

// React 18 需要显式声明 act 环境。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

describe("DialogContent", () => {
  it("渲染 modal dialog 与可访问名称", () => {
    const { container } = render(
      <Dialog.Content ariaLabel="片段库" size="lg">
        <DialogHeader>
          <DialogTitle id="t">标题</DialogTitle>
        </DialogHeader>
        <DialogBody>正文</DialogBody>
      </Dialog.Content>
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.getAttribute("aria-label")).toBe("片段库");
    expect(dialog!.className).toContain("dlg--standard");
    expect(dialog!.className).toContain("dlg--lg");
    expect(container.querySelector(".dlg__body")).not.toBeNull();
  });

  it("缺少可访问名称时抛错", () => {
    expect(() => render(<DialogContent>无名称</DialogContent>)).toThrow(/ariaLabel/);
  });

  it("提供 variants 与 sizes", () => {
    const { container } = render(
      <Dialog.Content variant="media" size="fullscreen" ariaLabel="媒体">
        内容
      </Dialog.Content>
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain("dlg--media");
    expect(dialog.className).toContain("dlg--fullscreen");
  });

  it("standard 与 sheet variant 结构稳定", () => {
    const { container } = render(
      <Dialog.Content variant="sheet" size="md" ariaLabel="底部面板">
        <DialogHeader>
          <DialogTitle id="s">标题</DialogTitle>
        </DialogHeader>
        <DialogBody>正文</DialogBody>
      </Dialog.Content>
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain("dlg--sheet");
    expect(dialog.className).toContain("dlg--md");
    expect(dialog.getAttribute("aria-label")).toBe("底部面板");
  });

  it("描述关联 aria-describedby", () => {
    const { container } = render(
      <Dialog.Content ariaLabel="标题" describedBy="desc-1">
        <p id="desc-1">补充说明</p>
      </Dialog.Content>
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-describedby")).toBe("desc-1");
    expect(container.querySelector("#desc-1")?.textContent).toBe("补充说明");
  });
});

describe("AlertDialog", () => {
  it("异步确认只执行一次并进入 busy", async () => {
    let calls = 0;
    let resolveConfirm: ((value: { ok: true }) => void) | null = null;
    const { container } = render(
      <AlertDialog
        instanceId="i1"
        title="删除片段"
        description="不可撤销"
        onCancel={() => undefined}
        onConfirm={() => {
          calls += 1;
          return new Promise((resolve) => {
            resolveConfirm = resolve;
          });
        }}
      />
    );
    const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
    act(() => {
      confirm.click();
      confirm.click();
      confirm.click();
    });
    expect(calls).toBe(1);
    expect(confirm.disabled).toBe(true);
    // 收尾：避免悬挂 promise。
    await act(async () => {
      resolveConfirm?.({ ok: true });
    });
  });

  it("确认失败保留弹窗并显示错误", async () => {
    const { container } = render(
      <AlertDialog
        instanceId="i2"
        title="删除"
        description="说明"
        onCancel={() => undefined}
        onConfirm={async () => ({ ok: false, error: "网络失败" })}
      />
    );
    const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
    await act(async () => {
      confirm.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络失败");
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(confirm.disabled).toBe(false);
  });
});

describe("MediaDialog", () => {
  it("渲染图片、共享媒体工作区、图标工具条与关闭控件", () => {
    const { container } = render(
      <MediaDialog instanceId="m1" title="结果图" url="/api/media/x" onClose={() => undefined} />
    );
    expect(container.querySelector(".dlg--media")).not.toBeNull();
    expect(container.querySelector(".dlg--fullscreen")).not.toBeNull();
    // 共享媒体工作区：主媒体区 + 中性舞台 + 应用 chrome Header/Toolbar。
    expect(container.querySelector(".dlg__media-workspace")).not.toBeNull();
    expect(container.querySelector(".dlg__media-main")).not.toBeNull();
    expect(container.querySelector(".dlg__stage--image")).not.toBeNull();
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/media/x");
    expect(container.querySelector(".dlg__zoom")?.textContent).toContain("100%");
    // 缩小/放大/重置使用 SVG 图标按钮，而非字体字符。
    for (const name of ["缩小", "放大", "适应屏幕并重置"]) {
      const button = container.querySelector<HTMLButtonElement>(`.dlg__icon-button[aria-label="${name}"]`);
      expect(button, name).not.toBeNull();
      expect(button!.querySelector("svg"), `${name} 应为 SVG 图标`).not.toBeNull();
      expect(button!.textContent?.trim() ?? "").toBe("");
    }
  });

  it("资产失效时显示不可用状态且仍可关闭", () => {
    const { container } = render(
      <MediaDialog instanceId="m2" title="结果图" url={null} onClose={() => undefined} />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("不可用");
    expect(container.querySelector(".dlg__close")).not.toBeNull();
  });

  it("空标题回退到默认可访问名称并重置缩放", () => {
    const { container } = render(
      <MediaDialog instanceId="m3" title="" url="/api/media/y" onClose={() => undefined} />
    );
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("媒体预览");
    const reset = container.querySelector<HTMLButtonElement>('.dlg__icon-button[aria-label="适应屏幕并重置"]')!;
    act(() => reset.click());
    expect(container.querySelector(".dlg__zoom")?.textContent).toContain("100%");
  });
});
