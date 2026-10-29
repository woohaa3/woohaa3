/**
 * 片场 owner 命令 codec（change: 2026-10-28-generic-extension-content-ownership，任务 3.3）。
 *
 * canonical `extension.command` 只承载信封；片场命令的 kind、payload、旧 type 认领与失败码都在
 * 这里。内核不识别 `filmSet.*` / `filmSetGroup.*`，旧持久化命令只能经 `legacyTypes` 进入本
 * owner 的过渡解码窗口。
 */
import type { ContentCommandCodec, ContentCommandEnvelope } from "../content-contribution.js";
import { isFilmSetClipPatchOp, type FilmSetClipPatchOp } from "../film-set-clip-ops.js";
import { readFilmSetAnimationProjection } from "../film-set-animation-projection.js";
import { filmSetAnimationsOf, resolveFilmSetClip } from "../film-set-clip-view.js";
import { establishItemMotionAdapter } from "../film-set-content.js";
import { hashMotionScript } from "../motion-script.js";
import { readFilmSetGroupMarker } from "../film-set-group.js";
import type { CanvasNodeData, ServerCanvas } from "../domain/index.js";
import type { CommandApplyResult, WorkingState } from "../command-reducer/types.js";
import { toWorkingState } from "../command-reducer/working-state.js";
import { patchFilmSetClip } from "../command-reducer/film-set-clip-commands.js";
import { patchFilmSetItem } from "../command-reducer/film-set-item-commands.js";
import { patchFilmSetGroupBinding, ungroupFilmSetGroup } from "../command-reducer/film-set-group-commands.js";
import type {
  FilmSetClipPatchCommand,
  FilmSetGroupBindingPatchCommand,
  FilmSetGroupUngroupCommand,
  FilmSetLegacyCommand,
  FilmSetLegacyItemPatchCommand
} from "./command-types.js";

/** 新写入的 canonical kind；业务名只留在 owner 侧。 */
export const FILM_SET_CLIP_PATCH_KIND = "clip.patch";
export const FILM_SET_GROUP_BINDING_PATCH_KIND = "group.bindingPatch";
export const FILM_SET_GROUP_UNGROUP_KIND = "group.ungroup";

/** 只用于旧持久化命令的过渡窗口；不得出现在 canonical 联合类型或内核分派。 */
export const FILM_SET_LEGACY_COMMAND_TYPES = [
  "filmSet.clipPatch",
  "filmSetGroup.bindingPatch",
  "filmSetGroup.ungroup",
  "filmSet.itemPatch"
] as const;

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

/** 解码失败统一使用稳定码，不回显载荷内容。 */
const INVALID = "invalid-film-set-command";
const invalid = (): { ok: false; code: string; reason: string } => ({ ok: false, code: INVALID, reason: INVALID });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeClipPatch(nodeId: string | undefined, payload: unknown): DecodeResult<FilmSetClipPatchCommand> {
  if (!nodeId || !isRecord(payload)) return invalid();
  if (!isNonEmptyString(payload.clipId) || !isNonEmptyString(payload.expectedHash) || !isFilmSetClipPatchOp(payload.op)) return invalid();
  return {
    ok: true,
    value: {
      type: "filmSet.clipPatch",
      nodeId,
      clipId: payload.clipId,
      expectedHash: payload.expectedHash,
      op: payload.op as FilmSetClipPatchOp
    }
  };
}

function decodeGroupBindingPatch(nodeId: string | undefined, payload: unknown): DecodeResult<FilmSetGroupBindingPatchCommand> {
  if (!nodeId || !isRecord(payload) || !isNonEmptyString(payload.bindingId) || !isRecord(payload.patch)) return invalid();
  const patch = payload.patch;
  if (payload.expectedContentKey !== undefined && !isNonEmptyString(payload.expectedContentKey)) return invalid();
  if (patch.visibility !== undefined && typeof patch.visibility !== "boolean") return invalid();
  if (patch.contentKey !== undefined && !isNonEmptyString(patch.contentKey)) return invalid();
  return {
    ok: true,
    value: {
      type: "filmSetGroup.bindingPatch",
      groupId: nodeId,
      bindingId: payload.bindingId,
      ...(payload.expectedContentKey !== undefined ? { expectedContentKey: payload.expectedContentKey } : {}),
      patch: patch as FilmSetGroupBindingPatchCommand["patch"]
    }
  };
}

