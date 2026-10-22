/**
 * 单节点快捷转为片场的公共契约入口
 * （change: 2026-10-13-add-node-to-film-set-shortcut）。
 *
 * 稳定 barrel；内部直接导入叶子模块，不反向 import 本文件。
 */
export * from "./film-set-conversion/types.js";
export * from "./film-set-conversion/capabilities.js";
export * from "./film-set-conversion/source.js";
export * from "./film-set-conversion/request.js";
export * from "./film-set-conversion/candidate.js";
export * from "./film-set-conversion/placement.js";
export * from "./film-set-conversion/origin.js";
export * from "./film-set-conversion/registry.js";
export * from "./film-set-conversion/node-status.js";
export * from "./film-set-conversion/generator.js";
export * from "./film-set-conversion/instruction.js";
export * from "./film-set-conversion/media-input.js";
export * from "./film-set-conversion/provider.js";
export * from "./film-set-conversion/provider-selection.js";
export * from "./film-set-conversion/assistant.js";
