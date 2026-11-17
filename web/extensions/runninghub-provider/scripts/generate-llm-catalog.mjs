#!/usr/bin/env node
/**
 * 生成 RunningHub 官方文字目录快照。
 *
 * ```sh
 * node scripts/generate-llm-catalog.mjs --region cn
 * node scripts/generate-llm-catalog.mjs --region ai
 * ```
 *
 * 两个文字站目录不同：国际站 `llm.runninghub.ai/v1/models`，国内站 `llm.runninghub.cn/v1/models`。
 * 快照只保留解析身份与逐模型能力所需的字段；价格、促销与内部字段不进入产品常量。
 * 与 `parseRunningHubLanguageCatalog` 保持同一过滤口径：只收 `capabilities.chat === true`，
 * 排除 `deprecated` 或带 `redirect_to` 的模型。
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGION_HOSTS = {
  ai: "llm.runninghub.ai",
  cn: "llm.runninghub.cn"
};
const TIMEOUT_MS = 30_000;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node generate-llm-catalog.mjs --region <ai|cn> [--out <path>]");
  process.exit(2);
}

function parseArgs(argv) {
  let region;
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--region") {
      region = argv[i + 1];
      i += 1;
    } else if (arg === "--out") {
      out = argv[i + 1];
      i += 1;
    } else {
      usage(`未知参数 ${arg}`);
    }
  }
  if (region !== "ai" && region !== "cn") usage("--region 必须是 ai 或 cn");
  return {
    region,
    out: resolve(out ?? (region === "cn" ? resolve(PACKAGE_DIR, "data/llm-models.cn.json") : resolve(PACKAGE_DIR, "data/llm-models.json")))
  };
}

function snapshotModel(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry;
  if (typeof record.id !== "string" || record.id.trim() === "") return undefined;
  if (!record.capabilities || typeof record.capabilities !== "object" || record.capabilities.chat !== true) return undefined;
  if (record.deprecated === true || typeof record.redirect_to === "string") return undefined;
  return {
    id: record.id.trim(),
    object: typeof record.object === "string" ? record.object : "model",
    ...(typeof record.owned_by === "string" ? { owned_by: record.owned_by } : {}),
    ...(typeof record.created === "number" ? { created: record.created } : {}),
    ...(typeof record.context_length === "number" ? { context_length: record.context_length } : {}),
    capabilities: record.capabilities
  };
}

const { region, out } = parseArgs(process.argv.slice(2));
const source = `https://${REGION_HOSTS[region]}/v1/models`;
const response = await fetch(source, {
  method: "GET",
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(TIMEOUT_MS)
});
if (!response.ok) {
  console.error(`[llm-catalog] ${source} 返回 HTTP ${response.status}`);
  process.exit(1);
}
const payload = await response.json();
const list = Array.isArray(payload?.data) ? payload.data : null;
if (!list) {
  console.error("[llm-catalog] 响应缺少 data 数组");
  process.exit(1);
}
const data = list.map(snapshotModel).filter(Boolean);
if (data.length === 0) {
  console.error("[llm-catalog] 过滤后没有可用模型，拒绝写入空目录");
  process.exit(1);
}

const artifact = {
  source,
  fetchedAt: new Date().toISOString().slice(0, 10),
  note: "脱敏后的官方文字目录快照：只保留解析所需的身份与逐模型能力字段。模型集合与价格不进产品常量，刷新时以官方接口为准。",
  object: "list",
  data
};
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(`[llm-catalog] ${region}：${data.length} 个模型 → ${out}`);
