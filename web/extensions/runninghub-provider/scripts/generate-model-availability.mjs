#!/usr/bin/env node
/**
 * 生成 `data/model-availability.json`：RunningHub 标准模型在两站的**可售/可用**端点。
 *
 * ```sh
 * node scripts/generate-model-availability.mjs
 * ```
 *
 * 数据源是官方标准模型 SKU 列表（`POST /api/sku/list`，`categoryType: STANDARD_MODEL`）与
 * SKU 详情（`POST /api/sku/detail`）。详情里的：
 * - `rhEndpoint`：与 registry 精确匹配的 API 路由；
 * - `isOversea`：0 表示国内站可用，1 表示仅海外/国际站；
 * - `status` / `sourceTypeName`：售卖状态与供应商。
 *
 * 两站的 SKU 列表本身也不同（国际站 400、国内站 283）。只记录**有正面证据**的端点：
 * 某个端点只在一个站的可用清单里时，另一站隐藏它；两个站都没有的端点视为“未知”并保留
 * （legacy/free 端点可能不作为 SKU 出售），避免用不完整清单误删合法模型。
 *
 * 不要用 `/openapi/v2/<endpoint>` 的 `1001` 探测代替：路由注册不等于账号能调用。
 * 实测国内站账号调用 `rhart-image-g-*`、`rhart-image-n-*`、`dola-*` 会失败，但路由探测
 * 仍返回参数错误；SKU 的 `isOversea` 才是区域可用性标记。
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(PACKAGE_DIR, "data/model-availability.json");
const REGIONS = {
  ai: "https://www.runninghub.ai",
  cn: "https://www.runninghub.cn"
};
const LIST_PATH = "/api/sku/list";
const DETAIL_PATH = "/api/sku/detail";
const PAGE_SIZE = 500;
const TIMEOUT_MS = 30_000;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node generate-model-availability.mjs [--out <path>] [--concurrency <1-32>]");
  process.exit(2);
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let concurrency = 8;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) usage("--out 缺少路径");
      out = resolve(value);
      i += 1;
    } else if (arg === "--concurrency") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 32) usage("--concurrency 需要 1–32 的整数");
      concurrency = value;
      i += 1;
    } else {
      usage(`未知参数 ${arg}`);
    }
  }
  return { out, concurrency };
}

async function postJson(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${origin}${path} 返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || payload.code !== 0) {
    throw new Error(`${origin}${path} 返回失败：${payload && typeof payload === "object" ? payload.msg ?? "unknown" : "non-object"}`);
  }
  return payload.data;
}

async function listSkus(origin) {
  const records = [];
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    const data = await postJson(origin, LIST_PATH, {
      categoryType: "STANDARD_MODEL",
      pageNum,
      pageSize: PAGE_SIZE
    });
    const page = data && typeof data === "object" ? data.page : undefined;
    const pageRecords = page && Array.isArray(page.records) ? page.records : [];
    records.push(...pageRecords);
    const total = Number(page?.total);
    if (pageRecords.length === 0 || (Number.isFinite(total) && records.length >= total)) break;
  }
  if (records.length === 0) throw new Error(`${origin}${LIST_PATH} 没有返回标准模型 SKU`);
  return records;
}

async function skuDetail(origin, skuId) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const data = await postJson(origin, DETAIL_PATH, { id: skuId });
      if (!data || typeof data !== "object") return { skipped: true };
      const endpoint = typeof data.rhEndpoint === "string" ? data.rhEndpoint.trim().replace(/^\/+/, "") : "";
      if (!endpoint) return { skipped: true };
      return {
        endpoint,
        // 0 = 国内站可用；1 = 仅海外；缺失时不据此判断，交给所在站的列表决定。
        isOversea: typeof data.isOversea === "number" ? data.isOversea : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("1913") || message.includes("暂无权限")) return { skipped: true };
      if (attempt === 2) throw error;
    }
  }
  return { skipped: true };
}

async function endpointsForRegion(origin, concurrency) {
  const records = await listSkus(origin);
  const ids = [...new Set(records.map((record) => String(record?.id ?? "").trim()).filter(Boolean))];
  const endpoints = new Set();
  let cursor = 0;
  let failures = 0;

  async function worker() {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      try {
        const result = await skuDetail(origin, id);
        if (result.endpoint) {
          // 国内站清单里标成仅海外的 SKU 不进入国内站可用集合。
          if (origin === REGIONS.cn && result.isOversea === 1) continue;
          endpoints.add(result.endpoint);
        } else if (result.skipped) {
          console.error(`[model-availability] ${origin} SKU ${id} 无可用 rhEndpoint，跳过`);
        }
      } catch (error) {
        failures += 1;
        console.error(`[model-availability] ${origin} SKU ${id} 详情失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  if (failures > 0) throw new Error(`${origin} 有 ${failures} 个 SKU 详情失败，拒绝写入不完整映射`);
  console.error(`[model-availability] ${origin}：${records.length} 个 SKU，${endpoints.size} 个可用端点`);
  return [...endpoints].sort();
}

const { out, concurrency } = parseArgs(process.argv.slice(2));
const regions = {};
for (const [region, origin] of Object.entries(REGIONS)) {
  regions[region] = await endpointsForRegion(origin, concurrency);
}

const artifact = {
  schemaVersion: 3,
  source: {
    ai: `${REGIONS.ai}${LIST_PATH}?categoryType=STANDARD_MODEL`,
    cn: `${REGIONS.cn}${LIST_PATH}?categoryType=STANDARD_MODEL`
  },
  note: "由 scripts/generate-model-availability.mjs 生成；按站点 SKU 列表与详情 isOversea/rhEndpoint 记录可用端点。只隐藏有正面证据属于另一站的端点，未知端点保留。",
  regions
};

writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(`[model-availability] 写入 ${out}（ai ${regions.ai.length}，cn ${regions.cn.length}）`);
