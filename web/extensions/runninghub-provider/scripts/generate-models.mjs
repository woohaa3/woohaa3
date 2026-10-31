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
 * 规则（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials, design D1/D1b/D4）：
 * - 只纳管四个族：GPT Image(rhart-image-g-*)、Nano Banana(rhart-image-n-*)、
 *   Seedream(seedream-v*|dola-Seedream-*|bytedance/jimeng-*)、Seedance(bytedance/seedance-*|
 *   seedance-v1*|rhart-video/sparkvideo-*)。
 * - 剔除 deprecated / 已下架 / 含 "star" 的营销款。
 * - 按 endpoint 去掉最后一段（操作）合并为一个**逻辑模型**；操作用有序 `routes` 表达，
 *   由插件按输入（是否有图/视频/音频参考）选择具体 endpoint。
 * - 每个 route 带 `collect`（该操作的媒体字段归属），插件据此把稳定引用放入对应字段；
 *   这避免把 i2v 的首尾帧与 multimodal 的 imageUrls 混用。
 * - schema = 各操作 params 的并集；required 取各操作 required 的交集，且排除媒体字段
 *   （媒体字段由路由决定，不作为无条件必填）。
 * - 清掉上游示例 `prompt.default`（示例文案不是默认值）与 LIST 的 `empty` 占位。
 * - 忽略 `IGNORED_MEDIA_FIELDS`：只有单值落点、本仓库又没有对应输入通道的可选修饰媒体
 *   （如 `maskUrl`）既不是参考图输入，也不进路由落点，否则会变成「面板能填、请求永不发送」。
 *
 * 输入缺失、JSON 非法或合并后为空 → 非零退出且不写任何输出。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = resolve(PACKAGE_DIR, "data/models.json");

const MEDIA = new Set(["IMAGE", "VIDEO", "AUDIO"]);

/** 上游可选修饰媒体：无输入通道、也无单值落点，不能冒充参考图输入。 */
const IGNORED_MEDIA_FIELDS = new Set(["maskUrl"]);

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

const familyOf = (e) => {
  if (/^rhart-image-g-/.test(e)) return "GPT Image";
  if (/^rhart-image-n-/.test(e)) return "Nano Banana";
  if (/^(seedream-v\d|dola-Seedream)/.test(e) || /^bytedance\/jimeng-/.test(e)) return "Seedream";
  if (/^bytedance\/seedance-/.test(e) || /^seedance-v1/.test(e) || /^rhart-video\/sparkvideo-/.test(e)) return "Seedance";
  return null;
};
const opOf = (e) => e.slice(e.lastIndexOf("/") + 1);
const logicalIdOf = (e) => e.slice(0, e.lastIndexOf("/"));

/** 属性 schema 由 params 映射（prompt 的 default 是上游示例文案，忽略）；被忽略的媒体字段返回 null。 */
function paramToSchema(p) {
  if (IGNORED_MEDIA_FIELDS.has(p.fieldKey)) return null;
  const s = {};
  switch (p.type) {
    case "STRING":
      s.type = "string";
      if (p.maxLength) s.maxLength = p.maxLength;
      break;
    case "INT":
      s.type = "integer";
      break;
    case "FLOAT":
      s.type = "number";
      break;
    case "BOOLEAN":
      s.type = "boolean";
      break;
    case "LIST": {
      const opts = (p.options || [])
        .map((o) => o.value)
        .filter((v) => v !== undefined && v !== null && v !== "" && String(v).toLowerCase() !== "empty");
      s.type = "string";
      if (opts.length > 0) s.enum = opts;
      break;
    }
    case "IMAGE":
    case "VIDEO":
    case "AUDIO": {
      s.type = "array";
      s["x-pptask-semantic"] = `reference-${p.type.toLowerCase()}`;
      if (p.accept) {
        try { s["x-accept"] = JSON.parse(p.accept); } catch { /* 保留原始为字符串 */ s["x-accept"] = p.accept; }
      }
      if (p.maxSize) s["x-max-size"] = p.maxSize;
      break;
    }
    default:
      s.type = "string";
  }
  if (p.fieldKey !== "prompt" && !MEDIA.has(p.type) && p.defaultValue !== undefined && p.defaultValue !== null && p.defaultValue !== "" && String(p.defaultValue).toLowerCase() !== "empty") {
    s.default = p.defaultValue;
  }
  return s;
}

/** 每个操作声明的媒体字段（用于路由 collect）。 */
function mediaFields(op) {
  return op.params
    .filter((p) => MEDIA.has(p.type) && !IGNORED_MEDIA_FIELDS.has(p.fieldKey))
    .map((p) => p.fieldKey);
}

/** 选择路由 collect：给动作类型挑选正确的媒体字段，避免首尾帧/多图混用。 */
function routeCollect(op, outputType) {
  const media = mediaFields(op);
  if (outputType !== "video") return media;
  // 视频：多模态收集 imageUrls/videoUrls/audioUrls；i2v 只收集首尾帧字段；t2v 无媒体。
  const multimodal = media.filter((f) => f === "imageUrls" || f === "videoUrls" || f === "audioUrls");
  const frames = media.filter((f) => f === "firstFrameUrl" || f === "lastFrameUrl" || f === "imageUrl");
  if (multimodal.length > 0) return multimodal;
  return frames.length > 0 ? frames : media;
}

