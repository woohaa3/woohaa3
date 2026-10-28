/**
 * 服务期发布目录指针解析（Vite dev/preview 的 HTML 注入用）。
 *
 * 现场：2026-10-28，dev 里宿主重启后页面整页没有扩展（remote-server 不加载），刷新才恢复。
 *
 * 背景：dev 的 Vite 与宿主是**两个进程**，页面 HTML 里的 `<link rel="woohaa-extension-release">`
 * 由 Vite 在服务 HTML 时向宿主（`/extension-releases/current.json`）现取。宿主重启窗口里这个
 * 请求会失败（dev 的宿主 watch、受管扩展安装后的受控重启），而旧实现直接让 HTML **不带** link：
 * 前端据此判定「无扩展能力」，整页一个扩展都不装配，且不报错——只有刷新一次才好。
 *
 * 这里做两件事，都只在指针读不到时生效：
 * 1. 在有限窗口内重试（宿主通常 1–3s 内就绪）；
 * 2. 窗口用尽时回落到**上次成功**的发布目录，且只有确认该目录仍可读才回落（避免注入一个 404
 *    的指针，那会让页面启动直接失败，比没有扩展更糟）。
 *
 * 不做的事：不缓存指针用于正常路径（正常路径永远读宿主当前值），不隐藏非法指针——宿主返回
 * 形状不对的 href 属于宿主 bug，直接抛错，不猜测。
 */

/** 宿主发布目录发现端点（不可缓存）。 */
export const RELEASE_POINTER_PATH = "/extension-releases/current.json";

/** 合法发布目录 href：固定前缀 + 64 位 sha256。 */
export const RELEASE_HREF_PATTERN = /^\/extension-releases\/[a-f0-9]{64}\.json$/;

/** 逻辑路径 → 宿主 URL（只在请求出口加一次公开挂载前缀）。 */
export function backendPath(backendUrl, basePath, logicalPath) {
  const base = String(backendUrl ?? "").replace(/\/+$/, "");
  const raw = basePath ?? "/";
  const prefix = raw === "/" || raw === "" ? "" : raw.replace(/\/+$/, "");
  const logical = logicalPath.startsWith("/") ? logicalPath : `/${logicalPath}`;
  return `${base}${prefix}${logical}`;
}

/**
 * 解析当前发布目录 href。
 *
 * @returns {Promise<{ href: string | null, source: "pointer" | "last-good" | null }>}
 *   `source` 说明 href 的来源；`href === null` 表示本次无法注入（宿主持久不可用且没有可回落的目录）。
 * @throws 宿主返回非法 href 时抛错（宿主 bug，不静默降级）。
 */
export async function resolveReleasePointer(options) {
  const {
    backendUrl,
    basePath = "/",
    fetchImpl = (...args) => fetch(...args),
    lastGoodHref = null,
    retryWindowMs = 3_000,
    retryDelayMs = 250,
    attemptTimeoutMs = 1_500,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => undefined
  } = options ?? {};

  const readPointer = async () => {
    const response = await fetchImpl(backendPath(backendUrl, basePath, RELEASE_POINTER_PATH), {
      signal: AbortSignal.timeout(attemptTimeoutMs)
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    const href = typeof body?.href === "string" ? body.href : "";
    if (!RELEASE_HREF_PATTERN.test(href)) {
      throw new Error("后端扩展发布目录地址无效");
    }
    return href;
  };

  const catalogServed = async (href) => {
    if (!RELEASE_HREF_PATTERN.test(href)) return false;
    const response = await fetchImpl(backendPath(backendUrl, basePath, href), {
      signal: AbortSignal.timeout(attemptTimeoutMs)
    }).catch(() => null);
    return response?.ok === true;
  };

  const deadline = now() + Math.max(0, retryWindowMs);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const href = await readPointer();
    if (href) return { href, source: "pointer" };
    if (now() >= deadline) break;
    await sleep(retryDelayMs);
  }

  if (lastGoodHref) {
    if (await catalogServed(lastGoodHref)) {
      log({ event: "extension-release-pointer-stale", attempts, release: lastGoodHref });
      return { href: lastGoodHref, source: "last-good" };
    }
    log({ event: "extension-release-pointer-stale-gone", attempts, release: lastGoodHref });
  }
  log({ event: "extension-release-pointer-unavailable", attempts });
  return { href: null, source: null };
}
