import type { GameFurnaceState } from "../shared/index.js";

export type GameFurnaceRemote = {
  saveProject(input: { canvasId: string; nodeId: string; state: GameFurnaceState }): Promise<GameFurnaceRemoteResult<{ projectStorageKey: string; inputHash: string; state?: GameFurnaceState }>>;
  openProject(input: { canvasId: string; nodeId: string; projectStorageKey: string }): Promise<GameFurnaceRemoteResult<{ projectStorageKey: string; inputHash: string; state: GameFurnaceState }>>;
  collectResources(input: { canvasId: string; nodeId: string; operations: readonly import("@woohaa3/contracts").Woohaa3CanvasJsonObject[]; collectionId?: string; expectedProjectStorageKey?: string; sourceSnapshots?: readonly { nodeId: string; data: import("@woohaa3/contracts").Woohaa3CanvasJsonObject }[] }): Promise<GameFurnaceRemoteResult<{ projectStorageKey: string; inputHash: string }>>;
  generate(input: { canvasId: string; nodeId: string; expectedInputHash: string; supportedInputs?: readonly { mediaKinds: readonly string[]; mediaTypes: readonly string[] }[] }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  finalize(input: { canvasId: string; nodeId: string; generationId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  cancel(input: { canvasId: string; nodeId: string; generationId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  activateBuild(input: { canvasId: string; nodeId: string; buildId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  previewOpen(input: { canvasId: string; nodeId: string; buildId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  previewDescribe(input: { sessionId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  previewClose(input: { sessionId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
  /** 目标节点删除时通知后端取消/脱离在途任务（任务 6.10）。 */
  detachTarget(input: { canvasId: string; nodeId: string }): Promise<GameFurnaceRemoteResult<Record<string, unknown>>>;
};

/** 稳定结果：成功携带业务正文；失败携带 code 与安全消息。 */
export type GameFurnaceRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export function remoteFailureMessage(result: { code: string; message: string }): string {
  const known: Record<string, string> = {
    unauthorized: "请求未通过认证，请检查登录或本地开发配置",
    "not-found": "项目不存在或已被删除",
    conflict: "输入已变化，请先保存最新素材/需求",
    unavailable: "无法连接服务，请稍后重试",
    invalid: "请求被拒绝",
    "unsupported-version": "项目版本不受支持，原件已保留",
    "content-conflict": "素材内容或项目已变化，请重新收集",
    "target-missing": "炼丹炉节点已被删除或停用"
  };
  return known[result.code] ?? "操作失败";
}
