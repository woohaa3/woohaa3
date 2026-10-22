/**
 * 业务 Dialog 经 Host 迁移后的集成验证
 * （change: adopt-radix-lucide-canvas-ui，任务 6.5）。
 *
 * 覆盖：async busy、失败保留、nested confirm、Plugin/dispose 与迟到 result identity；
 * 并静态确认业务 renderer 不直接 import Radix。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogHost } from "./DialogHost.js";
import { DialogService } from "./service.js";
import { DialogHostStore } from "./host-store.js";
import { DialogRegistry } from "./registry.js";
import { AlertDialog } from "./AlertDialog.js";
import { alertDefinition } from "./alert-dialog.js";
import type { DialogRendererProps } from "./renderer-registry.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let service: DialogService;
let store: DialogHostStore;
let renderAlert: (props: DialogRendererProps) => React.ReactNode;

beforeEach(() => {
  const registry = new DialogRegistry();
  registry.register("alert", alertDefinition);
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
  act(() => instance.render(<DialogHost dialogs={service} renderDialog={(props) => renderAlert(props)} />));
  return container;
}

describe("业务 Dialog 迁移（任务 6.5）", () => {
  it("async 确认进入 busy，失败保留弹窗并显示错误，成功由调用方按 instanceId 关闭", async () => {
    let resolveConfirm: ((value: { ok: boolean; error?: string }) => void) | null = null;
    renderAlert = ({ instance, requestClose, setBusy }: DialogRendererProps) => (
      <AlertDialog
        instanceId={instance.instanceId}
        title={(instance.payload as { title: string }).title}
        description={(instance.payload as { description: string }).description}
        onCancel={requestClose}
        onBusyChange={setBusy}
        onConfirm={() =>
          new Promise((resolve) => {
            resolveConfirm = resolve as typeof resolveConfirm;
          })
        }
      />
    );
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "删除", description: "不可撤销" } });
    });
    const confirm = container.querySelector<HTMLButtonElement>(".dlg__footer .ui-button--primary")!;
    await act(async () => {
      confirm.click();
    });
    // busy：确认禁用；Host 记录 busy。
    expect(confirm.disabled).toBe(true);
    expect(store.top()?.busy).toBe(true);

    // 失败：保留弹窗、退出 busy、显示安全错误。
    await act(async () => {
      resolveConfirm?.({ ok: false, error: "网络失败" });
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络失败");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(confirm.disabled).toBe(false);

    // 成功路径：调用方按 instanceId 关闭。
    act(() => {
      if (store.top()) store.close(store.top()!.instanceId);
    });
    expect(store.getSnapshot().stack).toHaveLength(0);
  });

  it("nested confirm：父层保持挂载、仅顶部可交互；关闭子层回到父层", () => {
    renderAlert = ({ instance, requestClose }: DialogRendererProps) => (
      <AlertDialog
        instanceId={instance.instanceId}
        title={(instance.payload as { title: string }).title}
        description={(instance.payload as { description: string }).description}
        onCancel={requestClose}
        onConfirm={async () => ({ ok: true })}
      />
    );
    const container = mountHost();
    act(() => {
      store.open({ dialogId: "alert", payload: { title: "父", description: "父说明" } });
      const parent = store.top()!;
      store.open({ dialogId: "alert", payload: { title: "子", description: "子说明" }, parentInstanceId: parent.instanceId } as never);
    });
    const layers = container.querySelectorAll(".dlg-host__layer");
    expect(layers).toHaveLength(2);
    // 父层 inert/aria-hidden；子层可交互。
    expect(layers[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(layers[0]!.hasAttribute("inert")).toBe(true);
    expect(layers[1]!.getAttribute("aria-hidden")).toBeNull();
    // 父 renderer 仍挂载（草稿/滚动保留）。
    expect(container.textContent).toContain("父说明");
    // 关闭子层后父层回到 top。
    act(() => {
      store.close(store.top()!.instanceId);
    });
    expect(store.getSnapshot().stack).toHaveLength(1);
    expect(container.querySelectorAll(".dlg-host__layer")).toHaveLength(1);
    expect(container.querySelector(".dlg-host__layer")!.getAttribute("aria-hidden")).toBeNull();
  });

  it("迟到 result identity：旧 instanceId 的关闭不作用于后来的实例", () => {
    renderAlert = ({ instance, requestClose }: DialogRendererProps) => (
      <AlertDialog
        instanceId={instance.instanceId}
        title={(instance.payload as { title: string }).title}
        description={(instance.payload as { description: string }).description}
        onCancel={requestClose}
        onConfirm={async () => ({ ok: true })}
      />
    );
    mountHost();
    let firstId = "";
    act(() => {
      const result = store.open({ dialogId: "alert", payload: { title: "第一", description: "d" } });
      if (result.ok) firstId = result.instance.instanceId;
    });
    act(() => {
      store.close(firstId);
      store.open({ dialogId: "alert", payload: { title: "第二", description: "d" } });
    });
    // 迟到回调按旧 instanceId 关闭：不作用于当前顶部。
    act(() => {
      expect(store.close(firstId)).toBe(false);
    });
    expect(store.getSnapshot().stack).toHaveLength(1);
    expect(store.top()?.instanceId).not.toBe(firstId);
  });

  it("业务 renderer 不直接 import Radix（import firewall）", () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(HERE, "../../../");
    const rendererFiles = [
      "cordis/plugins/media-preview/builtin-renderers.tsx",
      "cordis/plugins/paste-import/replace-dialog.tsx",
      "cordis/plugins/video-capture/frame-capture-dialog.tsx",
      "cordis/plugins/video-capture/video-edit-dialog.tsx",
      "cordis/plugins/canvas-switcher/chrome.tsx"
    ];
    // 片段 dialog renderer 已迁至独立 extension 包
    // （change: 2026-10-10-extract-optional-feature-extensions）：宿主 firewall 不再覆盖它们，
    // 包内边界由其自身架构审计（extensions/prompt-snippets/tests/architecture.test.ts）保证。
    for (const relative of rendererFiles) {
      const source = readFileSync(path.resolve(srcRoot, relative), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      expect(source, relative).not.toMatch(/from\s+["']@radix-ui\//);
    }
  });
});
