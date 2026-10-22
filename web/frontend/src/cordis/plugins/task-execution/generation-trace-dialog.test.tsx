/**
 * 画布内「生成溯源」浮窗组件测试
 * （change: 生成溯源改为画布内浮窗）。
 *
 * 覆盖：注册+打开（经真实 Dialog Host）、加载中显式文案、成功渲染共享正文、
 * 失败显式错误 + 「在任务监控中打开」兜底、关闭回栈底、无 taskKey 的 payload 被拒绝
 * （入口不会打开一个空白浮窗）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskExecutionDetail } from "@woohaa3/contracts";
import { DialogHost } from "../../services/dialogs/DialogHost.js";
import { DialogService } from "../../services/dialogs/service.js";
import type { TaskMonitorRemote, TaskMonitorResult } from "../../../shared/task-trace/remote.js";
import {
  GENERATION_TRACE_DIALOG_ID,
  createGenerationTraceRenderer,
  generationTraceDialogDefinition
} from "./generation-trace-dialog.js";
import type { GenerationTraceDialogPayload } from "./generation-trace.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-20T10:00:00.000Z";

const detail: TaskExecutionDetail = {
  taskKey: "task-1",
  state: "succeeded",
  providerId: "ark",
  providerName: "Ark",
  createdAt: NOW,
  updatedAt: NOW,
  finishedAt: NOW,
  recordRevision: 1,
  events: [{ sequence: 0, occurredAt: NOW, stage: "provider.completed" }],
  upstreamTaskId: "upstream-task-42",
  request: { prompt: "画一只猫", parameters: {} }
} as unknown as TaskExecutionDetail;

function deferred(): { promise: Promise<TaskMonitorResult<TaskExecutionDetail>>; resolve: (value: TaskMonitorResult<TaskExecutionDetail>) => void } {
  let resolve!: (value: TaskMonitorResult<TaskExecutionDetail>) => void;
  const promise = new Promise<TaskMonitorResult<TaskExecutionDetail>>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeRemote(detailCall: (input: { taskKey: string; signal?: AbortSignal }) => Promise<TaskMonitorResult<TaskExecutionDetail>>): TaskMonitorRemote {
  return {
    detail: detailCall,
    snapshot: async () => ({ ok: false, code: "unavailable", error: "not used" })
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function mountDialog(options: {
  remote: TaskMonitorRemote;
  openedTaskMonitor?: GenerationTraceDialogPayload[];
  payload?: Partial<GenerationTraceDialogPayload>;
}): Promise<{ container: HTMLElement; dialogs: DialogService }> {
  const dialogs = new DialogService();
  dialogs.registerDialog(GENERATION_TRACE_DIALOG_ID, {
    definition: generationTraceDialogDefinition,
    renderer: createGenerationTraceRenderer({
      remote: options.remote,
      resolveMediaUrl: (key) => `/media/${key}`,
      openTaskMonitor: (payload) => options.openedTaskMonitor?.push(payload)
    })
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = createRoot(container);
  root = instance;
  await act(async () => {
    instance.render(<DialogHost dialogs={dialogs} />);
  });
  await act(async () => {
    dialogs.open({
      dialogId: GENERATION_TRACE_DIALOG_ID,
      payload: { taskKey: "task-1", canvasId: "canvas-1", nodeId: "node-9", ...options.payload }
    });
  });
  return { container, dialogs };
}

describe("画布内生成溯源浮窗", () => {
  it("打开即显示加载文案，成功后渲染共享详情正文", async () => {
    const pending = deferred();
    const { container } = await mountDialog({ remote: fakeRemote(() => pending.promise) });

    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    expect(container.textContent).toContain("生成溯源");
    expect(container.querySelector("[role='status']")?.textContent).toContain("正在读取任务详情…");

    await act(async () => {
      pending.resolve({ ok: true, value: detail });
    });
    expect(container.querySelector("[data-testid='task-trace-body']")).not.toBeNull();
    expect(container.textContent).toContain("上游任务号");
    expect(container.textContent).toContain("upstream-task-42");
    expect(container.textContent).toContain("画一只猫");
  });

  it("关闭按钮只关浮层，dialog 栈清空", async () => {
    const { container, dialogs } = await mountDialog({
      remote: fakeRemote(async () => ({ ok: true, value: detail }))
    });
    const close = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "关闭")!;
    await act(async () => {
      close.click();
    });
    expect(dialogs.getSnapshot().stack).toHaveLength(0);
  });

  it("加载失败显示错误文案与「在任务监控中打开」兜底链接", async () => {
    const openedTaskMonitor: GenerationTraceDialogPayload[] = [];
    const { container, dialogs } = await mountDialog({
      remote: fakeRemote(async () => ({ ok: false, code: "unavailable", error: "监控服务暂时不可用" })),
      openedTaskMonitor
    });
    const alert = container.querySelector("[role='alert']")!;
    expect(alert.textContent).toContain("读取任务详情失败");
    expect(alert.textContent).toContain("监控服务暂时不可用");
    const fallback = [...alert.querySelectorAll("button")].find((button) => button.textContent?.includes("在任务监控中打开"))!;
    expect(fallback).toBeTruthy();
    await act(async () => {
      fallback.click();
    });
    expect(openedTaskMonitor).toEqual([{ taskKey: "task-1", canvasId: "canvas-1", nodeId: "node-9" }]);
    expect(dialogs.getSnapshot().stack).toHaveLength(0);
  });

  it("记录不存在时说明两种成因并给出任务号（不把提交失败说成过期）", async () => {
    const { container } = await mountDialog({
      remote: fakeRemote(async () => ({ ok: false, code: "not-found", error: "任务不存在或已超过保留期" }))
    });
    const alert = container.querySelector("[role='alert']")!;
    expect(alert.textContent).toContain("读取任务详情失败");
    // 2026-10-21 现场：提交阶段失败会产生同样的 404，旧文案只提「保留期」。
    expect(alert.textContent).toContain("提交阶段就失败");
    expect(alert.textContent).toContain("已超过保留期");
    expect(alert.textContent).toContain("任务号：task-1");
  });

  it("成功态提供次要入口「在任务监控中打开」", async () => {
    const openedTaskMonitor: GenerationTraceDialogPayload[] = [];
    const { container } = await mountDialog({
      remote: fakeRemote(async () => ({ ok: true, value: detail })),
      openedTaskMonitor
    });
    const link = [...container.querySelectorAll<HTMLButtonElement>(".dlg__footer button")].find((button) => button.textContent?.includes("在任务监控中打开"))!;
    expect(link).toBeTruthy();
    await act(async () => {
      link.click();
    });
    expect(openedTaskMonitor).toHaveLength(1);
  });

  it("payload 缺少 taskKey 时拒绝打开（入口不会出现空白浮窗）", async () => {
    const dialogs = new DialogService();
    dialogs.registerDialog(GENERATION_TRACE_DIALOG_ID, {
      definition: generationTraceDialogDefinition,
      renderer: createGenerationTraceRenderer({
        remote: fakeRemote(async () => ({ ok: true, value: detail })),
        openTaskMonitor: () => undefined
      })
    });
    const opened = dialogs.open({ dialogId: GENERATION_TRACE_DIALOG_ID, payload: { canvasId: "canvas-1" } });
    expect(opened.ok).toBe(false);
    expect(dialogs.getSnapshot().stack).toHaveLength(0);
  });
});
