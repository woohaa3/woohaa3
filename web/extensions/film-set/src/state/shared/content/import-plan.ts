/**
 * 片场内容身份、默认内容与导入规划
 * （自 `film-set-content.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R19）。
 *
 * 内容身份哈希、默认内容、复制导入布局/规划/ID 重映射与时间线时长；复用 composition/几何
 * 层的稳定编码。纯函数、JSON-only。
 */
import type { ModelDefinition } from "../../../../../../contracts/src/canvas/model-definition.js";
import { isBoundedId, isFiniteNumber } from "../../../../../../contracts/src/validation.js";
import {
  FILM_SET_CONTENT_VERSION,
  FILM_SET_LAYOUT_STEP,
  MAX_FILM_SET_NAME_LENGTH,
  isFilmSetMediaItem,
  type FilmSetContent,
  type FilmSetImportableKind,
  type FilmSetItem,
  type FilmSetLocalTransform,
  type FilmSetMotion,
  type FilmSetOrigin,
  type FilmSetPlayback
} from "./types.js";
import {
  cloneFilmSetItem
} from "./codec.js";
import { validateItemBudget } from "./motion.js";

/**
 * 内容标识：片场完整内部集合的确定性哈希（参与片场完整身份）。
 *
 * 派生自**实际保存内容**（对象顺序、种类、变换、模型快照内容标识、媒体引用与宽高比、
 * 对象 motion/playback）；不含 origin / 临时 URL / 播放头 / schemaVersion（1 与 2 语义相同）。
 */
export function filmSetContentHash(content: FilmSetContent): string {
  return JSON.stringify(canonicalFilmSetContent(content));
}

function canonicalFilmSetContent(content: FilmSetContent): unknown {
  return {
    items: content.items.map((item) => {
      const base: Record<string, unknown> = {
        id: item.id,
        kind: item.kind,
        name: item.name,
        transform: [
          item.localTransform.offset.x,
          item.localTransform.offset.y,
          item.localTransform.offset.z,
          item.localTransform.scale,
          item.localTransform.yaw
        ]
      };
      if (item.motion) {
        base.motion = {
          sourceHash: item.motion.sourceHash,
          basedOn: item.motion.basedOnModelVersion.contentHash,
          revision: item.motion.revision
        };
      }
      if (item.playback) {
        base.playback = [item.playback.startTime, item.playback.duration, item.playback.timeScale, item.playback.loop];
      }
      if (item.kind === "model") {
        base.model = {
          language: item.model.modelScriptLanguage,
          version: item.model.modelScriptVersion,
          sourceHash: item.model.contentVersion.sourceHash,
          contentHash: item.model.contentVersion.contentHash,
          placement: [
            item.model.placement.offset.x,
            item.model.placement.offset.y,
            item.model.placement.offset.z,
            item.model.placement.scale,
            item.model.placement.yaw
          ]
        };
      } else if (isFilmSetMediaItem(item)) {
        base.assetId = item.assetId;
        base.aspectRatio = item.aspectRatio;
      } else {
        base.size = [item.size.width, item.size.depth];
      }
      return base;
    })
  };
}

/**
 * 为一次复制导入计算**错开**的默认局部变换（change design D5）。
 *
 * 不重排已有内容；新对象沿片场局部 X/Z 稳定错开，避免全部堆在原点。已有内容为空时
 * 第一个对象落在原点。基准为片场局部 Y=0（无地面时仍以 Y=0 落地）。
 */
export function layoutFilmSetImport(input: {
  existing: readonly FilmSetItem[];
  count: number;
}): FilmSetLocalTransform[] {
  const base = input.existing.length;
  const result: FilmSetLocalTransform[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const slot = base + index;
    const ring = Math.floor(slot / 4);
    const within = slot % 4;
    result.push({
      offset: {
        x: (within - 1.5) * FILM_SET_LAYOUT_STEP + ring * FILM_SET_LAYOUT_STEP * 0.5,
        y: 0,
        z: ring * FILM_SET_LAYOUT_STEP
      },
      scale: 1,
      yaw: 0
    });
  }
  return result;
}

/**
 * 为整份内容重映射内部对象 ID（复制片场用，change design D3）。
 *
 * 媒体资产共享不复制，因此 `assetId` 保持不变；只重写对象的稳定 ID。对象内 motion 中的
 * 部件目标属于对象自身，不重映射。未知字段/非法内容原样返回空集合（调用方应先经
 * `decodeFilmSetContent`）。`makeId` 必须对同一旧 id 稳定。
 */
export function remapFilmSetItemIds(
  content: FilmSetContent,
  makeId: (item: FilmSetItem, index: number) => string
): FilmSetContent {
  return {
    schemaVersion: content.schemaVersion,
    items: content.items.map((item, index) => {
      const next = cloneFilmSetItem(item);
      return { ...next, id: makeId(next, index) };
    })
  };
}

/**
 * 一次复制导入的权威来源描述（change design D4）。
 *
 * 服务端从当前权威画布重新读取 `model3d` 定义或 ready image/video asset 后填充：
 * - `model`：完整 `ModelDefinition` 快照；
 * - `image`/`video`：稳定 ready `assetId` 与固有宽高比。
 * 文本、音频、片场自身、未就绪/非法来源由调用方在进入本函数前整批拒绝。
 *
 * 画布**拖动**导入只产生 `model`（change: 2026-10-18-restrict-film-set-drop-to-models）；
 * 媒体来源仍由内容接口（MCP 导入）使用，本规划函数本身不区分调用入口。
 */
