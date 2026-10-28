/**
 * 拍摄镜头 schema2 → schema3 + 预览闭包的**离线迁移纯计划**
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 3.1/3.2 / design D9）。
 *
 * 由启动前迁移与离线 CLI 共用；只在开放仓储/room 前使用，不进入浏览器或实时读取链路。
 * 复用既有 model-native migration 的离线 Yjs 源读取（备份/dry-run/verify/restore 模式），但不修改
 * 原工具既有迁移目标：本工具只处理已是 items-only（filmSetContent schema3）但动画仍是 schema2
 * 的片场，补 `kind` 与预览节点闭包，并原子收敛 checkpoint/projection/update tail/epoch。
 *
 * 纯计划 + 单一 apply 入口：`planMigration(db)` 不写库，`applyMigration(db, plan)` 只在 CLI 的
 * 独占事务内执行。不丢内容：零时长却带动作/时序的镜头明确阻断并报告，不裁剪也不猜时长。
 */
import { compareByZIndexThenId, YJS_CANVAS_FORMAT_VERSION, serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  canonicalFilmSetFields,
  parseCanvasAggregate,
  readNodeWidth,
  readNodeHeight,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  isFilmSetNode,
  managedNodeRelationOf,
  shotPreviewNodeId,
  type ServerCanvas
} from "@woohaa3/contracts";
import { planFilmSetNodeV3 } from "../../animation/film-set-shooting-shot-migration.js";
import { auditFilmSetSceneSpace, planFilmSetSceneSpaceNode } from "../../animation/film-set-scene-space-migration.js";
import { animationDefinitionIdentityFromPayload } from "../core/node-history-service/current-state.js";
import { loadOfflineYjsCanvasSources } from "./offline-yjs-source.mjs";
import { createHash, randomUUID } from "node:crypto";

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry);
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
function fail(message: string): never { throw new Error(message); }

export type MigrationOptions = { transaction?: boolean; managedMigrations?: readonly import("@woohaa3/contracts").ManagedNodeMigrationAdapter[] };

/** 画布内全部片场节点（composite-asset + film-set 身份）。 */
function filmSetNodeIds(canvas: ServerCanvas): string[] {
  return canvas.document.nodes
    .filter((node) => isFilmSetNode(node.type, canvas.nodeData[node.id]))
    .map((node) => node.id)
    .sort();
}

/** 从源镜头派生应存在的预览闭包（含稳定 ID 与布局尺寸）。 */
function desiredPreviews(canvas: ServerCanvas, filmSetId: string) {
  const decoded = decodeFilmSetNodeData(canvas.nodeData[filmSetId]);
  if (!decoded.ok) fail(`片场 ${filmSetId} 内容非法：${decoded.reason}`);
  const collection = filmSetAnimationsOf(decoded.value);
  if (collection.schemaVersion !== 3) fail(`片场 ${filmSetId} 动画未完成 schema3 迁移`);
  return collection.clips.map((clip) => ({
    clipId: clip.id,
    nodeId: shotPreviewNodeId(filmSetId, clip.id),
    aspect: aspectRatioOf(clip.initialCamera.aspect)
  }));
}

function aspectRatioOf(aspect: string): number {
  const parts = String(aspect).split(":");
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 16 / 9;
}

type HistoryWrite = { row: Record<string, unknown>; payload: unknown; currentIdentity: string; bytes: number; changed: boolean };

/** 迁移历史条目 payload 中的 `animation`（schema2→schema3），不丢其他 metadata。 */
function convertHistoryRow(row: Record<string, unknown>): HistoryWrite {
  const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  const { entry, identity } = convertHistoryEntry(payload);
  const currentIdentity = identity ?? String(row.current_identity);
  return {
    row,
    payload: entry,
    currentIdentity,
    bytes: Buffer.byteLength(JSON.stringify(entry), "utf8"),
    changed: stable(entry) !== stable(payload) || currentIdentity !== String(row.current_identity)
  };
}

/**
 * 迁移单条历史/回执条目：只改 schema2 的 `animation`，返回新条目与迁移后的内容身份（无变化返回 null 身份）。
 *
 * 身份用生产同一公式重算，保证历史恢复与「当前内容」比较一致。
 */
