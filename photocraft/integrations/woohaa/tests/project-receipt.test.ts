import { expect, it, vi } from "vitest";
import type { ImageEditCompleteRequest } from "@woohaa3/contracts";
import type { EditCompleteResult } from "@woohaa3/frontend/plugin-api";
import { settleProjectReceipt } from "../src/project-receipt.js";

const request = { canvasId: "c", nodeId: "n", sessionId: "s", requestId: "r", kind: "image" } as ImageEditCompleteRequest;
function result(status: "prepared" | "history-pending" | "completed" = "completed"): EditCompleteResult {
  return { ok: true, receipt: { ...request, status, contentCommitted: status !== "prepared", contentIdentity: "content", entryId: "entry", revision: 2 } };
}

it("complete 回执丢失后查询权威状态，不重复提交", async () => {
  const complete = vi.fn(async () => { throw new Error("offline"); });
  const status = vi.fn(async () => result());
  expect(await settleProjectReceipt(request, { complete, status })).toEqual(result());
  expect(complete).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce();
});

it.each(["prepared", "missing"])("%s 用原请求续作，历史待登记再查询补登", async (state) => {
  const complete = vi.fn().mockResolvedValueOnce(result("prepared")).mockResolvedValueOnce(result("history-pending"));
  const status = vi.fn().mockResolvedValueOnce(state === "prepared" ? result("prepared") : { ok: false, code: "EDIT_SESSION_NOT_FOUND", error: "missing" }).mockResolvedValueOnce(result());
  expect(await settleProjectReceipt(request, { complete, status })).toEqual(result());
  expect(complete.mock.calls).toEqual([[request], [request]]);
  expect(status).toHaveBeenCalledTimes(2);
});

it("status 的明确冲突不能被网络异常掩盖或自动重提", async () => {
  const conflict = { ok: false as const, code: "EDIT_SESSION_BASELINE_STALE", error: "内容已改变" };
  const complete = vi.fn(async () => { throw new Error("offline"); });
  expect(await settleProjectReceipt(request, { complete, status: async () => conflict })).toEqual(conflict);
  expect(complete).toHaveBeenCalledOnce();
});

it("其他会话的回执和未提交的终态不能推进基线", async () => {
  for (const patch of [{ nodeId: "other" }, { requestId: "other" }, { sessionId: "other" }, { contentCommitted: false }]) {
    const complete = async () => { const value = result(); return value.ok ? { ...value, receipt: { ...value.receipt, ...patch } } : value; };
    expect(await settleProjectReceipt(request, { complete })).toMatchObject({ ok: false, code: "unconfirmed" });
  }
});
