/**
 * Canvas 可信主体解析桥（Backend 侧）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 3.6 / design D4；
 *   change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.2/4.8：
 *   旧的同步 `AccessService.resolveCanvasSubject` 已删除，改接统一**异步**
 *   `ApplicationRequestAuthenticator`（由必需 identity provider，或本地单实例的实例 owner 支撑）。
 *
 * Canvas 的 prepare/status/来源目录/片场转 owner 等面必须用**宿主建立**的主体，绝不信任
 * 请求 body 的 staffId/ownerId。未认证返回 null，调用方据此 fail-closed。
 */
import type { IncomingMessage } from "node:http";
import type { ApplicationRequestAuthenticator } from "@woohaa3/application-service";

export function createCanvasSubjectResolver(
  auth: ApplicationRequestAuthenticator
): (req: IncomingMessage) => Promise<string | null> {
  return async (req) => {
    const principal = await auth(req, "http");
    return principal ? principal.subject : null;
  };
}
