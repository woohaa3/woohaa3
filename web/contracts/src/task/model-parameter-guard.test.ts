/**
 * 模型参数提交门禁（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 钉住现场两次失败：缺 `aspectRatio` / `resolution` 与时长越界，都必须在提交前形成
 * 可读原因；模型声明的默认值必须进入提交快照。
 */
import { describe, expect, it } from "vitest";
import {
  modelParameterBlockingReasons,
  resolveModelParameters,
  resolveModelSubmissionParameters
} from "./model-parameter-guard.js";

const AGNES_SCHEMA = {
  type: "object",
  required: ["prompt", "aspectRatio", "resolution", "durationSeconds"],
  properties: {
    prompt: { type: "string", title: "提示词" },
    aspectRatio: { type: "string", title: "比例", enum: ["16:9", "9:16", "1:1"] },
    resolution: { type: "string", title: "分辨率", enum: ["720p", "1080p", "2k"] },
    durationSeconds: { type: "number", title: "时长", minimum: 5, maximum: 12, unit: "秒" }
  }
};

const AGNES_DEFAULTS = { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 };

describe("模型参数提交门禁", () => {
  it("缺宽高比时给出缺失字段原因", () => {
    const reasons = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: { ...AGNES_SCHEMA, properties: { ...AGNES_SCHEMA.properties, aspectRatio: { type: "string", title: "比例", enum: ["16:9", "9:16", "1:1"] } } } },
      { resolution: "720p", durationSeconds: 5 },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(reasons).toEqual(["缺少必填参数「比例」（aspectRatio）"]);
  });

  it("缺分辨率时给出缺失字段原因", () => {
    const reasons = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: AGNES_SCHEMA },
      { aspectRatio: "16:9", durationSeconds: 5 },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(reasons).toEqual(["缺少必填参数「分辨率」（resolution）"]);
  });

  it("时长越界时给出允许范围", () => {
    const below = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: AGNES_SCHEMA },
      { aspectRatio: "16:9", resolution: "720p", durationSeconds: 0 },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(below[0]).toContain("时长不能小于 5秒");

    const above = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: AGNES_SCHEMA },
      { aspectRatio: "16:9", resolution: "720p", durationSeconds: 13 },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(above[0]).toContain("时长不能大于 12秒");
  });

  it("不在允许集合内的值给出可选项", () => {
    const reasons = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: AGNES_SCHEMA },
      { aspectRatio: "21:9", resolution: "4k", durationSeconds: 5 },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(reasons).toContain("比例只支持 16:9、9:16、1:1，当前为「21:9」");
    expect(reasons).toContain("分辨率只支持 720p、1080p、2k，当前为「4k」");
  });

  it("应用模型默认值后参数完整且无阻止原因", () => {
    const resolved = resolveModelParameters(
      { modelType: "video", inputSchema: AGNES_SCHEMA, defaultInput: AGNES_DEFAULTS },
      {},
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(resolved.issues).toEqual([]);
    expect(resolved.parameters).toEqual(AGNES_DEFAULTS);
    expect(
      resolveModelSubmissionParameters(
        { modelType: "video", inputSchema: AGNES_SCHEMA, defaultInput: AGNES_DEFAULTS },
        {},
        { prompt: "一段动画", skipRequired: ["prompt"] }
      )
    ).toEqual(AGNES_DEFAULTS);
  });

  it("显式值覆盖默认值，空值回落到默认值", () => {
    const resolved = resolveModelParameters(
      { modelType: "video", inputSchema: AGNES_SCHEMA, defaultInput: AGNES_DEFAULTS },
      { resolution: "1080p", aspectRatio: "" },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(resolved.parameters).toMatchObject({ aspectRatio: "16:9", resolution: "1080p", durationSeconds: 5 });
  });

  it("视频模型没有参数 schema 时显式阻止，不静默放行", () => {
    const reasons = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: {} },
      { aspectRatio: "16:9" },
      { prompt: "一段动画", skipRequired: ["prompt"] }
    );
    expect(reasons[0]).toContain("没有声明参数 schema");
  });

  it("x-hidden-when 命中的字段不参与必填与范围校验", () => {
    const schema = {
      type: "object",
      required: ["generationMode", "durationSeconds"],
      properties: {
        generationMode: { type: "string", enum: ["edit_video", "omni_reference"] },
        durationSeconds: {
          type: "number",
          title: "时长",
          minimum: 5,
          maximum: 12,
          unit: "秒",
          "x-hidden-when": [{ field: "generationMode", equals: "edit_video" }]
        }
      }
    };
    const reasons = modelParameterBlockingReasons(
      { modelType: "video", inputSchema: schema },
      { generationMode: "edit_video" },
      { prompt: "编辑这段视频", skipRequired: ["prompt"] }
    );
    expect(reasons).toEqual([]);
  });
});
