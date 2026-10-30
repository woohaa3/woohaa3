/**
 * owner 版本化的 nodeData 迁移（change: 2026-10-28-generic-extension-content-ownership，任务 2.5）。
 *
 * 内核不读取业务版本字段：owner 通过 `version.accessor` 告诉宿主如何读取/写入版本。
 * 迁移链按 `from → to` 顺序执行；任一步失败、链断裂或版本过新时该节点保持原样，
 * 不推进版本，也不允许半迁移写回。迁移是纯数据变换，宿主决定何时持久化。
 */
import type { ContentContribution, ContentContributionResolver, ContentMigration } from "./content-contribution.js";
import { locateContentNode } from "./content-location.js";
import type { CanvasNodeData, ServerCanvas } from "./domain/index.js";

export type ContentMigrationFailure = {
  readonly nodeId: string;
  readonly extensionId: string;
  readonly code: "content-migration-failed" | "content-migration-chain-missing" | "content-migration-too-new" | "content-migration-invalid";
  readonly from?: number;
  readonly to?: number;
};

export type ContentMigrationOutcome = {
  readonly canvas: ServerCanvas;
  readonly changed: boolean;
  readonly migrated: readonly { nodeId: string; extensionId: string; from: number; to: number }[];
  readonly failures: readonly ContentMigrationFailure[];
  /** 版本过新的节点保持只读；写入方应拒绝它们。 */
  readonly readonlyNodeIds: ReadonlySet<string>;
};

function targetVersion(migrations: readonly ContentMigration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.to), 0);
}

function migrateOne(
  nodeId: string,
  extensionId: string,
  data: CanvasNodeData,
  owner: ContentContribution
): { data: CanvasNodeData; from: number; to: number } | { failure: ContentMigrationFailure } {
  const migrations = owner.migrations ?? [];
  const accessor = owner.version;
  if (!accessor) return { failure: { nodeId, extensionId, code: "content-migration-invalid" } };
  let current: number | null;
  try {
    current = accessor.read(data);
  } catch {
    return { failure: { nodeId, extensionId, code: "content-migration-invalid" } };
  }
  if (current === null || !Number.isInteger(current) || current < 0) {
    return { failure: { nodeId, extensionId, code: "content-migration-invalid" } };
  }
  const target = targetVersion(migrations);
  if (current > target) return { failure: { nodeId, extensionId, code: "content-migration-too-new", from: current, to: target } };
  if (current === target) return { data, from: current, to: current };

  const byFrom = new Map<number, ContentMigration>();
  for (const migration of migrations) {
    if (byFrom.has(migration.from)) return { failure: { nodeId, extensionId, code: "content-migration-invalid", from: migration.from } };
    byFrom.set(migration.from, migration);
  }
  let working: unknown = structuredClone(data);
  let cursor = current;
  try {
    while (cursor < target) {
      const migration = byFrom.get(cursor);
      if (!migration) return { failure: { nodeId, extensionId, code: "content-migration-chain-missing", from: cursor, to: target } };
      if (migration.to <= cursor) return { failure: { nodeId, extensionId, code: "content-migration-invalid", from: cursor, to: migration.to } };
      working = migration.migrate(working);
      cursor = migration.to;
    }
    const written = accessor.write(working, target);
    if (typeof written !== "object" || written === null || Array.isArray(written)) {
      return { failure: { nodeId, extensionId, code: "content-migration-invalid" } };
    }
    return { data: written as CanvasNodeData, from: current, to: target };
  } catch {
    return { failure: { nodeId, extensionId, code: "content-migration-failed", from: current, to: target } };
  }
}

export function migrateCanvasContent(canvas: ServerCanvas, content: ContentContributionResolver | undefined): ContentMigrationOutcome {
  if (!content) return { canvas, changed: false, migrated: [], failures: [], readonlyNodeIds: new Set() };
  const nodeTypes = new Map(canvas.document.nodes.map((node) => [node.id, node.type]));
  const nodeData: Record<string, CanvasNodeData> = { ...canvas.nodeData };
  const migrated: { nodeId: string; extensionId: string; from: number; to: number }[] = [];
  const failures: ContentMigrationFailure[] = [];
  const readonlyNodeIds = new Set<string>();
  for (const [nodeId, data] of Object.entries(canvas.nodeData)) {
    const type = nodeTypes.get(nodeId);
    if (!type || !data) continue;
    const located = locateContentNode(content, type, data);
    if (!located.ok) {
      failures.push({ nodeId, extensionId: "unknown", code: "content-migration-invalid" });
      continue;
    }
    if (!located.location) continue;
    const extensionId = located.location.extensionId;
    const owner = content.resolve(extensionId);
    if (!owner?.migrations?.length || !owner.version) continue;
    const result = migrateOne(nodeId, extensionId, data, owner);
    if ("failure" in result) {
      failures.push(result.failure);
      if (result.failure.code === "content-migration-too-new") readonlyNodeIds.add(nodeId);
      continue;
    }
    if (result.from === result.to) continue;
    nodeData[nodeId] = result.data;
    migrated.push({ nodeId, extensionId, from: result.from, to: result.to });
  }
  if (migrated.length === 0) return { canvas, changed: false, migrated, failures, readonlyNodeIds };
  return { canvas: { ...canvas, nodeData }, changed: true, migrated, failures, readonlyNodeIds };
}
