/**
 * 导演场（复合资产 + film-set）旧默认标题幂等迁移与展示名契约测试
 * （change: 2026-10-10-add-game-furnace-extension；2026-10-11 身份迁移）。
 *
 * 只验证：canonical 节点类型为复合资产 `composite-asset`（业务 film-set）、只改系统旧默认标题、
 * 自定义标题与全部技术字段保留、第二次加载不再改写（幂等）。
 */
import { describe, expect, it } from "vitest";
import { normalizeCanvas } from "./domain/normalization.js";
import type { ServerCanvas } from "./domain/types.js";
import {
  DIRECTOR_STUDIO_DEFAULT_TITLE,
  LEGACY_ANIMATION_DEFAULT_TITLE
} from "./director-studio-title.js";
import { COMPOSITE_ASSET_NODE_TYPE, FILM_SET_EXTENSION_ID } from "./domain/core/composite-asset-identity.js";

function canvas(nodeData: Record<string, unknown>, type: string = COMPOSITE_ASSET_NODE_TYPE): ServerCanvas {
  return {
    id: "c1",
    revision: 1,
    title: "画布",
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "n1", type, position: { x: 0, y: 0 }, width: 320, height: 200 }],
      edges: [],
      updatedAt: "2026-10-10T00:00:00.000Z"
    },
    // 片场业务身份：仅复合资产节点注入 extensionId（D11）；其它类型保留调用方数据。
    nodeData: Object.fromEntries(
      Object.entries(nodeData).map(([id, data]) => [
        id,
        type === COMPOSITE_ASSET_NODE_TYPE ? { extensionId: FILM_SET_EXTENSION_ID, ...(data as object) } : data
      ])
    ) as ServerCanvas["nodeData"],
    assets: [],
    jobs: [],
    updatedAt: "2026-10-10T00:00:00.000Z"
  };
}

describe("导演场更名（任务 2.1/2.2）", () => {
  it("常量区分当前默认名与历史默认名", () => {
    expect(DIRECTOR_STUDIO_DEFAULT_TITLE).toBe("导演场");
    expect(LEGACY_ANIMATION_DEFAULT_TITLE).toBe("3D 片场");
  });

  it("系统旧默认标题被改写为新默认名，节点类型不变、技术字段保留", () => {
    const normalized = normalizeCanvas(
      canvas({
        n1: {
          title: LEGACY_ANIMATION_DEFAULT_TITLE,
          modelScript: "scene.box();",
          modelScriptVersion: "woohaa-model-js-v2",
          timeline: { duration: 4, loop: true }
        }
      })
    );
    // 不迁类型：仍是 canonical 复合资产（业务 film-set）。
    expect(normalized.document.nodes[0]!.type).toBe(COMPOSITE_ASSET_NODE_TYPE);
    expect(normalized.nodeData.n1!.title).toBe(DIRECTOR_STUDIO_DEFAULT_TITLE);
    expect(normalized.nodeData.n1!.modelScript).toBe("scene.box();");
    expect(normalized.nodeData.n1!.timeline).toEqual({ duration: 4, loop: true });
  });

  it("自定义标题（含恰好等于新默认名）不改写；迁移幂等", () => {
    const custom = normalizeCanvas(canvas({ n1: { title: "我的片场" } }));
    expect(custom.nodeData.n1!.title).toBe("我的片场");
    // 已经是新默认名：第二次加载不再匹配旧值。
    const alreadyNew = normalizeCanvas(canvas({ n1: { title: DIRECTOR_STUDIO_DEFAULT_TITLE } }));
    expect(alreadyNew.nodeData.n1!.title).toBe(DIRECTOR_STUDIO_DEFAULT_TITLE);
    const idempotent = normalizeCanvas(alreadyNew);
    expect(idempotent.nodeData.n1!.title).toBe(DIRECTOR_STUDIO_DEFAULT_TITLE);
  });

  it("非 animation3d 节点即使标题等于旧默认名也不改写", () => {
    const normalized = normalizeCanvas(canvas({ n1: { title: LEGACY_ANIMATION_DEFAULT_TITLE } }, "text"));
    expect(normalized.document.nodes[0]!.type).toBe("text");
    // 文本节点的标题保持原样（仅 animation3d 参与迁移）。
    expect(normalized.nodeData.n1!.title).toBe(LEGACY_ANIMATION_DEFAULT_TITLE);
  });
});
