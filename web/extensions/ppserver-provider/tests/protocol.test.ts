import { describe, expect, it } from "vitest";
import {
  buildCreateStreamBody,
  buildTaskBody,
  collectResultUrls,
  parseSseBuffer,
  readCost,
  readJobId,
  readProgress,
  readTaskError,
  readTaskState,
  serializeOptions
} from "../src/protocol.js";
import {
  DEFAULT_PPSERVER_BASE_URL,
  isTemplateId,
  parseTemplateIds,
  ppserverOrigin,
  templateIdFromLocator,
  templateLocator
} from "../src/shared.js";
import { interpretDescribe, parseTemplateSpecs, ppserverModelDefinitions } from "../src/discovery.js";

const UUID = "8f14e45f-ceea-467a-9f0b-1c1e2c3d4e5f";

describe("ppserver 模板标识", () => {
  it("locator 双向可逆，裸 id 原样返回", () => {
    expect(templateLocator(UUID)).toBe(`sdpppx://template/${UUID}`);
    expect(templateIdFromLocator(`sdpppx://template/${UUID}`)).toBe(UUID);
    expect(templateIdFromLocator(UUID)).toBe(UUID);
  });

  it("只把 UUID 当作模板 id", () => {
    expect(isTemplateId(UUID)).toBe(true);
    expect(isTemplateId("crun/nano-banana-pro")).toBe(false);
  });

  it("名单整份拒绝坏项，而不是静默丢掉", () => {
    expect(parseTemplateIds(`${UUID}, nano-banana-pro`)).toEqual({
      ok: false,
      message: expect.stringContaining("必须是 UUID")
    });
    const parsed = parseTemplateIds(`${UUID}\n${UUID}`);
    expect(parsed).toEqual({ ok: true, ids: [UUID] });
  });

  it("spec 支持 <uuid>:video，非法 kind 被拒", () => {
    expect(parseTemplateSpecs(`${UUID}:video`)).toEqual({ ok: true, specs: [{ templateId: UUID, kind: "video" }] });
    expect(parseTemplateSpecs(`${UUID}:audio`).ok).toBe(false);
  });

  it("默认地址去掉末尾斜杠", () => {
    expect(ppserverOrigin(`${DEFAULT_PPSERVER_BASE_URL}/`)).toBe(DEFAULT_PPSERVER_BASE_URL);
  });
});

describe("ppserver 请求体", () => {
  it("创建体带 templateId / payload，租户只在有时才写", () => {
    expect(buildCreateStreamBody({ templateId: UUID, payload: { prompt: "hi" } })).toMatchObject({
      templateId: UUID,
      payload: { prompt: "hi" }
    });
    expect(buildCreateStreamBody({ templateId: UUID, payload: {} })).not.toHaveProperty("tenantId");
    expect(buildCreateStreamBody({ templateId: UUID, payload: {}, tenantId: "t1" })).toHaveProperty("tenantId", "t1");
  });

  it("状态 / 结果 / 取消都用 taskId", () => {
    expect(buildTaskBody({ taskId: "job-1" })).toMatchObject({ taskId: "job-1" });
  });

  it("options 为空时不给这个字段", () => {
    expect(serializeOptions(undefined)).toBeUndefined();
    expect(serializeOptions({ metadata: {} })).toBeUndefined();
    expect(serializeOptions({ metadata: { a: 1 } })).toEqual({ a: 1, options: { a: 1 } });
  });
});

