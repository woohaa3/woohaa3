/**
 * `@` 候选门禁测试。参考必须已就绪且挂槽位才允许进入候选。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { canMentionReference, changeReferences } from "./model-execution-host-helpers.js";

describe("canMentionReference（@ 候选）", () => {
  it("就绪且挂槽位可 @", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "ready" })).toBe(true);
  });

  it("其他未就绪参考不进入候选", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "pending" })).toBe(false);
    expect(canMentionReference({ slotId: "slot-1", role: "reference_video", status: "failed" })).toBe(false);
  });

  it("没有槽位不能 @", () => {
    expect(canMentionReference({ slotId: "", role: "reference_image", status: "ready" })).toBe(false);
  });
});


it("surfaces an asynchronous reference conflict without changing or retrying the command", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("refs");
  canvas.document.nodes = ["a","target"].map(id=>({id,type:"image",position:{x:0,y:0}}));
  canvas.nodeData.target = {inputMapping:[{sourceNodeId:"a",slotId:"slot-a",role:"reference_image",sortKey:"0"}]};
  canvas.document.edges = [{id:"edge-a",source:"a",target:"target",data:{}}];
  let reject!: (receipt: unknown) => void;
  const settled = new Promise(resolve=>{reject=resolve;});
  const submitCommands = vi.fn(()=>({ok:true,handle:{settled}}));
  const failure = vi.fn();
  expect(changeReferences({isWritable:()=>true,submitCommands} as never,canvas,"target",[{sourceNodeId:"a",slotId:"slot-a"}],undefined,failure)).toBe(true);
  expect(failure).not.toHaveBeenCalled();
  reject({state:"rejected",error:"参考映射已被其他操作修改"}); await Promise.resolve();
  expect(failure).toHaveBeenCalledWith("参考映射已被其他操作修改"); expect(submitCommands).toHaveBeenCalledOnce();
  expect(canvas.nodeData.target!.inputMapping).toHaveLength(1); expect(canvas.document.edges).toHaveLength(1);
  const readonlyFailure = vi.fn();
  expect(changeReferences({isWritable:()=>false} as never,canvas,"target",[],undefined,readonlyFailure)).toBe(false);
  expect(readonlyFailure).toHaveBeenCalledWith("画布当前只读，无法修改参考");
});
