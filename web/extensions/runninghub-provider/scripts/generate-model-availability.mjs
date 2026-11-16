#!/usr/bin/env node
/**
 * 生成 `data/model-availability.json`：RunningHub 标准模型在哪些站点的 API 路由不存在。
 *
 * ```sh
 * node scripts/generate-model-availability.mjs
 * ```
 *
 * 判定只看**路由是否存在**：对 registry 里的每个端点向两个站点各发一次最小 POST，使用一个
 * 明确无效的 Bearer Key。上游在参数/鉴权校验前先匹配路由：
 * - `errorCode === 1001`（Invalid URL）→ 该站点没有这个端点；
 * - `1007` / `1026` / `806` 等业务码 → 路由存在（只是参数或 Key 不合格）；
 * - 网络失败、5xx、405 等无法判断 → 记为“未知”，不写入不可用清单。
 *
 * 因此这份映射只保存**有证据不可用**的端点；运行期只隐藏这些端点，未知端点一律保留。
 * 不要用 SKU 列表代替：SKU 是商品/售卖信息，和 API 路由是否注册不是一回事
 * （例如 `rhart-image-n-pro` 的端点在两个站点都存在）。
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(PACKAGE_DIR, "data/model-availability.json");
const REGISTRY_URL = "https://raw.githubusercontent.com/HM-RunningHub/ComfyUI_RH_OpenAPI/main/developer-kit/model-registry.public.json";
const REGIONS = {
  ai: "https://www.runninghub.ai",
  cn: "https://www.runninghub.cn"
};
const PROBE_TOKEN = "rh-region-probe-invalid";
const TIMEOUT_MS = 20_000;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node generate-model-availability.mjs [--out <path>] [--concurrency <1-32>]");
  process.exit(2);
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let concurrency = 12;
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

async function registryEndpoints() {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`registry 返回 HTTP ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : null;
  if (!list) throw new Error("registry 缺少 models 数组");
  const endpoints = new Set();
  for (const entry of list) {
    if (entry && typeof entry === "object" && typeof entry.endpoint === "string" && entry.endpoint.trim() !== "") {
      endpoints.add(entry.endpoint.trim());
    }
  }
  if (endpoints.size === 0) throw new Error("registry 没有端点");
  return [...endpoints].sort();
}

async function probe(origin, endpoint) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${origin}/openapi/v2/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${PROBE_TOKEN}`
        },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { state: "unknown" };
      }
      const code = payload && typeof payload === "object" ? Number(payload.errorCode) : Number.NaN;
      if (code === 1001) return { state: "unavailable" };
      if (Number.isFinite(code)) return { state: "available", code };
      if (response.status === 404) return { state: "unavailable" };
      return { state: "unknown" };
    } catch {
      if (attempt === 2) return { state: "unknown" };
    }
  }
  return { state: "unknown" };
}

async function unavailableForRegion(origin, endpoints, concurrency) {
  const unavailable = new Set();
  const counts = { available: 0, unavailable: 0, unknown: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < endpoints.length) {
      const index = cursor;
      cursor += 1;
      const endpoint = endpoints[index];
      const result = await probe(origin, endpoint);
      counts[result.state] += 1;
      if (result.state === "unavailable") unavailable.add(endpoint);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, endpoints.length) }, () => worker()));
  console.error(
    `[model-availability] ${origin}：可用 ${counts.available}，不可用 ${counts.unavailable}，未知 ${counts.unknown}`
  );
  return [...unavailable].sort();
}

const { out, concurrency } = parseArgs(process.argv.slice(2));
const endpoints = await registryEndpoints();
const unavailable = {};
for (const [region, origin] of Object.entries(REGIONS)) {
  unavailable[region] = await unavailableForRegion(origin, endpoints, concurrency);
}

const artifact = {
  schemaVersion: 2,
  source: REGISTRY_URL,
  method: "POST /openapi/v2/<endpoint> with an invalid Bearer token; errorCode 1001 means the route is absent in that region.",
  note: "由 scripts/generate-model-availability.mjs 生成；只记录有证据不可用的端点，未知端点保留。",
  unavailable
};

writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(
  `[model-availability] 写入 ${out}（ai 不可用 ${unavailable.ai.length}，cn 不可用 ${unavailable.cn.length}）`
);
