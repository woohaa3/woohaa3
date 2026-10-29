/**
 * 片场受保护编辑的内部载荷（change: 2026-10-28-generic-extension-content-ownership，任务 3.4）。
 *
 * 这些业务条件与操作只属于片场 owner：canonical `EditPrecondition` / `EditOperation` 不再包含
 * `film-set-*` 成员。owner 通过 `ContentEditPlanner` 规划，经 `extension.edit` 原样传递，
 * 内核只保证批次原子性，不解释载荷。
 */
import type { FilmSetLocalTransform, FilmSetItem } from "./types.js";
import type { FilmSetItemBindingRestore, FilmSetItemOrderAnchor } from "../film-set-item-edit.js";
import type { FilmSetAnimationClip } from "../film-set-animations.js";

export type FilmSetEditPrecondition =
  | { kind: "film-set-item-state"; nodeId: string; itemId: string; contentHash: string }
  | { kind: "film-set-item-missing"; nodeId: string; itemId: string }
  | { kind: "film-set-clip-present"; nodeId: string; clipId: string }
  | { kind: "film-set-item-binding"; nodeId: string; clipId: string; itemId: string; bindingHash: string }
  | { kind: "film-set-item-binding-closure"; nodeId: string; itemId: string; bindings: readonly { clipId: string; bindingHash: string }[] }
  | { kind: "film-set-clip-state"; nodeId: string; clipId: string; clipHash: string }
  | { kind: "film-set-shot-preview-state"; previewNodeId: string; filmSetNodeId: string; clipId: string };

export type FilmSetEditOperation =
  | { kind: "film-set-item-transform"; nodeId: string; itemId: string; localTransform: FilmSetLocalTransform; expectedLocalTransform?: FilmSetLocalTransform }
  | { kind: "film-set-item-set"; nodeId: string; item: FilmSetItem }
  | { kind: "film-set-item-remove"; nodeId: string; itemId: string }
  | { kind: "film-set-item-restore"; nodeId: string; item: FilmSetItem; orderAnchor: FilmSetItemOrderAnchor; bindings: readonly FilmSetItemBindingRestore[] }
  | { kind: "film-set-clip-set"; nodeId: string; clipId: string; clip: FilmSetAnimationClip; defaultClipId: string | null }
  | { kind: "film-set-clip-remove"; nodeId: string; clipId: string; defaultClipId: string | null };

/** `extension.edit` 的片场载荷：owner 内部操作序列。 */
export type FilmSetEditPayload = { operations: readonly FilmSetEditOperation[] };