function convertHistoryEntry(payload: Record<string, unknown>): { entry: Record<string, unknown>; identity: string | null } {
  const animation = payload.animation as Record<string, unknown> | undefined;
  if (!animation || animation.schemaVersion !== 2) return { entry: payload, identity: null };
  const probe = {
    extensionId: "film-set",
    title: "迁移",
    scenePlacement: animation.scenePlacement,
    sceneCamera: animation.sceneCamera,
    filmSetContent: animation.filmSetContent,
    filmSetAnimations: animation.filmSetAnimations
  };
  const migrated = planFilmSetNodeV3(probe);
  if (!migrated.ok) fail(`历史条目迁移失败：${migrated.reason}`);
  const nextAnimation = {
    schemaVersion: 3 as const,
    scenePlacement: migrated.value.scenePlacement,
    sceneCamera: migrated.value.sceneCamera,
    filmSetContent: migrated.value.filmSetContent,
    filmSetAnimations: filmSetAnimationsOf(migrated.value)
  };
  return {
    entry: { ...payload, animation: { ...nextAnimation, ...(animation.origin !== undefined ? { origin: animation.origin } : {}) } },
    identity: animationDefinitionIdentityFromPayload(nextAnimation)
  };
}

type CompletionWrite = {
  row: Record<string, unknown>;
  pendingEntries: unknown[];
  contentIdentity: string;
  baselineContentIdentity: string;
  changed: boolean;
};

/**
 * 迁移 `canvas_edit_completions` 的待登记历史并同步内容身份。
 *
 * `identityRemap` 由历史条目迁移建立（旧 `current_identity` → 新身份）；outbox 里引用的旧身份
 * 据此改写，保证重启补登记时与历史条目一致。无映射时保留原字符串（状态不明但不得猜测改写）。
 */
