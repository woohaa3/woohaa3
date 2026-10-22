import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelParameterPanel, modelPromptGuide } from "./model-parameter-panel.js";

describe("ModelParameterPanel MCP 指引", () => {
  it("model3d 节点显示 HTTP MCP 地址和 disabled 提示词输入框", () => {
    const markup = renderToStaticMarkup(
      <ModelParameterPanel
        canvasId="canvas-1"
        nodeId="model-7"
        nodeType="model3d"
        mcpServerUrl="https://canvas.example/mcp/model-canvas"
      />
    );

    expect(markup).toContain("Streamable HTTP");
    expect(markup).toContain("mc-panel__host");
    expect(markup).toContain("mc-panel--model");
    expect(markup).toContain('data-surface="dock"');
    expect(markup).toContain("https://canvas.example/mcp/model-canvas");
    expect(markup).toContain("MCP 模型提示词指引");
    expect(markup).toContain("disabled");
    expect(markup).toContain("canvas-1");
    expect(markup).toContain("model-7");
    expect(markup).toContain("node-param-panel__mcp-control");
    expect((markup.match(/>复制</g) ?? [])).toHaveLength(2);
  });

  it("面板不再包含模型摆放控件", () => {
    const markup = renderToStaticMarkup(<ModelParameterPanel nodeId="m1" nodeType="model3d" />);
    expect(markup).not.toContain("模型摆放");
    expect(markup).not.toContain("重置模型位置");
    expect(markup).not.toContain('type="range"');
    expect(markup).not.toContain('type="number"');
  });

  it("已下线的 edit/shot 节点不再渲染面板", () => {
    for (const nodeType of ["edit", "shot", "generate"] as const) {
      const markup = renderToStaticMarkup(<ModelParameterPanel nodeId={`${nodeType}-1`} nodeType={nodeType} />);
      expect(markup, nodeType).not.toContain("MCP 模型生成");
      expect(markup, nodeType).not.toContain("模型摆放");
      expect(markup, nodeType).not.toContain("node-param-panel");
    }
  });

  it("提示词明确要求先读取再提交", () => {
    expect(modelPromptGuide("canvas-1", "model-7")).toContain(
      "先调用 get_model_node，再调用 submit_model_script"
    );
    // 统计口径由工具给出，提示词禁止手算（change: 2026-10-18-align-model-statistics-with-agent）。
    expect(modelPromptGuide("canvas-1", "model-7")).toContain("get_model_statistics");
    expect(modelPromptGuide("canvas-1", "model-7")).toContain("不要自己按成本表推算");
  });

  it("自包含 3D 节点同样显示 MCP 面板，片场给出动画工具指引（change: 2026-10-05；2026-10-11 身份迁移）", () => {
    const model = renderToStaticMarkup(<ModelParameterPanel nodeId="m3d-1" nodeType="model3d" />);
    expect(model).toContain("MCP 模型生成");
    expect(model).toContain("submit_model_script");

    const animation = renderToStaticMarkup(<ModelParameterPanel nodeId="anim-1" nodeType="composite-asset" isFilmSet />);
    expect(animation).toContain("MCP 模型生成");
    expect(animation).toContain("create_film_set_node");
    expect(animation).toContain("import_model_snapshot");
  });
});

describe("ModelParameterPanel 通用 authoring 生成入口（change: 2026-10-08-unlock-...，任务 6.4）", () => {
  it("提供 renderGenerate 时直接显示生成入口，不再渲染二选一 tabs 或旧 MCP 页", () => {
    const markup = renderToStaticMarkup(
      <ModelParameterPanel
        canvasId="cv"
        nodeId="n1"
        nodeType="model3d"
        renderGenerate={() => <div data-testid="generate-slot">生成入口</div>}
      />
    );
    expect(markup).toContain("生成");
    expect(markup).not.toContain("MCP 指引");
    expect(markup).not.toContain("ui-tabs");
    expect(markup).not.toContain("node-param-panel__mcp");
    expect(markup).toContain("generate-slot");
  });

  it("无 renderGenerate（生成插件缺失）时只显示 MCP 指引，不出现生成 tab", () => {
    const markup = renderToStaticMarkup(<ModelParameterPanel canvasId="cv" nodeId="n1" nodeType="model3d" />);
    expect(markup).toContain("MCP 模型生成");
    expect(markup).not.toContain("generate-slot");
    expect(markup).not.toContain(">生成<");
  });
});
