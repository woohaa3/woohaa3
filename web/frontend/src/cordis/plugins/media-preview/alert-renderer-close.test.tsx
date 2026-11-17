/**
 * 内置 alert renderer 的关闭契约
 * （现场问题：纯提示弹窗点「确认」后界面卡死）。
 *
 * `AlertDialog` 成功后**保持 busy** 等 Host 关闭（防止关闭前被再次触发），所以成功路径必须由
 * renderer 自己按 instanceId 关闭。漏掉这一步的症状是：确认后 busy 永不复位，确认/取消/Escape/
 * 遮罩全部失效，弹窗一直盖在画布上——用户看到的就是「点了确认就卡死」。
 *
 * 这些用例直接渲染 `createAlertRenderer` 的真实实现（不是手写的假 renderer），锁住这条契约。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogHost } from "../../services/dialogs/DialogHost.js";
import { DialogService } from "../../services/dialogs/service.js";
import { DialogHostStore } from "../../services/dialogs/host-store.js";
import { DialogRegistry } from "../../services/dialogs/registry.js";
import { ALERT_DIALOG_ID, alertDefinition } from "../../services/dialogs/alert-dialog.js";
import { createAlertRenderer } from "./builtin-renderers.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let service: DialogService;
let store: DialogHostStore;

beforeEach(() => {
  const registry = new DialogRegistry();
  registry.register(ALERT_DIALOG_ID, alertDefinition);
  store = new DialogHostStore(registry);
  service = new DialogService({ store });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mountHost() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = createRoot(container);
  root = instance;
  const Renderer = createAlertRenderer(service);
  act(() => instance.render(<DialogHost dialogs={service} renderDialog={props => <Renderer {...props} />} />));
  return container;
}

describe("内置 alert renderer 的关闭契约", () => {
  it("无 actionKey 的纯提示：点确认后弹窗关闭，不留在 busy", async () => {
    const container = mountHost();
    act(() => {
      store.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "整理未完成", description: "请选择画布卡片整理" } });
    });
    expect(store.getSnapshot().stack).toHaveLength(1);

    const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
    await act(async () => {
      confirm.click();
    });

    // 关键断言：关闭了。若仍停在 busy，用户无法关闭弹窗也点不动画布。
    expect(store.getSnapshot().stack).toHaveLength(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("带 actionKey 且动作成功：弹窗同样关闭", async () => {
    const dispose = service.registerAlertAction("test-ok", async () => ({ ok: true }));
    try {
      const container = mountHost();
      act(() => {
        store.open({
          dialogId: ALERT_DIALOG_ID,
          payload: { title: "删除", description: "确认删除", actionKey: "test-ok" }
        });
      });
      const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
      await act(async () => {
        confirm.click();
      });
      expect(store.getSnapshot().stack).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("动作失败：保留弹窗、退出 busy 并可再次点击", async () => {
    const dispose = service.registerAlertAction("test-fail", async () => ({ ok: false, error: "网络失败" }));
    try {
      const container = mountHost();
      act(() => {
        store.open({
          dialogId: ALERT_DIALOG_ID,
          payload: { title: "删除", description: "确认删除", actionKey: "test-fail" }
        });
      });
      const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
      await act(async () => {
        confirm.click();
      });
      expect(store.getSnapshot().stack).toHaveLength(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络失败");
      expect(confirm.disabled).toBe(false);
    } finally {
      dispose();
    }
  });

  it("取消仍可关闭（确认路径的修复没有破坏既有出口）", async () => {
    const container = mountHost();
    act(() => {
      store.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "整理未完成", description: "原因" } });
    });
    const cancel = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button")!;
    await act(async () => {
      cancel.click();
    });
    expect(store.getSnapshot().stack).toHaveLength(0);
  });
});