function convertCompletionRow(row: Record<string, unknown>, identityRemap: ReadonlyMap<string, string>): CompletionWrite {
  const pendingEntries = JSON.parse(String(row.pending_entries_json)) as unknown[];
  if (!Array.isArray(pendingEntries)) fail(`非法 edit completion outbox：${String(row.request_id)}`);
  const identity = (value: unknown): string => {
    const text = String(value);
    return identityRemap.get(text) ?? text;
  };
  const converted = pendingEntries.map((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? convertHistoryEntry(entry as Record<string, unknown>).entry
      : entry
  );
  const contentIdentity = identity(row.content_identity);
  const baselineContentIdentity = identity(row.baseline_content_identity);
  return {
    row,
    pendingEntries: converted,
    contentIdentity,
    baselineContentIdentity,
    changed:
      stable(converted) !== stable(pendingEntries) ||
      contentIdentity !== String(row.content_identity) ||
      baselineContentIdentity !== String(row.baseline_content_identity)
  };
}


/**
 * 迁移画布：拍摄镜头集合升级 → 坐标契约升级（场景单位）→ 预览闭包；返回新 checkpoint 与净变化标记。
 *
 * 坐标迁移必须在镜头集合已是 schema 3 之后执行：它要读全部片段的 `initialCamera` 与镜头运动，
 * 并按该节点当时的显示映射把世界单位反解成场景单位。缺少节点尺寸的片场明确阻断该画布，
 * 保留原件（change: 2026-10-23-isolate-film-set-camera-space，design D5）。
 */
function convertCanvas(source: { canvas: ServerCanvas; report: Record<string, unknown>; raw: { meta: { createdAt: string } } }, options: MigrationOptions) {
  let canvas: ServerCanvas = structuredClone(source.canvas);
  let changed = false;
  const conflicts: Array<{ nodeId: string; conflict: string; reason: string }> = [];
  for (const filmSetId of filmSetNodeIds(canvas)) {
    const data = canvas.nodeData[filmSetId] as Record<string, unknown>;
    const migrated = planFilmSetNodeV3(data);
    if (!migrated.ok) fail(`画布 ${canvas.id}/${filmSetId} 迁移失败：${migrated.reason}`);
    const node = canvas.document.nodes.find((entry) => entry.id === filmSetId);
    const projected = planFilmSetSceneSpaceNode(
      { ...data, ...canonicalFilmSetFields(migrated.value) },
      { nodeSize: node ? { width: readNodeWidth({ ...node, data: {} }), height: readNodeHeight({ ...node, data: {} }) } : null }
    );
    if (!projected.ok) {
      // 无法精确反解单位：报告具名冲突并**保留原件**，不按数值大小猜测
      // （change: 2026-10-23-isolate-film-set-camera-space，design D5）。
      conflicts.push({ nodeId: filmSetId, conflict: projected.conflict, reason: projected.reason });
      continue;
    }
    canvas.nodeData[filmSetId] = { ...data, ...canonicalFilmSetFields(projected.value) } as never;
    changed = changed || projected.changed;
  }
  // 冲突画布不做预览闭包重排：保留原样便于人工处理。
  if (conflicts.length > 0) {
    return {
      canvas: source.canvas,
      sourceReport: source.report,
      changed: false,
      conflicts,
      snapshot: new Uint8Array(),
      roomEpoch: String(source.report.roomEpoch),
      snapshotSeq: source.report.storageSeq,
      beforeHash: digest(source.canvas),
      afterHash: digest(source.canvas)
    };
  }
  const migrations = options.managedMigrations ?? [];
  if (new Set(migrations.map(m => m.extensionId)).size !== migrations.length || migrations.some(m => m.schemaVersion !== 1)) fail("managed-media-migration-registration-conflict");
  if (!migrations.some(m => m.extensionId === "film-set")) {
    const legacy = canvas.document.nodes.some(n => n.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE || canvas.nodeData[n.id]?.shotPreview !== undefined);
    const missing = filmSetNodeIds(canvas).some(id => desiredPreviews(canvas, id).some(p => !canvas.document.nodes.some(n => n.id === p.nodeId)));
    if (legacy || missing) fail(`managed-media-migration-unavailable: ${canvas.id}`);
  }
  for (const migration of migrations) {
    const migrated = migration.migrate(canvas);
    canvas = migrated.canvas; changed = migrated.changed || changed;
  }

  // 预览应为派生新节点：节点顺序按 zIndex 排序（与 mapping 一致）。
  canvas.document.nodes = [...canvas.document.nodes].sort(compareByZIndexThenId);
  const doc = serverCanvasToYDoc(canvas);
  try {
    doc.getMap("meta").set("createdAt", source.raw.meta.createdAt);
    const decoded = yDocToServerCanvas(doc, { now: canvas.updatedAt });
    if (!decoded.ok) fail(`目标 checkpoint 丢失或规范化内容：${canvas.id}`);
    // 域规范化会按当前 schema 剥掉不合法/过期的字段（例如非片场节点上残留的旧版
    // `filmSetContent`）。期望值同样过一遍领域校验，避免把「规范化」误判成「迁移丢数据」：
    // 真正的丢失（编码后领域视图与规范化视图不一致）仍然会被下面的比较拦住。
    const normalized = parseCanvasAggregate(canvas, { now: canvas.updatedAt });
    if (!normalized.ok) fail(`迁移结果无法通过领域校验：${canvas.id}/${normalized.failure.code}`);
    if (stable(decoded.canvas) !== stable(normalized.canvas)) {
      fail(`目标 checkpoint 丢失或规范化内容：${canvas.id}`);
    }
    return {
      canvas: decoded.canvas,
      sourceReport: source.report,
      changed,
      conflicts,
      snapshot: Y.encodeStateAsUpdate(doc),
      roomEpoch: changed ? `film-set-shooting-shots-${randomUUID()}` : String(source.report.roomEpoch),
      snapshotSeq: source.report.storageSeq,
      beforeHash: digest(source.canvas),
      afterHash: digest(decoded.canvas)
    };
  } finally {
    doc.destroy();
  }
}

/**
 * 当前 codec 对同一份 raw 会写出的 projection（`canvas` 是离线 reader 从 raw 重建的聚合）。
 *
 * 为什么需要：应用每次提交都用生产 codec 重新派生 projection，而规范化会按设计剥掉当前
 * schema 无法表达的内容（例：片场 `filmSetContent` schema < 当前版本）。这样的库里 raw 保留
 * 用户数据、projection 是规范化视图，二者本就不相等。若启动迁移仍按"原样相等"判定，就会
 * 一直拒绝开放画布；用派生视图作为期望值即可区分"缓存陈旧/半写"与"规范化差异"。
 */
const expectDerivedProjection = (canvas: ServerCanvas) => {
  const doc = serverCanvasToYDoc(canvas);
  try {
    const exported = yDocToServerCanvas(doc, { now: canvas.updatedAt });
    return exported.ok ? exported.canvas : null;
  } finally {
    doc.destroy();
  }
};

/** 纯计划：读取全部画布与历史，产出自包含、可审计的迁移计划。不写库。 */
export function planMigration(db: unknown, _options: MigrationOptions = {}) {
  const sources = loadOfflineYjsCanvasSources(db as never, {
    transaction: _options.transaction ?? true,
    expectProjection: expectDerivedProjection
  }) as Array<{ canvas: ServerCanvas; report: Record<string, unknown>; raw: { meta: { createdAt: string } } }>;
  const documents = sources.map(source => convertCanvas(source, _options));

  const tables = new Set<string>(
    (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
  );
  const historyWrites: HistoryWrite[] = [];
  const identityRemap = new Map<string, string>();
  if (tables.has("node_generation_history")) {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } })
      .prepare("SELECT * FROM node_generation_history ORDER BY canvas_id,node_id,created_at,entry_id")
      .all();
    for (const row of rows) {
      const write = convertHistoryRow(row);
      if (write.changed && String(row.current_identity) !== write.currentIdentity) {
        identityRemap.set(String(row.current_identity), write.currentIdentity);
      }
      historyWrites.push(write);
    }
  }
  const completionWrites: CompletionWrite[] = [];
  if (tables.has("canvas_edit_completions")) {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } })
      .prepare("SELECT * FROM canvas_edit_completions ORDER BY canvas_id,node_id,updated_at")
      .all();
    for (const row of rows) completionWrites.push(convertCompletionRow(row, identityRemap));
  }

  const changed =
    documents.some((document) => document.changed) ||
    historyWrites.some((write) => write.changed) ||
    completionWrites.some((write) => write.changed);
  const conflicts = documents.flatMap((document) =>
    (document.conflicts ?? []).map((entry) => ({ canvasId: document.canvas.id, ...entry }))
  );
  // dry-run 概览：逐片场列出坐标来源分类（current / migratable + 旧显示倍率 / conflict）。
  const sceneSpaceSources = sources.flatMap((source) =>
    filmSetNodeIds(source.canvas).map((nodeId) => {
      const node = source.canvas.document.nodes.find((entry) => entry.id === nodeId);
      const audit = auditFilmSetSceneSpace(
        source.canvas.nodeData[nodeId],
        node ? { width: readNodeWidth({ ...node, data: {} }), height: readNodeHeight({ ...node, data: {} }) } : null
      );
      return { canvasId: source.canvas.id, nodeId, ...audit };
    })
  );
  return {
    documents,
    historyWrites,
    completionWrites,
    changed,
    conflicts,
    report: {
      version: "film-set-shooting-shots-migration-v1",
      canvasCount: documents.length,
      historyCount: historyWrites.length,
      completionCount: completionWrites.length,
      /** 无法精确反解坐标单位、已保留原件的片场（具名诊断，不猜测）。 */
      sceneSpaceConflicts: conflicts,
      /** 每个片场的坐标来源分类（dry-run 概览；不含用户内容）。 */
      sceneSpaceSources,
      canvases: documents.map(({ canvas, sourceReport, beforeHash, afterHash, changed: documentChanged }) => ({
        canvasId: canvas.id,
        revision: canvas.revision,
        nodeCount: canvas.document.nodes.length,
        previewCount: canvas.document.nodes.filter(node => managedNodeRelationOf(canvas.nodeData[node.id])?.extensionId === "film-set").length,
        restoredUpdates: sourceReport.restoredUpdates,
        beforeHash,
        afterHash,
        changed: documentChanged
      }))
    }
  };
}

