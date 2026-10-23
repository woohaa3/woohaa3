/**
 * 新转换对象摆放只执行一次 + 旧重复摆放修复
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 2.4 / design D6）。
 *
 * 复现本次真实片场：人物 + 被握着的长剑（非零 offset/scale/yaw）。剑的外层 offset 曾同时写进
 * `localTransform` 与 `model.placement`，组合器执行两层后握柄升到建模高度 2.73。
 */
import { describe, expect, it } from "vitest";
import {
  normalizeFilmSetConversionOutput,
  filmSetConversionCandidateSchema
} from "./film-set-conversion/instruction.js";
import { validateFilmSetConversionCandidate } from "./film-set-conversion/candidate.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { filmSetContentHash, type FilmSetContent } from "./film-set-content.js";
import {
  duplicatedPlacementPreview,
  isDuplicatedPlacement,
  repairDuplicatedPlacements
} from "./film-set-placement-repair.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";

const SWORD_OFFSET = { x: 0.235, y: 1.365, z: -0.025 };
const SWORD_SCRIPT = "scene.box({id:'blade',size:[0.06,0.9,0.02],position:[0,0.45,0]});";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: "hero",
        kind: "model",
        name: "人物",
        localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
        modelScript: "scene.box({id:'body',size:[0.5,1.7,0.3]});",
        modelScriptVersion: "woohaa-model-js-v2"
      },
      {
        id: "sword",
        kind: "model",
        name: "长剑",
        // 外层摆放：只在这里出现一次
        localTransform: { offset: SWORD_OFFSET, scale: 0.8, yaw: 0.4 },
        modelScript: SWORD_SCRIPT,
        modelScriptVersion: "woohaa-model-js-v2"
      }
    ],
    clips: null,
    defaultClipId: null,
    sceneCamera: { azimuth: 0, elevation: 0.2, distance: 2.65, aspect: "16:9", focusOffset: { x: 0, y: 0.1, z: 0 } },
    note: null,
    ...overrides
  };
}

