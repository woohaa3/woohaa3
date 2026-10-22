/**
 * Canvas Script 受限执行与提交模块入口
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.1–2.6 / 3.1–3.8）。
 *
 * 服务端职责：受限执行用户脚本、记录语义计划、在权威队列内编译/复核并原子提交，
 * 同时保证源码不进入任何持久层。MCP 只经内部协议调用，不持有此实现。
 */
export * from "./prelude.js";
export * from "./engine.js";
export * from "./recorder.js";
export * from "./availability.js";
export * from "./service.js";
