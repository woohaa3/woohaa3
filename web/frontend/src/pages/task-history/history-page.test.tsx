/**
 * 全局任务历史页组件测试（change: split-web-runtime-services，任务 6.5 / 6.7；
 *   change: improve-task-history-experience，任务 4.1–4.5、5.5）。
 *
 * 用 `react-dom/server` 渲染（无 DOM 环境）：验证 tabs、筛选控件、空状态、表格层级、
 * 详情按状态组织与安全字段。数据加载/合并由 history-state 与 task-remote 单测覆盖。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryDetail, TaskHistoryPage } from "./history-page.js";
import { HistoryRowView } from "./history-row.js";
import type { TaskHistoryClient } from "../../shared/task-history/client.js";
import type { TaskExecutionDetail } from "@woohaa3/contracts";

function stubClient(): TaskHistoryClient {
  return {
    list: async () => ({ items: [], watermark: 0 }),
    detail: async (taskKey: string) => ({ ok: true, detail: { taskKey } as TaskExecutionDetail }),
    candidates: async () => ({ providers: [], models: [], plugins: [] }),
    subscribe: () => () => undefined
  };
}

describe("TaskHistoryPage（任务 3.1 / 4.1 / 5.5）", () => {
  it("渲染状态 tabs、筛选控件与空状态", () => {
    const markup = renderToStaticMarkup(<TaskHistoryPage client={stubClient()} resolveMediaUrl={(k) => `/api/media/${k}`} />);
    for (const label of ["全部", "进行中", "成功", "失败", "取消"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("canvasId");
    expect(markup).toContain("nodeId");
    expect(markup).toContain("modelKey");
    // SSR 首帧是加载骨架（异步 list 未运行）；空态由交互测试覆盖。
    expect(markup).toContain("task-history__skeleton-row");
    expect(markup).toContain("高级筛选");
  });

  it("页面为只读视图：不含提交/取消/重跑控件", () => {
    const markup = renderToStaticMarkup(<TaskHistoryPage client={stubClient()} resolveMediaUrl={(k) => `/api/media/${k}`} />);
    expect(markup).not.toContain("取消任务");
    expect(markup).not.toContain("重新执行");
    expect(markup).not.toContain("提交任务");
    expect(markup).not.toContain("<form");
  });

  it("表头以任务为中心组织：任务/来源/状态/结果/时间/操作", () => {
    const markup = renderToStaticMarkup(<TaskHistoryPage client={stubClient()} resolveMediaUrl={(k) => `/api/media/${k}`} />);
    for (const header of ["任务", "来源", "状态", "时间", "操作"]) {
      expect(markup).toContain(header);
    }
    // 结果/异常列标题带斜杠，避免被 HTML 转义影响断言。
    expect(markup).toContain("结果");
  });
});

describe("HistoryDetail（任务 4.5 / 4.6 / 5.5）", () => {
  const base: TaskExecutionDetail = {
    taskKey: "t1",
    state: "failed",
    providerId: "litellm",
    providerName: "LiteLLM",
    modelKey: "gpt-image-2",
    modelTitle: "GPT Image 2",
    canvasId: "c1",
    nodeId: "n1",
    runId: "r1",
    progress: 0.5,
    attempt: 2,
    error: { name: "ProviderError", message: "上游失败" },
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:05Z",
    durationMs: 5000,
    recordRevision: 3,
    events: [
      { sequence: 0, occurredAt: "2026-09-24T00:00:00Z", kind: "scheduling", stage: "worker.enqueued" },
      { sequence: 1, occurredAt: "2026-09-24T00:00:05Z", kind: "execution", stage: "pptask.failed" }
    ]
  };

  it("长文本在列表与详情使用独立样式，详情保留换行与全文", () => {
    const text = `第一行\n${"长文本".repeat(100)}\n最后一行`;
    const detail = { ...base, state: "succeeded" as const, error: undefined, result: { mediaKind: "text" as const, text } };
    const row = renderToStaticMarkup(<table><tbody><HistoryRowView row={detail} selected={false} onOpen={() => {}} onCopy={async () => true} resolveMediaUrl={key => key} /></tbody></table>);
    const full = renderToStaticMarkup(<HistoryDetail detail={detail} error={null} resolveMediaUrl={key => key} copyText={async () => true} onClose={() => {}} />);
    expect(row).toContain("task-history__result-summary");
    expect(row).not.toContain("task-history__result-text");
    expect(full).toContain(`class="task-history__result-text">${text}</pre>`);
  });

  it("失败记录优先展示安全错误与可读阶段，保留安全原 stage", () => {
    const markup = renderToStaticMarkup(<HistoryDetail detail={base} error={null} resolveMediaUrl={(k) => `/api/media/${k}`} copyText={async () => true} onClose={() => undefined} />);
    expect(markup).toContain("ProviderError");
    expect(markup).toContain("上游失败");
    // 可读阶段名与安全原 stage 都在（技术信息保留原值）。
    expect(markup).toContain("已入队");
    expect(markup).toContain("worker.enqueued");
    expect(markup).not.toContain("stack");
    expect(markup).not.toContain("signedUrl");
  });

  it("成功图片记录：请求摘要与图片用同源媒体 URL 渲染，不是签名地址", () => {
    const detail: TaskExecutionDetail = {
      taskKey: "t2",
      state: "succeeded",
      providerId: "litellm",
      modelKey: "gpt-image-2",
      canvasId: "c1",
      nodeId: "n1",
      runId: "r1",
      createdAt: "2026-09-24T06:39:25.586Z",
      updatedAt: "2026-09-24T06:42:29.870Z",
      durationMs: 182789,
      recordRevision: 1,
      events: [],
      request: { prompt: "一只红色的苹果", parameters: { size: "1024x1024", quality: "high" } },
      result: {
        mediaKind: "image",
        storageKey: "generation-outputs/deadbeef.png",
        contentType: "image/png",
        size: 12345,
        checksum: "a".repeat(64)
      }
    };
    const markup = renderToStaticMarkup(<HistoryDetail detail={detail} error={null} resolveMediaUrl={(k) => `/api/media/${k}`} copyText={async () => true} onClose={() => undefined} />);
    expect(markup).toContain("一只红色的苹果");
    expect(markup).toContain("1024x1024");
    expect(markup).toContain("generation-outputs/deadbeef.png");
    expect(markup).toContain('src="/api/media/generation-outputs/deadbeef.png"');
    expect(markup).not.toContain("sign=");
  });

  it("请求摘要截断与事件裁剪有明确标记", () => {
    const detail: TaskExecutionDetail = {
      ...base,
      state: "succeeded",
      error: undefined,
      eventsTruncated: true,
      request: { prompt: "很长的提示", promptTruncated: true, parameters: { a: 1 }, parametersTruncated: true },
      result: { mediaKind: "text", text: "摘要", textTruncated: true }
    };
    const markup = renderToStaticMarkup(<HistoryDetail detail={detail} error={null} resolveMediaUrl={(k) => k} copyText={async () => true} onClose={() => undefined} />);
    expect(markup).toContain("已截断");
    expect(markup).toContain("已裁剪");
    expect(markup).toContain("事件时间线已裁剪");
  });

  it("详情失效（not-found）显示稳定反馈", () => {
    const markup = renderToStaticMarkup(<HistoryDetail detail={null} error="该执行记录不存在或已超过保留期" resolveMediaUrl={(k) => k} copyText={async () => true} onClose={() => undefined} />);
    expect(markup).toContain("该执行记录不存在或已超过保留期");
  });
});

describe("HistoryDetail（时间戳本地化）", () => {
  it("时间戳按本地时区显示，而不是原始 UTC ISO", () => {
    const markup = renderToStaticMarkup(
      <HistoryDetail
        detail={{
          taskKey: "t3",
          state: "succeeded",
          providerId: "litellm",
          createdAt: "2026-09-24T06:39:25.586Z",
          updatedAt: "2026-09-24T06:39:25.586Z",
          durationMs: 1,
          recordRevision: 1,
          events: [{ sequence: 0, occurredAt: "2026-09-24T06:39:25.586Z", kind: "execution", stage: "x" }]
        }}
        resolveMediaUrl={(k) => `/api/media/${k}`}
        copyText={async () => undefined}
        error={null}
        onClose={() => undefined}
      />
    );
    expect(markup).not.toContain("2026-09-24T06:39:25.586Z");
  });
});
