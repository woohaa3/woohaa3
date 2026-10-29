import { readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { filmSetTestMigrations } from "../../../../../test-support/managed-shot-commands.js";
const migrateSqliteCanvasBeforeStartup = (filename: string) => migrateBeforeStartup(filename, { managedMigrations: filmSetTestMigrations });
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Y from "yjs";
import {
  canonicalFilmSetFields,
  FILM_SET_CONTENT_VERSION,
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  createMotionSnapshot,
  decodeFilmSetNodeData
} from "@woohaa3/contracts";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { loadNodeSqlite } from "../sqlite/sqlite-loader.js";
import { migrateSqliteCanvasBeforeStartup as migrateBeforeStartup } from "./startup.js";
import {
  auditFilmSetSceneSpace,
  legacyDisplayMapping,
  needsFilmSetSceneSpaceMigration,
  planFilmSetSceneSpaceNode
} from "../../animation/film-set-scene-space-migration.js";

/**
 * 片场坐标契约 schema 3 → 4 的启动前迁移
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 4.2/4.3 / design D5）。
 *
 * 断言：旧世界单位镜头按该节点当时的显示映射反解成场景单位；已是 schema 4 时重跑无净变化；
 * 缺少节点尺寸/无法等价表达时纯计划显式阻断并保留原件，不按数值猜测。
 */

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function legacyNodeData(cameraMotionScript =
  `motion.camera.tween({ id: "dolly", property: "distance", startTime: 0, endTime: 4, from: 2.65, to: 1.325, easing: "linear" });`) {
  const base = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: 'scene.box({id:"character",size:[0.6,1.7,0.3]});', modelScriptVersion: "woohaa-model-js-v2" },
    timeline: { duration: 0, loop: false }
  });
  return canonicalFilmSetFields({
    ...base,
    sceneCamera: { ...base.sceneCamera, distance: 2.65, focusOffset: { x: 0, y: 0.5, z: 0 } },
    filmSetContent: { ...base.filmSetContent, schemaVersion: 3 } as never,
    filmSetAnimations: {
      schemaVersion: 3,
      defaultClipId: "clip",
      clips: [{
        id: "clip",
        name: "动作",
        kind: "dynamic" as const,
        timeline: { duration: 4, loop: false },
        initialCamera: { ...base.sceneCamera, distance: 2.65, focusOffset: { x: 0, y: 0.5, z: 0 } },
        cameraMotion: createMotionSnapshot({
          motionScript: cameraMotionScript,
          basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" }
        }),
        bindings: []
      }]
    }
  } as never);
}

