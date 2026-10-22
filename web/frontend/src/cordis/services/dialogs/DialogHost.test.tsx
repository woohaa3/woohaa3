/**
 * Dialog Host 集成（change: add-frontend-dialog-system，任务 3.1 / 3.2 / 3.3 / 4.4）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { DialogHost } from "./DialogHost.js";
import { DialogService } from "./service.js";
import { DialogRegistry } from "./registry.js";
import { DialogHostStore } from "./host-store.js";
import { alertDefinition } from "./alert-dialog.js";
import { mediaPreviewDefinition } from "../../plugins/media-preview/media-preview.js";

let root: Root | null = null;
let service: DialogService;
let store: DialogHostStore;

function mountHost() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DialogHost
        dialogs={service}
        renderDialog={({ instance, requestClose, setBusy, replace }) =>
          instance.dialogId === "alert" ? (
            <AlertProbe instance={instance} requestClose={requestClose} setBusy={setBusy} replace={replace} />
          ) : null
        }
      />
    );
  });
  return container;
}

beforeEach(() => {
  const registry = new DialogRegistry();
  registry.register("alert", alertDefinition);
  registry.register("media-preview", mediaPreviewDefinition);
  store = new DialogHostStore(registry);
  service = new DialogService({ store });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

import { AlertDialog } from "./AlertDialog.js";
import type { DialogRendererProps } from "./renderer-registry.js";

function AlertProbe({ instance, requestClose, setBusy }: DialogRendererProps) {
  void setBusy;
  const payload = instance.payload as { title: string; description: string };
  return (
    <AlertDialog
      instanceId={instance.instanceId}
      title={payload.title}
      description={payload.description}
      onCancel={requestClose}
      onConfirm={async () => ({ ok: true })}
    />
  );
}

describe("DialogHost", () => {
  it("渲染 stack 顶部并暴露可访问 modal", () => {
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "确认删除", description: "不可撤销" } });
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("确认删除");
    expect(container.textContent).toContain("不可撤销");
  });

  it("一次 Escape 只关闭顶部且不触发默认行为", () => {
    mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "父", description: "父说明" } });
      store.open({ dialogId: "alert", payload: { title: "子", description: "子说明" } });
    });
    expect(store.getSnapshot().stack).toHaveLength(2);
    // 从 document 派发 Escape（Radix DismissableLayer 在 capture 阶段接管最高层）。
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(store.getSnapshot().stack).toHaveLength(1);
    expect(store.getSnapshot().activeDialogId).toBe("alert");
  });

  it("非顶部实例标记为不可交互（aria-hidden）", () => {
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "父", description: "父说明" } });
      store.open({ dialogId: "alert", payload: { title: "子", description: "子说明" } });
    });
    const layers = container.querySelectorAll(".dlg-host__layer");
    expect(layers).toHaveLength(2);
    expect(layers[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(layers[1]!.getAttribute("aria-hidden")).toBeNull();
  });

  it("busy 时 Escape 不关闭", () => {
    mountHost();
    let id = "";
    act(() => {
      const result = store.open({ dialogId: "alert", payload: { title: "t", description: "d" } });
      if (result.ok) id = result.instance.instanceId;
    });
    act(() => {
      store.setBusy(id, true);
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(store.getSnapshot().isModalActive).toBe(true);
  });

  it("关闭顶部后焦点恢复到 opener", () => {
    // 放一个可聚焦的 opener 再打开弹窗。
    const opener = document.createElement("button");
    opener.id = "opener";
    document.body.appendChild(opener);
    opener.focus();
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "t", description: "d" } });
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      store.closeTop();
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("未注册 renderer 的 dialog 不崩溃", () => {
    // 注册一个只有定义、没有 renderer 的 dialog。
    store.registryRef().register("no-renderer", { validatePayload: () => ({ ok: true, payload: {} }) });
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "no-renderer" });
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(store.getSnapshot().isModalActive).toBe(true);
  });
});
