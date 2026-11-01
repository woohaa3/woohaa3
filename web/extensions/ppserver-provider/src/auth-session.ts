/**
 * 登录后的**会话投递**路由。
 *
 * 为什么需要它：令牌来源要从「配置里手填」换成「用户自己登录」。登录发生在**前端**
 * （四喜界面里调 Authing），而 Supabase 会话文件在**宿主进程**的扩展数据目录里，
 * 前端没有文件系统权限。所以前端登录成功后把 access + refresh 投递给这里，
 * 由宿主写盘 —— 之后 `ensureSession` 就能照常续期，用户下次启动也不用重登。
 *
 * 与 `routes.ts` 的区别：那条是「借宿主的令牌花钱」，这条是「把令牌交给宿主」。
 * 两条都在本机同源后面，信任档位一致：有认证器就要求 principal，没有就按本机可信放行。
 * **它不转发任何上游请求**，也不返回令牌内容 —— 只回报「收了 / 过期时间」。
 *
 * 为什么要拒绝空 refresh_token 以外的怪值：Supabase 刷新是**轮换**的，
 * 写进去一个坏的 refresh_token 会把原本能用的会话顶掉（`ensureSession` 优先读磁盘），
 * 用户表现为「登录完反而续不上了」。所以校验宁可紧：格式不对就整体拒绝、不落盘。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostExtensionContext } from "@woohaa3/contracts";
import { readExpiry, saveSession, type StoredSession } from "./session.js";

/** 前缀与任务转发共用 `/api/ppserver/` 这一层，只是挂在 `auth/` 下面。 */
export const AUTH_SESSION_PATH = "/api/ppserver/auth/session";

/**
 * 模板目录（只读）。
 *
 * 为什么不让前端去读宿主的 `/api/generation-models`：那张表是全宿主的模型目录，
 * 里面有十几个 Provider，前端要自己筛，而且路径在 `/api/ppserver/` 之外 ——
 * 扩展部署在别的 basePath 下时拼不出来。这里直接给「本 Provider 能跑的模板」，
 * 前端不用知道宿主的目录结构。
 */
export const TEMPLATES_PATH = "/api/ppserver/templates";

export type TemplateSummary = {
  templateId: string;
  title: string;
  kind: string;
  category?: string;
  /** 模板表里的 `cost_coins`。**未必是真实扣费**：实测有的模板标 0、实际扣 32。 */
  cost?: number;
};

/** 访问令牌的上限。JWT 通常 1~2 KB，留足余量但不接受任意大字符串。 */
const MAX_TOKEN_LENGTH = 8192;

/** 没给 `expiresAt`、也从 JWT 里读不到 `exp` 时的兜底有效期（Supabase 默认 1 小时）。 */
const DEFAULT_TTL_MS = 3600_000;

type RouteRuntime = {
  gateway: {
    route(order: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>): () => void;
  };
  access: {
    authenticator?: (req: IncomingMessage, transport?: "http" | "ws" | "mcp") => Promise<unknown | null>;
  };
};

export type ParsedSessionInput =
  | { ok: true; session: StoredSession }
  | { ok: false; message: string };

/**
 * 校验并规范化前端投来的会话。
 *
 * **不信任 `expiresAt`**：前端时钟可能偏，优先用 JWT 自带的 `exp`；
 * 前端给的只在读不出 `exp`（不透明令牌）时才用。
 */