export type FilmSetImportSource =
  | { kind: "model"; name: string; model: ModelDefinition }
  | {
      kind: "image" | "video";
      name: string;
      assetId: string;
      aspectRatio: number;
      /** 媒体时长（秒）；视频导入时用于扩展片场时间线（缺省不计入）。 */
      durationSeconds?: number;
    };

export type FilmSetImportItemDraft = {
  /** 调用方提供的稳定对象 ID（集合内唯一）。 */
  id: string;
  source: FilmSetImportSource;
  origin?: Omit<FilmSetOrigin, "importedAt">;
  /** 可随导入一并写入的对象动作/播放配置（可选；默认静态）。 */
  motion?: FilmSetMotion;
  playback?: FilmSetPlayback;
};

export type FilmSetImportPlan =
  | { ok: true; items: FilmSetItem[] }
  | { ok: false; reason: string };

/**
 * 规划一次复制导入：在**已有内容之后**按稳定错开布局追加对象，不重排已有内容。
 *
 * - 全部来源必须是非 ground 的可导入种类，`itemIds` 与来源一一对应且集合内唯一；
 * - 默认变换基准为片场局部 Y=0（无地面时仍落地，不重建地面）；
 * - 任一来源非法时整批拒绝（返回 `ok:false`），绝不追加部分对象。
 */
export function planFilmSetImportItems(input: {
  existingItems: readonly FilmSetItem[];
  drafts: readonly FilmSetImportItemDraft[];
  importedAt: string;
}): FilmSetImportPlan {
  const { existingItems, drafts } = input;
  if (drafts.length === 0) return { ok: false, reason: "导入批次为空" };
  const used = new Set(existingItems.map((item) => item.id));
  for (const draft of drafts) {
    if (!isBoundedId(draft.id) || draft.id.length === 0) return { ok: false, reason: "导入对象 id 非法" };
    if (used.has(draft.id)) return { ok: false, reason: `导入对象 id 冲突：${draft.id}` };
    used.add(draft.id);
    const budget = validateItemBudget(draft.id, draft.motion, draft.playback);
    if (budget !== null) return { ok: false, reason: budget };
  }
  const transforms = layoutFilmSetImport({ existing: existingItems, count: drafts.length });
  const items: FilmSetItem[] = [];
  for (const [index, draft] of drafts.entries()) {
    const source = draft.source;
    const name = source.name.trim();
    if (name === "" || name.length > MAX_FILM_SET_NAME_LENGTH) return { ok: false, reason: "导入对象名称非法" };
    const localTransform = transforms[index]!;
    const origin: FilmSetOrigin = { importedAt: input.importedAt, ...(draft.origin ?? {}) };
    if (source.kind === "model") {
      items.push({
        id: draft.id,
        kind: "model",
        name,
        localTransform,
        model: {
          ...source.model,
          contentVersion: { ...source.model.contentVersion },
          placement: {
            offset: { ...source.model.placement.offset },
            scale: source.model.placement.scale,
            yaw: source.model.placement.yaw
          }
        },
        origin
      });
      continue;
    }
    if (!isBoundedId(source.assetId) || source.assetId.length === 0) {
      return { ok: false, reason: "导入媒体 assetId 非法" };
    }
    if (!isFiniteNumber(source.aspectRatio) || source.aspectRatio <= 0) {
      return { ok: false, reason: "导入媒体宽高比非法" };
    }
    items.push({
      id: draft.id,
      kind: source.kind,
      name,
      localTransform,
      assetId: source.assetId,
      aspectRatio: source.aspectRatio,
      origin
    });
  }
  return { ok: true, items };
}

/** 把规划出的对象追加到已有内容（不改动已有对象；真实写入升级到当前 schema）。 */
export function appendFilmSetItems(content: FilmSetContent, items: readonly FilmSetItem[]): FilmSetContent {
  return { schemaVersion: FILM_SET_CONTENT_VERSION, items: [...content.items, ...items] };
}

/**
 * 计算导入后片场时间线时长（change design D6）。
 *
 * 新导入视频超出当前时长时，默认把时长扩展到「当前时长与最长导入视频时长的最大值」，
 * 不缩短已有时间线、不修改 loop 或模型动作/镜头。
 */
export function extendedTimelineDuration(
  currentDuration: number,
  drafts: readonly FilmSetImportItemDraft[]
): number {
  let duration = Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 0;
  for (const draft of drafts) {
    if (draft.source.kind !== "video") continue;
    const candidate = draft.source.durationSeconds;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > duration) {
      duration = candidate;
    }
  }
  return duration;
}

/** 单个对象非循环动作要求的最小时间线时长（循环对象按第一周期）。 */
export function requiredItemDuration(item: FilmSetItem): number {
  const motion = item.motion;
  const playback = item.playback;
  if (!motion || motion.motionScript.trim() === "" || !playback) return 0;
  if (playback.loop) return playback.startTime + playback.duration;
  return playback.startTime + playback.duration / playback.timeScale;
}

/**
 * 计算含对象动作的完整片场要求的最小时长；不缩短已有时间线。
 *
 * 非循环动作按 `startTime + duration/timeScale`，循环按第一周期，与 design D4 一致。
 */
export function requiredFilmSetDuration(currentDuration: number, items: readonly FilmSetItem[]): number {
  let duration = Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 0;
  for (const item of items) {
    const required = requiredItemDuration(item);
    if (required > duration) duration = required;
  }
  return duration;
}

/** 复用 `FilmSetImportableKind`，保持类型可被外部按名引用。 */
export type { FilmSetImportableKind };
