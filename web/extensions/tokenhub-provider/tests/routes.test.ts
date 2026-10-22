import { describe, expect, it } from "vitest";
import {
  buildSubmit,
  collectResultUrls,
  interpretStatus,
  readTaskId,
  routeModel
} from "../src/routes.js";

describe("TokenHub 系列路由", () => {
  it("只给有协议的图片和视频模型分配路由", () => {
    expect(routeModel("hy-image-v3.5-preview")?.family).toBe("hy-image-v35");
    expect(routeModel("hy-image-v3")).toMatchObject({ family: "hy-image-v3", mode: "sync" });
    expect(routeModel("kling-image-v3-omni")?.mode).toBe("async");
    expect(routeModel("kling-video-v3")?.family).toBe("kling-video");
    expect(routeModel("kling-video-v3-omni")?.family).toBe("kling-omni");
    expect(routeModel("minimax-video-h3")?.family).toBe("minimax-video-v2");
    expect(routeModel("minimax-video-v2.3")?.family).toBe("minimax-video");
    expect(routeModel("hy3")).toBeUndefined();
    expect(routeModel("vidu-video-q3")).toBeUndefined();
    expect(routeModel("wand-vega-image-pro")).toBeUndefined();
    expect(routeModel("kling-video-motion-control-v3.0")).toBeUndefined();
  });

  it("混元 3.0 用 prompt，3.5 用 messages，可灵图生走 image_list", () => {
    expect(buildSubmit("hy-image-v3", { prompt: "猫", aspectRatio: "16:9" })).toEqual({
      path: "/v1/wand/hunyuan-image/v3-generation",
      body: { model: "hy-image-v3", prompt: "猫", size: "1280x720" }
    });
    expect(buildSubmit("hy-image-v3.5-preview", {
      prompt: "猫",
      urls: ["https://cdn.example/ref.png"],
      resolution: "2K"
    }).body).toMatchObject({
      model: "hy-image-v3.5-preview",
      size: "2048x2048",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "猫" },
          { type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }
        ]
      }]
    });
    expect(buildSubmit("kling-image-o1", { prompt: "猫", images: ["https://cdn.example/a.png"] }).body).toMatchObject({
      image_list: ["https://cdn.example/a.png"],
      resolution: "1k"
    });
  });

  it("Hy-Image-3.5-preview 自适应省略 size，固定比例按分辨率查像素表", () => {
    const auto = buildSubmit("hy-image-v3.5-preview", {
      prompt: "猫",
      aspectRatio: "auto",
      resolution: "2K"
    });
    expect(auto.body).toMatchObject({ model: "hy-image-v3.5-preview", generate_max_pixels: 4194304 });
    expect(auto.body).not.toHaveProperty("size");

    const fixed = buildSubmit("hy-image-v3.5-preview", {
      prompt: "猫",
      aspectRatio: "16:9",
      resolution: "1.5K"
    });
    expect(fixed.body).toMatchObject({ size: "2048x1152" });

    // 未显式选择分辨率时按预设默认 1.5K；1:1 为 1536x1536。
    const fallback = buildSubmit("hy-image-v3.5-preview", { prompt: "猫", aspectRatio: "1:1" });
    expect(fallback.body).toMatchObject({ size: "1536x1536" });
  });

  it("Seedream 按模型版本使用共享预设的尺寸档", () => {
    expect(buildSubmit("seedream-image-5-pro", { prompt: "猫", resolution: "1.5K" }).body)
      .toMatchObject({ size: "1.5K" });
    expect(buildSubmit("seedream-image-5-lite", { prompt: "猫", resolution: "3K" }).body)
      .toMatchObject({ size: "3K" });
    // 不在版本档位内的值回退到该模型默认分辨率。
    expect(buildSubmit("seedream-image-4.5", { prompt: "猫", resolution: "1K" }).body)
      .toMatchObject({ size: "2K" });
  });

  it("Seedream 选了固定比例时按官方像素表下发 size，4.0 没有比例表则退回档位", () => {
    // 即梦没有 aspect_ratio：比例必须写进像素 size 才生效。
    expect(buildSubmit("seedream-image-5-pro", { prompt: "猫", aspectRatio: "16:9", resolution: "2K" }).body)
      .toMatchObject({ size: "2848x1600" });
    expect(buildSubmit("seedream-image-5-lite", { prompt: "猫", aspectRatio: "9:16", resolution: "3K" }).body)
      .toMatchObject({ size: "2304x4096" });
    expect(buildSubmit("seedream-image-4.5", { prompt: "猫", aspectRatio: "21:9", resolution: "4K" }).body)
      .toMatchObject({ size: "6240x2656" });
    // 4.0 的官方文档只给一组像素值、没有按档位拆分，比例交给 prompt。
    expect(buildSubmit("seedream-image-4.0", { prompt: "猫", aspectRatio: "16:9", resolution: "4K" }).body)
      .toMatchObject({ size: "4K" });
    // 自适应 / 没选比例时保持原有「按档位下发」。
    expect(buildSubmit("seedream-image-5-pro", { prompt: "猫", aspectRatio: "auto", resolution: "1K" }).body)
      .toMatchObject({ size: "1K" });
  });

  it("有参考图时视频走图生接口", () => {
    const text = buildSubmit("kling-video-v3", { prompt: "跑", aspectRatio: "9:16", duration: 8, resolution: "1080p" });
    expect(text.path).toBe("/v1/wand/kling/text-to-video");
    expect(text.body.settings).toMatchObject({ aspect_ratio: "9:16", duration: 8, resolution: "1080p" });

    const image = buildSubmit("pixverse-video-v6.0", { prompt: "转头", urls: ["https://cdn.example/in.jpg"], duration: 5 });
    expect(image.path).toBe("/v1/wand/pixverse/image-to-video");
    expect(image.body.img_id).toBe("https://cdn.example/in.jpg");

    expect(() => buildSubmit("minimax-video-v2.3-fast", { prompt: "跑" })).toThrow(/图生视频/);
  });

  it("从各系列的结果字段取出地址，并识别任务状态", () => {
    expect(collectResultUrls({
      choices: [{ delta: { image: { url: "https://cdn.example/out.png" } } }]
    })).toEqual(["https://cdn.example/out.png"]);
    expect(interpretStatus({ state: "processing" })).toEqual({ state: "pending", phase: "running" });
    expect(interpretStatus({ Resp: { status: 1, url: "https://cdn.example/out.mp4" } })).toEqual({
      state: "completed",
      urls: ["https://cdn.example/out.mp4"]
    });
    expect(interpretStatus({ status: "Success", content: { url: "https://cdn.example/mm.mp4" } }).state).toBe("completed");
    expect(interpretStatus({ task: { status: "failed", error: { message: "审核未通过" } } })).toEqual({
      state: "failed",
      error: "审核未通过"
    });
    expect(readTaskId({ data: { id: "task-1" } })).toBe("task-1");
    expect(readTaskId({ Resp: { video_id: "vid-1" } })).toBe("vid-1");
  });
});
