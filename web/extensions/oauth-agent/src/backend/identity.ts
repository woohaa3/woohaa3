/**
 * ChatGPT 授权 owner 与本地会话绑定
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.2 / design D2）。
 *
 * owner 选择规则（MUST）：
 * 1. 有应用认证时：owner = 可信认证适配器确认的 `principal.subject`。前端自报 userId、
 *    localStorage 随机 ID、管理员令牌、伪造身份头、ChatGPT ID token 的 `sub` 都 MUST NOT
 *    选择 owner。
 * 2. 无登录体系的**纯本地开发**姿态：后端生成高熵随机会话 ID，经 HttpOnly cookie 签发并
 *    用服务端派生密钥验证真实性/有效期。它只隔离浏览器会话；同一浏览器配置文件中的不同自然人
 *    共用授权，不构成真正应用用户隔离。
 * 3. 公网部署缺少可信认证时：拒绝个人授权与生成（不启用匿名 fallback）。
 */
import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CHATGPT_SESSION_COOKIE = "woohaa3-chatgpt-session";
/** 本地会话 cookie 最长有效期（30 天）。 */
const LOCAL_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type OwnerKind = "principal" | "local-session";

export type ResolvedOwner = {
  ok: true;
  /** 凭据 owner：principal.subject 或后端生成的本地会话 id。 */
  ownerId: string;
  ownerKind: OwnerKind;
  /** 需要下发的 Set-Cookie（仅新建本地会话时）。 */
  setCookie?: string;
  /** 本地会话模式（供文案提示）。 */
  localSession: boolean;
};

export type OwnerResolutionFailure = {
  ok: false;
  code: "unauthenticated" | "anonymous-fallback-disabled" | "not-configured";
  message: string;
  status: number;
};

export type OwnerResolution = ResolvedOwner | OwnerResolutionFailure;

export type OwnerResolverOptions = {
  /** 是否配置了可信应用认证适配器。 */
  authConfigured: boolean;
  /** 从请求解析可信 principal.subject；未认证返回 null。 */
  resolvePrincipalSubject: (req: IncomingMessage) => string | null;
  /**
   * 是否处于公网姿态（拒绝匿名 fallback）。缺省 false（本地）。
   * 由部署配置推导：配置了非 loopback 回调 origin 即为公网。
   */
  publicPosture: boolean;
  /** 是否允许本地开发会话 fallback。 */
  allowLocalSession: boolean;
  /** 服务端派生会话签名密钥（重启稳定）。 */
  sessionSecret: Buffer;
  /** 是否 HTTPS（决定 Secure cookie 属性）。 */
  secure: boolean;
  /**
   * 当前公开挂载路径（change: 2026-10-15-support-configurable-app-base-path）。
   * 根挂载保持既有 cookie 名称与 `Path=/`；子挂载使用确定性名称后缀与挂载 Path，
   * 且读取/新建/清除使用同一名称与 Path。
   */
  basePath?: string;
  now?: () => number;
};

export type OwnerResolver = {
  resolve: (req: IncomingMessage) => OwnerResolution;
  /**
   * 由**显式输入**解析 owner（不依赖请求对象）：宿主在其它路由（如画布「转为片场」的 HTTP
   * 边界）已解析出可信主体并持有 Cookie 头时，复用**同一规则**解析 owner，保证与
   * `/api/oauth-agent/*` 的姿态完全一致（生产 principal、本地受控会话、公网拒绝匿名）。
   */
  resolveFor: (input: { subject?: string | null; cookie?: string | null }) => OwnerResolution;
  /** 清除本地会话 cookie 的 Set-Cookie 值。 */
  clearSessionCookie: () => string;
};

function sign(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key !== "") out[key] = value;
  }
  return out;
}

/**
 * 构造会话 resolver。会话签名密钥必须由部署派生且重启稳定（例如 HMAC(masterKey, label)）。
 */
