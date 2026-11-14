/**
 * Canvas task activity contracts（change: 2026-09-29-add-canvas-task-activity-feed，任务 1.1）。
 *
 * 锁定安全投影、白名单与 cursor 语义：活动 DTO 绝不携带 prompt/parameters/provider I/O/
 * URL/bytes/stack，且只在具备 runId + nodeId 时才可进入画布活动面。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_TASK_ACTIVITY_LIMITS,
  decodeCanvasActivityCursor,
  decodeCanvasTaskActivityQuery,
  encodeCanvasActivityCursor,
  isCanvasTaskActivity,
  isCanvasTaskActivityEventMessage,
  isCanvasTaskActivitySnapshot,
  toCanvasTaskActivity,
  type CanvasTaskActivity
} from "./activity.js";
import { containsForbiddenHistoryKey, type TaskExecutionSummary } from "./history.js";

const baseSummary: TaskExecutionSummary = {
  taskKey: "worker-1",
  state: "running",
  providerId: "litellm",
  modelType: "image",
  modelKey: "litellm:gpt-image-2",
  canvasId: "canvas-a",
  nodeId: "node-1",
  runId: "run-1",
  progress: 0.4,
  attempt: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  durationMs: 1000,
  recordRevision: 1
};

describe("Canvas task activity DTO（任务 1.1）", () => {
  it("从 summary 投影出白名单活动项，丢弃 provider 身份/attempt", () => {
    const activity = toCanvasTaskActivity(baseSummary);
    expect(activity).toEqual({
      taskKey: "worker-1",
      runId: "run-1",
      nodeId: "node-1",
      state: "running",
      modelType: "image",
      modelKey: "litellm:gpt-image-2",
      progress: 0.4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000
    });
    // providerId / attempt / canvasId 不在活动项里（更少字段的独立 read model）。
    expect(activity).not.toHaveProperty("providerId");
    expect(activity).not.toHaveProperty("attempt");
    expect(activity).not.toHaveProperty("canvasId");
  });

  it("缺 runId 或 nodeId 的任务不进入画布活动面", () => {
    expect(toCanvasTaskActivity({ ...baseSummary, runId: undefined })).toBeNull();
    expect(toCanvasTaskActivity({ ...baseSummary, nodeId: undefined })).toBeNull();
  });

  it("合法活动项通过校验，畸形输入被拒绝", () => {
    const activity = toCanvasTaskActivity(baseSummary) as CanvasTaskActivity;
    expect(isCanvasTaskActivity(activity)).toBe(true);
    expect(isCanvasTaskActivity({ ...activity, state: "bogus" })).toBe(false);
    expect(isCanvasTaskActivity({ ...activity, runId: undefined })).toBe(false);
    expect(isCanvasTaskActivity({ ...activity, durationMs: -1 })).toBe(false);
    expect(isCanvasTaskActivitySnapshot({ active: [activity], recent: [], cursor: 3 })).toBe(true);
    expect(isCanvasTaskActivitySnapshot({ active: [activity], recent: [], cursor: "3" })).toBe(false);
    expect(isCanvasTaskActivityEventMessage({ record: activity, cursor: 3 })).toBe(true);
    expect(isCanvasTaskActivityEventMessage({ record: activity, cursor: -1 })).toBe(false);
  });

  it("结果/错误摘要只保留白名单字段，序列化后无敏感键", () => {
    const withResult = toCanvasTaskActivity({
      ...baseSummary,
      state: "succeeded",
      result: { mediaKind: "image", storageKey: "sha256-abc", contentType: "image/png", size: 10, checksum: "c" },
      error: { name: "ProviderError", message: "boom" }
    }) as CanvasTaskActivity;
    expect(containsForbiddenHistoryKey(withResult)).toBe(false);
    const serialized = JSON.stringify(withResult);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("providerInput");
    expect(serialized).not.toContain("signedUrl");
  });

  it("活动查询夹紧 limit 并限长 cursor", () => {
    const query = decodeCanvasTaskActivityQuery({ limit: "100000", cursor: "abc" });
    expect(query.limit).toBe(CANVAS_TASK_ACTIVITY_LIMITS.maxPageSize);
    expect(query.cursor).toBe("abc");
    expect(decodeCanvasTaskActivityQuery({ limit: "0" }).limit).toBeUndefined();
    expect(decodeCanvasTaskActivityQuery({ cursor: "x".repeat(513) }).cursor).toBeUndefined();
  });

  it("分页 cursor 不暴露 taskKey 明文且解码稳定", () => {
    const cursor = encodeCanvasActivityCursor({ createdAt: "2026-01-01T00:00:00Z", taskKey: "task-secret" });
    expect(cursor).not.toContain("task-secret");
    expect(decodeCanvasActivityCursor(cursor)).toEqual({
      createdAt: "2026-01-01T00:00:00Z",
      taskKey: "task-secret"
    });
    expect(decodeCanvasActivityCursor("garbage")).toBeNull();
    expect(decodeCanvasActivityCursor("x".repeat(513))).toBeNull();
  });
});

it("动作任务的完成消息通过活动契约校验",()=>{
 const activity=toCanvasTaskActivity({...baseSummary,modelType:"motion",state:"succeeded",result:{mediaKind:"motion"}});
 expect(isCanvasTaskActivity(activity)).toBe(true);
 expect(isCanvasTaskActivityEventMessage({record:activity,cursor:2})).toBe(true);
});
