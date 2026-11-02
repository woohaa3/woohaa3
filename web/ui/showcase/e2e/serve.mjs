#!/usr/bin/env node
/**
 * 查看页静态服务（Showcase e2e 用）。
 *
 * 复用仓库的 `scripts/lib/static-server.mjs`；只额外把 Godot 侧字体挂到
 * `/fonts/NotoSansSC-Regular.otf`（与 Ladle dev/preview 的 local-font 插件一致），
 * 让视觉/布局断言拿到和生产一致的字形宽度。
 *
 *   node e2e/serve.mjs --port 5199 --dist dist
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticHandler } from "../../../../scripts/lib/static-server.mjs";
import { createReviewServer, reviewScheme } from "../../../../scripts/lib/review-tls.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const showcaseRoot = path.resolve(here, "..");
const repoRoot = path.resolve(showcaseRoot, "..", "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(process.env.PORT || arg("port", "5199"));
const host = process.env.HOST || "127.0.0.1";
const dist = path.resolve(showcaseRoot, arg("dist", "dist"));
const fontCandidates = [
  path.join(repoRoot, "web", "frontend", "public", "assets", "fonts", "NotoSansSC-Regular.otf"),
  path.join(repoRoot, "bevy", "assets", "fonts", "NotoSansSC-Regular.otf"),
  path.join(dist, "fonts", "NotoSansSC-Regular.otf")
];
const fontFile = fontCandidates.find((candidate) => fs.existsSync(candidate)) ?? fontCandidates[0];
const fontUrl = "/fonts/NotoSansSC-Regular.otf";
// Bevy AssetPlugin（`file_path: "assets"`）相对页面 base 读取 `assets/fonts/...`。
const assetFontUrl = "/assets/fonts/NotoSansSC-Regular.otf";

if (!fs.existsSync(dist)) {
  process.stderr.write(`缺少查看页构建产物：${dist}\n先运行：pnpm -C web/ui/showcase run build\n`);
  process.exit(1);
}

const serveStatic = createStaticHandler(dist);

const server = createReviewServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if ((url.pathname === fontUrl || url.pathname === assetFontUrl) && fs.existsSync(fontFile)) {
    const body = fs.readFileSync(fontFile);
    res.writeHead(200, {
      "content-type": "font/otf",
      "content-length": body.byteLength,
      "cache-control": "no-cache"
    });
    res.end(body);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, host, () => {
  process.stderr.write(`[showcase-e2e] ${reviewScheme()}://${host}:${port}（dist=${dist}）\n`);
});
