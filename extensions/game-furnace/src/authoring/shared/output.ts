import { MAX_BUILD_DEPENDENCIES, MAX_GAME_HTML_BYTES } from "../../state/shared/index.js";

export type GameResultDocument = {
  schemaVersion: 1;
  title: string;
  controlsSummary: string;
  entry: "index.html";
  html: string;
  resourceIds: string[];
};

export type DecodeResult =
  | { ok: true; value: GameResultDocument }
  | { ok: false; code: string; message: string };

import { isRecord } from "../../state/shared/record.js";
export function decodeGameResult(raw: string): DecodeResult {
  if (typeof raw !== "string" || raw.trim() === "") return fail("invalid-game-output", "模型输出为空");
  const text = raw.trim();

  // 单 JSON（纯对象或以 `{` 开头）或单个 ```json 代码块：只按 JSON 解析，绝不回退到 HTML 探测，
  // 避免把嵌入 JSON 的 HTML 字符串当作整段 HTML（design D10）。
  const jsonBlock = extractSingleCodeBlock(text, "json");
  const looksJson = jsonBlock !== null || text.startsWith("{");
  if (looksJson) {
    const candidate = jsonBlock ?? text;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return decodeResultObject(parsed);
    } catch {
      return fail("invalid-game-output", "JSON 结果无法解析");
    }
  }

  const htmlCandidate = extractSingleCodeBlock(text, "html");
  if (htmlCandidate) {
    return decodeResultObject({
      schemaVersion: 1,
      title: "",
      controlsSummary: "",
      entry: "index.html",
      html: htmlCandidate,
      resourceIds: []
    });
  }
  // 整段就是 HTML。
  if (/<!doctype html|<html[\s>]/i.test(text)) {
    return decodeResultObject({
      schemaVersion: 1,
      title: "",
      controlsSummary: "",
      entry: "index.html",
      html: text,
      resourceIds: []
    });
  }
  return fail("invalid-game-output", "无法解析为单个 JSON 或 HTML 代码块");
}

function decodeResultObject(value: unknown): DecodeResult {
  if (!isRecord(value)) return fail("invalid-game-output", "结果不是对象");
  if (value.schemaVersion !== 1) return fail("invalid-game-output", "结果 schemaVersion 不支持");
  if (typeof value.html !== "string" || value.html.trim() === "") return fail("invalid-game-output", "缺少 html");
  if (value.entry !== "index.html") return fail("invalid-game-output", "缺少 index.html 入口");
  const title = typeof value.title === "string" ? value.title.slice(0, 200) : "";
  const controlsSummary = typeof value.controlsSummary === "string" ? value.controlsSummary.slice(0, 2000) : "";
  const resourceIds = Array.isArray(value.resourceIds)
    ? [...new Set(value.resourceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  if (resourceIds.length > MAX_BUILD_DEPENDENCIES) return fail("invalid-game-output", "资源引用超限");
  return { ok: true, value: { schemaVersion: 1, title, controlsSummary, entry: "index.html", html: value.html, resourceIds } };
}

function extractSingleCodeBlock(text: string, lang: string): string | null {
  const fence = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "gi");
  const matches = [...text.matchAll(fence)];
  if (matches.length === 0) return null;
  // 多个同语言代码块视为多候选，拒绝（design D10：不拼接）。
  if (matches.length > 1) return null;
  return matches[0]![1]!.trim();
}

/**
 * 静态校验生成 HTML（design D10）：
 * - 体积上限（1 MiB）；
 * - 完整入口（doctype/html/body 结构基本存在）；
 * - 内联 CSS/JS；
 * - 禁止未打包外部依赖（http(s) 脚本、CDN、外部样式表）、顶层导航、应用内部接口；
 * - 引用的资源路径必须是本 build 的确定相对路径；
 * - 存在脚本（否则无游戏循环）。
 * 不执行生成 JS，静态校验不宣称玩法正确。
 */
export function validateGameHtml(input: {
  html: string;
  /** 允许引用的资源相对路径集合；空集合表示不允许引用任何资源。 */
  allowedResourcePaths: ReadonlySet<string>;
  /** 已声明资源 id → 相对路径（供错误信息）。 */
  knownResourceIds: ReadonlySet<string>;
}): { ok: true } | { ok: false; code: string; message: string } {
  const { html } = input;
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_GAME_HTML_BYTES) return { ok: false, code: "invalid-game-output", message: `HTML 超过 ${MAX_GAME_HTML_BYTES} 字节上限` };
  const lower = html.toLowerCase();
  if (!lower.includes("<!doctype html") && !lower.includes("<html")) {
    return { ok: false, code: "invalid-game-output", message: "缺少完整 HTML 文档" };
  }
  if (!lower.includes("<script")) return { ok: false, code: "invalid-game-output", message: "缺少脚本，无法形成游戏循环" };
  // 内联样式：不得引用外部样式表。
  if (/<link[^>]+rel\s*=\s*["']?stylesheet/i.test(html)) {
    return { ok: false, code: "undeclared-resource", message: "禁止外部样式表依赖" };
  }
  // 外部脚本 / CDN / 任意网络。
  const externalScript = /<script[^>]+src\s*=/i.test(html);
  if (externalScript) return { ok: false, code: "undeclared-resource", message: "禁止外部脚本依赖，CSS/JS 必须内联" };
  if (/\b(?:https?:)?\/\/[^"'\s)]+/i.test(html.replace(/https?:\/\/www\.w3\.org[^"'\s)]*/gi, ""))) {
    return { ok: false, code: "undeclared-resource", message: "禁止外部网络/CDN 依赖" };
  }
  // fetch/XHR/WebSocket：禁止访问任意网络与应用接口。
  if (/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|import\s*\()/i.test(html)) {
    return { ok: false, code: "undeclared-resource", message: "禁止生成代码访问网络或动态导入" };
  }
  if (/top\.location|window\.top|parent\.location|document\.cookie|localStorage|sessionStorage/i.test(html)) {
    return { ok: false, code: "undeclared-resource", message: "禁止访问主页面、存储或顶层导航" };
  }
  // 资源引用：只允许本 build 的确定相对路径。
  const refs = collectResourceReferences(html);
  for (const ref of refs) {
    if (!input.allowedResourcePaths.has(ref)) {
      return { ok: false, code: "undeclared-resource", message: `引用了未声明资源：${ref}` };
    }
  }
  return { ok: true };
}

/** 收集 HTML 中引用的相对资源路径（图片/音视频/`GAME_ASSETS` 映射值）。 */
export function collectResourceReferences(html: string): string[] {
  const refs = new Set<string>();
  const attrRegex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRegex)) {
    const value = match[1]!;
    if (value.startsWith("assets/")) refs.add(value);
  }
  // GAME_ASSETS 映射中的相对路径。
  const mapRegex = /["'](assets\/[A-Za-z0-9_./-]+)["']/g;
  for (const match of html.matchAll(mapRegex)) refs.add(match[1]!);
  return [...refs];
}

/** 注入受控 `GAME_ASSETS` 映射（字符严格转义；只含本 build 授权资源）。 */
export function injectAssetMap(html: string, mapping: Record<string, string>): string {
  const serialized = JSON.stringify(mapping)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const script = `<script>window.GAME_ASSETS=Object.freeze(${serialized});</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (match) => `${match}\n${script}`);
  return `${script}\n${html}`;
}

// ---------------------------------------------------------------------------
// 源码包与 manifest 编解码
// ---------------------------------------------------------------------------

function fail(code: string, message: string): DecodeResult {
  return { ok: false, code, message };
}
