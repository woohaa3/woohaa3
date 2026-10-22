// 渲染 docs/diagrams 下的 HTML 为 PNG，用于目检排版（离线，不联网）。
// 用法（从 web/ 下跑，才能解析到 @playwright/test）：
//   cd web && node ../scripts/render-diagrams.mjs ../docs/diagrams/xxx.html
import { chromium } from "@playwright/test";
import path from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法: node scripts/render-diagrams.mjs <html...>");
  process.exit(1);
}

const browser = await chromium.launch();
for (const file of files) {
  const abs = path.resolve(file);
  const out = abs.replace(/\.html$/, ".render.png");
  const page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 1.5 });
  // 阻断外部字体请求，避免离线环境等待超时；字体回退到本机 sans。
  await page.route("**://fonts.googleapis.com/**", (r) => r.abort());
  await page.route("**://fonts.gstatic.com/**", (r) => r.abort());
  await page.goto("file://" + abs, { waitUntil: "load" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, fullPage: true });
  console.log("rendered", out);
  await page.close();
}
await browser.close();
