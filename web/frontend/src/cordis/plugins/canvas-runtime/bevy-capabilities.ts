/**
 * WASM 能力校验（从 `bevy-runtime.ts` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`bevy-runtime.ts` 曾越过 800 物理行上限。这里只比较模块导出与
 * 当前 wire 版本，不持有状态，独立成文件后也便于单独测「装了旧 WASM 会怎样」。
 */
import { CANVAS_OBSERVER_UPDATE_VERSION, CANVAS_POSITION_UPDATE_VERSION, CANVAS_RENDER_SCENE_VERSION, CANVAS_VIEWPORT_UPDATE_VERSION } from "@woohaa3/contracts";
import type { BevyModule } from "./bevy-runtime-types.js";
/**
 * 初始化时校验当前必需 WASM 能力（change: 2026-10-07-remove-residual-compatibility）。
 *
 * 缺失当前资源注册或 Shot Camera capture 导出时抛稳定错误，使宿主呈现明确的版本/能力不匹配，
 * 而不是把能力缺失伪装成截图超时或回退旧边界。
 */
export function assertRequiredCapabilities(module: BevyModule): void {
  const missing: string[] = [];
  if (!module.prepare_and_register_model_resource) missing.push("prepare_and_register_model_resource");
  // change: 2026-10-23-scale-canvas-media-residency —— descriptor 声明与 payload lease 是模型
  // 驻留的必需通道；缺失时明确能力不匹配，不静默回退「引用即常驻整场 IR」。
  if (!module.declare_model_resource) missing.push("declare_model_resource");
  if (!module.set_model_payload_leases) missing.push("set_model_payload_leases");
  if (!module.request_shot_capture) missing.push("request_shot_capture");
  if (!module.poll_shot_capture) missing.push("poll_shot_capture");
  // change: 2026-10-10-optimize-canvas-interaction-hot-path —— 新 Frontend 必须有视口增量
  // 边界；缺失时明确能力不匹配，不静默回退旧 full-scene 接口（design D3 / spec）。
  if (!module.set_viewport) missing.push("set_viewport");
  if (!module.base_scene_generation) missing.push("base_scene_generation");
  if (!module.viewport_capability) missing.push("viewport_capability");
  if (!module.set_positions) missing.push("set_positions");
  if (!module.position_capability) missing.push("position_capability");
  if (!module.query_drop_target) missing.push("query_drop_target");
  // scene wire 版本必须同步：缺失能力字符串时明确能力不匹配，不静默忽略结构变化。
  if (!module.scene_capability) missing.push("scene_capability");
  if (missing.length > 0) {
    throw new Error(`Bevy WASM 缺少必需能力：${missing.join(", ")}`);
  }
  // 场景 wire 版本必须逐字节一致：结构变化时必须同步升级，旧 WASM 明确拒绝。
  const scene = module.scene_capability!();
  if (scene !== CANVAS_RENDER_SCENE_VERSION) {
    throw new Error(`Bevy WASM 场景能力不匹配：${scene || "(空)"} != ${CANVAS_RENDER_SCENE_VERSION}`);
  }
  // 视口 wire 版本必须逐字节一致：结构变化时必须同步升级，旧 WASM 明确拒绝。
  const capability = module.viewport_capability!();
  if (capability !== CANVAS_VIEWPORT_UPDATE_VERSION) {
    throw new Error(`Bevy WASM 视口能力不匹配：${capability || "(空)"} != ${CANVAS_VIEWPORT_UPDATE_VERSION}`);
  }
  const positions = module.position_capability!();
  if (positions !== CANVAS_POSITION_UPDATE_VERSION) {
    throw new Error(`Bevy WASM 位置能力不匹配：${positions || "(空)"} != ${CANVAS_POSITION_UPDATE_VERSION}`);
  }
  // 观察镜头增量是可选能力：旧 WASM 缺导出时调度器回退 full，不阻断装载。
  if (module.observer_capability) {
    const observer = module.observer_capability();
    if (observer !== CANVAS_OBSERVER_UPDATE_VERSION) {
      throw new Error(`Bevy WASM 观察镜头能力不匹配：${observer || "(空)"} != ${CANVAS_OBSERVER_UPDATE_VERSION}`);
    }
  }
}
