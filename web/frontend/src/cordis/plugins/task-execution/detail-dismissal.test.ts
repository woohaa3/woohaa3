import { describe, expect, it } from "vitest";
import type { CanvasPanelRoute } from "../../navigation/contracts.js";
import { shouldDismissAgentDetailOnDeselect } from "./detail-dismissal.js";

const DETAIL: CanvasPanelRoute = {
  type: "agent-conversation",
  conversationId: "conv-1",
  requestId: "req-1",
  nodeId: "n1"
};

describe("取消选择节点时收起 Agent 对话详情", () => {
  it("从选中节点清空选择时收起打开的详情侧栏", () => {
    expect(shouldDismissAgentDetailOnDeselect({
      previousNodeId: "n1",
      nextNodeId: null,
      panel: DETAIL
    })).toBe(true);
  });

  it("没有选择的时候不因画布回流关闭历史/活动打开的详情", () => {
    expect(shouldDismissAgentDetailOnDeselect({
      previousNodeId: null,
      nextNodeId: null,
      panel: DETAIL
    })).toBe(false);
  });

  it("换选到另一个节点时由目标节点的面板接替，不在这里收起", () => {
    expect(shouldDismissAgentDetailOnDeselect({
      previousNodeId: "n1",
      nextNodeId: "n2",
      panel: DETAIL
    })).toBe(false);
  });

  it("当前不是 Agent 详情侧栏时不影响普通执行面板", () => {
    expect(shouldDismissAgentDetailOnDeselect({
      previousNodeId: "n1",
      nextNodeId: null,
      panel: { type: "node-execution", nodeId: "n1" }
    })).toBe(false);
  });
});
