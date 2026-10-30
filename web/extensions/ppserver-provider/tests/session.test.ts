import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearSession,
  ensureSession,
  interpretRefreshResponse,
  loadSession,
  needsRefresh,
  readExpiry,
  saveSession,
  sessionFilePath,
  type StoredSession
} from "../src/session.js";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppserver-session-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** 造一个形如 JWT 的令牌，`exp` 用作过期时间断言。 */
function jwt(expSeconds: number, mark = "a"): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, role: "authenticated" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-${mark}`;
}

describe("会话存储", () => {
  it("能从 JWT 里读出 exp", () => {
    expect(readExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(readExpiry("not-a-jwt")).toBeUndefined();
    expect(readExpiry("a.b")).toBeUndefined();
  });

  it("到期前 60 秒就该刷新", () => {
    const now = 1_000_000;
    expect(needsRefresh({ accessToken: "x", refreshToken: "y", expiresAt: now + 30_000 }, now)).toBe(true);
    expect(needsRefresh({ accessToken: "x", refreshToken: "y", expiresAt: now + 300_000 }, now)).toBe(false);
  });

  it("写入后能读回，坏文件当作没有", async () => {
    const file = sessionFilePath(await tempDir());
    const session: StoredSession = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
    await saveSession(file, session);
    expect(await loadSession(file)).toEqual(session);

    await fs.writeFile(file, "{ broken");
    expect(await loadSession(file)).toBeUndefined();

    await clearSession(file);
    expect(await loadSession(file)).toBeUndefined();
  });

  it("清掉后重复清除不报错", async () => {
    const file = sessionFilePath(await tempDir());
    await expect(clearSession(file)).resolves.toBeUndefined();
  });
});

describe("刷新响应解读", () => {
  it("取 access/refresh 与过期时间", () => {
    const session = interpretRefreshResponse(
      { access_token: jwt(1_900_000_000), refresh_token: "r2", expires_in: 3600 },
      0
    );
    expect(session?.refreshToken).toBe("r2");
    expect(session?.expiresAt).toBe(1_900_000_000_000);
  });

  it("缺 access_token 返回 undefined，不编造", () => {
    expect(interpretRefreshResponse({ refresh_token: "r" })).toBeUndefined();
    expect(interpretRefreshResponse(null)).toBeUndefined();
  });

  it("没有 exp 时退回 expires_in", () => {
    const session = interpretRefreshResponse({ access_token: "opaque", refresh_token: "r", expires_in: 120 }, 1000);
    expect(session?.expiresAt).toBe(1000 + 120_000);
  });
});

describe("ensureSession", () => {
  it("未到期的持久化会话直接用，不发请求", async () => {
    const file = sessionFilePath(await tempDir());
    const session = { accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
    await saveSession(file, session);
    const fetchImpl = vi.fn();
    const result = await ensureSession({ supabaseUrl: "https://pp.test", anonKey: "k", filePath: file, fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: true, refreshed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("临到期时刷新，并把新 refresh_token 落盘", async () => {
    const file = sessionFilePath(await tempDir());
    await saveSession(file, { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() + 1000 });
    const next = jwt(Math.floor(Date.now() / 1000) + 3600, "new");
    const requests: Array<{ url: string; body?: string; apikey?: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        apikey: new Headers(init?.headers).get("apikey")
      });
      return Response.json({ access_token: next, refresh_token: "r2", expires_in: 3600 });
    });

    const result = await ensureSession({
      supabaseUrl: "https://pp.test/supabase/p1",
      anonKey: "anon",
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, refreshed: true });
    expect(requests[0]?.url).toBe("https://pp.test/supabase/p1/auth/v1/token?grant_type=refresh_token");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ refresh_token: "r1" });
    expect(requests[0]?.apikey).toBe("anon");
    // 关键：轮换后的 refresh_token 必须落盘，否则下次续不上。
    expect((await loadSession(file))?.refreshToken).toBe("r2");
  });

  it("刷新失败但旧令牌还没过期时继续用它", async () => {
    const file = sessionFilePath(await tempDir());
    // 已进入刷新窗口（60 秒内），但还没真正过期。
    await saveSession(file, { accessToken: "still-good", refreshToken: "r1", expiresAt: Date.now() + 30_000 });
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const errors: string[] = [];
    const result = await ensureSession({
      supabaseUrl: "https://pp.test",
      anonKey: "k",
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRefreshError: (message) => errors.push(message)
    });
    expect(result).toMatchObject({ ok: true, refreshed: false });
    if (!result.ok) return;
    expect(result.session.accessToken).toBe("still-good");
    expect(errors[0]).toMatch(/HTTP 503/);
  });

  it("刷新失败且已过期时报错，不拿过期令牌硬发", async () => {
    const file = sessionFilePath(await tempDir());
    await saveSession(file, { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await ensureSession({
      supabaseUrl: "https://pp.test",
      anonKey: "k",
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(false);
  });

  it("没有持久化会话时用手填令牌", async () => {
    const file = sessionFilePath(await tempDir());
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    const result = await ensureSession({ supabaseUrl: "https://pp.test", anonKey: "k", fallbackAccessToken: token, filePath: file });
    expect(result).toMatchObject({ ok: true, refreshed: false });
    if (!result.ok) return;
    expect(result.session.accessToken).toBe(token);
    expect(result.session.refreshToken).toBe("");
  });

  it("手填令牌已过期时明确报错", async () => {
    const file = sessionFilePath(await tempDir());
    const token = jwt(Math.floor(Date.now() / 1000) - 10);
    const result = await ensureSession({ supabaseUrl: "https://pp.test", anonKey: "k", fallbackAccessToken: token, filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/已过期/);
  });

  it("配置了 refresh_token 时先换权，并把轮换后的值落盘", async () => {
    const file = sessionFilePath(await tempDir());
    const next = jwt(Math.floor(Date.now() / 1000) + 3600, "seeded");
    const fetchImpl = vi.fn(async () => Response.json({ access_token: next, refresh_token: "rotated", expires_in: 3600 }));

    const result = await ensureSession({
      supabaseUrl: "https://pp.test",
      anonKey: "k",
      seedRefreshToken: "seed-r",
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, refreshed: true });
    // 轮换后的 refresh_token 必须落盘，否则下次续不上。
    expect((await loadSession(file))?.refreshToken).toBe("rotated");
  });

  it("seed 换权失败时回落到手填访问令牌", async () => {
    const file = sessionFilePath(await tempDir());
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const errors: string[] = [];
    const result = await ensureSession({
      supabaseUrl: "https://pp.test",
      anonKey: "k",
      seedRefreshToken: "bad-seed",
      fallbackAccessToken: token,
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRefreshError: (m) => errors.push(m)
    });
    expect(result).toMatchObject({ ok: true, refreshed: false });
    if (!result.ok) return;
    expect(result.session.accessToken).toBe(token);
    expect(errors[0]).toMatch(/换权失败/);
  });

  it("已有持久化会话时不会用配置的旧 seed 覆盖它", async () => {
    const file = sessionFilePath(await tempDir());
    const live = { accessToken: "live", refreshToken: "rotated", expiresAt: Date.now() + 3600_000 };
    await saveSession(file, live);
    const fetchImpl = vi.fn();
    const result = await ensureSession({
      supabaseUrl: "https://pp.test",
      anonKey: "k",
      seedRefreshToken: "stale-config-value",
      filePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: true, refreshed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await loadSession(file))?.refreshToken).toBe("rotated");
  });

  it("什么都没有时说清楚该怎么配", async () => {
    const file = sessionFilePath(await tempDir());
    const result = await ensureSession({ supabaseUrl: "https://pp.test", anonKey: "k", filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/accessToken|refresh_token/);
  });
});
