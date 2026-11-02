import { describe, expect, it } from "vitest";
import {
  buildChatBody,
  buildImageBody,
  buildVideoBody,
  collectResultUrls,
  imageResultBase64,
  imageResultUrls,
  interpretStatus,
  readTaskId,
  statusPath,
  submitError,
  videoSpecFor,
  CHAT_PATH,
  IMAGES_PATH,
  VIDEO_TASKS_PATH
} from "../src/routes.js";

describe("端脑云端点", () => {
  it("路径前缀固定为 /user-center/v1/model", () => {
    expect(CHAT_PATH).toBe("/user-center/v1/model/chat/completions");
    expect(IMAGES_PATH).toBe("/user-center/v1/model/images/generations");
    expect(VIDEO_TASKS_PATH).toBe("/user-center/v1/model/video/tasks");
    expect(statusPath("abc/def")).toBe("/user-center/v1/model/video/tasks/abc%2Fdef");
  });
});

describe("文本请求体", () => {
  const input = {
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    max_tokens: 64,
    urls: ["https://cdn.example/ref.png"]
  };

  it("未声明视觉的模型不带 image_url", () => {
    const body = buildChatBody("deepseek-v4-pro", input, { supportsVision: false }) as {
      messages: Array<{ role: string; content: unknown }>;
      max_tokens: number;
      model: string;
    };
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.max_tokens).toBe(64);
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(body.messages.at(-1)?.content).toBe("你好");
  });

  it("声明视觉的模型把参考图追加到用户消息", () => {
    const body = buildChatBody("gemini-3.5-flash", input, { supportsVision: true }) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages.at(-1)?.content).toEqual([
      { type: "text", text: "你好" },
      { type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }
    ]);
  });

  it("system 与 jsonMode 只在需要时出现", () => {
    const plain = buildChatBody("m", { messages: [] }, { supportsVision: false });
    expect(plain).not.toHaveProperty("response_format");
    const withSystem = buildChatBody(
      "m",
      { messages: [{ role: "user", content: "hi" }], system: "简洁", jsonMode: true },
      { supportsVision: false }
    ) as { messages: Array<{ role: string; content: unknown }>; response_format: unknown };
    expect(withSystem.messages[0]).toEqual({ role: "system", content: "简洁" });
    expect(withSystem.response_format).toEqual({ type: "json_object" });
  });
});

describe("图片请求体与结果", () => {
  it("size 只下发平台接受的取值", () => {
    expect(buildImageBody("NanoBanana2", { prompt: "猫", size: "2k" })).toMatchObject({ size: "2K" });
    expect(buildImageBody("NanoBanana2", { prompt: "猫", resolution: "1024x1024" })).toMatchObject({
      size: "1024x1024"
    });
    // 平台不接受的档位不下发，避免 400。
    expect(buildImageBody("NanoBanana2", { prompt: "猫", resolution: "1024" })).not.toHaveProperty("size");
    // 平台没有 aspect_ratio 校验证据：只有比例时也不下发（分辨率才是平台认的字段）。
    expect(buildImageBody("NanoBanana2", { prompt: "猫", aspectRatio: "16:9" })).not.toHaveProperty("aspect_ratio");
  });

  it("数量收敛在 1..10，默认不下发", () => {
    expect(buildImageBody("NanoBanana2", { prompt: "猫", n: 1 })).not.toHaveProperty("n");
    expect(buildImageBody("NanoBanana2", { prompt: "猫", n: 99 })).toMatchObject({ n: 10 });
  });

  it("空提示词直接报错", () => {
    expect(() => buildImageBody("NanoBanana2", { prompt: "  " })).toThrow("提示词不能为空");
    expect(() => buildVideoBody("seedance-2.5", {})).toThrow("提示词不能为空");
  });

  it("结果只取 https 地址，b64 保持裸 base64 载荷", () => {
    expect(imageResultUrls({ data: [{ url: "https://cdn.example/a.png" }, { url: "file:///tmp/b.png" }] })).toEqual([
      "https://cdn.example/a.png"
    ]);
    // 共享 output 解析把 b64_json 当 base64 读取：data URL 前缀要先剥掉。
    expect(imageResultBase64({ data: [{ b64_json: "QUJD" }] })).toEqual(["QUJD"]);
    expect(imageResultBase64({ data: [{ b64_json: "data:image/webp;base64,QUJD" }] })).toEqual(["QUJD"]);
    expect(imageResultUrls({ data: [] })).toEqual([]);
  });
});