describe("新转换候选：外层摆放只执行一次", () => {
  it("normalizeItem 归一内部 placement 为单位变换，localTransform 保留原值", () => {
    const normalized = normalizeFilmSetConversionOutput(candidate()) as {
      filmSetContent: { schemaVersion: number; items: Array<{ id: string; localTransform: unknown; model: { placement: unknown } }> };
    };
    expect(normalized.filmSetContent.schemaVersion).toBe(4);
    const sword = normalized.filmSetContent.items.find((item) => item.id === "sword")!;
    expect(sword.localTransform).toEqual({ offset: SWORD_OFFSET, scale: 0.8, yaw: 0.4 });
    expect(sword.model.placement).toEqual({ offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 });
    expect(isDuplicatedPlacement(sword as never)).toBe(false);
  });

  it("完整校验接受归一后的候选，且握柄与手部保持原候选相对位置", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", "2026-10-23T00:00:00.000Z");
    const normalized = normalizeFilmSetConversionOutput(candidate());
    const validated = validateFilmSetConversionCandidate({
      candidate: normalized,
      canvas,
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      title: "片场"
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const sword = validated.value.filmSetContent.items.find((item) => item.id === "sword")!;
    // 场景单位下的实际握柄位置 = 外层一次 offset（不是两倍）。
    expect(sword.localTransform.offset).toEqual(SWORD_OFFSET);
    if (sword.kind === "model") {
      expect(sword.model.placement.offset).toEqual({ x: 0, y: 0, z: 0 });
    }
    const hand = { x: 0.13, y: 1.365, z: 0.045 };
    const grip = sword.localTransform.offset;
    const distance = Math.hypot(grip.x - hand.x, grip.y - hand.y, grip.z - hand.z);
    expect(distance).toBeCloseTo(0.1262, 3);
    // 旧的重复摆放会导致 ~1.388 的场景距离，这里必须明显更近。
    expect(distance).toBeLessThan(1);
  });

  it("schema 明确要求 localTransform 为唯一外层摆放", () => {
    const schema = filmSetConversionCandidateSchema() as {
      properties: { items: { items: { anyOf: Array<{ properties: Record<string, { description?: string }> }> } } };
    };
    const modelItem = schema.properties.items.items.anyOf[0]!;
    expect(modelItem.properties.localTransform).toBeDefined();
    expect(Object.keys(modelItem.properties)).not.toContain("placement");
  });
});

function legacyContentWithDuplicatedSword(): FilmSetContent {
  const model = (script: string) => ({
    modelScript: script,
    modelScriptLanguage: "javascript" as const,
    modelScriptVersion: "woohaa-model-js-v2" as const,
    contentVersion: { revision: 1, sourceHash: script.length.toString(36), contentHash: `h${script.length}` },
    placement: { offset: { ...SWORD_OFFSET }, scale: 0.8, yaw: (0.4 * 180) / Math.PI }
  });
  return {
    schemaVersion: 4,
    items: [
      {
        id: "hero",
        kind: "model",
        name: "人物",
        localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
        model: model("scene.box({id:'body'});")
      },
      {
        id: "sword",
        kind: "model",
        name: "长剑",
        localTransform: { offset: SWORD_OFFSET, scale: 0.8, yaw: 0.4 },
        // 旧候选误把同一摆放写进内部 placement（角度制）。
        model: model(SWORD_SCRIPT)
      }
    ]
  };
}

describe("旧重复摆放修复", () => {
  it("识别重复层，并在内容身份匹配时只移除重复层", () => {
    const content = legacyContentWithDuplicatedSword();
    const sword = content.items[1]!;
    expect(isDuplicatedPlacement(sword)).toBe(true);
    const preview = duplicatedPlacementPreview(content);
    expect(preview).toEqual([{ itemId: "sword", doubledOffsetY: SWORD_OFFSET.y * 2, sceneOffsetY: SWORD_OFFSET.y }]);

    const repaired = repairDuplicatedPlacements({ content, expectedContentHash: filmSetContentHash(content) });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.repairedItemIds).toEqual(["sword"]);
    expect(repaired.changed).toBe(true);
    const nextSword = repaired.value.items[1]!;
    expect(nextSword.localTransform.offset).toEqual(SWORD_OFFSET);
    if (nextSword.kind === "model") {
      expect(nextSword.model.placement).toEqual({ offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 });
    }
    // 人物（无重复层）原样保留。
    expect(repaired.value.items[0]).toEqual(content.items[0]);
  });

  it("内容已被编辑时拒绝旧修复，不覆盖用户改动", () => {
    const content = legacyContentWithDuplicatedSword();
    const edited = { ...content, items: content.items.map((item) => item.id === "hero"
      ? { ...item, localTransform: { ...item.localTransform, offset: { x: 5, y: 0, z: 0 } } }
      : item) };
    const outcome = repairDuplicatedPlacements({ content: edited, expectedContentHash: filmSetContentHash(content) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("precondition");
    // 缺少前置条件同样拒绝（不盲改）。
    expect(repairDuplicatedPlacements({ content }).ok).toBe(false);
  });

  it("合法源模型 placement 不被误删", () => {
    const content = legacyContentWithDuplicatedSword();
    const distinct: FilmSetContent = {
      ...content,
      items: content.items.map((item) => item.id === "sword" && item.kind === "model"
        ? { ...item, model: { ...item.model, placement: { ...item.model.placement, scale: 1 } } }
        : item)
    };
    const outcome = repairDuplicatedPlacements({ content: distinct, expectedContentHash: filmSetContentHash(distinct) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changed).toBe(false);
    expect(outcome.repairedItemIds).toEqual([]);
    expect(isDuplicatedPlacement(distinct.items[1]!)).toBe(false);
  });

  it("修复产物仍是可直接解码的片场内容", () => {
    const content = legacyContentWithDuplicatedSword();
    const repaired = repairDuplicatedPlacements({ content, expectedContentHash: filmSetContentHash(content) });
    if (!repaired.ok) throw new Error(repaired.message);
    const decoded = decodeFilmSetNodeData({
      extensionId: "film-set",
      title: "片场",
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      sceneCamera: { azimuth: 0, elevation: 0.2, distance: 2.65, aspect: "16:9", focusOffset: { x: 0, y: 0.1, z: 0 } },
      filmSetContent: repaired.value,
      filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] }
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(filmSetAnimationsOf(decoded.value).clips).toHaveLength(0);
  });
});
