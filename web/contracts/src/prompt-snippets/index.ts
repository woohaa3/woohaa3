/**
 * 提示词片段目录契约 barrel（change: add-prompt-snippet-library）。
 *
 * 纯类型与无副作用 codec/validator；不导出任何 repository、HTTP handler 或数据库 adapter。
 */
export * from "./dto.js";
export * from "./codec.js";
export * from "./protocol.js";
export * from "./seed.js";