function writeProfile(
  nodeData: Record<string, unknown>,
  now: string,
  projection: "source" | "derived" = "source"
) {
  const canvas = createEmptyWoohaa3ServerCanvas("scene-space", now);
  canvas.document.nodes.push({ id: "film", type: "composite-asset", width: 260, height: 195, position: { x: 100, y: 60 } } as never);
  canvas.nodeData.film = nodeData as never;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-scene-space-"));
  directories.push(directory);
  const filename = path.join(directory, "custom-canvas.sqlite");
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE canvas_yjs_documents(canvas_id TEXT PRIMARY KEY,format_version TEXT,room_epoch TEXT,snapshot BLOB,snapshot_seq INTEGER,revision INTEGER,projection_json TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE canvas_yjs_updates(canvas_id TEXT,seq INTEGER,sha256 TEXT,update_bytes BLOB);`);
  const doc = serverCanvasToYDoc(canvas as never);
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  // `source`：旧客户端写入的正是这份 projection（当前 codec 按设计拒绝 schema 3，故直接写源 JSON）。
  // `derived`：真实库的另一种状态——文档被重建/提交过一次，projection 由当前 codec 从同一份 raw
  // 派生（schema 3 内容按规范化被剥除），而 raw 仍保留旧内容。
  const stored = projection === "source" ? canvas : derivedProjection(snapshot, now);
  db.prepare("INSERT INTO canvas_yjs_documents VALUES(?,?,?,?,?,?,?,?,?)").run(
    canvas.id,
    "woohaa3-ycanvas-v2",
    "epoch",
    snapshot,
    0,
    canvas.revision,
    JSON.stringify(stored),
    now,
    now
  );
  return { db, filename };
}

/** 用当前生产 codec 从同一份 raw 派生 projection：这正是应用真实写入的形态。 */
function derivedProjection(snapshot: Uint8Array, now: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  const exported = yDocToServerCanvas(doc, { now });
  doc.destroy();
  if (!exported.ok) throw new Error(exported.failure.message);
  return exported.canvas;
}

describe("片场坐标契约迁移（纯计划）", () => {
  it("用旧显示映射反解距离与焦点偏移，并重写镜头轨道", () => {
    const nodeData = legacyNodeData();
    const animation = decodeFilmSetNodeData(nodeData, { acceptedContentVersions: [3] });
    if (!animation.ok) throw new Error(animation.reason);
    const display = legacyDisplayMapping({ animation: animation.value, nodeSize: { width: 260, height: 195 } });
    expect(display).not.toBeNull();
    const scale = display!.scale;
    expect(scale).toBeGreaterThan(0);

    const planned = planFilmSetSceneSpaceNode(nodeData, { nodeSize: { width: 260, height: 195 } });
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.changed).toBe(true);
    expect(planned.value.filmSetContent.schemaVersion).toBe(FILM_SET_CONTENT_VERSION);
    expect(planned.value.sceneCamera.distance).toBeCloseTo(2.65 / scale, 6);
    expect(planned.value.sceneCamera.focusOffset.y).toBeCloseTo(0.5 / scale, 6);
    const clip = planned.value.filmSetAnimations!.clips[0]!;
    expect(clip.initialCamera.distance).toBeCloseTo(2.65 / scale, 6);
    // 轨道被改写成场景单位，并仍可执行、可复现。
    expect(clip.cameraMotion.motionScript).toContain("motion.camera.tween");
    expect(clip.cameraMotion.sourceHash).not.toBe("camera");
    // 重跑幂等。
    const again = planFilmSetSceneSpaceNode(canonicalFilmSetFields(planned.value), { nodeSize: { width: 260, height: 195 } });
    expect(again.ok && again.changed === false).toBe(true);
  });

  it("缺少节点尺寸时阻断，不猜单位", () => {
    const nodeData = legacyNodeData();
    expect(needsFilmSetSceneSpaceMigration(nodeData)).toBe(true);
    const planned = planFilmSetSceneSpaceNode(nodeData, { nodeSize: null });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.conflict).toBe("missing-node-size");
  });

  it("dry-run 审计把每类片场分别标为 current / migratable / conflict", () => {
    const nodeData = legacyNodeData();
    expect(auditFilmSetSceneSpace(nodeData, { width: 260, height: 195 }).status).toBe("migratable");
    expect(auditFilmSetSceneSpace(nodeData, null)).toMatchObject({ status: "conflict", conflict: "missing-node-size" });
    expect(auditFilmSetSceneSpace({ filmSetContent: { schemaVersion: 4, items: [] } }, null).status).toBe("current");
    expect(auditFilmSetSceneSpace({ filmSetContent: { schemaVersion: 3, items: "bad" } }, { width: 1, height: 1 }))
      .toMatchObject({ status: "conflict", conflict: "invalid-content" });
  });

  it("无法等价表达的镜头轨道阻断该节点", () => {
    const nodeData = legacyNodeData(`motion.camera.orbit({ speed: 1 });`);
    const planned = planFilmSetSceneSpaceNode(nodeData, { nodeSize: { width: 260, height: 195 } });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(["unsupported-motion", "invalid-content"]).toContain(planned.conflict);
  });

  it("已是当前 schema 时 no-op", () => {
    expect(needsFilmSetSceneSpaceMigration({ filmSetContent: { schemaVersion: 4, items: [] } })).toBe(false);
  });
});

describe("片场坐标契约迁移（启动前）", () => {
  it("升级到 schema 4 并保持重跑无净变化", () => {
    const now = "2026-10-23T00:00:00.000Z";
    const { db, filename } = writeProfile(legacyNodeData(), now);
    try {
      const result = migrateSqliteCanvasBeforeStartup(filename);
      expect(result.changed).toBe(true);
      const row = db.prepare("SELECT * FROM canvas_yjs_documents").get()!;
      const migrated = JSON.parse(String(row.projection_json));
      expect(readFilmSetAnimationProjection(migrated, "film")!.filmSetContent.schemaVersion).toBe(FILM_SET_CONTENT_VERSION);
      expect(readFilmSetAnimationProjection(migrated, "film")!.sceneCamera.distance).not.toBe(2.65);
      expect(readFilmSetAnimationProjection(migrated, "film")!.filmSetAnimations!.clips[0]!.cameraMotion.motionScript).toContain("motion.camera.tween");
      // 迁移产物必须是生产严格解码可接受的 schema 4。
      expect(readFilmSetAnimationProjection(migrated, "film")).not.toBeNull();
      expect(migrated.nodeData.film.filmSetContent).toBeUndefined();
      expect(migrateSqliteCanvasBeforeStartup(filename)).toEqual({ changed: false });
    } finally {
      db.close();
    }
  });

  it("projection 已是当前 codec 的规范化形态时仍能迁移（raw 保留旧内容）", () => {
    const now = "2026-10-23T00:00:00.000Z";
    const { db, filename } = writeProfile(legacyNodeData(), now, "derived");
    try {
      // 前置条件：projection 已由当前 codec 派生（可保留旧 nodeData 供只读兼容）。
      const result = migrateSqliteCanvasBeforeStartup(filename);
      expect(result.changed).toBe(true);
      const row = db.prepare("SELECT * FROM canvas_yjs_documents").get()!;
      const migrated = JSON.parse(String(row.projection_json));
      expect(readFilmSetAnimationProjection(migrated, "film")!.filmSetContent.schemaVersion).toBe(FILM_SET_CONTENT_VERSION);
      expect(readFilmSetAnimationProjection(migrated, "film")).not.toBeNull();
      expect(migrated.nodeData.film.filmSetContent).toBeUndefined();
      // 迁移后 raw 与 projection 一致，重启无净变化。
      expect(migrateSqliteCanvasBeforeStartup(filename)).toEqual({ changed: false });
    } finally {
      db.close();
    }
  });

  it("派生视图也不匹配时仍然拒绝（不放过陈旧/半写 projection）", () => {
    const now = "2026-10-23T00:00:00.000Z";
    const { db, filename } = writeProfile(legacyNodeData(), now, "derived");
    try {
      const stored = JSON.parse(String(db.prepare("SELECT projection_json FROM canvas_yjs_documents").get()!.projection_json));
      // 篡改一个 raw 不存在的 nodeData 值：既不是 raw 原样，也不是当前 codec 的派生结果。
      stored.nodeData.film = { ...stored.nodeData.film, title: "被改过的标题" };
      db.prepare("UPDATE canvas_yjs_documents SET projection_json = ?").run(JSON.stringify(stored));
      expect(() => migrateSqliteCanvasBeforeStartup(filename)).toThrow(/projection-mismatch/);
      // 拒绝时不得改动数据。
      expect(db.prepare("SELECT room_epoch FROM canvas_yjs_documents").get()!.room_epoch).toBe("epoch");
    } finally {
      db.close();
    }
  });

  it("projection 缺节点时仍然拒绝", () => {
    const now = "2026-10-23T00:00:00.000Z";
    const { db, filename } = writeProfile(legacyNodeData(), now, "derived");
    try {
      const stored = JSON.parse(String(db.prepare("SELECT projection_json FROM canvas_yjs_documents").get()!.projection_json));
      stored.document.nodes = [];
      db.prepare("UPDATE canvas_yjs_documents SET projection_json = ?").run(JSON.stringify(stored));
      expect(() => migrateSqliteCanvasBeforeStartup(filename)).toThrow(/projection-mismatch/);
    } finally {
      db.close();
    }
  });
});