/** 只在启动前或 CLI 的独占事务内调用：写入 checkpoint/projection、清理 update tail、回写历史。 */
export function applyMigration(db: unknown, plan: ReturnType<typeof planMigration>): void {
  const database = db as { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
  for (const document of plan.documents) {
    if (!document.changed) continue;
    database
      .prepare("UPDATE canvas_yjs_documents SET format_version=?,room_epoch=?,snapshot=?,snapshot_seq=?,projection_json=? WHERE canvas_id=? AND revision=?")
      .run(
        YJS_CANVAS_FORMAT_VERSION,
        document.roomEpoch,
        document.snapshot,
        document.snapshotSeq,
        JSON.stringify(document.canvas),
        document.canvas.id,
        document.canvas.revision
      );
    // 旧 update 无法再进入新 epoch：清空 update tail，由 checkpoint 承担完整恢复。
    database.prepare("DELETE FROM canvas_yjs_updates WHERE canvas_id=?").run(document.canvas.id);
  }
  for (const write of plan.historyWrites) {
    if (!write.changed) continue;
    database
      .prepare("UPDATE node_generation_history SET payload_json=?,current_identity=?,bytes=? WHERE canvas_id=? AND node_id=? AND entry_id=?")
      .run(JSON.stringify(write.payload), write.currentIdentity, write.bytes, write.row.canvas_id, write.row.node_id, write.row.entry_id);
  }
  for (const write of plan.completionWrites) {
    if (!write.changed) continue;
    database
      .prepare("UPDATE canvas_edit_completions SET pending_entries_json=?,content_identity=?,baseline_content_identity=? WHERE canvas_id=? AND node_id=? AND request_id=?")
      .run(JSON.stringify(write.pendingEntries), write.contentIdentity, write.baselineContentIdentity, write.row.canvas_id, write.row.node_id, write.row.request_id);
  }
}
