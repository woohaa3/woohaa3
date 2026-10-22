// 稳定 identity 移到叶子模块，使纯 metadata / 薄 activation 入口不必可达业务 barrel。
export * from "./shared/identity.js";
export * from "./shared/playback-controller.js";
export * from "./shared/object-session.js";
export * from "./shared/composition.js";