export function createOwnerResolver(options: OwnerResolverOptions): OwnerResolver {
  const now = options.now ?? (() => Date.now());
  // 挂载路径决定 cookie 名称与 Path：根挂载保持既有标识；子挂载用确定性后缀，避免同站点
  // 不同挂载之间的会话相互串用。读取/新建/清除都使用同一 name/path。
  const basePath = options.basePath && options.basePath !== "/" ? options.basePath : "/";
  const sessionCookieName = basePath === "/" ? CHATGPT_SESSION_COOKIE : `${CHATGPT_SESSION_COOKIE}${basePath.slice(0, -1).replace(/\//g, "-")}`;
  const cookiePath = basePath;
  const cookieAttributes = ["HttpOnly", "SameSite=Lax", `Path=${cookiePath}`, `Max-Age=${Math.floor(LOCAL_SESSION_MAX_AGE_MS / 1000)}`];
  if (options.secure) cookieAttributes.push("Secure");

  const buildCookie = (token: string): string => `${sessionCookieName}=${token}; ${cookieAttributes.join("; ")}`;

  const newToken = (): string => {
    const id = randomBytes(32).toString("base64url");
    const issuedAt = now();
    const value = `${id}.${issuedAt}`;
    return `${value}.${sign(options.sessionSecret, value)}`;
  };

  const verifyToken = (token: string): { id: string } | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [id, issuedAtRaw, signature] = parts as [string, string, string];
    if (id === "" || issuedAtRaw === "" || signature === "") return null;
    const value = `${id}.${issuedAtRaw}`;
    if (!safeEqual(sign(options.sessionSecret, value), signature)) return null;
    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt)) return null;
    const age = now() - issuedAt;
    if (age < -60_000 || age > LOCAL_SESSION_MAX_AGE_MS) return null;
    return { id };
  };

  return {
    clearSessionCookie: () => `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=${cookiePath}; Max-Age=0${options.secure ? "; Secure" : ""}`,
    resolve(req) {
      return resolveFrom(options.authConfigured ? options.resolvePrincipalSubject(req) : null, req.headers.cookie);
    },
    resolveFor(input) {
      return resolveFrom(input.subject ?? null, input.cookie ?? undefined);
    }
  };

  /** owner 解析核心：可信主体（生产）或受控本地会话（本地开发）；公网缺认证一律拒绝。 */
  function resolveFrom(subject: string | null, cookieHeader: string | undefined): OwnerResolution {
    // 1. 有应用认证：principal.subject 是唯一 owner。
    if (options.authConfigured) {
      if (subject && subject.trim() !== "") {
        return { ok: true, ownerId: `principal:${subject}`, ownerKind: "principal", localSession: false };
      }
      return {
        ok: false,
        code: "unauthenticated",
        message: "需要应用登录后才能授权个人 ChatGPT",
        status: 401
      };
    }
    // 3. 公网缺少可信认证：拒绝匿名 fallback。
    if (options.publicPosture) {
      return {
        ok: false,
        code: "anonymous-fallback-disabled",
        message: "公网部署未配置可信用户认证，个人 ChatGPT 授权不可用",
        status: 403
      };
    }
    // 2. 本地开发：使用/签发服务端 HttpOnly 会话。
    if (!options.allowLocalSession) {
      return {
        ok: false,
        code: "not-configured",
        message: "未启用个人 ChatGPT 授权（需要部署配置凭据目录与本地会话允许）",
        status: 503
      };
    }
    const cookies = parseCookies(cookieHeader);
    const existing = cookies[sessionCookieName];
    if (existing) {
      const verified = verifyToken(existing);
      if (verified) {
        return { ok: true, ownerId: `local:${verified.id}`, ownerKind: "local-session", localSession: true };
      }
    }
    const token = newToken();
    const verified = verifyToken(token)!;
    return {
      ok: true,
      ownerId: `local:${verified.id}`,
      ownerKind: "local-session",
      localSession: true,
      setCookie: buildCookie(token)
    };
  }
}

/** 由主密钥派生重启稳定的会话签名密钥。 */
export function deriveSessionSecret(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("woohaa3-chatgpt-session-v1").digest();
}
