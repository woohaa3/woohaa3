import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry, decideContentWrite, type ContentNodeDataCodec } from "./content-contribution.js";
import { decideContentAction } from "./content-interaction.js";
import { migrateCanvasContent } from "./content-migration.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

/**
 * 未来私有扩展的闭环验收（change: 2026-10-28-generic-extension-content-ownership，任务 7.4）。
 *
 * 这里刻意使用仓库中不存在的 `npc-production` 身份，证明新增业务只需要注册 owner 贡献，
 * 不需要修改内核 id、命令联合、编辑字段表或渲染协议。
 */

type NpcData = { extensionId: "npc-production"; version: number; name: string; entityId: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const codec: ContentNodeDataCodec = {
  decode(data) {
    return isRecord(data) && data.extensionId === "npc-production" && typeof data.name === "string" && typeof data.entityId === "string"
      ? { ok: true, value: data }
      : { ok: false, code: "npc-invalid", reason: "npc-invalid" };
  },
  validatePatch(_previous, patch) {
    if (!isRecord(patch) || typeof patch.name !== "string" || patch.name.trim() === "") {
      return { code: "npc-patch-invalid", reason: "name 必须是非空字符串" };
    }
    return null;
  },
  normalize: (data) => data,
  sanitizeRuntime: (data) => data,
  copy(data, context) {
    const input = data as NpcData;
    const entityId = context.nodeIds.get(input.entityId) ?? `${input.entityId}-copy`;
    return { data: { ...input, name: `${input.name}（副本）`, entityId }, assetRefs: [], remap: { [input.entityId]: entityId } };
  },
  diff(before, after) {
    return { ok: true, forward: after, inverse: before };
  }
};

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({
    extensionId: "npc-production",
    targetModes: ["npc-production"],
    eventOwners: ["npc-production"],
    nodeData: codec,
    commands: {
      kinds: ["npc.rename"],
      decode(envelope) {
        if (!envelope.nodeId || !isRecord(envelope.payload) || typeof envelope.payload.name !== "string") {
          return { ok: false, code: "npc-command-invalid", reason: "npc-command-invalid" };
        }
        return { ok: true, value: { nodeId: envelope.nodeId, name: envelope.payload.name } };
      },
      apply(value, canvas) {
        const input = value as { nodeId: string; name: string };
        const current = canvas.nodeData[input.nodeId] as NpcData | undefined;
        if (!current) return { ok: false, code: "npc-node-missing", reason: "npc-node-missing" };
        return { ok: true, canvas: { ...canvas, nodeData: { ...canvas.nodeData, [input.nodeId]: { ...current, name: input.name } } } };
      },
      satisfied(value, canvas) {
        const input = value as { nodeId: string; name: string };
        return (canvas.nodeData[input.nodeId] as NpcData | undefined)?.name === input.name;
      }
    },
    edit: {
      matchesNode: (type, data) => type === "composite-asset" && isRecord(data) && data.extensionId === "npc-production",
      plan: () => ({ ok: true, plan: { forward: { preconditions: [], operations: [] }, inverse: { preconditions: [], operations: [] } } }),
      apply({ direction, edit, preconditions, canvas }) {
        const input = edit as { nodeId: string; name: string; previous?: string };
        const current = canvas.nodeData[input.nodeId] as NpcData | undefined;
        const expected = preconditions[0] as { name?: string } | undefined;
        if (!current) return { ok: false, code: "npc-node-missing", reason: "npc-node-missing" };
        if (expected?.name !== undefined && current.name !== expected.name) {
          return { ok: false, code: "edit-precondition-failed", reason: "stale" };
        }
        const name = direction === "forward" ? input.name : input.previous ?? "old";
        return { ok: true, canvas: { ...canvas, nodeData: { ...canvas.nodeData, [input.nodeId]: { ...current, name } } } };
      },
      satisfied: () => true
    },
    migrations: [{ extensionId: "npc-production", from: 1, to: 2, migrate: (data) => ({ ...(data as object), version: 2 }) }],
    version: {
      read: (data) => (isRecord(data) && typeof data.version === "number" ? data.version : null),
      write: (data, version) => ({ ...(data as object), version })
    },
    interaction: {
      isManagedNode: (type, data) => type === "composite-asset" && isRecord(data) && data.extensionId === "npc-production",
      selectionActions: () => ({ allowed: true }),
      hoverPlaybackTarget: () => ({ ownerNodeId: "npc-owner", entityId: "npc-entity" }),
      doubleClickTarget: () => ({ kind: "npc-production", nodeId: "npc-owner", entityId: "npc-entity" })
    }
  });
  return result;
}

