/**
 * RunningHub 端点清单 → 逻辑模型的**唯一一套规则**。
 *
 * 两个消费者：
 * 1. `scripts/generate-models.mjs`（构建期：生成 `data/models.json` 入库）；
 * 2. `src/discovery.ts`（运行期：设置页「刷新可用模型」拉上游公开 registry 后合并）。
 *
 * 所以这里只有纯函数，不读文件、不发网络请求、不写 stdout——I/O 由两边各自负责。
 *
 * 规则（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials, design D1/D1b/D4）：
 * - 只纳管四个族：GPT Image(rhart-image-g-*)、Nano Banana(rhart-image-n-*)、
 *   Seedream(seedream-v*|dola-Seedream-*|bytedance/jimeng-*)、Seedance(bytedance/seedance-*|
 *   seedance-v1*|rhart-video/sparkvideo-*)。
 * - 剔除 deprecated / 已下架 / 含 "star" 的营销款。
 * - 按 endpoint 去掉最后一段（操作）合并为一个**逻辑模型**；操作用有序 `routes` 表达，
 *   由插件按输入（是否有图/视频/音频参考）选择具体 endpoint。
 * - 每个 route 带 `collect`（该操作的媒体字段归属），插件据此把稳定引用放入对应字段。
 * - schema = 各操作 params 的并集；required 取各操作 required 的交集，且排除媒体字段。
 * - 清掉上游示例 `prompt.default`（示例文案不是默认值）与 LIST 的 `empty` 占位。
 * - 忽略 `IGNORED_MEDIA_FIELDS`：只有单值落点、本仓库又没有对应输入通道的可选修饰媒体。
 */

const MEDIA = new Set(["IMAGE", "VIDEO", "AUDIO"]);

/** 上游可选修饰媒体：无输入通道、也无单值落点，不能冒充参考图输入。 */
export const IGNORED_MEDIA_FIELDS = new Set(["maskUrl"]);

/** endpoint → 模型族；不属于四族的返回 null。 */
export function familyOf(endpoint) {
  if (/^rhart-image-g-/.test(endpoint)) return "GPT Image";
  if (/^rhart-image-n-/.test(endpoint)) return "Nano Banana";
  if (/^(seedream-v\d|dola-Seedream)/.test(endpoint) || /^bytedance\/jimeng-/.test(endpoint)) return "Seedream";
  if (/^bytedance\/seedance-/.test(endpoint) || /^seedance-v1/.test(endpoint) || /^rhart-video\/sparkvideo-/.test(endpoint)) return "Seedance";
  return null;
}

const opOf = (endpoint) => endpoint.slice(endpoint.lastIndexOf("/") + 1);
const logicalIdOf = (endpoint) => endpoint.slice(0, endpoint.lastIndexOf("/"));

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

/** 端点级条目 → 逻辑模型（按 `id` 排序）。 */
export function logicalModelsOf(entries) {
  return [...groupsOf(entries).values()].map(toLogicalModel).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 只有增量的合并：`base` 中上游已不再返回的逻辑模型保留（RunningHub 的公开 registry
 * 比线上少，直接覆盖会把线上还在的模型删掉）。保留项原样返回并单独列出。
 */
export function mergeWithBase(models, base) {
  const generated = new Set(models.map((m) => m.id));
  const preserved = base.filter((m) => typeof m?.id === "string" && m.id !== "" && !generated.has(m.id));
  // 输出顺序与内容一样要稳定：保留项并进来后统一按 id 排序，重复生成不会产生顺序抖动。
  const merged = [...models, ...preserved].sort((a, b) => a.id.localeCompare(b.id));
  return { models: merged, preserved };
}
