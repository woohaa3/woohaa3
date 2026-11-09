import { describe, expect, it, vi } from "vitest";
import { createSdpppxProvider, outputUrlsOf } from "../src/backend/provider.js";
import type { SessionManager } from "../src/backend/session.js";
import type { SdpppxReferenceUploader } from "../src/backend/reference.js";
import type { SdpppxTemplate } from "../src/backend/catalog.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, PNG_BYTES, bodyOf, createFetch, headersOf, jsonResponse, pngResponse, sseResponse, textResponse } from "./helpers.js";

const FORM_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", title: "提示词" },
    size: { type: "string", title: "尺寸", enum: ["512", "1024"] },
    image: {
      type: "string",
      title: "参考图",
      "x-component": "Upload",
      format: "image",
      "x-component-props": { maxCount: 1 }
    },
    video: {
      type: "array",
      title: "参考视频",
      "x-component": "Upload",
      items: { format: "video" },
      "x-component-props": { maxCount: 2 }
    }
  }
};

function setup(handler: Parameters<typeof createFetch>[0], options: { now?: () => number; timeoutMs?: number } = {}) {
  const { fetchImpl, calls } = createFetch(handler);
  const config = readTestConfig({
    ...FULL_ENV,
    SDPPPX_TASK_TIMEOUT_MS: String(options.timeoutMs ?? 600_000)
  });
  const now = options.now ?? (() => 1_000_000);
  const session = {
    accessToken: vi.fn(async () => "jwt-1"),
    clear: vi.fn(async () => undefined),
    epoch: () => 0
  } as unknown as SessionManager;
  const allowed = new Set<string>();
  const uploads: SdpppxReferenceUploader = {
    upload: vi.fn(async () => ({ url: "https://upload.example/x.png" })),
    isUploaded: (url: string) => allowed.has(url),
    clear: () => allowed.clear(),
    size: () => allowed.size
  };
  const templates = new Map<string, SdpppxTemplate>([
    ["tpl-1", { templateId: "tpl-1", title: "图片模板", modelType: "image" }],
    ["tpl-2", { templateId: "tpl-2", title: "视频模板", modelType: "video" }]
  ]);
  const runtime = createSdpppxProvider({
    config: () => config,
    session,
    uploads,
    templates: () => templates,
    fetchImpl,
    now,
    pollIntervalMs: 1
  });
  return { runtime, session, uploads, allowed, calls, now };
}

function describeHandler(cancelable = true) {
  return ({ url }: { url: string }) => {
    if (url.includes("/tasks/describe")) {
      return jsonResponse({
        formSchema: FORM_SCHEMA,
        formValues: { size: "512" },
        recommendUploadProvider: "grsai",
        cancelable
      });
    }
    throw new Error(`unexpected ${url}`);
  };
}

describe("outputUrlsOf", () => {
  it("只抽取 outputs/result/data 下的 URL，去重并有界", () => {
    expect(
      outputUrlsOf({
        status: "succeeded",
        prompt: "https://should-not-count.example/p.png",
        outputs: [
          { url: "https://cdn.example/1.png" },
          { image_url: "https://cdn.example/2.png" },
          { url: "https://cdn.example/1.png" },
          { url: "javascript:alert(1)" }
        ]
      })
    ).toEqual(["https://cdn.example/1.png", "https://cdn.example/2.png"]);
  });
});