function decodeGroupUngroup(nodeId: string | undefined, payload: unknown): DecodeResult<FilmSetGroupUngroupCommand> {
  if (!nodeId) return invalid();
  const expected = isRecord(payload) ? payload.expectedSchemaVersion : undefined;
  if (expected !== undefined && !Number.isSafeInteger(expected)) return invalid();
  return {
    ok: true,
    value: {
      type: "filmSetGroup.ungroup",
      groupId: nodeId,
      ...(expected !== undefined ? { expectedSchemaVersion: expected as number } : {})
    }
  };
}

/** 旧命令由 reducer 以整条命令为 payload 交给 owner；新命令只携带业务字段。 */
function decodeLegacy(kind: string, envelope: ContentCommandEnvelope): DecodeResult<FilmSetLegacyCommand> {
  const payload = envelope.payload;
  if (!isRecord(payload)) return invalid();
  switch (kind) {
    case "filmSet.clipPatch":
      return decodeClipPatch(isNonEmptyString(payload.nodeId) ? payload.nodeId : envelope.nodeId, payload);
    case "filmSetGroup.bindingPatch":
      return decodeGroupBindingPatch(isNonEmptyString(payload.groupId) ? payload.groupId : envelope.nodeId, payload);
    case "filmSetGroup.ungroup":
      return decodeGroupUngroup(isNonEmptyString(payload.groupId) ? payload.groupId : envelope.nodeId, payload);
    case "filmSet.itemPatch": {
      const nodeId = isNonEmptyString(payload.nodeId) ? payload.nodeId : envelope.nodeId;
      if (!nodeId || !isNonEmptyString(payload.itemId) || !isRecord(payload.op) || !isNonEmptyString(payload.op.kind)) return invalid();
      return {
        ok: true,
        value: {
          type: "filmSet.itemPatch",
          nodeId,
          itemId: payload.itemId,
          op: payload.op as FilmSetLegacyItemPatchCommand["op"]
        }
      };
    }
    default:
      return invalid();
  }
}

function canvasFromWork(canvas: ServerCanvas, work: WorkingState): ServerCanvas {
  return {
    ...canvas,
    title: work.title,
    document: {
      ...canvas.document,
      nodes: work.nodes.map((node) => ({ ...node, data: {} })),
      edges: work.edges
    },
    nodeData: work.nodeData as Record<string, CanvasNodeData>,
    assets: work.assets,
    jobs: work.jobs
  };
}

function rejection(result: Extract<CommandApplyResult, { ok: false }>): { ok: false; code: string; reason: string } {
  return { ok: false, code: result.rejection.code, reason: result.rejection.message };
}

function applyLegacy(canvas: ServerCanvas, command: FilmSetLegacyCommand): { ok: true; canvas: ServerCanvas } | { ok: false; code: string; reason: string } {
  const work = toWorkingState(canvas);
  const result = command.type === "filmSet.clipPatch"
    ? patchFilmSetClip(work, command)
    : command.type === "filmSet.itemPatch"
      ? patchFilmSetItem(work, command)
      : command.type === "filmSetGroup.bindingPatch"
        ? patchFilmSetGroupBinding(work, command)
        : ungroupFilmSetGroup(work, command);
  if (!result.ok) return rejection(result);
  return { ok: true, canvas: canvasFromWork(canvas, work) };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Record<string, unknown>)[key]]))
      : entry);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * 动作定义的 `sourceHash` 会按脚本内容重算（与 marker 解码一致），比较后置条件时不能把
 * 客户端提交的旧 hash 当成语义差异。
 */
