/**
 * 应用 HTML 的运行时挂载注入（change: 2026-10-15-support-configurable-app-base-path，design D2）。
 *
 * 宿主与 renderer 构建使用可迁移的相对资源地址（`base: "./"`）；服务器在响应应用 HTML 时，
 * 在所有脚本、样式与 preload **之前**注入确定的 `<base href>` 与只含公开 `basePath` 的元数据。
 * 深链接回退与 renderer 走同一处理。不泄漏其他服务端环境变量。
 *
 * 生产静态服务器（`static-server.mjs`）与 Vite dev/preview 插件共用本实现。
 */
import { APP_BASE_PATH_META } from "../../web/contracts/src/base-path/app-base-path.mjs";

export { APP_BASE_PATH_META };

/** 页面标题是公开启动配置，不进入构建产物或浏览器环境变量集合。 */
export function resolveAppPageTitle(env) {
  return env?.WOOHAA3_PAGE_TITLE?.trim() || "WooHaa3";
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * 按文本替换可选标题，再在 `<head>` 起始处注入 `<base href>` 与公开 basePath 元数据。
 * 挂载标签只注入一次；重复调用仍可更新标题。
 * `basePath` 必须已规范化（服务器配置保证），否则调用方不应注入。
 */
export function injectAppHtml(html, basePath, pageTitle) {
  if (typeof html !== "string") return html;
  if (pageTitle !== undefined) {
    const title = `<title>${escapeAttribute(pageTitle).replace(/>/g, "&gt;")}</title>`;
    if (/<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(html)) {
      html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, () => title);
    } else {
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, head => `${head}\n\t\t${title}`)
        : `${title}\n${html}`;
    }
  }
  if (html.includes(`name="${APP_BASE_PATH_META}"`)) return html;
  const escaped = escapeAttribute(basePath);
  const tags = `<base href="${escaped}" />\n\t\t<meta name="${APP_BASE_PATH_META}" content="${escaped}" />`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const end = head.index + head[0].length;
    return `${html.slice(0, end)}\n\t\t${tags}${html.slice(end)}`;
  }
  return `${tags}\n${html}`;
}