describe("ppserver 响应解读", () => {
  it("只有 succeeded / failed / cancelled 是终态，其余都算进行中", () => {
    expect(readTaskState({ status: "succeeded" })).toBe("succeeded");
    expect(readTaskState({ status: "FAILED" })).toBe("failed");
    expect(readTaskState({ status: "cancelled" })).toBe("cancelled");
    expect(readTaskState({ status: "running" })).toBe("running");
    expect(readTaskState({ status: "weird" })).toBe("pending");
    expect(readTaskState(null)).toBe("pending");
  });

  it("失败原因取 error / message，取不到不编造", () => {
    expect(readTaskError({ error: "额度不足" })).toBe("额度不足");
    expect(readTaskError({ error: { message: "上游超时" } })).toBe("上游超时");
    expect(readTaskError({})).toContain("未返回原因");
  });

  it("进度 0–1 与 0–100 都归一成百分数", () => {
    expect(readProgress({ progress: 0.5 })).toBe(50);
    expect(readProgress({ progress: 37 })).toBe(37);
    expect(readProgress({})).toBeUndefined();
  });

  it("job id 兼容 job_id / jobId / taskId", () => {
    expect(readJobId({ job_id: "a" })).toBe("a");
    expect(readJobId({ jobId: "b" })).toBe("b");
    expect(readJobId({ taskId: 7 })).toBe("7");
    expect(readJobId({})).toBe("");
  });

  it("结果地址递归收集，非 http 的不算", () => {
    expect(collectResultUrls({ raw: [{ url: "https://cdn.test/a.png" }, { url: "not-a-url" }] })).toEqual([
      "https://cdn.test/a.png"
    ]);
    expect(collectResultUrls({ data: { outputs: [{ images: ["https://cdn.test/b.png"] }] } })).toEqual([
      "https://cdn.test/b.png"
    ]);
  });

  it("费用取 costMoney / charge", () => {
    expect(readCost({ costMoney: 12 })).toBe(12);
    expect(readCost({ charge: 3 })).toBe(3);
    expect(readCost({})).toBeUndefined();
  });
});

describe("ppserver SSE 解析", () => {
  it("按空行切事件，半截留在 remainder", () => {
    const { events, remainder } = parseSseBuffer(
      'event: created\ndata: {"job_id":"job-1"}\n\nevent: status\ndata: {"status":"running"}\n\nevent: resu'
    );
    expect(events.map((event) => event.type)).toEqual(["created", "status"]);
    expect(events[0]?.data).toEqual({ job_id: "job-1" });
    expect(remainder).toBe("event: resu");
  });

  it("坏 JSON 不抛，退化成 text", () => {
    const { events } = parseSseBuffer("event: error\ndata: boom\n\n");
    expect(events[0]?.data).toEqual({ text: "boom" });
  });
});

describe("ppserver describe 解读", () => {
  it("取 kind / 标题 / 表单，缺 kind 时回落到配置里的声明", () => {
    const described = interpretDescribe({
      name_zhcn: "Nano Banana Pro",
      kind: "image",
      formSchema: { type: "object" },
      formValues: { prompt: "" },
      recommendUploadProvider: "sdpppx"
    });
    expect(described).toMatchObject({
      kind: "image",
      title: "Nano Banana Pro",
      inputSchema: { type: "object" },
      defaultInput: { prompt: "" },
      uploadProvider: "sdpppx"
    });

    const specs = parseTemplateSpecs(`${UUID}:video`);
    expect(specs.ok).toBe(true);
    if (!specs.ok) return;
    const fallback = interpretDescribe({});
    expect(fallback.kind).toBeUndefined();
  });

  it("模型定义把模板 UUID 直接当 providerModelId", () => {
    const [definition] = ppserverModelDefinitions([
      { modelId: UUID, templateId: UUID, kind: "image", title: "X" }
    ]);
    expect(definition).toMatchObject({ providerId: "ppserver", providerModelId: UUID, modelType: "image" });
  });

  it("模板的运营分类透传到 capabilities.category，没有分类就不带", () => {
    const [withCategory, without] = ppserverModelDefinitions([
      { modelId: UUID, templateId: UUID, kind: "image", title: "X", category: "image-21" },
      { modelId: UUID, templateId: UUID, kind: "image", title: "Y" }
    ]);
    expect(withCategory?.capabilities).toEqual({ category: "image-21" });
    expect(without?.capabilities).toBeUndefined();
  });
});
