/**
 * 应用挂载路径（base path）纯契约
 * （change: 2026-10-15-support-configurable-app-base-path，design D1/D3/D4）。
 *
 * 这是**唯一**的挂载路径规范化/匹配行为来源：浏览器（frontend）、Node 服务
 * （backend/services/extensions）与仓库根脚本（`scripts/`）共用同一实现。写成纯
 * ESM（`.mjs`）+ 相邻类型声明，使不经过构建的 Node 入口与经 esbuild 打包的 TS 单元
 * 都能直接消费，避免维护两份规则。
 *
 * 术语：
 * - 「逻辑路径」：应用内部根相对路径，例如 `/api/media/<key>`、`/task-history`；
 *   它是 DTO/route/DOM 引用中稳定的应用事实，不含部署前缀。
 * - 「公开路径」：浏览器可见的实际 URL 路径，等于逻辑路径前加当前挂载前缀。
 *
 * 规则：
 * - 未设置、空字符串、`/` 都表示根路径 `/`。
 * - 合法非根配置以 `/` 开始，路径段只允许 `[A-Za-z0-9_-]+`，可多级，规范为带尾斜杠。
 * - 完整 URL、无起始斜杠、协议相对、双斜杠、反斜杠、空白、query/fragment、`.`/`..`
 *   路径段、百分号编码与超过 256 字符一律拒绝。
 */

export const APP_BASE_PATH_ENV = "WOOHAA3_BASE_PATH";

/** 宿主注入的公开挂载元数据 meta name（浏览器启动时读取一次）。 */
export const APP_BASE_PATH_META = "woohaa-app-base-path";

/** 规范化后挂载路径的最大长度（含首尾斜杠）。 */
export const APP_BASE_PATH_MAX_LENGTH = 256;

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_DISALLOWED = /[^A-Za-z0-9_/-]/;

/**
 * 规范化启动配置。
 *
 * @param {unknown} raw 原始环境值（未设置/空/`/` 表示根）。
 * @returns {{ ok: true, basePath: string } | { ok: false, error: string }}
 */
export function normalizeAppBasePath(raw) {
  if (raw === undefined || raw === null) return { ok: true, basePath: "/" };
  if (typeof raw !== "string") return { ok: false, error: "必须是字符串" };
  if (raw === "" || raw === "/") return { ok: true, basePath: "/" };
  if (raw.length > APP_BASE_PATH_MAX_LENGTH) {
    return { ok: false, error: `长度超过 ${APP_BASE_PATH_MAX_LENGTH} 字符` };
  }
  if (raw[0] !== "/") return { ok: false, error: "必须以 / 开始" };
  if (raw.startsWith("//")) return { ok: false, error: "不得是协议相对地址（//）" };
  if (raw.includes("?") || raw.includes("#")) return { ok: false, error: "不得包含 query 或 fragment" };
  if (raw.includes("\\")) return { ok: false, error: "不得包含反斜杠" };
  if (raw.includes("%")) return { ok: false, error: "不得包含百分号编码" };
  if (raw.includes(":") || UNSAFE_DISALLOWED.test(raw)) {
    return { ok: false, error: "只允许 / 与 [A-Za-z0-9_-] 路径段" };
  }
  const segments = raw.split("/").slice(1);
  if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  if (segments.length === 0) return { ok: true, basePath: "/" };
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, error: "不得包含空、. 或 .. 路径段" };
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      return { ok: false, error: "路径段只允许 [A-Za-z0-9_-]+" };
    }
  }
  return { ok: true, basePath: `/${segments.join("/")}/` };
}

/** 是否根挂载。 */
export function isRootAppBasePath(basePath) {
  return basePath === "/";
}

/** 挂载前缀（不含尾斜杠）；根挂载为空字符串。 */
export function appBasePathPrefix(basePath) {
  return basePath === "/" ? "" : basePath.slice(0, -1);
}

/**
 * 逻辑路径 → 公开路径（加一次挂载前缀）。`logicalPath` 必须是应用逻辑路径（以 `/` 开始）。
 */
export function addAppBasePath(basePath, logicalPath) {
  if (basePath === "/") return logicalPath;
  return `${basePath.slice(0, -1)}${logicalPath}`;
}

/**
 * 公开 pathname → 逻辑 pathname（去一次挂载前缀）。不在挂载内返回 null。
 * 只按完整路径段匹配：`/canvas-other` 不是 `/canvas/` 的子路径。
 */
export function stripAppBasePath(basePath, pathname) {
  if (basePath === "/") return pathname;
  const prefix = basePath.slice(0, -1);
  if (pathname === prefix) return "/";
  if (pathname.startsWith(basePath)) return pathname.slice(prefix.length);
  return null;
}

/** 完整路径段匹配结果。 */
export function matchAppBasePath(basePath, pathname) {
  if (basePath === "/") return { kind: "inside", logicalPath: pathname };
  const prefix = basePath.slice(0, -1);
  if (pathname === basePath) return { kind: "inside", logicalPath: "/" };
  if (pathname === prefix) return { kind: "entry", location: basePath };
  if (pathname.startsWith(basePath)) return { kind: "inside", logicalPath: pathname.slice(prefix.length) };
  return { kind: "outside" };
}

/**
 * 公开请求 URL（`req.url` 形如 `/canvas/api/x?y=1`）的挂载判定与剥离。
 *
 * 不先做会折叠 `..` 的 URL 解析再决定归属：直接对原始 pathname 做边界与完整段匹配，
 * 拒绝编码分隔符、编码点段与穿越段。
 *
 * @returns {{ action: "outside" } | { action: "invalid" } | { action: "redirect", location: string } | { action: "forward", url: string, pathname: string, search: string }}
 */
export function decideAppPathMount(basePath, rawUrl) {
  const raw = typeof rawUrl === "string" && rawUrl !== "" ? rawUrl : "/";
  const index = raw.indexOf("?");
  const rawPathname = index >= 0 ? raw.slice(0, index) : raw;
  const search = index >= 0 ? raw.slice(index) : "";
  if (!isSafeAppRequestPath(rawPathname)) return { action: "invalid" };
  if (basePath === "/") {
    return { action: "forward", url: `${rawPathname}${search}`, pathname: rawPathname, search };
  }
  const prefix = basePath.slice(0, -1);
  if (rawPathname === prefix) return { action: "redirect", location: `${basePath}${search}` };
  if (rawPathname === basePath) {
    return { action: "forward", url: `/${search}`, pathname: "/", search };
  }
  if (rawPathname.startsWith(basePath)) {
    const pathname = rawPathname.slice(prefix.length);
    return { action: "forward", url: `${pathname}${search}`, pathname, search };
  }
  return { action: "outside" };
}

/**
 * 请求路径是否可安全用于挂载判定：拒绝编码分隔符/点段、反斜杠与 `..` 穿越段。
 * 允许普通百分号编码（画布/节点身份经 encodeURIComponent）。
 */
export function isSafeAppRequestPath(pathname) {
  if (typeof pathname !== "string" || pathname === "" || pathname[0] !== "/") return false;
  if (pathname.includes("\\")) return false;
  if (/%2f|%5c|%2e|%00/i.test(pathname)) return false;
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(pathname)) return false;
  return true;
}
