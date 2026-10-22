/**
 * 服务端环境文件加载（change: split-web-runtime-services）。
 *
 * 三个服务与入口脚本读的是 `process.env`；`.env` 不会自动进进程环境（仓库不使用
 * dotenv 运行时依赖）。本模块给 `scripts/serve-web.mjs` 与 `scripts/dev-orchestrator.mjs`
 * 提供**同一套**加载语义：
 *
 * 1. 先读仓库内的服务端 `.env`（`web/.env`，已被 `.gitignore` 忽略，只允许放服务端密钥）；
 * 2. 再用 `process.env` 覆盖它 —— 部署侧注入优先，本地文件只是便捷默认。
 *
 * `.env` 里的变量**绝不**带 `VITE_` 前缀：Vite 只把 `VITE_*` 暴露给浏览器 bundle，
 * 服务端密钥必须留在这里。
 */
import fs from "node:fs";
import path from "node:path";

/** 解析一个 `.env` 文件为对象；文件不存在时返回空对象（部署侧可能只用进程环境）。 */
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** 仓库内服务端环境文件（服务密钥只允许放这里，且已被 `.gitignore` 忽略）。 */
export function serviceEnvFile(root) {
  return path.resolve(root, "web/.env");
}

/**
 * 合并「仓库 `.env` + 进程环境」，进程环境优先。
 *
 * `explicitFile` 供测试/运维指定替代文件；省略时用 `web/.env`。
 */
export function loadServiceEnv(root, explicitFile) {
  const file = explicitFile ? path.resolve(explicitFile) : serviceEnvFile(root);
  return { ...readEnvFile(file), ...process.env };
}
