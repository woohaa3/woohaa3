/**
 * Canvas presentation navigation 与 App Router 导出面
 * （change: 2026-09-28-unify-canvas-presentation-navigation）。
 */
export * from "./contracts.js";
export * from "./app-router.js";
export { planTransition, emptyPresentation } from "./transition.js";
export type { TransitionContext, TransitionPlan, TransitionEffect } from "./transition.js";
export { CanvasNavigationStore } from "./store.js";
export type { CanvasNavigationOptions } from "./store.js";
export { AppRouterStore } from "./app-router-store.js";
