#!/usr/bin/env node
/**
 * 从上游端点定义派生本插件的 RunningHub API 逻辑模型清单。
 *
 * ```sh
 * node scripts/generate-models.mjs [--prune] [--base <path>] <input.json>... > data/models.json
 * ```
 *
 * 输入可以是数组，也可以是官方 `model-registry.public.json` 的 `{ version, models: [...] }`
 * 形状；多个文件按 `endpoint` 合并，靠后的覆盖靠前的。`scripts/upstream/*.json` 与我们手工
 * 记录的端点级条目字段名与官方 registry 一致，因此可以直接拼在一起传进来
 * （`scripts/upstream/runninghub-gpt-image-2-5.json` 抓取于 2026-10-31，来源 URL 逐条记在其
 * 头部 `source` 字段）。
 *
 * 复现当前清单：
 * ```sh
 * node scripts/generate-models.mjs \
 *   <model-registry.public.json> scripts/upstream/runninghub-gpt-image-2-5.json > data/models.json
 * ```
 *
 * 默认**只增不删**：已入库但上游输入里缺失的逻辑模型会被保留（并把 id 打到 stderr），
 * 避免上游快照缩水时静默删掉线上仍在的模型。要真的丢弃它们必须显式 `--prune`。
 * `--base` 指定保留基底（缺省为同包 `data/models.json`）。
 *
 * 规则本身在 `model-pipeline.mjs`：运行期「刷新可用模型」（`src/discovery.ts`）用的是
 * 同一份实现，两边不会各维护一套合并逻辑。
 *
 * 输入缺失、JSON 非法或合并后为空 → 非零退出且不写任何输出。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logicalModelsOf, mergeWithBase } from "./model-pipeline.mjs";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = resolve(PACKAGE_DIR, "data/models.json");

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node generate-models.mjs [--prune] [--base <path>] <input.json>... > data/models.json");
  process.exit(2);
}

function parseArgs(argv) {
  const inputs = [];
  let prune = false;
  let base = DEFAULT_BASE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prune") prune = true;
    else if (arg === "--base") {
      const value = argv[i + 1];
      if (!value) usage("--base 缺少路径");
      base = resolve(value);
      i += 1;
    } else if (arg.startsWith("-")) usage(`未知参数 ${arg}`);
    else inputs.push(resolve(arg));
  }
  if (inputs.length === 0) usage();
  return { inputs, prune, base };
}

/** 读取一个输入文件，返回端点级条目数组。数组与 `{ models: [...] }` 两种形状都认。 */
function readEntries(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    usage(`无法读取 ${path}: ${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : null;
  if (list === null) usage(`${path} 既不是数组，也不是 { models: [...] }`);
  return list;
}

/** 按 endpoint 合并多个来源；靠后的覆盖靠前的。 */
function mergeEntries(files) {
  const byEndpoint = new Map();
  for (const path of files) {
    for (const entry of readEntries(path)) {
      if (typeof entry?.endpoint !== "string" || entry.endpoint === "") {
        usage(`${path} 中存在缺少 endpoint 的条目`);
      }
      byEndpoint.set(entry.endpoint, entry);
    }
  }
  return [...byEndpoint.values()];
}

/** 读取保留基底；不存在或不可解析时视作没有基底（不是错误）。 */
function readBase(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

const { inputs, prune, base } = parseArgs(process.argv.slice(2));
const generated = logicalModelsOf(mergeEntries(inputs));

if (generated.length === 0) usage("输入没有产生任何逻辑模型");

let models = generated;
if (!prune) {
  const merged = mergeWithBase(generated, readBase(base));
  models = merged.models;
  if (merged.preserved.length > 0) {
    console.error(`preserved upstream-missing models (${merged.preserved.length}): ${merged.preserved.map((m) => m.id).join(", ")}`);
  }
}

process.stdout.write(JSON.stringify({ provider: "runninghub", generatedFrom: "models_registry.json", models }, null, 2) + "\n");
