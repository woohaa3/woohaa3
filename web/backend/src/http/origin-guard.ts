/**
 * 浏览器写请求的 Origin/CSRF 判定
 * （change: 2026-10-13-add-enterprise-access-and-production-production，任务 2.4 / design D7）。
 *
 * 规则（在进入任何领域 handler **之前**执行，只读 header，不读 body）：
 * - 安全方法（GET/HEAD/OPTIONS）不做 Origin 校验；
 * - 无 `Origin` 头：视为非浏览器/服务端调用（浏览器跨站写请求一定带 Origin），放行；
 * - 有 `Origin`：必须命中部署允许列表，或与本次请求的 Host（优先 `x-forwarded-host`）同源。
 *
 * 目的：身份经网关后，浏览器写请求仍需阻挡跨站伪造（CSRF）。同源兜底不需要额外配置即可生效；
 * 允许列表用于显式放行多域名部署。绝不把 header 当身份，也不因 loopback 放行。
 */
import type { IncomingMessage } from "node:http";

export type OriginGuardResult = { ok: true } | { ok: false; status: 403; code: string; message: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function hostOf(req: IncomingMessage): string {
  // 优先可信 ingress 注入的原始 Host；回退到直连 Host。
  const forwarded = headerValue(req.headers["x-forwarded-host"]).trim();
  return (forwarded !== "" ? forwarded : headerValue(req.headers["host"]).trim()).toLowerCase();
}

/**
 * 构造 Origin 守卫。`allowedOrigins` 为归一化 origin（`scheme://host[:port]`）。
 */
export function createOriginGuard(allowedOrigins: readonly string[] = []): (req: IncomingMessage) => OriginGuardResult {
  const allowed = new Set(allowedOrigins);
  return (req: IncomingMessage): OriginGuardResult => {
    const method = (req.method ?? "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) return { ok: true };
    const raw = headerValue(req.headers.origin).trim();
    if (raw === "") return { ok: true };
    if (allowed.has(raw)) return { ok: true };
    let originHost: string;
    try {
      originHost = new URL(raw).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, code: "invalid-origin", message: "请求 Origin 无效" };
    }
    const host = hostOf(req);
    if (host !== "" && originHost === host) return { ok: true };
    return { ok: false, status: 403, code: "invalid-origin", message: "请求 Origin 无效" };
  };
}