function normalizedMotion(motion: unknown): unknown {
  if (!motion || typeof motion !== "object" || Array.isArray(motion)) return motion;
  const value = motion as { motionScript?: unknown; sourceHash?: unknown };
  return typeof value.motionScript === "string" ? { ...(motion as object), sourceHash: hashMotionScript(value.motionScript) } : motion;
}

function sameMotion(left: unknown, right: unknown): boolean {
  return sameJson(normalizedMotion(left), normalizedMotion(right));
}

function sameClip(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return sameJson(left, right);
  const strip = (clip: Record<string, unknown>) => ({ ...clip, cameraMotion: normalizedMotion(clip.cameraMotion) });
  return sameJson(strip(left as Record<string, unknown>), strip(right as Record<string, unknown>));
}

/** 片场命令后置条件：按稳定 clipId / bindingId 观察，不按数组序号。 */
function legacySatisfied(command: FilmSetLegacyCommand, canvas: ServerCanvas): boolean {
  if (command.type === "filmSet.clipPatch") {
    const projected = readFilmSetAnimationProjection(canvas, command.nodeId);
    if (!projected) return false;
    const collection = filmSetAnimationsOf(projected);
    const clip = resolveFilmSetClip(projected, command.clipId)?.clip;
    const op = command.op;
    if (op.kind === "delete") return !clip;
    if (op.kind === "set-default") return collection.defaultClipId === command.clipId;
    if (op.kind === "duplicate") return collection.clips.some((entry) => entry.id === op.newClipId);
    if (!clip) return false;
    if (op.kind === "create" || op.kind === "replace") return sameClip(clip, op.clip);
    if (op.kind === "rename") return clip.name === op.name.trim();
    if (op.kind === "timeline") return sameJson(clip.timeline, op.timeline);
    if (op.kind === "camera") return sameJson(clip.initialCamera, op.initialCamera);
    if (op.kind === "camera-motion") return sameMotion(clip.cameraMotion, op.cameraMotion);
    if (op.kind === "backdrop") return sameJson(clip.backdrop, op.backdrop);
    if (op.kind === "set-kind") return clip.kind === op.toKind;
    if (op.kind === "binding") return sameJson(clip.bindings.find((binding) => binding.itemId === op.itemId) ?? null, op.binding);
    if (op.kind === "confirm-adaptation") {
      const item = readFilmSetAnimationProjection(canvas, command.nodeId)?.filmSetContent.items.find((entry) => entry.id === op.itemId);
      const motion = clip.bindings.find((binding) => binding.itemId === op.itemId)?.motion;
      return !!item && !!motion && motion.basedOnModelVersion.contentHash === establishItemMotionAdapter(item).contentHash;
    }
    return false;
  }
  if (command.type === "filmSetGroup.bindingPatch") {
    const marker = readFilmSetGroupMarker(canvas.nodeData[command.groupId]);
    const binding = marker?.sceneBindings.find((entry) => entry.bindingId === command.bindingId);
    if (!binding) return false;
    if (command.patch.animation !== undefined && !sameJson(binding.animation, command.patch.animation)) return false;
    if (command.patch.contentKey !== undefined && binding.contentKey !== command.patch.contentKey) return false;
    if (command.patch.visibility !== undefined && binding.visibility !== command.patch.visibility) return false;
    if (command.patch.transform !== undefined && !sameJson(binding.transform, command.patch.transform)) return false;
    return true;
  }
  if (command.type === "filmSetGroup.ungroup") {
    return !canvas.document.nodes.some((node) => node.id === command.groupId) && !readFilmSetGroupMarker(canvas.nodeData[command.groupId]);
  }
  // 旧 composite 对象命令只读：只有目标对象已不存在（删除已生效）才算满足。
  const item = readFilmSetAnimationProjection(canvas, command.nodeId)?.filmSetContent.items.find((entry) => entry.id === command.itemId);
  if (command.op.kind === "delete") return item === undefined;
  if (!item) return false;
  if (command.op.kind === "transform") return sameJson(item.localTransform, command.op.localTransform);
  return false;
}

