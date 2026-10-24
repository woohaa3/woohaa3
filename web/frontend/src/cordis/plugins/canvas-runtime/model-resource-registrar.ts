/**
 * 模型 descriptor 声明与 payload 注册的边界调用
 * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
 *
 * 拆出本模块的原因：`bevy-runtime.ts` 已接近文件体积守卫上限，而「声明轻量身份」与「注册
 * 重型 payload」是本 change 新增的独立职责——前者幂等且极轻，后者只在当前需求下发生并被
 * 预算淘汰后重建。两者放在一起最容易让人误以为「声明即驻留」。
 *
 * 本模块只做**跨 WASM 边界的调用与账本更新**：不缓存 payload JSON（重型 IR 的常驻副本只能
 * 由 Rust payload cache 与前端不可变资源决定），不决定需求。
 */
import {
  modelDescriptorOf,
  modelDescriptorPayload,
  modelPrepareRequest,
  type ModelDescriptor,
  type PreparedModelMetadata,
  type PreparedModelResource
} from "@woohaa3/contracts";
import type { BevyModule } from "./bevy-runtime-types.js";
import { sceneDiagnostics } from "./scene-diagnostics.js";

export type ModelResourceRegistrarInput = {
  /** 当前 WASM 模块（重建期间会被替换，因此按调用取值）。 */
  module: () => BevyModule;
  /** 已声明 descriptor 的 key（跨调用累积；重建时由调用方清空）。 */
  declaredKeys: Set<string>;
  /** 已成功注册 payload 的 key（Rust 侧驻留账本）。 */
  registeredKeys: Set<string>;
  /** 曾声明过的模型内容身份（把资产/片场 key 与模型 key 区分开）。 */
  knownModelKeys: Set<string>;
};

export type ModelResourceRegistrar = {
  /** 声明轻量 descriptor（幂等；缺少边界时抛出，由能力门禁保证不会发生）。 */
  declare: (resource: PreparedModelResource) => void;
  /** 注册重型 payload；返回 Rust 派生的轻量 metadata。 */
  register: (resource: PreparedModelResource) => PreparedModelMetadata;
  /** 合并准备与注册的原语（`register` 的实现，也是对外暴露的兼容入口）。 */
  prepareAndRegister: (input: {
    sceneVersion: string;
    ops: readonly unknown[];
    opsJson?: string;
    expectedSignature?: string;
    expectedExtent?: number;
  }) => PreparedModelMetadata | null;
};

export function createModelResourceRegistrar(input: ModelResourceRegistrarInput): ModelResourceRegistrar {
  const declare = (resource: PreparedModelResource): void => {
    input.knownModelKeys.add(resource.resourceKey);
    if (input.declaredKeys.has(resource.resourceKey)) return;
    const module = input.module();
    if (!module.declare_model_resource) {
      throw new Error("Bevy 运行时缺少 declare_model_resource 边界");
    }
    const declared = JSON.parse(
      module.declare_model_resource(modelDescriptorPayload(modelDescriptorOf(resource)))
    ) as ModelDescriptor;
    if (declared.resourceKey !== resource.resourceKey) {
      throw new Error(`模型 descriptor key 不一致：${declared.resourceKey} != ${resource.resourceKey}`);
    }
    input.declaredKeys.add(resource.resourceKey);
    sceneDiagnostics.modelDescriptors += 1;
  };

  const prepareAndRegister: ModelResourceRegistrar["prepareAndRegister"] = (request) => {
    const module = input.module();
    if (!module.prepare_and_register_model_resource) return null;
    const json = modelPrepareRequest({
      sceneVersion: request.sceneVersion,
      ops: request.ops as never,
      ...(request.opsJson ? { opsJson: request.opsJson } : {}),
      ...(request.expectedSignature ? { expectedSignature: request.expectedSignature } : {}),
      ...(request.expectedExtent !== undefined ? { expectedExtent: request.expectedExtent } : {})
    });
    const metadata = JSON.parse(module.prepare_and_register_model_resource(json)) as PreparedModelMetadata;
    // 注册在 Rust 侧完成。本运行时**不缓存** payload JSON：重型 IR 的常驻副本必须只由 Rust
    // 的 payload cache 与前端不可变资源决定（design D5）；这里只记驻留账本。
    input.registeredKeys.add(metadata.resourceKey);
    sceneDiagnostics.modelRegistrations += 1;
    sceneDiagnostics.boundaryBytes += json.length;
    return metadata;
  };

  const register = (resource: PreparedModelResource): PreparedModelMetadata => {
    const metadata = prepareAndRegister({
      sceneVersion: resource.sceneVersion,
      ops: resource.ops as readonly unknown[],
      // 复用同一份规范化 ops JSON，保持 signature 逐字节兼容。
      opsJson: JSON.stringify(resource.ops),
      expectedSignature: resource.signature
    });
    if (!metadata) {
      throw new Error("Bevy 运行时未返回模型资源 metadata");
    }
    if (metadata.resourceKey !== resource.resourceKey) {
      throw new Error(`模型资源 key 不一致：${metadata.resourceKey} != ${resource.resourceKey}`);
    }
    return metadata;
  };

  return { declare, register, prepareAndRegister };
}
