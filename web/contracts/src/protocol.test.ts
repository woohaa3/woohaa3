/**
 * 协议 contract tests（change: split-web-runtime-services，任务 1.3）。
 *
 * 覆盖 round-trip、畸形输入、版本协商、错误码与安全裁剪。这些测试是 client/server 的
 * 共同门禁：服务实现必须与这里声明的行为一致，否则协议漂移。
 */
import { describe, expect, it } from "vitest";
import { checkProtocolVersion,
  isProtocolErrorCode,
  isRetryableProtocolError,
  WOOHAA3_PROTOCOL_VERSION } from "./errors.js";
import { decodeCanvasCancelRequest,
  decodeCanvasRunRequest,
  isCanvasRunResponse } from "./canvas/protocol.js";
import { decodeMediaImportRequest,
  decodeMediaSignRequest,
  decodeMediaVerifyRequest,
  isMediaSignResponse,
  isMediaVerifyResponse } from "./media/protocol.js";
import { computeGeneratedStorageKey,
  computeStorageKey,
  extensionForMediaType,
  isAllowedMediaType,
  normalizeMediaType } from "./media/keys.js";
import { checkModelCapability,
  decodeTaskSubmitRequest,
  isSubmitResponse } from "./task/protocol.js";
import { containsForbiddenHistoryKey,
  isTaskExecutionDetail,
  isTaskExecutionSummary,
  isTaskHistoryPage,
  parseTaskHistoryQuery,
  TASK_HISTORY_MAX_PAGE_SIZE } from "./task/history.js";
import { isValidStorageKey } from "./validation.js";

const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

describe("协议版本与错误码（任务 1.3）", () => {
  it("接受当前版本，拒绝不兼容或缺失版本", () => {
    expect(checkProtocolVersion(WOOHAA3_PROTOCOL_VERSION)).toEqual({ ok: true });
    // 内部调用必须显式携带版本：缺省不再视为当前版本。
    expect(checkProtocolVersion(undefined).ok).toBe(false);
    expect(checkProtocolVersion(null).ok).toBe(false);
    const mismatch = checkProtocolVersion(999);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("protocol-incompatible");
  });

  it("只有 unavailable / storage-failed 是可重试错误码", () => {
    expect(isRetryableProtocolError("unavailable")).toBe(true);
    expect(isRetryableProtocolError("storage-failed")).toBe(true);
    expect(isRetryableProtocolError("unauthorized")).toBe(false);
    expect(isRetryableProtocolError("key-reused")).toBe(false);
    expect(isProtocolErrorCode("protocol-incompatible")).toBe(true);
    expect(isProtocolErrorCode("nope")).toBe(false);
  });
});

describe("媒体键与类型（任务 1.3）", () => {
  it("内容寻址键稳定且受控", () => {
    expect(computeStorageKey(CHECKSUM)).toBe(STORAGE_KEY);
    expect(computeGeneratedStorageKey(CHECKSUM, "png")).toBe(`generation-outputs/${CHECKSUM}.png`);
    expect(isValidStorageKey(STORAGE_KEY)).toBe(true);
    expect(isValidStorageKey(`generation-outputs/${CHECKSUM}.png`)).toBe(true);
  });

  it("拒绝路径遍历与任意 URL", () => {
    expect(isValidStorageKey("../etc/passwd")).toBe(false);
    expect(isValidStorageKey("https://evil.example/x.png")).toBe(false);
    expect(isValidStorageKey("sha256-")).toBe(false);
  });

  it("规范化媒体类型并保留扩展名", () => {
    expect(normalizeMediaType("Image/PNG; charset=utf-8")).toBe("image/png");
    expect(isAllowedMediaType("image/png")).toBe(true);
    expect(isAllowedMediaType("application/x-msdownload")).toBe(false);
    expect(extensionForMediaType("image/jpeg")).toBe("jpg");
  });
});

