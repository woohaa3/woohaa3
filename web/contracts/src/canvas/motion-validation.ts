/**
 * 片场片段本地检查与播放门禁
 * （change: 2026-10-05-bind-model-animation-to-shots；
 *  change: 2026-10-11-extract-film-set-extension，D10 —— items-only + 独立镜头）。
 *
 * 片段镜头来自独立 `cameraMotion`（仅允许镜头）；对象动作来自 bindings（每个 binding 只引用
 * 一个稳定 item，以其模型部件集合校验目标，并比较 binding 的适配版本与该 item 当前内容）。
 * items 只保存几何，无顶层模型/动作。
 *
 * 派生状态（versionMatch / validation / issues）只存在于本地会话，**不**写成规范数据。
 */
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { executeMotionScript } from "./motion-executor.js";
import type { MotionValidation, MotionVersionMatch } from "./motion-script.js";
import { hashMotionScript } from "./motion-script.js";
import { establishItemMotionAdapter, type FilmSetItem } from "./film-set-content.js";
import type { FilmSetClipView } from "./film-set-clip-view.js";

/** 一条检查问题（稳定 code + 可读原因；引用类问题带目标 ID）。 */
export type MotionValidationIssue = {
  code: string;
  targetId?: string;
  message: string;
};

/** 片场片段本地派生检查状态（不写规范数据）。 */
export type AnimationValidationState = {
  versionMatch: MotionVersionMatch;
  validation: MotionValidation;
  issues: MotionValidationIssue[];
};

/** 播放/预览/拍摄门禁结果。 */
export type AnimationGate = {
  canPreview: boolean;
  canCapture: boolean;
  /** 是否可提供「确认适配当前模型版本」动作。 */
  canConfirmAdaptation: boolean;
  /** 不可用时的稳定原因；可用时为 null。 */
  reason: string | null;
};

/** 模型 Scene IR op 中承载稳定部件 ID 的类型（group 与实体几何）。 */
const PART_OP_TYPES = new Set(["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"]);

export type ModelPartsResult =
  | { ok: true; partIds: Set<string> }
  | { ok: false; code: string; message: string };

/**
 * 执行模型脚本，返回可被运动引用的稳定部件 ID 集合。
 *
 * 模型脚本非法时返回稳定失败；调用方对应 `validation: unavailable`。
 */