export const filmSetCommandCodec: ContentCommandCodec = {
  kinds: [FILM_SET_CLIP_PATCH_KIND, FILM_SET_GROUP_BINDING_PATCH_KIND, FILM_SET_GROUP_UNGROUP_KIND],
  legacyTypes: FILM_SET_LEGACY_COMMAND_TYPES,
  decode(envelope) {
    for (const legacyType of FILM_SET_LEGACY_COMMAND_TYPES) {
      if (envelope.kind === legacyType) return decodeLegacy(legacyType, envelope);
    }
    switch (envelope.kind) {
      case FILM_SET_CLIP_PATCH_KIND:
        return decodeClipPatch(envelope.nodeId, envelope.payload);
      case FILM_SET_GROUP_BINDING_PATCH_KIND:
        return decodeGroupBindingPatch(envelope.nodeId, envelope.payload);
      case FILM_SET_GROUP_UNGROUP_KIND:
        return decodeGroupUngroup(envelope.nodeId, envelope.payload);
      default:
        return invalid();
    }
  },
  apply(value, canvas) {
    return applyLegacy(canvas, value as FilmSetLegacyCommand);
  },
  satisfied(value, canvas) {
    return legacySatisfied(value as FilmSetLegacyCommand, canvas);
  }
};


export type FilmSetExtensionCommand =
  | { type: "extension.command"; extensionId: "film-set"; nodeId: string; kind: typeof FILM_SET_CLIP_PATCH_KIND; payload: { clipId: string; expectedHash: string; op: FilmSetClipPatchOp } }
  | { type: "extension.command"; extensionId: "film-set"; nodeId: string; kind: typeof FILM_SET_GROUP_BINDING_PATCH_KIND; payload: { bindingId: string; expectedContentKey?: string; patch: FilmSetGroupBindingPatchCommand["patch"] } }
  | { type: "extension.command"; extensionId: "film-set"; nodeId: string; kind: typeof FILM_SET_GROUP_UNGROUP_KIND; payload: { expectedSchemaVersion?: number } };

/** 生产调用点只构造 canonical 信封；kind/payload 的解释权在 owner。 */
export function filmSetClipPatchCommand(input: { nodeId: string; clipId: string; expectedHash: string; op: FilmSetClipPatchOp }): FilmSetExtensionCommand {
  return {
    type: "extension.command",
    extensionId: "film-set",
    nodeId: input.nodeId,
    kind: FILM_SET_CLIP_PATCH_KIND,
    payload: { clipId: input.clipId, expectedHash: input.expectedHash, op: input.op }
  };
}

export function filmSetGroupBindingPatchCommand(input: { groupId: string; bindingId: string; expectedContentKey?: string; patch: FilmSetGroupBindingPatchCommand["patch"] }): FilmSetExtensionCommand {
  return {
    type: "extension.command",
    extensionId: "film-set",
    nodeId: input.groupId,
    kind: FILM_SET_GROUP_BINDING_PATCH_KIND,
    payload: {
      bindingId: input.bindingId,
      ...(input.expectedContentKey !== undefined ? { expectedContentKey: input.expectedContentKey } : {}),
      patch: input.patch
    }
  };
}

export function filmSetGroupUngroupCommand(input: { groupId: string; expectedSchemaVersion?: number }): FilmSetExtensionCommand {
  return {
    type: "extension.command",
    extensionId: "film-set",
    nodeId: input.groupId,
    kind: FILM_SET_GROUP_UNGROUP_KIND,
    payload: input.expectedSchemaVersion !== undefined ? { expectedSchemaVersion: input.expectedSchemaVersion } : {}
  };
}