describe("Task 内部 submit 协议（任务 1.3）", () => {
  const valid = {
    workerTaskKey: "worker-1",
    canvasId: "canvas-1",
    nodeId: "node-1",
    runId: "run-1",
    jobId: "job-1",
    nodeType: "image",
    modelType: "image",
    modelKey: "litellm:gpt-image-2",
    prompt: "一只猫",
    parameters: { size: "1024x1024" },
    inputs: [{ assetId: "asset-1", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png" }]
  };

  it("round-trip 合法请求", () => {
    const decoded = decodeTaskSubmitRequest(valid);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.workerTaskKey).toBe("worker-1");
      expect(decoded.value.inputs).toHaveLength(1);
    }
  });

  it("拒绝节点/模型类型不匹配", () => {
    const decoded = decodeTaskSubmitRequest({ ...valid, nodeType: "text", modelType: "image" });
    expect(decoded.ok).toBe(false);
  });

  it("拒绝任意远程 URL 作为持久输入", () => {
    const decoded = decodeTaskSubmitRequest({
      ...valid,
      inputs: [{ assetId: "a", role: "reference_image", storageKey: "https://evil/x.png", mediaType: "image/png" }]
    });
    expect(decoded.ok).toBe(false);
  });

  it("拒绝超长 prompt", () => {
    const decoded = decodeTaskSubmitRequest({ ...valid, prompt: "x".repeat(20) }, { maxPromptChars: 10 });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.code).toBe("limit-exceeded");
  });

  it("按模型能力拒绝不支持的参考输入", () => {
    const model = {
      modelKey: "litellm:gpt-image-2",
      providerId: "litellm",
      providerModelId: "gpt-image-2",
      modelType: "image" as const,
      title: "t",
      interaction: { id: "generic-model", version: 1 },
      inputSchema: {},
      defaultInput: {},
      bindings: [],
      taskTimeoutMs: 1000
    };
    const decoded = decodeTaskSubmitRequest(valid);
    if (!decoded.ok) throw new Error("fixture invalid");
    const checked = checkModelCapability(decoded.value, model);
    expect(checked.ok).toBe(false);
  });

  it("submit 响应形态判定", () => {
    expect(isSubmitResponse({ workerTaskKey: "w", state: "queued", reused: false, canvasId: "c", nodeId: "n", runId: "r" })).toBe(true);
    expect(isSubmitResponse({ workerTaskKey: "w" })).toBe(false);
  });
});

