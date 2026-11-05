/**
 * 进程内契约适配器
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 2.1 / design D2）。
 *
 * 把各模块暴露的 `Backend*Port` 适配成调用方历史上期望的窄接口形状：
 * - Task 模块的 `BackendTaskPort` → Canvas 的 `CanvasTaskClient`
 * - Media 模块的 `BackendMediaPort` → Canvas 的 `CanvasMediaClient`
 * - Media 模块的 `BackendMediaPort` → Task 的 `MediaClient`
 * - Canvas MCP 服务 → MCP 模块的 `CanvasMcpClient` / `AgentCanvasClient`
 *
 * 这些适配器只在后端进程内使用，不含任何 HTTP/WS、服务令牌或 transport retry。
 */
import type {
  BackendMediaPort,
  BackendTaskPort
} from "@woohaa3/contracts";
import type { CanvasTaskClient } from "@woohaa3/canvas-service";
import type { CanvasMediaClient } from "@woohaa3/canvas-service";
import type { MediaClient } from "@woohaa3/task-service";
import type { MediaMetadata } from "@woohaa3/contracts";

/** BackendTaskPort → CanvasTaskClient（Canvas 模块运行期直接调用 Task 领域方法）。 */
export function taskPortToCanvasTaskClient(port: BackendTaskPort): CanvasTaskClient {
  return {
    submit: (request) => port.submit(request as never),
    cancel: (workerTaskKey) => port.cancel(workerTaskKey),
    status: (workerTaskKey) => port.status(workerTaskKey),
    history: (query) => port.history(query),
    canvasActivity: (canvasId, query) => port.canvasActivity(canvasId, query),
    canvasActivitySince: (canvasId, after, limit) => port.canvasActivitySince(canvasId, after, limit),
    canvasActivityChanges: (canvasId, after, limit) => port.canvasActivityChanges(canvasId, after, limit)
  };
}

/** BackendMediaPort → CanvasMediaClient（固定资源读取与核验，保留画布作用域）。 */
export function mediaPortToCanvasMediaClient(port: BackendMediaPort): CanvasMediaClient {
  const resources = port.resources;
  return {
    ...(resources ? { read: (storageKey: string, canvasId?: string) => resources.read(storageKey, canvasId) } : {}),
    verify: (storageKey, expected, scope) => port.verify(storageKey, expected, scope)
  };
}

/** BackendMediaPort → Task MediaClient（verify/sign/import/import-bytes）。 */
export function mediaPortToTaskMediaClient(port: BackendMediaPort): MediaClient {
  return {
    // scope 必须透传：远端生成的结果对象在**画布作用域**下（服务端写的
    // `<canvasId>/media/<key>`）。丢了 scope 会按无作用域去读，键变成 `media/<key>`，
    // 直接落到主存储/错误路径，把一个已经成功生成的对象报成「核验失败」。
    // 任务侧 scope 的 canvasId 可缺省；port 侧要求有值，因此只在真的有画布时传。
    verify: (storageKey, expected, scope) =>
      port.verify(storageKey, expected, scope?.canvasId ? { canvasId: scope.canvasId } : undefined),
    sign: (storageKey, expiresSeconds, scope) => port.sign(storageKey, expiresSeconds, scope),
    // import 的 canvasId 在 input 里：原样转给媒体模块，由它交给存储层做画布路由。
    importFromUrl: (input) => port.importFromUrl(input),
    importBytes: (input) => port.importBytes(input),
    importFromLocator: (input) => port.importFromLocator(input)
  };
}

export type { MediaMetadata };
