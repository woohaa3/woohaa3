/**
 * 已打开的页面把当时的宿主脚本钉在文档里。扩展升级只换该扩展自己的实例，
 * 换不到宿主脚本（例如连线菜单是否收录扩展模板）。发布目录切换后对照一次
 * 网络上的入口 HTML，主脚本文件名不同就换掉整页。
 */

const MAIN_SCRIPT = /assets\/main-[\w-]+\.js/;

/** 从脚本地址或 HTML 里取出宿主主脚本的稳定文件名；没有则返回 null。 */
export function hostMainScript(source: string | null | undefined): string | null {
  if (!source) return null;
  return source.match(MAIN_SCRIPT)?.[0] ?? null;
}

/** 当前文档与网络上的入口 HTML 是否钉着不同的宿主主脚本。 */
export function hostDocumentStale(currentSource: string | null | undefined, nextHtml: string): boolean {
  const current = hostMainScript(currentSource);
  const next = hostMainScript(nextHtml);
  return Boolean(current && next && current !== next);
}

type ScriptNode = { getAttribute(name: string): string | null };

export type HostDocumentReloadInput = {
  fetch?: typeof fetch;
  location?: { href: string; pathname: string; search: string; replace(url: string): void };
  document?: { querySelectorAll(selector: string): Iterable<ScriptNode> };
};

/**
 * 宿主入口脚本变了就换文档。查询参数只用于绕开旧文档缓存，路由会丢掉不认识的字段。
 * 没有 document / 主脚本相同 / 请求失败时什么都不做。
 */
export async function replaceDocumentIfHostChanged(input: HostDocumentReloadInput = {}): Promise<boolean> {
  const doc = input.document ?? (typeof document === "undefined" ? undefined : document);
  const loc = input.location ?? (typeof location === "undefined" ? undefined : location);
  const doFetch = input.fetch ?? (typeof fetch === "undefined" ? undefined : globalThis.fetch.bind(globalThis));
  if (!doc || !loc || !doFetch) return false;
  const current = [...doc.querySelectorAll("script[src]")]
    .map((node) => node.getAttribute("src"))
    .find((src) => hostMainScript(src));
  if (!current) return false;
  let html: string;
  try {
    const response = await doFetch(`${loc.pathname}${loc.search}`, { cache: "reload", credentials: "same-origin" });
    if (!response.ok) return false;
    html = await response.text();
  } catch {
    return false;
  }
  if (!hostDocumentStale(current, html)) return false;
  const token = hostMainScript(html)?.split("/").pop()?.replace(/[^\w]/g, "") ?? "1";
  const next = new URL(loc.href);
  if (next.searchParams.get("__host") === token) return false;
  next.searchParams.set("__host", token);
  loc.replace(next.toString());
  return true;
}