describe("视频请求体", () => {
  it("PascalCase 形状，模型名不进 body", () => {
    const body = buildVideoBody("seedance-2.5", {
      prompt: "镜头推进",
      aspect_ratio: "16:9",
      resolution: "720P",
      duration: 4,
      urls: ["https://cdn.example/a.png"]
    });
    expect(body).toEqual({
      Prompt: "镜头推进",
      FileInfos: [{ Type: "Url", Category: "Image", Url: "https://cdn.example/a.png", Usage: "Reference" }],
      OutputConfig: { Resolution: "720P", AspectRatio: "16:9", Duration: 4 }
    });
    expect(body).not.toHaveProperty("model");
  });

  it("分辨率与时长按模型取值范围收敛", () => {
    expect(videoSpecFor("seedance-2.5")).toMatchObject({ resolutions: ["720P", "1080P"], maxDuration: 30 });
    expect(videoSpecFor("seedance-2.0").resolutions).toContain("4K");
    // H3 的平台文档明确写「768P / 2K，注意没有 720P」。
    expect(videoSpecFor("minimax-h3")).toMatchObject({ resolutions: ["768P", "2K"], defaultResolution: "768P" });
    // 平台没给出取值域的模型：不猜，也不下发该字段。
    expect(videoSpecFor("whatever").resolutions).toEqual([]);

    const long = buildVideoBody("seedance-2.0", { prompt: "x", resolution: "4K", duration: 99 }) as {
      OutputConfig: { Resolution: string; Duration: number };
    };
    expect(long.OutputConfig).toMatchObject({ Resolution: "4K", Duration: 15 });
    // 越界档位回落到默认值，不把上游必然拒绝的值发出去。
    const bad = buildVideoBody("seedance-2.5", { prompt: "x", resolution: "768P" }) as {
      OutputConfig: { Resolution: string };
    };
    expect(bad.OutputConfig.Resolution).toBe("720P");
    const tooShort = buildVideoBody("seedance-2.5", { prompt: "x", duration: 1 }) as {
      OutputConfig: { Duration: number };
    };
    expect(tooShort.OutputConfig.Duration).toBe(4);
    const unspecified = buildVideoBody("unknown-video-model", { prompt: "x", resolution: "768P" }) as {
      OutputConfig: Record<string, unknown>;
    };
    expect(unspecified.OutputConfig).not.toHaveProperty("Resolution");
  });

  it("比例只接受平台枚举，自适应即不下发字段", () => {
    const ok = buildVideoBody("seedance-2.5", { prompt: "x", aspectRatio: "9:16" }) as {
      OutputConfig: { AspectRatio?: string };
    };
    expect(ok.OutputConfig.AspectRatio).toBe("9:16");
    // seedance 的默认就是 adaptive；H3 的枚举里没有 adaptive，所以自适应一律不发字段。
    const fallback = buildVideoBody("seedance-2.5", { prompt: "x", aspectRatio: "2:1" }) as {
      OutputConfig: Record<string, unknown>;
    };
    expect(fallback.OutputConfig).not.toHaveProperty("AspectRatio");
    const adaptive = buildVideoBody("minimax-h3", { prompt: "x" }) as { OutputConfig: Record<string, unknown> };
    expect(adaptive.OutputConfig).not.toHaveProperty("AspectRatio");
  });
});