export function modelPartIds(modelScript: string, version: string): ModelPartsResult {
  const result = executeModelScriptVersioned(modelScript, version);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  // 只接受作者**显式声明**的部件 ID（任务 1.5/R10）：自动命名（如 box_1）不能作为运动目标。
  if ("declaredIds" in result && result.declaredIds instanceof Set) {
    return { ok: true, partIds: new Set(result.declaredIds) };
  }
  const ops = (result.scene as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return { ok: true, partIds: new Set() };
  const partIds = new Set<string>();
  for (const op of ops as { t?: string; id?: unknown }[]) {
    if (typeof op.t === "string" && PART_OP_TYPES.has(op.t) && typeof op.id === "string") {
      partIds.add(op.id);
    }
  }
  return { ok: true, partIds };
}

/** binding 适配版本相对 item 当前内容是否已变化。 */
function bindingVersionMatch(item: FilmSetItem, binding: { motion?: { basedOnModelVersion: { contentHash: string } } }): MotionVersionMatch {
  if (!binding.motion) return "matched";
  return binding.motion.basedOnModelVersion.contentHash === establishItemMotionAdapter(item).contentHash ? "matched" : "changed";
}

/**
 * 对片场片段做引用与参数检查。
 *
 * - 相机脚本无法执行：`invalid`，附带原因；
 * - 任一声明动作的 binding 找不到 item / item 模型脚本无法执行：`unavailable`（无法确认引用）；
 * - 对象动作脚本语法/参数/目标非法：`invalid`，附带目标与原因；数据保留；
 * - 其余：`valid`。
 *
 * versionMatch 为所有带动作 binding 的适配比较结果（任一 changed 即 changed）。
 */
export function checkAnimationMotion(view: FilmSetClipView): AnimationValidationState {
  if (view.cameraMotion.motionScript.trim() !== "") {
    const camera = executeMotionScript(view.cameraMotion.motionScript, { duration: view.timeline.duration });
    if (!camera.ok) {
      return { versionMatch: "matched", validation: "invalid", issues: [{ code: camera.code, message: camera.message, ...(extractTarget(camera.message) ? { targetId: extractTarget(camera.message)! } : {}) }] };
    }
    if (camera.ir.modelMotion.length > 0) {
      return { versionMatch: "matched", validation: "invalid", issues: [{ code: "camera-targets-model", message: "片段镜头定义不得作用于模型部件" }] };
    }
  }
  let versionMatch: MotionVersionMatch = "matched";
  const items = new Map(view.content.items.map(item => [item.id, item]));
  for (const binding of view.clip.bindings) {
    if (!binding.motion || binding.motion.motionScript.trim() === "") continue;
    const item = items.get(binding.itemId);
    if (!item) {
      return { versionMatch, validation: "unavailable", issues: [{ code: "unknown-item", targetId: binding.itemId, message: `绑定对象 ${binding.itemId} 不存在` }] };
    }
    if (bindingVersionMatch(item, binding) === "changed") versionMatch = "changed";
    const parts = item.kind === "model"
      ? modelPartIds(item.model.modelScript, item.model.modelScriptVersion)
      : { ok: true as const, partIds: new Set<string>(["root", "", "surface"]) };
    if (!parts.ok) {
      return { versionMatch, validation: "unavailable", issues: [{ code: parts.code, targetId: binding.itemId, message: parts.message }] };
    }
    // 对象根（`root` / 空 partId）始终是合法 child 动作目标（与 buildFilmSetObjectMotions 一致）。
    if (item.kind === "model") { parts.partIds.add("root"); parts.partIds.add(""); }
    const result = executeMotionScript(binding.motion.motionScript, {
      duration: binding.playback.duration,
      partIds: parts.partIds
    });
    if (!result.ok) {
      const target = extractTarget(result.message);
      return { versionMatch, validation: "invalid", issues: [{ code: result.code, message: result.message, ...(target ? { targetId: target } : {}) }] };
    }
    if (result.ir.cameraMotion.length > 0) {
      return { versionMatch, validation: "invalid", issues: [{ code: "child-camera-motion", targetId: binding.itemId, message: `片场对象 ${binding.itemId} 绑定动作不得操作共享镜头` }] };
    }
  }
  return { versionMatch, validation: "valid", issues: [] };
}

/**
 * 由检查状态派生播放门禁。
 *
 * - 检查通过（不论 versionMatch）允许预览、播放与拍摄；
 * - 检查失败阻止播放与拍摄，但仍可显示原因与「确认适配」；
 * - 正在检查或不可用时暂不播放/拍摄。
 */
export function resolveAnimationGate(state: AnimationValidationState): AnimationGate {
  const canConfirmAdaptation = state.versionMatch === "changed";
  if (state.validation === "valid") {
    return { canPreview: true, canCapture: true, canConfirmAdaptation, reason: null };
  }
  const issue = state.issues[0];
  const reason = issue ? `${issue.code}: ${issue.message}` : "动作检查未通过";
  if (state.validation === "invalid") {
    return { canPreview: false, canCapture: false, canConfirmAdaptation, reason };
  }
  return { canPreview: false, canCapture: false, canConfirmAdaptation, reason };
}

/** 检查缓存键：区分片段镜头、全部 binding 动作源码与时间线。 */
export function animationCheckCacheKey(view: FilmSetClipView): string {
  const bindings = view.clip.bindings
    .map(binding => `${binding.itemId}:${hashMotionScript(binding.motion?.motionScript ?? "")}:${binding.playback.startTime}:${binding.playback.duration}:${binding.playback.timeScale}:${binding.playback.loop}`)
    .join(",");
  return [
    "woohaa-animation-check-v2",
    hashMotionScript(view.cameraMotion.motionScript),
    view.cameraMotion.motionScriptVersion,
    bindings,
    `${view.timeline.duration}:${view.timeline.loop}`
  ].join("\u0000");
}

function extractTarget(message: string): string | null {
  const match = /模型部件\s+(\S+)/.exec(message);
  return match ? match[1]! : null;
}
