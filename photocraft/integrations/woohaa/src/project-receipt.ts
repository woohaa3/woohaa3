/** 回执丢失时查询权威状态；prepared 用原请求续作，历史补登复用同一 requestId。 */
import type { ImageEditCompleteRequest } from "@woohaa3/contracts";
import type { EditCompleteResult } from "@woohaa3/frontend/plugin-api";

export type ProjectReceiptPort = {
  complete: (request: ImageEditCompleteRequest) => Promise<EditCompleteResult>;
  status?: (request: Pick<ImageEditCompleteRequest, "canvasId" | "nodeId" | "requestId">) => Promise<EditCompleteResult>;
};

export async function settleProjectReceipt(request: ImageEditCompleteRequest, port: ProjectReceiptPort): Promise<EditCompleteResult> {
  const unavailable = (): EditCompleteResult => ({ ok: false, code: "unconfirmed", error: "暂时无法确认保存结果，请重试确认；当前编辑已保留" });
  const validate = (result: EditCompleteResult): EditCompleteResult => {
    const receipt = result.receipt;
    if (receipt && (receipt.canvasId !== request.canvasId || receipt.nodeId !== request.nodeId || receipt.requestId !== request.requestId
      || receipt.sessionId !== request.sessionId || receipt.kind !== "image")) return unavailable();
    if (result.ok && receipt && (receipt.status === "completed" || receipt.status === "history-pending") && !receipt.contentCommitted) return unavailable();
    return result;
  };
  const complete = () => port.complete(request).then(validate).catch(unavailable);
  const status = () => port.status?.(request).then(validate).catch(unavailable);
  let result = await complete();
  if (!port.status) return result;
  // 明确冲突或拒绝不自动重提，避免掩盖服务端错误。
  if (!result.ok && result.receipt && result.receipt.status !== "prepared") return result;
  if (!result.ok || result.receipt.status === "prepared") {
    const checked = await status();
    if (checked?.ok) {
      result = checked;
      if (checked.receipt.status === "prepared") result = await complete();
    } else if (checked?.code === "EDIT_SESSION_NOT_FOUND") {
      result = await complete();
    } else if (checked && (checked.receipt || checked.code === "EDIT_SESSION_CONFLICT" || checked.code === "EDIT_SESSION_BASELINE_STALE")) {
      result = checked;
    }
  }
  if (result.ok && result.receipt.status === "history-pending") {
    const checked = await status();
    if (checked?.ok && checked.receipt.contentCommitted && (checked.receipt.status === "completed" || checked.receipt.status === "history-pending")) result = checked;
  }
  return result;
}
