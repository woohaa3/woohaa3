/**
 * 片场 owner 的命令载荷（change: 2026-10-28-generic-extension-content-ownership，任务 3.3）。
 *
 * 这些业务命令只属于片场 owner：canonical `CanvasCommand` 不再包含任何 `filmSet.*` /
 * `filmSetGroup.*` 成员。新写入统一走 `extension.command`，旧持久化命令通过 owner
 * `legacyTypes` 过渡解码；不得在内核联合类型或 reducer 分派里恢复这些名字。
 */
import type { FilmSetLocalTransform } from "./types.js";
import type { FilmSetClipPatchOp } from "../film-set-clip-ops.js";
import type { FilmSetGroupSceneBinding } from "../film-set-group.js";

/** 旧 composite 对象级操作（只读兼容窗口；apply 会稳定拒绝写入）。 */
export type FilmSetItemPatchOp =
  | { kind: "transform"; localTransform: FilmSetLocalTransform; expectedLocalTransform?: FilmSetLocalTransform }
  | { kind: "delete" }
  | { kind: "replace-model"; sourceNodeId: string; expectedSourceHash: string; expectedModelHash: string; expectedItemHash: string; importedAt: string };

export type FilmSetClipPatchCommand = {
  readonly type: "filmSet.clipPatch";
  readonly nodeId: string;
  readonly clipId: string;
  readonly expectedHash: string;
  readonly op: FilmSetClipPatchOp;
};

export type FilmSetGroupBindingPatchCommand = {
  readonly type: "filmSetGroup.bindingPatch";
  readonly groupId: string;
  readonly bindingId: string;
  readonly expectedContentKey?: string;
  readonly patch: Partial<Pick<FilmSetGroupSceneBinding, "transform" | "visibility" | "contentKey" | "animation">>;
};

export type FilmSetGroupUngroupCommand = {
  readonly type: "filmSetGroup.ungroup";
  readonly groupId: string;
  readonly expectedSchemaVersion?: number;
};

export type FilmSetLegacyItemPatchCommand = {
  readonly type: "filmSet.itemPatch";
  readonly nodeId: string;
  readonly itemId: string;
  readonly op: FilmSetItemPatchOp;
};

export type FilmSetLegacyCommand =
  | FilmSetClipPatchCommand
  | FilmSetGroupBindingPatchCommand
  | FilmSetGroupUngroupCommand
  | FilmSetLegacyItemPatchCommand;
