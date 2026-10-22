/**
 * `@woohaa3/contracts` canvas domain 公共入口（原 `@woohaa3/canvas-domain` 并入）。
 *
 * 提供与来源项目 `ServerCanvas` 契约兼容的完整画布聚合：类型、不受信任输入规范化、
 * 文档往返序列化，以及画布图操作所需的纯函数。
 */
export * from "./core";
export * from "./types";
export * from "./aggregate";
export * from "./align-document";
export * from "./runtime-node-data";
export * from "./generation-mode";
export * from "./interaction-coverage";
export * from "./normalization";
export * from "./input-mapping";
export * from "./input-mapping-lifecycle";
export * from "./model-reference-inputs";