export function parseSessionInput(payload: unknown, now = Date.now()): ParsedSessionInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "请求体必须是会话对象" };
  }
  const record = payload as Record<string, unknown>;

  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  if (!accessToken) return { ok: false, message: "缺少 accessToken" };
  if (accessToken.length > MAX_TOKEN_LENGTH) return { ok: false, message: "accessToken 过长" };

  const rawRefresh = record.refreshToken;
  if (rawRefresh !== undefined && typeof rawRefresh !== "string") {
    return { ok: false, message: "refreshToken 必须是字符串" };
  }
  const refreshToken = typeof rawRefresh === "string" ? rawRefresh.trim() : "";
  if (refreshToken.length > MAX_TOKEN_LENGTH) return { ok: false, message: "refreshToken 过长" };

  const jwtExpiry = readExpiry(accessToken);
  const supplied = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : undefined;
  const expiresAt = jwtExpiry ?? supplied ?? now + DEFAULT_TTL_MS;

  return { ok: true, session: { accessToken, refreshToken, expiresAt } };
}

export type RegisterAuthSessionRouteOptions = {
  /** 会话文件（`sessionFilePath(...)` 的结果）。 */
  filePath: string;
  order?: number;
  now?: () => number;
  /** 落盘失败 / 成功都经过它记日志，不记录令牌内容。 */
  onSessionWritten?: (info: { hasRefreshToken: boolean; expiresAt: number }) => void;
  onError?: (message: string) => void;
  /**
   * 当前可跑的模板。**是函数不是数组**：目录在登录后会被异步刷新，
   * 构造时传一份副本的话，刷新完这条路由返回的还是旧目录（甚至空目录）。
   */
  templates?: () => TemplateSummary[];
};

/**
 * 注册两条只读/写入路由：
 * - `POST /api/ppserver/auth/session`：写入登录会话。成功返回 `{ ok: true, expiresAt }`，
 *   **不回显任何令牌**，避免它出现在日志或调试面板里；
 * - `GET /api/ppserver/templates`：本 Provider 当前能跑的模板（调试台用它选模板）。
 */
export function registerPpserverAuthSessionRoute(
  ctx: HostExtensionContext,
  options: RegisterAuthSessionRouteOptions
): void {
  const runtime = ctx as unknown as RouteRuntime;
  const now = options.now ?? (() => Date.now());

  ctx.effect(() =>
    runtime.gateway.route(options.order ?? 23, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      // 两条路由挂在同一个 handler 上：会话写入与模板目录。都不是本前缀就交回去。
      if (pathname !== AUTH_SESSION_PATH && pathname !== TEMPLATES_PATH) return false;

      if (runtime.access?.authenticator) {
        const principal = await runtime.access.authenticator(req, "http").catch(() => null);
        if (!principal) {
          writeJson(res, 401, { ok: false, message: "需要登录" });
          return true;
        }
      }

      if (pathname === TEMPLATES_PATH) {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, message: "只支持 GET" });
          return true;
        }
        writeJson(res, 200, { templates: options.templates?.() ?? [] });
        return true;
      }

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          // 读 body 抛错（坏 JSON / 超限）必须在这里接住：让 handler 的 Promise 拒绝
          // 会让网关只记一条未处理异常，前端拿到的是连接中断而不是可读的 400。
          writeJson(res, 400, { ok: false, message: error instanceof Error ? error.message : "请求体读取失败" });
          return true;
        }
        const parsed = parseSessionInput(body, now());
        if (!parsed.ok) {
          writeJson(res, 400, { ok: false, message: parsed.message });
          return true;
        }
        try {
          // **先落盘再回成功**：前端据此认为「令牌已交给宿主」，
          // 写失败却回 200 会让它以为续期已经可用。
          await saveSession(options.filePath, parsed.session);
          options.onSessionWritten?.({
            hasRefreshToken: parsed.session.refreshToken !== "",
            expiresAt: parsed.session.expiresAt
          });
          writeJson(res, 200, { ok: true, expiresAt: parsed.session.expiresAt });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.onError?.(message);
          writeJson(res, 500, { ok: false, message: `会话写入失败：${message}` });
        }
        return true;
      }

      writeJson(res, 405, { ok: false, message: "只支持 POST" });
      return true;
    })
  );
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // 会话只有两个令牌，64 KB 已经非常宽裕。
      if (size > 64 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}
