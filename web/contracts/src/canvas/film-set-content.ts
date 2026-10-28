/**
 * 片场内容契约的兼容再导出。
 *
 * 实现在片场扩展 shared：`extensions/film-set/src/state/shared/content/`。
 * 这里用相对路径再导出，避免 `@woohaa3/contracts` 主入口与扩展包形成循环依赖。
 * 主入口会在清债阶段去掉这层再导出。
 */
export * from "../../../extensions/film-set/src/state/shared/content/types.js";
export * from "../../../extensions/film-set/src/state/shared/content/codec.js";
export * from "../../../extensions/film-set/src/state/shared/content/motion.js";
export * from "../../../extensions/film-set/src/state/shared/content/import-plan.js";
export * from "../../../extensions/film-set/src/state/shared/content/part-identity.js";
export { filmSetContentContribution, filmSetNodeDataCodec } from "../../../extensions/film-set/src/state/shared/content/contribution.js";
