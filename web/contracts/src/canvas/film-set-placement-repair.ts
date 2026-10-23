/**
 * 旧转换候选「重复摆放」的一次性修复计划
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 2.4 / 4.4 / design D6）。
 *
 * 2026-10-23 之前的转换候选会把同一个外层 offset/scale/yaw 同时写进 `item.localTransform` 与
 * `item.model.placement`；组合器执行两层，独立道具（例如被握着的剑）被抬到双倍高度。新候选已
 * 只写 `localTransform`（`normalizeItem` 把 placement 归一为单位变换）。
 *
 * 本模块只处理**可证实**的旧数据：
 * - 必须带精确的当前内容身份前置条件（`expectedContentHash`），作品被编辑过就拒绝；
 * - 只移除「placement 与 localTransform 完全等价」的重复层，且把 placement 归零不会丢失信息；
 * - 原生导入源的合法 placement（与 localTransform 不同）保持不变；
 * - 输出仍是完整 `FilmSetContent`，由既有权威命令提交，绝不直接写运行中数据库。
 *
 * 纯函数、JSON-only。
 */
import { filmSetContentHash, type FilmSetContent, type FilmSetItem, type FilmSetLocalTransform } from "./film-set-content.js";

const EPSILON = 1e-9;

export type FilmSetPlacementRepairOutcome =
  | { ok: true; value: FilmSetContent; changed: boolean; repairedItemIds: string[] }
  | { ok: false; code: "precondition" | "invalid-content"; message: string };

/** 判断 item 的源模型 placement 与外层摆放是否等价（重复执行同一变换）。 */
export function isDuplicatedPlacement(item: FilmSetItem): boolean {
  if (item.kind !== "model") return false;
  const placement = item.model.placement;
  const local = item.localTransform;
  if (!sameOffset(placement.offset, local.offset)) return false;
  if (Math.abs(placement.scale - local.scale) > EPSILON) return false;
  // placement.yaw 是**角度**，localTransform.yaw 是**弧度**（与渲染层一致）。
  const placementRadians = (placement.yaw * Math.PI) / 180;
  return Math.abs(normalizeAngle(placementRadians) - normalizeAngle(local.yaw)) <= 1e-6;
}

/** 生成修复后的内容：仅把重复层的 placement 归零，保留 localTransform 与其它字段。 */
export function repairDuplicatedPlacements(input: {
  content: FilmSetContent;
  /** 当前内容身份前置条件；缺失即拒绝（不能无证据地改写用户作品）。 */
  expectedContentHash?: string;
}): FilmSetPlacementRepairOutcome {
  const actual = filmSetContentHash(input.content);
  if (!input.expectedContentHash || input.expectedContentHash !== actual) {
    return {
      ok: false,
      code: "precondition",
      message: "修复前置条件不成立：当前片场内容与修复请求记录的内容身份不一致（可能已被编辑）"
    };
  }
  const repairedItemIds: string[] = [];
  const items = input.content.items.map((item): FilmSetItem => {
    if (item.kind !== "model" || !isDuplicatedPlacement(item)) return item;
    repairedItemIds.push(item.id);
    return {
      ...item,
      model: { ...item.model, placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }
    };
  });
  if (repairedItemIds.length === 0) {
    return { ok: true, value: input.content, changed: false, repairedItemIds };
  }
  return {
    ok: true,
    value: { schemaVersion: input.content.schemaVersion, items },
    changed: true,
    repairedItemIds
  };
}

/**
 * 修复预览：给出「修复前后」世界高度差，供 dry-run 报告与人工确认。
 *
 * 只做场景单位算术（`offset.y` 是场景单位），不渲染、不写库。
 */
export function duplicatedPlacementPreview(content: FilmSetContent): Array<{
  itemId: string;
  doubledOffsetY: number;
  sceneOffsetY: number;
}> {
  return content.items.flatMap((item) => (isDuplicatedPlacement(item)
    ? [{ itemId: item.id, doubledOffsetY: item.localTransform.offset.y * 2, sceneOffsetY: item.localTransform.offset.y }]
    : []));
}

function sameOffset(left: FilmSetLocalTransform["offset"], right: FilmSetLocalTransform["offset"]): boolean {
  return (
    Math.abs(left.x - right.x) <= EPSILON &&
    Math.abs(left.y - right.y) <= EPSILON &&
    Math.abs(left.z - right.z) <= EPSILON
  );
}

function normalizeAngle(radians: number): number {
  const full = Math.PI * 2;
  let value = radians % full;
  if (value > Math.PI) value -= full;
  if (value < -Math.PI) value += full;
  return value;
}
