/**
 * ExecutionPanel 结构化 prompt editor 插槽
 * （change: add-reference-inputs-and-mentions，任务 4.4）。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanel } from "./ExecutionPanel.js";

const BASE_PROPS = {
  taskKind: "image-generation" as const,
  surface: "dock" as const,
  modelConfig: {
    modelOptions: [{ label: "M", value: "m" }],
    defaultModel: "m",
    parameterSchemaByModel: {}
  },
  data: { title: "节点", panelPrompt: "原始提示词", parameters: { model: "m" } },
  onRun: () => undefined
};

describe("ExecutionPanel prompt editor 插槽", () => {
  it("无插槽时使用默认 textarea", () => {
    const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("原始提示词");
  });

  it("提供插槽时替换 textarea 且 value/onChange 契约可用", () => {
    const html = renderToStaticMarkup(
      <ExecutionPanel
        {...BASE_PROPS}
        promptEditorSlot={({ value, placeholder }) => (
          <div data-testid="mention-editor" data-placeholder={placeholder}>
            {value}
          </div>
        )}
      />
    );
    expect(html).not.toContain("<textarea");
    expect(html).toContain('data-testid="mention-editor"');
    expect(html).toContain("原始提示词");
  });

  it("操作区显示 Enter 生成、Shift+Enter 换行说明（任务 3.3）", () => {
    const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} />);
    expect(html).toContain('data-testid="prompt-submit-hint"');
    expect(html).toContain("Enter 生成，Shift+Enter 换行");
  });
});
