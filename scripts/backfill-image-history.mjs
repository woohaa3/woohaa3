#!/usr/bin/env node
/**
 * 为“已经显示但从未登记历史”的图片节点补登当前版本。
 *
 * 背景：历史条目原本只在生成/编辑结算/恢复留档时产生；导入、粘贴、画布脚本创建的图片
 * 只有当前 outputAssetId，合并时会被判定为没有可合并的当前版本。本脚本调用 Canvas
 * Service 的补登逻辑，把当前图片输出登记为 image-baseline 版本。
 *
 * 只写 node_generation_history，不提交画布 command，不推进 canvas revision。
 *
 * 用法（在仓库根目录）：
 *   node client/scripts/backfill-image-history.mjs --db .local/canvas-dev.sqlite
 *   node client/scripts/backfill-image-history.mjs --db .local/canvas-dev.sqlite --apply
 *   node client/scripts/backfill-image-history.mjs --db ... --canvas canvas-... --apply
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isMergeEligibleNode } from "../web/contracts/dist/index.js";
import {
  NodeHistoryApplicationService,
  SqliteNodeHistoryRepository,
  currentIdentityOf
} from "../web/services/canvas-service/dist/index.js";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = readArg("--db") ?? process.env.WOOHAA3_CANVAS_SQLITE_PATH;
const canvasFilter = readArg("--canvas");
const apply = process.argv.includes("--apply");
if (!dbPath) {
  console.error("缺少 --db <sqlite 路径>（或设置 WOOHAA3_CANVAS_SQLITE_PATH）");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(2);
}

const readOnly = new DatabaseSync(dbPath, { readOnly: true });
let projections;
try {
  projections = readOnly
    .prepare("select canvas_id, projection_json from canvas_yjs_documents where projection_json is not null")
    .all();
} finally {
  readOnly.close();
}

const repository = new SqliteNodeHistoryRepository({ path: dbPath, busyTimeoutMs: 10_000 });
let totalInserted = 0;
let totalDuplicates = 0;
let totalSkipped = 0;

try {
  for (const row of projections) {
    const canvasId = String(row.canvas_id);
    if (canvasFilter && canvasId !== canvasFilter) continue;
    let canvas;
    try {
      canvas = JSON.parse(String(row.projection_json));
    } catch {
      console.warn(`[skip] ${canvasId}: projection_json 无法解析`);
      continue;
    }
    const imageNodes = canvas.document.nodes.filter((node) =>
      node.type === "image"
      && isMergeEligibleNode({ node, data: canvas.nodeData?.[node.id] })
    );
    const candidates = [];
    for (const node of imageNodes) {
      if (typeof canvas.nodeData?.[node.id]?.outputAssetId !== "string") continue;
      const identity = currentIdentityOf(canvas, node.id, "image");
      if (!identity) continue;
      const entries = await repository.listForNode(canvasId, node.id);
      const matched = entries.some((entry) =>
        entry.kind === "image"
        && entry.payload.kind !== "failure"
        && entry.currentIdentity === identity
      );
      if (!matched) candidates.push({ nodeId: node.id, identity });
    }
    console.log(`${canvasId}: 图片节点 ${imageNodes.length}，待补登 ${candidates.length}`);
    if (candidates.length > 0) {
      for (const candidate of candidates) console.log(`  - ${candidate.nodeId}  ${candidate.identity}`);
    }
    if (!apply || candidates.length === 0) continue;

    const service = new NodeHistoryApplicationService({
      repository,
      resolveRoom: async (requestedCanvasId) => {
        if (requestedCanvasId !== canvasId) return null;
        return {
          exportCanvas: () => ({ ok: true, canvas }),
          lookupCommand: async () => null,
          submit: async () => ({ ok: false, code: "read-only", message: "补登脚本不提交画布命令" })
        };
      },
      logger: () => undefined
    });
    const result = await service.backfillCurrentImageHistory(canvasId);
    totalInserted += result.inserted.length;
    totalDuplicates += result.duplicates.length;
    totalSkipped += result.skipped.length;
    console.log(`  补登 ${result.inserted.length}：${result.inserted.join(", ") || "-"}`);
    if (result.duplicates.length > 0) console.log(`  已存在 ${result.duplicates.length}：${result.duplicates.join(", ")}`);
    if (result.skipped.length > 0) {
      console.log(`  跳过 ${result.skipped.length}：${result.skipped.map((item) => `${item.nodeId}(${item.reason})`).join(", ")}`);
    }
  }
} finally {
  repository.close();
}

console.log(`完成：补登 ${totalInserted}，已存在 ${totalDuplicates}，跳过 ${totalSkipped}${apply ? "" : "（dry-run，未写入；加 --apply 执行）"}`);
