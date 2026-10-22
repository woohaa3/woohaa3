#!/usr/bin/env node
/**
 * 从参考 catalog-data 的 models_registry.json 派生本插件的 RunningHub API 逻辑模型清单。
 *
 *   node scripts/generate-models.mjs <models_registry.json> > data/models.json
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
 */
import { readFileSync } from "node:fs";

const src = process.argv[2];
if (!src) { console.error("usage: node generate-models.mjs <models_registry.json>"); process.exit(2); }
const raw = JSON.parse(readFileSync(src, "utf8"));

const MEDIA = new Set(["IMAGE", "VIDEO", "AUDIO"]);
const familyOf = (e) => {
  if (/^rhart-image-g-/.test(e)) return "GPT Image";
  if (/^rhart-image-n-/.test(e)) return "Nano Banana";
  if (/^(seedream-v\d|dola-Seedream)/.test(e) || /^bytedance\/jimeng-/.test(e)) return "Seedream";
  if (/^bytedance\/seedance-/.test(e) || /^seedance-v1/.test(e) || /^rhart-video\/sparkvideo-/.test(e)) return "Seedance";
  return null;
};
const opOf = (e) => e.slice(e.lastIndexOf("/") + 1);
const logicalIdOf = (e) => e.slice(0, e.lastIndexOf("/"));

/** 属性 schema 由 params 映射（prompt 的 default 是上游示例文案，忽略）。 */
function paramToSchema(p) {
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
  return op.params.filter((p) => MEDIA.has(p.type)).map((p) => p.fieldKey);
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
      if (!props[p.fieldKey]) props[p.fieldKey] = paramToSchema(p);
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

const models = [...groupsOf(raw).values()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((g) => {
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
  });

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

process.stdout.write(JSON.stringify({ provider: "runninghub", generatedFrom: "models_registry.json", models }, null, 2) + "\n");
