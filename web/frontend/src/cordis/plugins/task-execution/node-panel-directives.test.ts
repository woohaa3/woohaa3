/**
 * 执行面板 presentation / close 指令解析
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 1.2 / 1.4）。
 */
import { describe, expect, it } from "vitest";
import {
  planCollapseIntent,
  planEscapeIntent,
  planExpandIntent,
  panelRouteForIntent,
  panelTypeForNodeType
} from "./node-panel-directives.js";

describe("panel presentation intent", () => {
  it("执行面板 expand/collapse 生成同 identity replace route", () => {
    expect(planExpandIntent("node-execution")).toEqual({ kind: "expand" });
    expect(planCollapseIntent("node-execution")).toEqual({ kind: "collapse" });
    expect(panelRouteForIntent("node-execution", "n1", { kind: "expand" })).toEqual({
      type: "node-execution",
      nodeId: "n1",
      presentation: "expanded"
    });
    expect(panelRouteForIntent("node-execution", "n1", { kind: "collapse" })).toEqual({
      type: "node-execution",
      nodeId: "n1",
      presentation: "compact"
    });
  });

  it("model-node-editor 不支持 expand/collapse（保持 none）", () => {
    expect(planExpandIntent("model-node-editor")).toEqual({ kind: "none" });
    expect(planCollapseIntent("model-node-editor")).toEqual({ kind: "none" });
    expect(panelRouteForIntent("model-node-editor", "m1", { kind: "expand" })).toBeNull();
  });

  it("close 携带匹配的 panel 类型", () => {
    expect(panelTypeForNodeType("node-execution")).toBe("node-execution");
    expect(panelTypeForNodeType("model-node-editor")).toBe("model-node-editor");
  });
});

describe("Escape 优先级（design D7）", () => {
  it("picker 打开时返回 none（由 picker 表面消费）", () => {
    expect(
      planEscapeIntent({ type: "node-execution", presentation: "compact", localSurface: { picker: true, overlay: false } })
    ).toEqual({ kind: "none" });
  });

  it("panel-local 菜单打开时返回 none", () => {
    expect(
      planEscapeIntent({ type: "node-execution", presentation: "expanded", localSurface: { picker: false, overlay: true } })
    ).toEqual({ kind: "none" });
  });

  it("expanded 无浮层 → 收起为 compact", () => {
    expect(
      planEscapeIntent({ type: "node-execution", presentation: "expanded", localSurface: { picker: false, overlay: false } })
    ).toEqual({ kind: "collapse" });
  });

  it("compact 无浮层 → 关闭", () => {
    expect(
      planEscapeIntent({ type: "node-execution", presentation: "compact", localSurface: { picker: false, overlay: false } })
    ).toEqual({ kind: "close" });
  });
});
