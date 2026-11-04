/**
 * 统一生成运行状态契约公共入口
 * （change: 2026-10-12-unify-generation-history-strip，design D1）。
 *
 * 各生成入口共用的操作身份、生命周期与有界摘要读模型。纯 DTO 与纯函数；运行状态是
 * 可丢弃读模型，MUST NOT 进入 Canvas Y.Doc / `ServerCanvas`。
 */
export * from "./run-state/types.js";
export * from "./run-state/summary.js";
export * from "./run-state/progress.js";
