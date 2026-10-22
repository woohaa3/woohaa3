import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import { catalogFixture } from "./test-support/fixtures.js";
import { GenericModelPanel } from "./generic-panel.js";
import { projectModelConfig } from "./generic-panel-projection.js";

const model = catalogFixture([{ modelKey: "image-model", modelType: "image" }]).models[0];
const props: ModelPanelProps = {
  nodeId: "image-node", model, catalogModels: [model], defaultModelKey: model.modelKey,
  writable: true, readOnly: false, presentation: "expanded", status: "processing", progress: 37,
  draft: { prompt: "保留人物，调整光线", parameters: {} }, references: [], blockingReasons: [],
  patchDraft: () => {}, submit: async () => ({ ok: true, runId: "run", jobId: "job" }),
  requestPresentation: () => {}, actions: { viewTask: () => {} }
};

describe("展开图片生成反馈", () => {
  it("将宿主权威百分比传入当前工作区，并保留任务入口和草稿", () => {
    const html = renderToStaticMarkup(<GenericModelPanel {...props} />);
    expect(html).toContain("图片生成中 · 37%");
    expect(html).toContain("查看任务");
    expect(html).toContain("保留人物，调整光线");
  });
  it("排队或进度未知时不显示旧百分比或虚构进度", () => {
    expect(renderToStaticMarkup(<GenericModelPanel {...props} status="pending" />)).not.toContain("37%");
    const unknown = renderToStaticMarkup(<GenericModelPanel {...props} progress={Number.NaN} />);
    expect(unknown).toContain("图片生成中");
    expect(unknown).not.toContain("NaN%");
  });
});

describe("generic 面板参数投影", () => {
  it("复用共享投影并保留 x-pptask-control / x-pptask-adaptive 语义", () => {
    const semanticModel = {
      ...model,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", title: "提示词" },
          aspectRatio: {
            type: "string",
            title: "比例",
            default: "auto",
            "x-pptask-control": "aspect-ratio",
            enum: [
              { value: "auto", label: "自适应", "x-pptask-adaptive": true },
              { value: "1:1", label: "1:1" }
            ]
          },
          resolution: {
            type: "string",
            title: "分辨率",
            default: "1K",
            "x-pptask-control": "resolution",
            enum: ["1K", "2K"]
          }
        }
      },
      defaultInput: { prompt: "", aspectRatio: "auto", resolution: "1K" }
    };
    const config = projectModelConfig(
      [semanticModel],
      semanticModel.modelKey,
      semanticModel.modelKey
    );
    const fields = config.parameterSchemaByModel?.[semanticModel.modelKey] ?? [];
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    expect(byKey.aspectRatio).toMatchObject({
      type: "select",
      semantic: "aspect-ratio",
      adaptiveValue: "auto"
    });
    expect(byKey.resolution).toMatchObject({ semantic: "resolution" });
    expect(byKey.resolution.adaptiveValue).toBeUndefined();
    expect(config.defaultsByModel?.[semanticModel.modelKey]).toEqual({
      aspectRatio: "auto",
      resolution: "1K"
    });
  });
});
