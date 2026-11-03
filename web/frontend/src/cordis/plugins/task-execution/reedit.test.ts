import { afterEach, describe, expect, it, vi } from "vitest";
import { reeditFromSnapshot } from "./reedit.js";
import { nodeDraftStore } from "./drafts.js";
import { consumeDockExpand, resetDockExpandRequests } from "./dock-expand-request.js";

afterEach(() => {
  resetDockExpandRequests();
  nodeDraftStore.clear("img", "ppserver:m1");
});

function fakeCtx(options: { writable?: boolean; ok?: boolean } = {}) {
  const submitCommands = vi.fn(() => ({ ok: options.ok ?? true }));
  const selectNode = vi.fn(() => true);
  return {
    submitCommands,
    selectNode,
    ctx: {
      canvasSession: { isWritable: () => options.writable ?? true, submitCommands },
      canvasRuntime: { controller: () => ({ selectNode }) }
    } as never
  };
}

const snapshot = {
  prompt: "变成夜景",
  modelKey: "ppserver:m1",
  parameters: { size: "2K", model: "ppserver:m1" },
  references: [],
  selfReferenceAssetId: "asset-1"
};

describe("reeditFromSnapshot", () => {
  it("提示词与参数进草稿（去掉 run 补的 model），模型与主图写节点数据，展开并选中", () => {
    const { ctx, submitCommands, selectNode } = fakeCtx();
    expect(reeditFromSnapshot(ctx, "img", snapshot)).toBe(true);
    expect(nodeDraftStore.get("img", "ppserver:m1")).toEqual({ prompt: "变成夜景", parameters: { size: "2K" } });
    const commands = JSON.stringify(submitCommands.mock.calls[0]);
    expect(commands).toContain("selfReferenceAssetId");
    expect(commands).toContain("asset-1");
    expect(commands).toContain("ppserver:m1");
    expect(selectNode).toHaveBeenCalledWith("img");
    expect(consumeDockExpand("img")).toBe(true);
  });

  it("当时没有自带主图：写空串清掉现在的", () => {
    const { ctx, submitCommands } = fakeCtx();
    reeditFromSnapshot(ctx, "img", { prompt: "x", references: [] });
    expect(JSON.stringify(submitCommands.mock.calls[0])).toContain('"selfReferenceAssetId":""');
  });

  it("只读画布或命令被拒：不展开、不选中", () => {
    const readonly = fakeCtx({ writable: false });
    expect(reeditFromSnapshot(readonly.ctx, "img", snapshot)).toBe(false);
    expect(readonly.submitCommands).not.toHaveBeenCalled();
    const rejected = fakeCtx({ ok: false });
    expect(reeditFromSnapshot(rejected.ctx, "img", snapshot)).toBe(false);
    expect(rejected.selectNode).not.toHaveBeenCalled();
    expect(consumeDockExpand("img")).toBe(false);
  });
});