function canvasWithNpc() {
  const canvas = createEmptyWoohaa3ServerCanvas("npc-canvas", "2026-10-29T00:00:00.000Z");
  canvas.document.nodes.push({ id: "npc-1", type: "composite-asset", position: { x: 0, y: 0 } });
  canvas.nodeData["npc-1"] = { extensionId: "npc-production", version: 1, name: "守卫", entityId: "npc-entity" } as never;
  return canvas;
}

describe("npc-production 通用注册闭环", () => {
  it("只靠 owner 注册即可写入、命令、复制与 owner 交互", () => {
    const content = registry();
    const write = decideContentWrite("npc-production", {}, canvasWithNpc().nodeData["npc-1"], content);
    expect(write).toEqual({ ok: true, extensionId: "npc-production" });

    const renamed = applyCanvasCommands(canvasWithNpc(), [{
      type: "extension.command",
      extensionId: "npc-production",
      nodeId: "npc-1",
      kind: "npc.rename",
      payload: { name: "队长" }
    }], { content });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect((renamed.canvas.nodeData["npc-1"] as NpcData).name).toBe("队长");

    const copied = codec.copy(renamed.canvas.nodeData["npc-1"], { nodeIds: new Map(), createId: (prefix) => `${prefix}-copy` });
    expect(copied.data).toMatchObject({ name: "队长（副本）", entityId: "npc-entity-copy" });
    expect(copied.remap).toEqual({ "npc-entity": "npc-entity-copy" });

    expect(decideContentAction(content, "delete", "composite-asset", renamed.canvas.nodeData["npc-1"])).toEqual({ allowed: true });
    expect(decideContentAction(content, "delete", "composite-asset", { extensionId: "unknown" })).toEqual({ allowed: false, reason: "content-owner-unavailable" });
  });

  it("owner 编辑可前向执行、逆向前滚并在过期条件下拒绝", () => {
    const content = registry();
    const forward = applyCanvasCommands(canvasWithNpc(), [{
      type: "extension.edit",
      extensionId: "npc-production",
      direction: "forward",
      edit: { nodeId: "npc-1", name: "队长", previous: "守卫" },
      preconditions: [{ name: "守卫" }]
    }], { content });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect((forward.canvas.nodeData["npc-1"] as NpcData).name).toBe("队长");

    const inverse = applyCanvasCommands(forward.canvas, [{
      type: "extension.edit",
      extensionId: "npc-production",
      direction: "inverse",
      edit: { nodeId: "npc-1", name: "队长", previous: "守卫" },
      preconditions: [{ name: "队长" }]
    }], { content });
    expect(inverse.ok).toBe(true);
    if (!inverse.ok) return;
    expect((inverse.canvas.nodeData["npc-1"] as NpcData).name).toBe("守卫");

    const stale = applyCanvasCommands(inverse.canvas, [{
      type: "extension.edit",
      extensionId: "npc-production",
      direction: "forward",
      edit: { nodeId: "npc-1", name: "队长" },
      preconditions: [{ name: "错误" }]
    }], { content });
    expect(stale).toMatchObject({ ok: false, rejection: { code: "content-command-rejected" } });
  });

  it("owner 迁移版本化内容后仍可读写", () => {
    const migrated = migrateCanvasContent(canvasWithNpc(), registry());
    expect(migrated.changed).toBe(true);
    expect((migrated.canvas.nodeData["npc-1"] as NpcData).version).toBe(2);
    expect(migrated.failures).toEqual([]);
  });
});