describe("describeModel", () => {
  it("转换 schema、标题与取消能力，并缓存 5 分钟", async () => {
    const { runtime, calls } = setup(describeHandler());
    const first = await runtime.describeModel("tpl-1", "image");
    expect(first.title).toBe("图片模板");
    expect(first.promptRequirement).toBe("required");
    expect(first.cancel).toBe("remote");
    expect(first.defaultInput).toMatchObject({ size: "512", prompt: "" });

    await runtime.describeModel("tpl-1", "image");
    expect(calls.filter((call) => call.url.includes("/tasks/describe"))).toHaveLength(1);
    expect(runtime.recommendUploadProvider()).toBe("grsai");
  });

  it("cancelable=false 时降级为本地取消；describe 失败返回最小 schema", async () => {
    const local = setup(describeHandler(false));
    expect((await local.runtime.describeModel("tpl-1", "image")).cancel).toBe("local");

    const failing = setup(() => textResponse("boom", { status: 500 }));
    const described = await failing.runtime.describeModel("tpl-1", "image");
    expect(described.promptRequirement).toBe("required");
    expect((described.inputSchema?.properties as Record<string, unknown>).prompt).toBeDefined();
    expect(described.title).toBe("图片模板");
  });
});

describe("prepareInput", () => {
  const references = [
    {
      role: "reference_image",
      mediaKind: "image",
      mediaType: "image/png",
      url: "https://upload.example/a.png"
    },
    {
      role: "reference_video",
      mediaKind: "video",
      mediaType: "video/mp4",
      url: "https://upload.example/b.mp4"
    }
  ];

  it("只透传 schema 字段，prompt 落位，rawParams 最后覆盖；参考素材写入对应字段", async () => {
    const { runtime, allowed } = setup(describeHandler());
    allowed.add("https://upload.example/a.png");
    allowed.add("https://upload.example/b.mp4");
    const prepared = await runtime.prepareInput({
      providerModelId: "tpl-1",
      modelType: "image",
      prompt: "  一只猫 ",
      parameters: {
        size: "512",
        junk: "should-not-pass",
        rawParams: JSON.stringify({ size: "1024", extra: 1 })
      },
      references
    });
    expect(prepared.__sdpppxTemplateId).toBe("tpl-1");
    expect(prepared.__sdpppxPayload).toEqual({
      size: "1024",
      prompt: "一只猫",
      extra: 1,
      image: "https://upload.example/a.png",
      video: ["https://upload.example/b.mp4"]
    });
  });

  it("参考素材不在上传允许名单时拒绝提交（避免把本机签名地址发给远端）", async () => {
    const { runtime } = setup(describeHandler());
    await expect(
      runtime.prepareInput({
        providerModelId: "tpl-1",
        modelType: "image",
        prompt: "p",
        parameters: {},
        references: [references[0]!]
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.uploadFailed });
  });

  it("模板没有参考字段、但有参考素材时拒绝提交", async () => {
    const { runtime, allowed } = setup(describeHandler());
    allowed.add("https://upload.example/a.png");
    const noFields = setup(() => jsonResponse({ formSchema: { type: "object", properties: {} } }));
    noFields.allowed.add("https://upload.example/a.png");
    await expect(
      noFields.runtime.prepareInput({
        providerModelId: "tpl-1",
        modelType: "image",
        prompt: "p",
        parameters: {},
        references: [references[0]!]
      })
    ).rejects.toMatchObject({ code: "sdpppx-upload-failed" });
    expect(runtime).toBeDefined();
  });

  it("rawParams 不是 JSON 对象时拒绝提交", async () => {
    const { runtime } = setup(describeHandler());
    await expect(
      runtime.prepareInput({
        providerModelId: "tpl-1",
        modelType: "image",
        prompt: "p",
        parameters: { rawParams: "[1,2]" },
        references: []
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.taskFailed });
  });
});

describe("异步 operation", () => {
  function executionHandler(result: { outputs?: unknown; status?: string } = {}) {
    return ({ url }: { url: string }) => {
      if (url.endsWith("/tasks/create_stream")) {
        return sseResponse([{ event: "created", data: { job_id: "task-1", status: "queued" } }]);
      }
      if (url.endsWith("/tasks/status")) return jsonResponse({ status: result.status ?? "succeeded" });
      if (url.endsWith("/tasks/result")) {
        return jsonResponse({ status: result.status ?? "succeeded", outputs: result.outputs ?? [] });
      }
      if (url.endsWith("/tasks/cancel")) return jsonResponse({ ok: true });
      if (url.startsWith("https://cdn.example/")) return pngResponse();
      throw new Error(`unexpected ${url}`);
    };
  }

  it("image：create_stream → status → result，多图按顺序下载字节", async () => {
    const { runtime, calls } = setup(
      executionHandler({
        outputs: [{ url: "https://cdn.example/1.png" }, { url: "https://cdn.example/2.png" }]
      })
    );
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doStart(input: unknown): Promise<{ operation: Record<string, unknown> }>;
      doStatus(input: { operation: Record<string, unknown> }): Promise<Record<string, unknown>>;
    };
    const started = await model.doStart({
      __sdpppxTemplateId: "tpl-1",
      __sdpppxPayload: { prompt: "p" }
    });
    expect(started.operation).toMatchObject({ taskId: "task-1", templateId: "tpl-1", modelType: "image" });

    const done = await model.doStatus({ operation: started.operation });
    expect(done.status).toBe("completed");
    const images = done.images as Uint8Array[];
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual(PNG_BYTES);

    const create = calls.find((call) => call.url.endsWith("/tasks/create_stream"))!;
    expect(bodyOf(create)).toEqual({ templateId: "tpl-1", payload: { prompt: "p" }, tenantId: "tenant-1" });
    expect(headersOf(create).Authorization).toBe("Bearer jwt-1");
    expect(headersOf(create).Accept).toBe("text/event-stream");
  });

  it("create_stream 的 result 事件可直接完成，不必再轮询 status/result", async () => {
    const { runtime, calls } = setup(({ url }: { url: string }) => {
      if (url.endsWith("/tasks/create_stream")) {
        return sseResponse([
          { event: "created", data: { job_id: "task-sse", status: "queued" } },
          { event: "result", data: { status: "succeeded", result: [{ url: "https://cdn.example/sse.png" }] } },
          { event: "done", data: { job_id: "task-sse" } }
        ]);
      }
      if (url.startsWith("https://cdn.example/")) return pngResponse();
      throw new Error(`unexpected ${url}`);
    });
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doStart(input: unknown): Promise<{ operation: Record<string, unknown> }>;
      doStatus(input: { operation: Record<string, unknown> }): Promise<Record<string, unknown>>;
    };
    const started = await model.doStart({ __sdpppxTemplateId: "tpl-1", __sdpppxPayload: {} });
    await vi.waitFor(async () => {
      const done = await model.doStatus({ operation: started.operation });
      expect(done.status).toBe("completed");
      expect(done.images).toHaveLength(1);
    });
    expect(calls.some((call) => call.url.endsWith("/tasks/status"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/tasks/result"))).toBe(false);
  });

  it("提交返回 402 时给出余额不足，不伪造任务 ID", async () => {
    const { runtime } = setup(() =>
      textResponse(JSON.stringify({ error: "INSUFFICIENT_BALANCE" }), {
        status: 402,
        headers: { "content-type": "application/json" }
      })
    );
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doStart(input: unknown): Promise<unknown>;
    };
    await expect(
      model.doStart({ __sdpppxTemplateId: "tpl-1", __sdpppxPayload: {} })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.taskFailed, message: "账户余额不足" });
  });

  it("提交 401 清会话并返回 session-expired", async () => {
    const { runtime, session } = setup(() => textResponse("no", { status: 401 }));
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doStart(input: unknown): Promise<unknown>;
    };
    await expect(
      model.doStart({ __sdpppxTemplateId: "tpl-1", __sdpppxPayload: {} })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(session.clear).toHaveBeenCalledWith(SDPPPX_ERROR_CODES.sessionExpired);
  });

  it("video：结果保留 URL，不下载字节", async () => {
    const { runtime, calls } = setup(
      executionHandler({ outputs: [{ url: "https://cdn.example/v.mp4" }] })
    );
    const model = runtime.provider.videoModel("tpl-2") as unknown as {
      doStatus(input: { operation: unknown }): Promise<Record<string, unknown>>;
    };
    const done = await model.doStatus({
      operation: { taskId: "task-1", templateId: "tpl-2", startedAt: 1_000_000, modelType: "video" }
    });
    expect(done).toMatchObject({
      status: "completed",
      videos: [{ type: "url", url: "https://cdn.example/v.mp4", mediaType: "video/mp4" }]
    });
    expect(calls.some((call) => call.url === "https://cdn.example/v.mp4")).toBe(false);
  });

  it("下载失败判任务失败，不产出半成品", async () => {
    const { runtime } = setup(({ url }) => {
      if (url.endsWith("/tasks/status")) return jsonResponse({ status: "succeeded" });
      if (url.endsWith("/tasks/result")) {
        return jsonResponse({ status: "succeeded", outputs: [{ url: "https://cdn.example/bad.png" }] });
      }
      if (url.startsWith("https://cdn.example/")) return textResponse("boom", { status: 500 });
      throw new Error(`unexpected ${url}`);
    });
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doStatus(input: { operation: unknown }): Promise<unknown>;
    };
    await expect(
      model.doStatus({ operation: { taskId: "task-1", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" } })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.taskFailed });
  });

  it("failed / cancelled 返回稳定错误", async () => {
    const failed = setup(executionHandler({ status: "failed" }));
    const model = failed.runtime.provider.imageModel("tpl-1") as unknown as {
      doStatus(input: { operation: unknown }): Promise<Record<string, unknown>>;
    };
    expect(
      await model.doStatus({ operation: { taskId: "t", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" } })
    ).toEqual({ status: "error", error: SDPPPX_ERROR_CODES.taskFailed });

    const cancelled = setup(executionHandler({ status: "cancelled" }));
    const cancelledModel = cancelled.runtime.provider.imageModel("tpl-1") as unknown as typeof model;
    expect(
      await cancelledModel.doStatus({
        operation: { taskId: "t", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" }
      })
    ).toEqual({ status: "error", error: SDPPPX_ERROR_CODES.taskCancelled });
  });

  it("超时在请求前判定，401 清会话并返回 session-expired", async () => {
    let now = 1_000_000;
    const timed = setup(executionHandler(), { now: () => now, timeoutMs: 1000 });
    const model = timed.runtime.provider.imageModel("tpl-1") as unknown as {
      doStatus(input: { operation: unknown }): Promise<unknown>;
    };
    now += 2000;
    await expect(
      model.doStatus({ operation: { taskId: "t", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" } })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.taskTimeout });

    const unauthorized = setup(({ url }) => {
      if (url.endsWith("/tasks/status")) return textResponse("unauthorized", { status: 401 });
      throw new Error(`unexpected ${url}`);
    });
    const unauthorizedModel = unauthorized.runtime.provider.imageModel("tpl-1") as unknown as typeof model;
    await expect(
      unauthorizedModel.doStatus({
        operation: { taskId: "t", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" }
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(unauthorized.session.clear).toHaveBeenCalledWith(SDPPPX_ERROR_CODES.sessionExpired);
  });

  it("取消调用 /tasks/cancel，远端失败只记诊断", async () => {
    const { runtime, calls } = setup(({ url }) => {
      if (url.endsWith("/tasks/cancel")) return textResponse("down", { status: 503 });
      throw new Error(`unexpected ${url}`);
    });
    const model = runtime.provider.imageModel("tpl-1") as unknown as {
      doCancel(input: { operation: unknown }): Promise<void>;
    };
    await expect(
      model.doCancel({ operation: { taskId: "task-1", templateId: "tpl-1", startedAt: 1_000_000, modelType: "image" } })
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://sdpppx.zombee.tech/ppserver/tasks/cancel");
    expect(bodyOf(calls[0]!)).toEqual({ taskId: "task-1" });
  });
});
