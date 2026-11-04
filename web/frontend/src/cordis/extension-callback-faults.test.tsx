/**
 * 扩展非渲染回调与弹窗的故障归因、遥测（change: 2026-10-21-harden-extension-fault-isolation，lead 补充决定）。
 *
 * - 同步回调（node-template / node-drop / node-action / selection-action / input.paste/drop）抛错时
 *   归因到宿主盖章的扩展、计入熔断，并跳过该贡献、回落宿主默认行为；内置贡献语义不变；
 * - 扩展注册的 dialog.renderer 逐项隔离：出错只替换为可关闭的错误卡片；
 * - `extension.render-failed` 遥测只带 extension/slot/epoch 与错误类别，不带消息正文。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import { SlotRegistry, createScopedDialogs, createScopedSlots } from "./slots.js";
import { createExtensionFaultService } from "./extension-faults.js";
import { guardContributionCall, guardContributionMethods } from "./contribution-guard.js";
import { extensionNodeTemplateMenuItems } from "./plugins/canvas-menu/plugin.js";
import { dropNodeDrop, type NodeDropTarget } from "./plugins/canvas-shell/node-drop-dispatch.js";
import { describeNodeActions } from "./plugins/canvas-shell/node-action-host.js";
import { DialogService } from "./services/dialogs/service.js";
import { DialogHost } from "./services/dialogs/DialogHost.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const ORIGIN = { kind: "extension" as const, extensionId: "ext-x", epoch: 5 };

function setup() {
  const slots = new SlotRegistry();
  const scoped = createScopedSlots(() => slots, ORIGIN);
  const telemetry: TelemetryEventInput[] = [];
  const faults = createExtensionFaultService({ logger: () => undefined, telemetry: () => ({ record: (input) => telemetry.push(input) }) });
  return { slots, scoped, faults, telemetry };
}

const boom = () => {
  throw new Error("secret user prompt");
};

describe("同步回调故障归因", () => {
  it("node-template：扩展 createNodeData 抛错时跳过该项并计入故障；内置模板语义不变", () => {
    const { slots, scoped, faults, telemetry } = setup();
    scoped.register("canvas.node-template", { id: "bad", owner: "ext-x", label: "坏模板", nodeType: "x", createNodeData: boom } as never);
    slots.register("canvas.node-template", { id: "ok", owner: "host", label: "好模板", nodeType: "y", createNodeData: () => ({}) } as never);
    const items = extensionNodeTemplateMenuItems(slots.list("canvas.node-template") as never, true, {} as never, faults);
    expect(items.map((item) => item.label)).toEqual(["好模板"]);
    expect(faults.diagnostics()).toHaveLength(1);
    expect(faults.diagnostics()[0]).toMatchObject({ extensionId: "ext-x", slot: "canvas.node-template", kind: "callback" });
    expect(telemetry).toHaveLength(1);
  });

  it("node-drop：扩展 onDrop 抛错时归因，并按既有默认消费拖入（不移动来源）", () => {
    const { slots, scoped, faults } = setup();
    scoped.register("canvas.node-drop", { id: "drop", owner: "ext-x", nodeType: "furnace", onDrop: boom } as never);
    const targets = (slots.list("canvas.node-drop") as unknown as NodeDropTarget[]).map((target) =>
      guardContributionMethods(target, "canvas.node-drop", faults, ["matchesTarget", "acceptsSources", "onDrop", "onPreview"])
    );
    const canvas = { document: { nodes: [{ id: "n1", type: "furnace" }] } } as never;
    expect(dropNodeDrop(targets, canvas, ["s"], { x: 0, y: 0 }, { status: "target", nodeId: "n1" })).toBe(true);
    expect(faults.diagnostics().map((entry) => entry.slot)).toEqual(["canvas.node-drop"]);
  });

  it("node-action：扩展 describe 抛错只丢该动作；宿主动作照常", () => {
    const { slots, scoped, faults } = setup();
    scoped.register("canvas.node-action", { id: "bad", owner: "ext-x", order: 1, describe: boom, activate: () => undefined } as never);
    slots.register("canvas.node-action", { id: "download", owner: "host", order: 0, describe: () => ({ label: "下载", enabled: true }), activate: () => undefined } as never);
    const contributions = (slots.list("canvas.node-action") as never[]).map((entry) =>
      guardContributionMethods(entry as object, "canvas.node-action", faults, ["available", "describe", "activate"] as never)
    );
    const description = describeNodeActions({ contributions: contributions as never, context: { nodeId: "n", nodeType: "image", writable: true } });
    expect(description?.presentation.actions.map((action) => action.id)).toEqual(["download"]);
    expect(faults.diagnostics()).toHaveLength(1);
  });

  it("input.paste：扩展处理器抛错时返回回落值（交给下一个处理器/浏览器默认）；内置处理器照常抛出", () => {
    const { slots, scoped, faults } = setup();
    scoped.register("input.paste", { id: "paste", owner: "ext-x", handle: boom } as never);
    slots.register("input.paste", { id: "host-paste", owner: "host", handle: boom } as never);
    const [extensionEntry, hostEntry] = slots.list("input.paste");
    expect(guardContributionCall(extensionEntry!, "input.paste", faults, () => extensionEntry!.handle({} as ClipboardEvent), undefined)).toBeUndefined();
    expect(() => guardContributionCall(hostEntry!, "input.paste", faults, () => hostEntry!.handle({} as ClipboardEvent), undefined)).toThrow();
    expect(faults.diagnostics()).toHaveLength(1);
  });

  it("回调故障计入同一熔断：超过阈值后标记 tripped 并通知装配方", () => {
    const { slots, scoped } = setup();
    const trips: string[] = [];
    const faults = createExtensionFaultService({ threshold: 1, logger: () => undefined, telemetry: () => undefined });
    faults.attach("ext-x", { required: false, epoch: 5, trip: (reason) => trips.push(reason) });
    scoped.register("input.drop", { id: "drop", owner: "ext-x", handle: boom } as never);
    const entry = slots.list("input.drop")[0]!;
    guardContributionCall(entry, "input.drop", faults, () => entry.handle({} as DragEvent), undefined);
    guardContributionCall(entry, "input.drop", faults, () => entry.handle({} as DragEvent), undefined);
    expect(faults.isTripped("ext-x")).toBe(true);
    expect(trips).toEqual(["render-fault-threshold"]);
  });
});

describe("遥测", () => {
  it("只带 extension/slot/epoch 与错误类别，不带消息正文或堆栈", () => {
    const { faults, telemetry } = setup();
    faults.report({ extensionId: "ext-x", epoch: 5, slot: "canvas.toolbar", contributionId: "c", message: "secret user prompt" });
    expect(telemetry).toEqual([
      {
        name: "extension.render-failed",
        result: "failure",
        origin: "browser",
        errorCode: "extension.render",
        attributes: { extension: "ext-x", slot: "canvas.toolbar", epoch: "5" }
      }
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("secret");
  });

  it("遥测出口抛错不影响故障记录", () => {
    const faults = createExtensionFaultService({ logger: () => undefined, telemetry: () => ({ record: () => { throw new Error("down"); } }) });
    expect(() => faults.report({ extensionId: "e", epoch: 1, slot: "s", contributionId: "c", message: "m" })).not.toThrow();
    expect(faults.diagnostics()).toHaveLength(1);
  });
});

describe("dialog.renderer 逐项隔离", () => {
  it("扩展弹窗渲染抛错只替换为可关闭的错误卡片；宿主弹窗不受影响", async () => {
    const dialogs = new DialogService();
    const faults = createExtensionFaultService({ logger: () => undefined, telemetry: () => undefined });
    const scoped = createScopedDialogs(() => dialogs, ORIGIN);
    const definition = { validatePayload: () => ({ ok: true as const, payload: {} }) } as never;
    scoped.registerDialog("ext-dialog", { definition, renderer: () => { throw new Error("x"); } });
    dialogs.registerDialog("host-dialog", { definition, renderer: () => <div data-testid="host-dialog">ok</div> });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<DialogHost dialogs={dialogs} />);
    });
    await act(async () => {
      dialogs.open({ dialogId: "ext-dialog", payload: {} } as never);
    });
    expect(document.body.querySelector("[data-slot='dialog.renderer']")).not.toBeNull();
    await act(async () => {
      dialogs.close();
      dialogs.open({ dialogId: "host-dialog", payload: {} } as never);
    });
    expect(document.body.querySelector("[data-testid='host-dialog']")).not.toBeNull();
    void faults;
  });
});
