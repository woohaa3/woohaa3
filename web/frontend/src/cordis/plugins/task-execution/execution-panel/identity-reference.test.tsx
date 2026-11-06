/**
 * 身份参考阻止原因必须真正禁用主操作
 * （change: 2026-11-06-require-identity-reference，任务 2.1）。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IDENTITY_REFERENCE_REQUIRED_REASON } from "@woohaa3/contracts";
import { ExecutionPanel } from "./ExecutionPanel.js";

const BASE_PROPS = {
  taskKind: "image-generation" as const,
  surface: "dock" as const,
  modelConfig: {
    modelOptions: [{ label: "M", value: "m" }],
    defaultModel: "m",
    parameterSchemaByModel: {}
  },
  data: { title: "N07", panelPrompt: "同一短黑发女性近景", parameters: { model: "m" } },
  onRun: () => undefined
};

function sendButton(html: string): string {
  const match = html.match(/<button[^>]*class="mc-panel__send[^"]*"[^>]*>/);
  if (!match) throw new Error("未找到主操作按钮");
  return match[0];
}

describe("身份参考阻止原因", () => {
  it("无 ready 参考时主操作禁用并显示可行动原因", () => {
    const html = renderToStaticMarkup(
      <ExecutionPanel {...BASE_PROPS} blockingReasons={[IDENTITY_REFERENCE_REQUIRED_REASON]} />
    );
    expect(sendButton(html)).toContain("disabled");
    expect(html).toContain(IDENTITY_REFERENCE_REQUIRED_REASON);
  });

  it("没有阻止原因时不因提示词或状态误禁用", () => {
    const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} blockingReasons={[]} />);
    expect(sendButton(html)).not.toContain("disabled");
  });
});