function buildRoutes(g) {
  const byOp = new Map(g.ops.map((o) => [o.op, o]));
  const has = (op) => byOp.has(op);
  const route = (op, match) => ({ endpoint: byOp.get(op).endpoint, collect: routeCollect(byOp.get(op), g.outputType), match });
  const routes = [];
  if (g.outputType === "image") {
    // ultra 是独立 endpoint、不接受 quality 字段：以仅路由用的 `quality` 参数区分（插件发送前剥离）。
    if (has("edit-ultra")) routes.push(route("edit-ultra", { minImages: 1, param: { key: "quality", value: "ultra" } }));
    if (has("text-to-image-ultra")) routes.push(route("text-to-image-ultra", { param: { key: "quality", value: "ultra" } }));
    const editOp = has("edit") ? "edit" : has("image-to-image") ? "image-to-image" : null;
    if (editOp) routes.push(route(editOp, { minImages: 1 }));
    if (has("text-to-image")) routes.push(route("text-to-image", {}));
  } else {
    if (has("multimodal-video")) routes.push(route("multimodal-video", { anyMedia: ["video", "audio"], minImages: 2 }));
    const i2v = has("image-to-video") ? "image-to-video" : has("image-to-video-fast") ? "image-to-video-fast" : null;
    if (i2v) routes.push(route(i2v, { minImages: 1 }));
    if (has("reference-to-video")) routes.push(route("reference-to-video", { anyMedia: ["video"] }));
    const t2v = has("text-to-video") ? "text-to-video" : has("text-to-video-fast") ? "text-to-video-fast" : null;
    if (t2v) routes.push(route(t2v, {}));
  }
  return routes.length > 0 ? routes : [{ endpoint: g.ops[0].endpoint, collect: mediaFields(g.ops[0]), match: {} }];
}

/** 该逻辑模型是否有仅用于路由的 `quality`（存在 ultra endpoint 时）。 */
function hasQualityRouting(g) {
  return g.ops.some((o) => o.op === "edit-ultra" || o.op === "text-to-image-ultra");
}

function unionProperties(g) {
  const props = {};
  const requiredCount = new Map();
  for (const o of g.ops) {
    for (const p of o.params) {
      if (IGNORED_MEDIA_FIELDS.has(p.fieldKey)) continue;
      if (!props[p.fieldKey]) {
        const schema = paramToSchema(p);
        if (schema === null) continue;
        props[p.fieldKey] = schema;
      }
      if (p.required && !MEDIA.has(p.type)) requiredCount.set(p.fieldKey, (requiredCount.get(p.fieldKey) || 0) + 1);
    }
  }
  const n = g.ops.length;
  const required = [...requiredCount.entries()].filter(([, c]) => c === n).map(([k]) => k);
  if (hasQualityRouting(g)) {
    props.quality = { type: "string", enum: ["standard", "ultra"], default: "standard", "x-pptask-routing": true };
  }
  return { type: "object", required, properties: props };
}

/** defaultInput = 各字段的非空 default（媒体字段除外；上游 prompt.default 是示例文案，忽略）。 */
function defaultInput(schema) {
  const out = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (key === "prompt") continue;
    if (value["x-pptask-semantic"]) continue;
    if (value.default === undefined || value.default === null || value.default === "") continue;
    out[key] = value.default;
  }
  return out;
}

function groupsOf(entries) {
  const groups = new Map();
  for (const m of entries) {
    const fam = familyOf(m.endpoint);
    if (!fam) continue;
    if (/deprecated|已下架|star/i.test(m.endpoint + " " + (m.display_name || ""))) continue;
    const id = logicalIdOf(m.endpoint);
    let g = groups.get(id);
    if (!g) { g = { id, family: fam, outputType: m.output_type, label: m.name_cn || m.display_name || id, ops: [] }; groups.set(id, g); }
    g.ops.push({ op: opOf(m.endpoint), endpoint: m.endpoint, params: m.params || [] });
  }
  return groups;
}

function toLogicalModel(g) {
  const inputSchema = unionProperties(g);
  const promptRequired = g.ops.every((o) => (o.params.find((p) => p.fieldKey === "prompt") || {}).required === true);
  return {
    id: g.id,
    family: g.family,
    outputType: g.outputType,
    label: g.label,
    promptRequirement: promptRequired ? "required" : "optional",
    cancel: "unsupported",
    routes: buildRoutes(g),
    inputSchema,
    defaultInput: defaultInput(inputSchema)
  };
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
const models = [...groupsOf(mergeEntries(inputs)).values()].map(toLogicalModel);

if (models.length === 0) usage("输入没有产生任何逻辑模型");

if (!prune) {
  const generated = new Set(models.map((m) => m.id));
  const preserved = readBase(base).filter((m) => typeof m?.id === "string" && m.id !== "" && !generated.has(m.id));
  if (preserved.length > 0) {
    console.error(`preserved upstream-missing models (${preserved.length}): ${preserved.map((m) => m.id).join(", ")}`);
    models.push(...preserved);
  }
}

models.sort((a, b) => a.id.localeCompare(b.id));
process.stdout.write(JSON.stringify({ provider: "runninghub", generatedFrom: "models_registry.json", models }, null, 2) + "\n");
