/**
 * 片场对象动作：局部时间换算、适配关联与源码预算
 * （自 `film-set-content.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R19）。
 *
 * 只依赖类型叶子与 motion-script 契约；供片段 codec、操作与渲染层共用同一份语义。
 */
import {
  MOTION_REVISION_MAX,
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  basedOnModel,
  hashMotionScript,
  type MotionBasedOnModelVersion,
  type MotionDefinition,
  type MotionVersionMatch
} from "../motion-script.js";
import { fnv1a64Hex } from "../content-hash.js";
import {
  isFilmSetMediaItem,
  type FilmSetItem,
  type FilmSetMotion,
  type FilmSetPlayback
} from "./types.js";

/** 非空动作必须声明正有限 duration；无动作时 playback.duration 允许 0。 */
export function validateItemBudget(
  itemId: string,
  motion: FilmSetMotion | undefined,
  playback: FilmSetPlayback | undefined
): string | null {
  const hasMotion = motion !== undefined && motion.motionScript.trim() !== "";
  if (hasMotion) {
    if (!playback || !(playback.duration > 0)) {
      return `片场对象 ${itemId} 有动作但缺少正有限 playback.duration`;
    }
  }
  return null;
}

/**
 * 对象动作的适配关联内容 hash（design D6）。
 *
 * 模型对象使用自身模型内容版本 hash；媒体/地面使用自身规范内容定义 hash（不伪造模型源码）。
 */
export function filmSetItemAdapterHash(item: FilmSetItem): string {
  if (item.kind === "model") return item.model.contentVersion.contentHash;
  if (isFilmSetMediaItem(item)) {
    return fnv1a64Hex(`film-set-media-v1\u0000${item.kind}\u0000${item.assetId}\u0000${item.aspectRatio}`);
  }
  return fnv1a64Hex(`film-set-ground-v1\u0000${item.size.width}\u0000${item.size.depth}`);
}

/** 对象动作与自身内容的适配比较。 */
export function compareItemMotionToAdapter(item: FilmSetItem): MotionVersionMatch {
  const adapterHash = filmSetItemAdapterHash(item);
  return item.motion
    ? (item.motion.basedOnModelVersion.contentHash === adapterHash ? "matched" : "changed")
    : "matched";
}

/**
 * 生成对象动作的适配关联（初次创建或用户显式确认适配）。
 *
 * 模型使用自身模型内容版本；媒体/地面使用规范内容 hash 与 revision 1。
 */
export function establishItemMotionAdapter(item: FilmSetItem): MotionBasedOnModelVersion {
  if (item.kind === "model") return basedOnModel(item.model.contentVersion);
  return { revision: 1, contentHash: filmSetItemAdapterHash(item) };
}

/** 由源码为对象创建 `MotionDefinition`，并建立到自身内容的适配关联。 */
export function createFilmSetItemMotion(input: {
  item: FilmSetItem;
  motionScript: string;
  revision?: number;
}): MotionDefinition {
  return {
    motionScript: input.motionScript,
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: clampMotionRevision(input.revision ?? 1),
    sourceHash: hashMotionScript(input.motionScript),
    basedOnModelVersion: establishItemMotionAdapter(input.item)
  };
}

function clampMotionRevision(revision: number): number {
  if (!Number.isInteger(revision) || revision < 1) return 1;
  return Math.min(revision, MOTION_REVISION_MAX);
}
