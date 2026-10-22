import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { validateCanvasInputBatch } from "./dev-canvas-input.mjs";

export const INTERACTION_PERFORMANCE_PATH = "/__dev/performance/interactions";
const LIFECYCLE_STAGES = new Set([
  "app-start", "app-services", "page-services", "page-plugins", "page-resolve",
  "react-commit", "navigation-response", "navigation-dom", "navigation-load",
  "canvas-first-sync", "renderer-load", "wasm-module", "wasm-init", "renderer-ready",
  "renderer-first-render", "image-prepare", "video-first-frame", "model-prepare",
  "image-load-decode", "image-raster", "image-submit", "focus-bitmap-decode"
]);
const OUTCOMES = new Set(["ok", "error", "cancelled"]);
const MAX_BODY_BYTES = 128 * 1024;
const QUANTILE_WINDOW = 4096;
const KINDS = new Set(["pan", "zoom", "drag", "model-preview"]);
const SOURCES = new Set(["pointer", "mouse", "trackpad", "pinch", "zoom-by", "zoom-to", "zoom-to-fit", "model-preview", "command"]);
const PHASES = new Set(["down", "move", "up", "cancel", "wheel", "control", "settled"]);
const RELEASES = new Set(["click", "no-change", "move-submit", "reparent-submit", "attach-submit", "extension-consumed", "cancelled", "release-error"]);
const LONG_TASK_SUPPORT = new Set(["observed", "unavailable"]);
const TIMING_SCHEMAS = new Set([1, 2, 3]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
// Keep individual metrics bounded before cumulative aggregation. Timestamps
// have a separate bound so real epoch timeOrigin values remain valid.
const MAX_METRIC_VALUE = 1e12;
const boundedMetric = (value) => finite(value) && value <= MAX_METRIC_VALUE;
const timestamp = (value) => finite(value) && value <= Number.MAX_SAFE_INTEGER;

/** 可选分段字段白名单（毫秒，非负有限值）。 */
const SEGMENT_KEYS = [
  "coordinatesMs", "hitQueryMs", "domRectMs", "selectionMs",
  "dropPlanMs", "positionPlanMs", "attachPlanMs", "historyPlanMs", "pendingProjectionMs", "commandWireMs", "statePublishMs", "editSubmitSyncMs", "frameWorkMs", "rafWaitMs", "longTaskMs"
];
/** 帧诊断字段白名单（非负整数/有限值）。 */
const FRAME_KEYS = [
  "diagnosticsReadMs", "diagnosticsReads",
  "rustRenderMs", "rustRenderFrames",
  "rustRenderQueueMs", "rustRenderPrepareMs", "rustRenderPrepareFrames",
  "rustGeometryBuilds", "rustGeometryBuildMs", "rustGeometryCacheHits",
  "sceneBuilds", "sceneSubmits", "sceneDedupes", "sceneStringify", "fingerprintBuilds",
  "viewportSubmits", "observerSubmits", "positionSubmits", "modelRegistrations", "worldSnapshotBuilds", "pickCandidateBuilds",
  "meshBuilds", "cardBlockBuilds", "cardDecorationBuilds", "edgeBlockBuilds", "containerBlockBuilds", "frameTotalMs", "intervalId", "intervalMs", "frameExecutions", "frameExecutionMs", "sceneBuildMs", "fingerprintMs", "stringifyMs", "wasmAcceptMs"
];

/** 只保留白名单内、非负有限的分段字段；其余丢弃（不写任意浏览器 payload）。 */
function sanitizeSegments(segments) {
  if (!segments || typeof segments !== "object") return undefined;
  const out = {};
  for (const key of SEGMENT_KEYS) {
    if (boundedMetric(segments[key])) out[key] = segments[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 只保留白名单内的帧诊断字段。 */
function sanitizeFrame(frame) {
  if (!frame || typeof frame !== "object") return undefined;
  const out = {};
  for (const key of FRAME_KEYS) {
    if (boundedMetric(frame[key]) && (key.endsWith("Ms") || Number.isSafeInteger(frame[key]))) out[key] = frame[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 构建身份；未知/缺省显式 unknown（不猜测）。 */
function sanitizeIdentity(identity) {
  if (!identity || typeof identity !== "object") return { js: "unknown", wasm: "unknown", mode: "unknown" };
  const text = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : "unknown");
  return { js: text(identity.js, 128), wasm: text(identity.wasm, 128), mode: text(identity.mode, 32) };
}

function sanitizeSurface(surface) {
  if (!surface || typeof surface !== "object" || !boundedMetric(surface.width) || !boundedMetric(surface.height)) return undefined;
  return { width: surface.width, height: surface.height };
}

function sanitizeResources(value) {
  if (!value || value.scope !== "last-reported" || !timestamp(value.observedAt)) return undefined;
  const pick = (input, keys) => {
    if (!input || typeof input !== "object") return undefined;
    const out = {};
    for (const key of keys) if (boundedMetric(input[key]) && Number.isSafeInteger(input[key])) out[key] = input[key];
    return Object.keys(out).length ? out : undefined;
  };
  const models = pick(value.models, ["qualityVersion", "roots", "parts", "low", "medium", "high", "modelEntities",
    "staticBatches", "batchedParts", "instanceVertices", "instanceTriangles", "uniqueMeshes", "uniqueVertices",
    "uniqueTriangles", "retainedMeshes", "retainedMaterials", "retainedMeshBytes", "retainedBatchBytes", "captureSnapshots", "captureSnapshotBytes",
    "peakRetainedBatchBytes", "batchCreatedBufferBytes", "activeUniqueBatchBufferBytes", "activeBatchSourceBufferBytes"]);
  const previews = pick(value.previews, ["active", "pending", "textureBytes", "visible", "retained", "live", "deferred", "ready"]);
  const simplification = pick(value.simplification, ["active", "pending", "sourceBytes", "cppWorkspaceActiveBytes", "cppWorkspacePeakBytes", "generated", "cancelled"]);
  return models || previews || simplification ? { scope: "last-reported", observedAt: value.observedAt,
    ...(["bevy-automatic", "spatial-merge", "explicit-instancing"].includes(value.staticBatchStrategy) ? { staticBatchStrategy: value.staticBatchStrategy } : {}),
    ...(models ? { models } : {}), ...(previews ? { previews } : {}), ...(simplification ? { simplification } : {}) } : undefined;
}

function validateBatch(batch) {
  if (batch?.category === "canvas-input") return validateCanvasInputBatch(batch);
  if (!batch || typeof batch.recorderId !== "string" || !/^[\w-]{1,80}$/.test(batch.recorderId)
    || !Number.isSafeInteger(batch.sequence) || batch.sequence < 0
    || !Number.isSafeInteger(batch.dropped) || batch.dropped < 0
    || !Array.isArray(batch.samples) || batch.samples.length > 256) throw new Error("invalid batch");
  const meta = batch.metadata;
  if (!meta || typeof meta.userAgent !== "string" || meta.userAgent.length > 512
    || !timestamp(meta.timeOrigin) || ![meta.width, meta.height, meta.pixelRatio].every(boundedMetric)) throw new Error("invalid metadata");
  if (meta.timingSchema !== undefined && !TIMING_SCHEMAS.has(meta.timingSchema)) throw new Error("invalid timing schema");
  if (meta.longTaskSupport !== undefined && !LONG_TASK_SUPPORT.has(meta.longTaskSupport)) throw new Error("invalid long task support");
  if (batch.category !== undefined && batch.category !== "lifecycle") throw new Error("invalid category");
  const lifecycle = batch.category === "lifecycle";
  const samples = batch.samples.map((sample) => {
    if (lifecycle) {
      if (!sample || !LIFECYCLE_STAGES.has(sample.stage) || !OUTCOMES.has(sample.outcome)
        || !finite(sample.startedAt) || !finite(sample.durationMs) || typeof sample.hidden !== "boolean"
        || !Number.isSafeInteger(sample.spanId) || sample.spanId < 1) throw new Error("invalid lifecycle sample");
      return { stage: sample.stage, startedAt: sample.startedAt, durationMs: sample.durationMs,
        outcome: sample.outcome, hidden: sample.hidden, spanId: sample.spanId };
    }
    if (!sample || !KINDS.has(sample.kind) || !SOURCES.has(sample.source)
      || !PHASES.has(sample.phase) || !timestamp(sample.startedAt) || !boundedMetric(sample.handlerMs)
      || !(sample.nextRafMs === null || boundedMetric(sample.nextRafMs)) || typeof sample.hidden !== "boolean") {
      throw new Error("invalid sample");
    }
    // Whitelist fields: never write arbitrary browser payloads or user content.
    const clean = { kind: sample.kind, source: sample.source, phase: sample.phase,
      startedAt: sample.startedAt, handlerMs: sample.handlerMs,
      nextRafMs: sample.nextRafMs, hidden: sample.hidden };
    if (sample.kind === "drag" && (sample.phase === "up" || sample.phase === "cancel" || (sample.source === "command" && sample.phase === "settled")) && RELEASES.has(sample.release)) clean.release = sample.release;
    if (sample.kind === "drag" && Number.isSafeInteger(sample.commandId) && sample.commandId > 0) clean.commandId = sample.commandId;
    if (sample.kind === "drag" && sample.source === "command" && sample.phase === "settled"
      && clean.commandId && ["committed", "rejected", "unavailable"].includes(sample.command?.outcome)
      && finite(sample.command.waitMs) && sample.command.waitMs <= 60_000) {
      clean.command = { outcome: sample.command.outcome, waitMs: sample.command.waitMs };
    }
    const segments = sanitizeSegments(sample.segments);
    if (segments) clean.segments = segments;
    const frame = sanitizeFrame(sample.frame);
    if (frame) clean.frame = frame;
    if (Number.isSafeInteger(sample.intervalId) && sample.intervalId >= 0) clean.intervalId = sample.intervalId;
    if (sample.context && boundedMetric(sample.context.pixelRatio)) clean.context = {
      identity: sanitizeIdentity(sample.context.identity), pixelRatio: sample.context.pixelRatio,
      ...(sanitizeSurface(sample.context.surface) ? { surface: sanitizeSurface(sample.context.surface) } : {}),
      ...(sanitizeResources(sample.context.resources) ? { resources: sanitizeResources(sample.context.resources) } : {})
    };
    return clean;
  });
  return { ...(lifecycle ? { category: "lifecycle" } : {}), recorderId: batch.recorderId, sequence: batch.sequence, dropped: batch.dropped,
    metadata: { userAgent: meta.userAgent, timeOrigin: meta.timeOrigin,
      width: meta.width, height: meta.height, pixelRatio: meta.pixelRatio,
      timingSchema: meta.timingSchema ?? 1, loadId: typeof meta.loadId === "string" && meta.loadId.length <= 128 ? meta.loadId : "unknown",
      identity: sanitizeIdentity(meta.identity), longTaskSupport: meta.longTaskSupport ?? "unavailable",
      ...(sanitizeSurface(meta.surface) ? { surface: sanitizeSurface(meta.surface) } : {}) }, samples };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; reject(Object.assign(new Error("body too large"), { status: 413 })); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}

function observe(metric, value) {
  metric.count += 1;
  metric.total += value;
  metric.max = Math.max(metric.max, value);
  if (metric.values.length < QUANTILE_WINDOW) metric.values.push(value);
  else metric.values[(metric.count - 1) % QUANTILE_WINDOW] = value;
}
const metric = () => ({ count: 0, total: 0, max: 0, values: [] });
function stats(metric) {
  const sorted = [...metric.values].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1].toFixed(2) : "—";
  return [metric.count ? (metric.total / metric.count).toFixed(2) : "—",
    percentile(0.5), percentile(0.95), metric.count ? metric.max.toFixed(2) : "—"];
}

function segmentStats(group, key) {
  let entry = group.segments.get(key);
  if (!entry) { entry = metric(); group.segments.set(key, entry); }
  return entry;
}

/** Dev-only disk collector. A fixed session directory, never a path supplied by the browser. */
export async function createInteractionPerformanceSink({ root, outputDir, logger = console.warn }) {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(path.resolve(root, outputDir ?? "artifacts/performance"), sessionId);
  await mkdir(directory, { recursive: true });
  let commit = null;
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Non-git checkouts are supported. */ }
  await writeFile(path.join(directory, "session.json"), JSON.stringify({ sessionId,
    startedAt: new Date().toISOString(), commit, mode: "vite-dev", node: process.version,
    quantileWindow: QUANTILE_WINDOW,
    timingSchema: 3,
    timing: "handlerMs: synchronous input handler (schema v2: wheel covers pre-gate hit/coords); nextRafMs: handler start to next rAF callback, not presentation/GPU time; schema v3: rafWaitMs is wait; frameExecutionMs is measured JS execution; one frame owner per interval; GPU/presentation unavailable"
  }, null, 2) + "\n");
  const groups = new Map();
  const lifecycleGroups = new Map();
  const resources = new Map();
  /** 配置分组：recorder/DPR/surface/构建身份（标明混合总体）。 */
  const configs = new Map();
  let received = 0;
  let dropped = 0;
  let batches = 0;
  let queue = Promise.resolve();
  const summary = () => {
    const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) =>
      `| ${key} | ${group.handler.count} | ${stats(group.handler).join(" | ")} | ${group.raf.count} | ${stats(group.raf).join(" | ")} |`);
    const configRows = [...configs].sort(([a], [b]) => a.localeCompare(b)).map(([key, config]) =>
      `| ${key} | ${config.samples} | DPR ${config.pixelRatio} | ${config.surface ?? "—"} | ${config.timingSchema} | ${config.longTaskSupport} |`);    // 分段/帧实际工作列：每个分段键单独一行，只在其有样本时输出。
    const segmentKeys = new Set();
    for (const group of groups.values()) for (const key of group.segments.keys()) segmentKeys.add(key);
    const lifecycleRows = [...lifecycleGroups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) =>
      `| ${key} | ${entry.count} | ${stats(entry).join(" | ")} |`);
    const partitions = { execution: [], waiting: [], counters: [] };
    for (const [key, entry] of groupKeyByField(groups, segmentKeys)) {
      const field = key.slice(key.lastIndexOf("/") + 1);
      const waiting = ["commandConfirmMs", "rafWaitMs", "frameWorkMs", "frame.frameTotalMs", "frame.intervalMs"].includes(field);
      const counter = field.startsWith("frame.") && !field.endsWith("Ms");
      partitions[counter ? "counters" : waiting ? "waiting" : "execution"].push(
        `| ${key} | ${entry.count} | ${stats(entry).join(" | ")} |`);
    }
    const metricTable = (title, description, rows) => rows.length ? [title, "", description, "",
      "| 分组/字段 | 样本数 | 平均 | P50 | P95 | 最大 |",
      "| --- | ---: | ---: | ---: | ---: | ---: |", ...rows, ""] : [];
    const resourceRows = [...resources].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) =>
      `| ${key} | ${key.endsWith("Bytes") ? "bytes" : /simplification\.(generated|cancelled)$/.test(key) ? "cumulative count" : "count/version"} | ${entry.count} | ${stats(entry).join(" | ")} |`);
    return ["# 开发交互性能报告", "", `更新时间：${new Date().toISOString()}`,
      `已接收 ${received} 条事件，${batches} 个批次；客户端报告丢失 ${dropped} 条。`, "",
      "单位为 ms。次数、平均值、最大值覆盖整个会话；P50/P95 使用每组最近 4096 条有效样本。",
      "handlerMs 为完整同步处理耗时；v2 起 wheel 计时覆盖门禁后的前置模型预览命中与坐标换算，不能与旧 v1 滚轮 handlerMs 直接比较。",
      "下一帧等待从处理器入口计时到下一次 rAF 回调，包含处理耗时；不代表画面呈现或 GPU 耗时。",
      "后台页面及没有等到 rAF 的样本仅计入处理耗时，不计入下一帧分布。", "",
      ...(lifecycleRows.length ? ["## 启动与素材准备（独立墙钟计时）", "",
        "分组包含配置、阶段、结果与前后台；失败/取消不混入成功分布。阶段可能重叠，不能相加。",
        "首次 render 为 Bevy Render 调度完成，纹理提交为同步 WASM 调用接受；均不是 GPU 呈现确认。",
        "| 配置/阶段/结果/可见性 | 样本数 | 平均 | P50 | P95 | 最大 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |", ...lifecycleRows, ""] : []),
      "## 按操作/来源/阶段分组", "",
      "| 操作/来源/阶段 | 事件数 | 处理平均 | 处理 P50 | 处理 P95 | 处理最大 | rAF 样本数 | rAF 平均 | rAF P50 | rAF P95 | rAF 最大 |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows, "",
      "## 配置分组（混合总体请分别查看）", "",
      "| recorder/DPR/surface/构建身份 | 样本数 | DPR | surface | schema | 长任务观察 |",
      "| --- | ---: | ---: | ---: | ---: | --- |", ...configRows, "",
      ...metricTable("## 执行与长任务重叠分布（ms）", "包含输入分段及独立帧执行；longTaskMs 是输入区间重叠，不是额外执行组成。不同范围不能相加作为 handlerMs。", partitions.execution),
      ...metricTable("## 等待与旧口径分布（ms）", "命令确认、rAF 等待及旧 frameWork/frameTotal 是墙钟区间，不是 handler 组成或 GPU 执行。", partitions.waiting),
      ...metricTable("## 帧工作计数分布（count）", "帧/区间关联的执行计数；共享 intervalId 只标识区间，不参与统计。", partitions.counters),
      ...(resourceRows.length ? ["## 事件关联资源快照", "",
        "最近一次 JS 读取 Rust 诊断的缓存值，非事件发生时实时采样。observedAt 为 JS 读取时间，不是 Rust 生产时间；重复事件可能引用同一快照，分位数按事件加权。缺失字段不可用，不补零。", "",
        "| 配置/字段 | 单位 | 事件样本数 | 平均 | P50 | P95 | 最大 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |", ...resourceRows, ""] : []),
      ""].join("\n");
  };
  await writeFile(path.join(directory, "summary.md"), summary());
  await writeFile(path.join(directory, "canvas-input.jsonl"), "");

  /** 分段键跨分组的汇总（按 `分组/字段` 命名）。 */
  function* groupKeyByField(groupMap, keys) {
    for (const [groupKey, group] of [...groupMap].sort(([a], [b]) => a.localeCompare(b))) {
      for (const key of [...keys].sort()) {
        const entry = group.segments.get(key);
        if (entry && entry.count > 0) yield [`${groupKey}/${key}`, entry];
      }
    }
  }

  const persist = async (batch) => {
    if (batch.category === "canvas-input") {
      await appendFile(path.join(directory, "canvas-input.jsonl"), JSON.stringify({ receivedAt: new Date().toISOString(), ...batch }) + "\n");
      return;
    }
    await appendFile(path.join(directory, batch.category === "lifecycle" ? "lifecycle.jsonl" : "interactions.jsonl"), JSON.stringify({ receivedAt: new Date().toISOString(), ...batch }) + "\n");
    batches += 1;
    dropped += batch.dropped;
    received += batch.samples.length;
    const meta = batch.metadata;
    const configKey = `${batch.recorderId}/DPR${meta.pixelRatio}/${meta.surface ? `${meta.surface.width}x${meta.surface.height}` : "unknown"}/js:${meta.identity.js}/wasm:${meta.identity.wasm}`;
    const config = configs.get(configKey) ?? configs.set(configKey, {
      samples: 0, pixelRatio: meta.pixelRatio, timingSchema: meta.timingSchema,
      longTaskSupport: meta.longTaskSupport,
      surface: meta.surface ? `${meta.surface.width}x${meta.surface.height}` : undefined
    }).get(configKey);
    config.samples += batch.samples.length;
    for (const sample of batch.samples) {
      if (batch.category === "lifecycle") {
        const key = `${configKey}/mode:${meta.identity.mode}/${sample.stage}/${sample.outcome}/${sample.hidden ? "background" : "foreground"}`;
        if (!lifecycleGroups.has(key)) lifecycleGroups.set(key, metric());
        observe(lifecycleGroups.get(key), sample.durationMs);
        continue;
      }
      const context = sample.context ?? meta;
      const eventConfig = `schema${meta.timingSchema}/DPR${context.pixelRatio}/surface:${context.surface ? `${context.surface.width}x${context.surface.height}` : "unknown"}/mode:${context.identity.mode}/js:${context.identity.js}/wasm:${context.identity.wasm}/batch:${sample.context?.resources?.staticBatchStrategy ?? "unknown"}`;
      if (sample.context?.resources) {
        for (const section of ["models", "previews", "simplification"]) {
          for (const [field, value] of Object.entries(sample.context.resources[section] ?? {})) {
            const resourceKey = `${eventConfig}/${section}.${field}`;
            if (!resources.has(resourceKey)) resources.set(resourceKey, metric());
            observe(resources.get(resourceKey), value);
          }
        }
      }
      const key = `${eventConfig}/${sample.kind}/${sample.source}/${sample.phase}${sample.release ? `/${sample.release}` : ""}${sample.command ? `/${sample.command.outcome}` : ""}`;
      if (!groups.has(key)) groups.set(key, { handler: metric(), raf: metric(), segments: new Map() });
      const group = groups.get(key);
      observe(group.handler, sample.handlerMs);
      if (!sample.hidden && sample.nextRafMs !== null) observe(group.raf, sample.nextRafMs);
      if (sample.command) observe(segmentStats(group, "commandConfirmMs"), sample.command.waitMs);
      // 分段/帧实际工作：记录每类字段分布，供验证工作量与时间组成。
      if (sample.segments) {
        for (const [field, value] of Object.entries(sample.segments)) observe(segmentStats(group, field), value);
      }
      if (sample.frame) {
        for (const [field, value] of Object.entries(sample.frame)) {
          if (field !== "intervalId") observe(segmentStats(group, `frame.${field}`), value);
        }
      }
    }
    const temporary = path.join(directory, "summary.md.tmp");
    await writeFile(temporary, summary());
    await rename(temporary, path.join(directory, "summary.md"));
  };

  const handle = async (req, res) => {
    const respond = (status, message = "") => {
      res.statusCode = status;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(message);
    };
    if (req.method !== "POST") return respond(405, "POST required");
    if (!req.headers["content-type"]?.startsWith("application/json")) return respond(415, "JSON required");
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return respond(403, "same origin required"); }
      catch { return respond(403, "invalid origin"); }
    }
    let batch;
    try { batch = validateBatch(JSON.parse(await readBody(req))); }
    catch (error) { return respond(error.status ?? 400, "invalid performance payload"); }
    // Serialize writes and recover the queue after errors; no disk work on the input thread.
    const operation = queue.then(() => persist(batch));
    queue = operation.catch(() => {});
    try { await operation; respond(204); }
    catch (error) { logger(`[performance] 无法保存性能数据：${error.message}`); respond(500, "performance write failed"); }
  };
  return { directory, handle, close: () => queue };
}
