/**
 * 内容路由的纯分派（change: 2026-10-28-generic-extension-content-ownership，任务 5.1）。
 *
 * 宿主只负责 `/content/<extensionId>/...`、鉴权、body 上限与超时；路径匹配、业务处理与
 * 稳定状态码由 owner 声明。冲突在注册表注册时拒绝，运行期不会出现覆盖。
 */
import type { ContentContributionResolver, ContentRouteResult } from "./content-contribution.js";

export type ContentRouteResolution =
  | { readonly ok: true; readonly result: ContentRouteResult }
  | { readonly ok: false; readonly status: 404 | 409 | 500; readonly code: string };

export async function dispatchContentRoute(
  content: ContentContributionResolver | undefined,
  extensionId: string,
  method: string,
  path: readonly string[],
  body: unknown
): Promise<ContentRouteResolution> {
  const owner = content?.resolve(extensionId);
  if (!owner) return { ok: false, status: 404, code: "content-route-not-found" };
  const route = owner.routes?.find((entry) =>
    entry.method.toUpperCase() === method.toUpperCase() && entry.path.length === path.length
    && entry.path.every((segment, index) => segment === path[index])
  );
  if (!route) return { ok: false, status: 404, code: "content-route-not-found" };
  try {
    const result = await route.handle({ body });
    if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
      return { ok: false, status: 500, code: "content-route-invalid-result" };
    }
    return { ok: true, result };
  } catch {
    return { ok: false, status: 500, code: "content-route-failed" };
  }
}