describe("Media 内部协议（任务 1.3）", () => {
  it("verify 请求要求受控键", () => {
    expect(decodeMediaVerifyRequest({ storageKey: STORAGE_KEY }).ok).toBe(true);
    expect(decodeMediaVerifyRequest({ storageKey: "https://evil" }).ok).toBe(false);
  });

  it("sign 请求限制 TTL", () => {
    expect(decodeMediaSignRequest({ storageKey: STORAGE_KEY, expiresSeconds: 900 }).ok).toBe(true);
    expect(decodeMediaSignRequest({ storageKey: STORAGE_KEY, expiresSeconds: 100000 }).ok).toBe(false);
  });

  it("import 只接受 HTTPS 且限制 bytes", () => {
    expect(decodeMediaImportRequest({ url: "https://cdn.example/x.png" }).ok).toBe(true);
    expect(decodeMediaImportRequest({ url: "http://cdn.example/x.png" }).ok).toBe(false);
    expect(decodeMediaImportRequest({ url: "file:///etc/passwd" }).ok).toBe(false);
  });

  it("verify/sign 响应形态判定", () => {
    expect(
      isMediaVerifyResponse({ exists: true, matches: true, metadata: { storageKey: STORAGE_KEY, contentType: "image/png", size: 1, checksum: CHECKSUM } })
    ).toBe(true);
    expect(isMediaVerifyResponse({ exists: false })).toBe(true);
    expect(isMediaVerifyResponse({ exists: true, metadata: { storageKey: STORAGE_KEY } })).toBe(false);
    expect(isMediaSignResponse({ url: "https://cos.example/x?sig=1", expiresAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isMediaSignResponse({ url: "http://cos.example/x", expiresAt: "x" })).toBe(false);
  });
});

describe("Canvas run/cancel 协议（任务 1.3）", () => {
  it("解码 run 请求并拒绝缺失字段", () => {
    const decoded = decodeCanvasRunRequest({
      canvasId: "c",
      nodeId: "n",
      runId: "r",
      jobId: "j",
      modelKey: "m",
      prompt: "p",
      parameters: {}
    });
    expect(decoded.ok).toBe(true);
    expect(decodeCanvasRunRequest({ canvasId: "c" }).ok).toBe(false);
  });

  it("解码 cancel 请求", () => {
    expect(decodeCanvasCancelRequest({ canvasId: "c", nodeId: "n", runId: "r" }).ok).toBe(true);
    expect(decodeCanvasCancelRequest({ canvasId: "c" }).ok).toBe(false);
  });

  it("run 响应形态判定", () => {
    expect(isCanvasRunResponse({ ok: true, runId: "r", jobId: "j", state: "accepted" })).toBe(true);
    expect(isCanvasRunResponse({ ok: false, code: "unavailable", message: "m" })).toBe(true);
    expect(isCanvasRunResponse({ ok: true })).toBe(false);
  });
});

describe("Task history read model（任务 1.3）", () => {
  const summary = {
    taskKey: "worker-1",
    state: "running",
    providerId: "litellm",
    modelKey: "litellm:gpt-image-2",
    canvasId: "c",
    nodeId: "n",
    runId: "r",
    progress: 0.5,
    attempt: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    recordRevision: 7
  };

  it("接受安全 summary/detail/page", () => {
    expect(isTaskExecutionSummary(summary)).toBe(true);
    expect(isTaskExecutionDetail({ ...summary, events: [{ sequence: 0, occurredAt: "2026-01-01T00:00:00Z", kind: "scheduling", stage: "worker.enqueued" }] })).toBe(true);
    expect(isTaskHistoryPage({ items: [summary], watermark: 12 })).toBe(true);
    expect(isTaskHistoryPage({ items: [summary], nextCursor: "abc", watermark: 12 })).toBe(true);
    // recordRevision 与 watermark 是必需字段。
    expect(isTaskExecutionSummary({ ...summary, recordRevision: undefined })).toBe(false);
    expect(isTaskHistoryPage({ items: [summary] })).toBe(false);
  });

  it("history 查询把 limit 夹到上限并支持有界 states", () => {
    const parsed = parseTaskHistoryQuery({ limit: "100000", states: "queued,pending,running", modelKey: "m" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.limit).toBe(TASK_HISTORY_MAX_PAGE_SIZE);
      expect(parsed.query.states).toEqual(["queued", "pending", "running"]);
      expect(parsed.query.modelKey).toBe("m");
    }
  });

  it("history 查询稳定拒绝非法条件", () => {
    expect(parseTaskHistoryQuery({ state: "running", states: "queued" })).toMatchObject({ ok: false, code: "state-conflict" });
    expect(parseTaskHistoryQuery({ state: "bogus" })).toMatchObject({ ok: false, code: "invalid-state" });
    expect(parseTaskHistoryQuery({ modelType: "bogus" })).toMatchObject({ ok: false, code: "invalid-model-type" });
    expect(parseTaskHistoryQuery({ source: "bogus" })).toMatchObject({ ok: false, code: "invalid-source" });
    expect(parseTaskHistoryQuery({ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" })).toMatchObject({ ok: false, code: "invalid-time-range" });
  });

  it("阶段二来源/extensionId 与受理版本进入契约", () => {
    const parsed = parseTaskHistoryQuery({ source: "extension", extensionId: "sample-site" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.source).toBe("extension");
      expect(parsed.query.extensionId).toBe("sample-site");
      expect(parsed.fingerprint).toContain("source=extension");
    }
    const summaryWithAdmission = {
      ...summary,
      source: "extension" as const,
      extensionId: "sample-site",
      admission: { catalogRevision: 4, schemaRevision: 2, configVersion: 7 }
    };
    expect(isTaskExecutionSummary(summaryWithAdmission)).toBe(true);
    expect(isTaskExecutionSummary({ ...summaryWithAdmission, source: "bogus" })).toBe(false);
    expect(isTaskExecutionSummary({ ...summaryWithAdmission, admission: { catalogRevision: -1 } })).toBe(false);
  });

  it("检测响应里是否含敏感键", () => {
    expect(containsForbiddenHistoryKey({ error: { name: "X", message: "boom" } })).toBe(false);
    expect(containsForbiddenHistoryKey({ error: { stack: "at foo" } })).toBe(true);
    expect(containsForbiddenHistoryKey({ result: { signedUrl: "https://..." } })).toBe(true);
    expect(containsForbiddenHistoryKey({ nested: [{ prompt: "secret" }] })).toBe(true);
  });
});
