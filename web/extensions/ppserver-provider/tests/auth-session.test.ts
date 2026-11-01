import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AUTH_SESSION_PATH,
  parseSessionInput,
  registerPpserverAuthSessionRoute
} from "../src/auth-session.js";
import { loadSession, sessionFilePath } from "../src/session.js";

const temps: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppserver-auth-session-"));
  temps.push(dir);
  return sessionFilePath(dir);
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, role: "authenticated" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function makeReq(url: string, method = "POST", body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  return Object.assign(stream, { url, method }) as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: Buffer[] = [];
  const state = { status: 0, body: "", headersSent: false };
  const res = {
    get headersSent() { return state.headersSent; },
    writeHead(status: number) { state.status = status; state.headersSent = true; return res; },
    write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      state.body = Buffer.concat(chunks).toString("utf8");
      return res;
    },
    on() { return res; }
  };
  return { res: res as unknown as ServerResponse, state };
}

describe("会话输入校验", () => {
  it("接受成对令牌，过期时间以 JWT 的 exp 为准", () => {
    const result = parseSessionInput(
      { accessToken: jwt(1_900_000_000), refreshToken: "r1", expiresAt: 123 },
      0
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // 前端给的 expiresAt 不可信：读得出 exp 就一律用 exp。
    expect(result.session.expiresAt).toBe(1_900_000_000_000);
    expect(result.session.refreshToken).toBe("r1");
  });

  it("不透明令牌没有 exp 时才用前端给的过期时间", () => {
    const result = parseSessionInput({ accessToken: "opaque", refreshToken: "r", expiresAt: 555 }, 0);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.session.expiresAt).toBe(555);
  });

  it("都没有时按 1 小时兜底，不猜更长的有效期", () => {
    const result = parseSessionInput({ accessToken: "opaque", refreshToken: "r" }, 1000);
    if (!result.ok) throw new Error("应当接受");
    expect(result.session.expiresAt).toBe(1000 + 3600_000);
  });

  it("缺 accessToken / 类型不对一律拒绝", () => {
    expect(parseSessionInput({ refreshToken: "r" }).ok).toBe(false);
    expect(parseSessionInput({ accessToken: "  ", refreshToken: "r" }).ok).toBe(false);
    expect(parseSessionInput({ accessToken: "a", refreshToken: 123 }).ok).toBe(false);
    expect(parseSessionInput(null).ok).toBe(false);
    expect(parseSessionInput([]).ok).toBe(false);
  });

  it("没有 refreshToken 也接受（只是过期后续不上）", () => {
    const result = parseSessionInput({ accessToken: jwt(1_900_000_000) }, 0);
    if (!result.ok) throw new Error("应当接受");
    expect(result.session.refreshToken).toBe("");
  });
});

/** 把 `ctx.effect` 直接执行，拿到路由处理函数。 */
function install(options: {
  filePath: string;
  authenticator?: (req: IncomingMessage) => Promise<unknown | null>;
  now?: () => number;
}) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | undefined;
  const errors: string[] = [];
  const written: Array<{ hasRefreshToken: boolean; expiresAt: number }> = [];
  const ctx = {
    effect: (fn: () => unknown) => { fn(); },
    gateway: { route: (_order: number, fn: typeof handler) => { handler = fn; return () => undefined; } },
    access: options.authenticator ? { authenticator: options.authenticator } : {}
  };
  registerPpserverAuthSessionRoute(ctx as never, {
    filePath: options.filePath,
    ...(options.now ? { now: options.now } : {}),
    onSessionWritten: (info) => written.push(info),
    onError: (message) => errors.push(message)
  });
  if (!handler) throw new Error("路由没有注册");
  return { handler, errors, written };
}

describe("会话投递路由", () => {
  it("写入后能用 ensureSession 的读取路径读回", async () => {
    const file = await tempFile();
    const { handler, written } = install({ filePath: file, now: () => 0 });
    const { res, state } = makeRes();

    const handled = await handler(
      makeReq(AUTH_SESSION_PATH, "POST", JSON.stringify({ accessToken: jwt(1_900_000_000), refreshToken: "r1" })),
      res
    );

    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    // 关键：**不回显令牌** —— 它会出现在调试面板与日志里。
    expect(state.body).not.toContain("refreshToken");
    expect(JSON.parse(state.body)).toMatchObject({ ok: true, expiresAt: 1_900_000_000_000 });

    expect(await loadSession(file)).toMatchObject({ refreshToken: "r1", expiresAt: 1_900_000_000_000 });
    expect(written).toHaveLength(1);
  });

  it("坏输入返回 400，且**不覆盖**已有的可用会话", async () => {
    const file = await tempFile();
    const { handler } = install({ filePath: file });
    await handler(
      makeReq(AUTH_SESSION_PATH, "POST", JSON.stringify({ accessToken: jwt(1_900_000_000), refreshToken: "keep" })),
      makeRes().res
    );

    const { res, state } = makeRes();
    await handler(makeReq(AUTH_SESSION_PATH, "POST", JSON.stringify({ refreshToken: "no-access" })), res);

    expect(state.status).toBe(400);
    // 轮换后的 refresh_token 一旦被坏值顶掉就再也续不上，所以这条很重要。
    expect((await loadSession(file))?.refreshToken).toBe("keep");
  });

  it("请求体不是 JSON 时报错但不崩", async () => {
    const file = await tempFile();
    const { handler } = install({ filePath: file });
    const { res, state } = makeRes();
    await handler(makeReq(AUTH_SESSION_PATH, "POST", "{ broken"), res);
    expect(state.status).toBe(400);
  });

  it("有认证器且未登录时 401，且不落盘", async () => {
    const file = await tempFile();
    const { handler } = install({ filePath: file, authenticator: async () => null });
    const { res, state } = makeRes();
    await handler(
      makeReq(AUTH_SESSION_PATH, "POST", JSON.stringify({ accessToken: jwt(1_900_000_000), refreshToken: "r" })),
      res
    );
    expect(state.status).toBe(401);
    expect(await loadSession(file)).toBeUndefined();
  });

  it("不属于本路径的请求交还给其它路由", async () => {
    const file = await tempFile();
    const { handler } = install({ filePath: file });
    expect(await handler(makeReq("/api/ppserver/tasks/status"), makeRes().res)).toBe(false);
  });

  it("GET 返回 405（这是一条写接口）", async () => {
    const file = await tempFile();
    const { handler } = install({ filePath: file });
    const { res, state } = makeRes();
    await handler(makeReq(AUTH_SESSION_PATH, "GET"), res);
    expect(state.status).toBe(405);
  });
});