describe("视频任务响应", () => {
  it("任务 ID 取自 Response.TaskId", () => {
    expect(readTaskId({ Response: { RequestId: "r", TaskId: "task-1" } })).toBe("task-1");
    expect(readTaskId({ data: { task_id: "t2" } })).toBe("t2");
    expect(readTaskId({ Response: { RequestId: "r" } })).toBeUndefined();
  });

  it("业务失败码直接判失败", () => {
    expect(submitError({ code: 30002, msg: "余额不足" })).toBe("余额不足");
    expect(submitError({ code: 0, data: {} })).toBeUndefined();
    expect(submitError({ error: { message: "api-key 无效，请检查" } })).toBe("api-key 无效，请检查");
    expect(submitError(null)).toBe("端脑云返回了无法识别的响应");
    // 视频任务按平台约定失败也返回 HTTP 200，错误在 Response.Error。
    expect(submitError({ Response: { Error: { Code: "InvalidParameter", Message: "Prompt is required" } } })).toBe(
      "Prompt is required"
    );
    expect(submitError({ Response: { TaskId: "task-1", RequestId: "r" } })).toBeUndefined();
  });

  it("WAITING 仍是排队，ABORTED 判失败", () => {
    expect(interpretStatus({ Response: { Status: "WAITING" } })).toMatchObject({ state: "pending", phase: "queued" });
    expect(interpretStatus({ Response: { Status: "ABORTED", AigcVideoTask: { Status: "ABORTED" } } })).toMatchObject({
      state: "failed"
    });
    expect(
      interpretStatus({ Response: { Error: { Code: "InvalidParameter", Message: "ModelName is required" } } })
    ).toEqual({ state: "failed", error: "ModelName is required" });
  });

  it("轮询 PROCESSING 保持运行中，FINISH 输出成片地址", () => {
    const processing = interpretStatus({
      Response: { Status: "PROCESSING", AigcVideoTask: { Status: "PROCESSING", Progress: 42 } }
    });
    expect(processing).toEqual({ state: "pending", phase: "running", progress: 42 });

    const finished = interpretStatus({
      Response: {
        Status: "FINISH",
        AigcVideoTask: {
          Status: "FINISH",
          Progress: 100,
          ErrCode: 0,
          Message: "",
          Output: { FileInfos: [{ FileUrl: "https://cdn.example/out.mp4", ExpireTime: "2026-11-09T00:00:00Z" }] }
        }
      }
    });
    expect(finished).toEqual({ state: "completed", urls: ["https://cdn.example/out.mp4"] });
  });

  it("FINISH + ErrCode 判失败；失败状态带可读原因", () => {
    expect(
      interpretStatus({
        Response: {
          Status: "FINISH",
          AigcVideoTask: { Status: "FINISH", ErrCode: 50003, Message: "第三方接口调用异常" }
        }
      })
    ).toEqual({ state: "failed", error: "第三方接口调用异常" });

    expect(
      interpretStatus({ Response: { Status: "FINISH", AigcVideoTask: { Status: "FINISH", ErrCode: 0, Output: {} } } })
    ).toEqual({ state: "failed", error: "端脑云任务已完成但没有返回结果地址" });

    expect(submitError({ code: 50003, msg: "第三方接口调用异常" })).toBe("第三方接口调用异常");
  });

  it("状态字段缺失或未知保持非终态，不输出空成功", () => {
    expect(interpretStatus({ Response: {} })).toMatchObject({ state: "pending" });
    expect(interpretStatus({ Response: { Status: "SOMETHING_NEW" } })).toMatchObject({ state: "pending" });
    // 完全不是对象：无法识别。
    expect(interpretStatus(null)).toEqual({ state: "failed", error: "端脑云返回了无法识别的响应" });
    expect(interpretStatus("PROCESSING")).toEqual({ state: "failed", error: "端脑云返回了无法识别的响应" });
  });

  it("结果地址只从成片字段取，不扫请求回显里的参考图", () => {
    const payload = {
      Response: {
        Status: "FINISH",
        AigcVideoTask: {
          Status: "FINISH",
          ErrCode: 0,
          Input: { FileInfos: [{ Url: "https://cdn.example/reference.png" }] },
          Output: { FileInfos: [{ FileUrl: "https://cdn.example/out.mp4" }] }
        }
      }
    };
    expect(collectResultUrls(payload)).toEqual(["https://cdn.example/out.mp4"]);
  });
});
