/**
 * 换版窗口拦截路由（C 方向：进程内热切换）。
 *
 * 热切换是「先卸后装」：撤旧 fiber 到新版本装配完成之间，该扩展注册的路由与 Provider 都不存在。
 * 这段时间的请求如果直接落到下游，会变成 404（被读成「扩展不存在」这种永久失败）；这里先答
 * `extension-reloading` + `Retry-After`，把「短暂空窗」和「真的没有」区分开。
 *
 * 只认 `/api/extensions/<id>/...`，且只有该扩展正在换版时才拦截，其余一律交下游。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { isSwapping } from "./swap-registry.js";

/** 建议调用方的重试间隔（毫秒）；与 `Retry-After` 秒数保持一致。 */
export const RELOADING_RETRY_AFTER_MS = 2000;

export function createReloadingHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    const match = /^\/api\/extensions\/([^/]+)\//.exec(pathname);
    if (!match) return false;
    let extensionId: string;
    try {
      extensionId = decodeURIComponent(match[1]!);
    } catch {
      return false;
    }
    if (!isSwapping(extensionId)) return false;
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(RELOADING_RETRY_AFTER_MS / 1000)
    });
    res.end(
      JSON.stringify({
        code: "extension-reloading",
        message: `扩展 ${extensionId} 正在换版，请稍后重试`,
        retryAfterMs: RELOADING_RETRY_AFTER_MS
      })
    );
    return true;
  };
}
