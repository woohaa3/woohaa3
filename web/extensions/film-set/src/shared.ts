// 稳定 identity 移到叶子模块，使纯 metadata / 薄 activation 入口不必可达业务 barrel。
export * from "./state/shared/identity.js";
export * from "./preview/shared/playback-controller.js";
export * from "./authoring/browser/object-session.js";
export * from "./preview/shared/composition.js";
