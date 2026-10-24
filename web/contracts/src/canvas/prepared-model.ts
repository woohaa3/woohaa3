/**
 * Prepared Model Resource：模型 Scene IR 的归一化派生结果
 * （change: optimize-model-scene-snapshot-hot-path，design D1/D2）。
 *
 * 大型模型的顶点遍历与全量序列化**只能发生一次**（内容 identity 变化时），其后画布帧、
 * 聚焦镜头、viewport、hover、selection 与 placement 更新全部复用同一不可变资源。资源由
 * `resourceKey` 标识，`CanvasRenderScene` 节点只引用 key + 动态 placement。
 *
 * 本模块无副作用：只做纯派生，不写 Store / Y.Doc / nodeData。
 */
import type { Aabb } from "./model-transform.js";
import { fnv1a64Hex } from "./content-hash.js";
import { v2ExtentFromAabb, v2SceneAabb, type SceneV2Op } from "./scene-ir-v2.js";

/** prepared resource envelope 版本；结构变化时提升。 */
export const PREPARED_MODEL_RESOURCE_VERSION = "woohaa-prepared-model-resource-v1" as const;
export type PreparedModelResourceVersion = typeof PREPARED_MODEL_RESOURCE_VERSION;

/**
 * 不可变 prepared model resource。
 *
 * - `resourceKey` = `sceneVersion:signature`，**不含节点 ID**：内容相同的多个节点共享资源；
 *   placement / instance 生命周期仍按节点独立。
 * - `signature`：只覆盖模型内容（Scene IR/version/材质/动画），不含 placement / viewport。
 * - `aabb` / `extent`：与 signature 同一份规范化结果派生，供相机取景与渲染复用。
 * - `payload`：注册到 Bevy 的完整 descriptor（含 ops），避免注册时再次序列化。
 */
export type PreparedModelResource = {
  resourceVersion: PreparedModelResourceVersion;
  sceneVersion: string;
  signature: string;
  resourceKey: string;
  ops: readonly SceneV2Op[];
  aabb: Aabb | null;
  extent: number;
  /** 注册 payload（与 `modelResourcePayload` 一致）；只用于跨 WASM 传输。 */
  payload: string;
};

export type PrepareModelResourceInput = {
  sceneVersion: string;
  ops: readonly SceneV2Op[];
};

/**
 * 从**已校验的规范化 Scene IR** 一次性派生 signature / AABB / extent / payload。
 *
 * change: 2026-10-07-remove-residual-compatibility —— V2-only。
 */
export function prepareModelResource(input: PrepareModelResourceInput): PreparedModelResource {
  const canonical = `${input.sceneVersion}:${JSON.stringify(input.ops)}`;
  const signature = fnv1a64Hex(canonical);
  const aabb = v2SceneAabb(input.ops);
  const extent = v2ExtentFromAabb(aabb);
  const resourceKey = `${input.sceneVersion}:${signature}`;
  const resource: PreparedModelResource = {
    resourceVersion: PREPARED_MODEL_RESOURCE_VERSION,
    sceneVersion: input.sceneVersion,
    signature,
    resourceKey,
    ops: input.ops,
    aabb,
    extent,
    payload: ""
  };
  resource.payload = modelResourcePayload(resource);
  return resource;
}

/** 序列化注册 payload（含 protocol version、key、descriptor 与 ops）。 */
export function modelResourcePayload(resource: PreparedModelResource): string {
  return JSON.stringify({
    resourceVersion: resource.resourceVersion,
    resourceKey: resource.resourceKey,
    sceneVersion: resource.sceneVersion,
    signature: resource.signature,
    extent: resource.extent,
    aabb: resource.aabb,
    ops: resource.ops
  });
}

/**
 * prepared-and-register 边界的线格式请求
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.3 / design D6）。
 *
 * Rust 在同一次调用中派生兼容 signature、local AABB 与 extent、注册资源并返回轻量 metadata。
 * `opsJson` 复用 validator 的逐字节规范 ops JSON，嵌入唯一的 ops 字段，保证 resource key 兼容。
 */
export function modelPrepareRequest(input: {
  sceneVersion: string;
  ops: readonly SceneV2Op[];
  /** validator 输出的逐字节规范 ops JSON；缺省时由调用方保证与 ops 一致。 */
  opsJson?: string;
  expectedSignature?: string;
  expectedExtent?: number;
}): string {
  const envelope = JSON.stringify({
    resourceVersion: PREPARED_MODEL_RESOURCE_VERSION,
    sceneVersion: input.sceneVersion,
    ...(input.expectedSignature ? { expectedSignature: input.expectedSignature } : {}),
    ...(input.expectedExtent !== undefined ? { expectedExtent: input.expectedExtent } : {})
  });
  // Preserve the canonical bytes for the signature while sending the geometry only once.
  const opsJson = input.opsJson ?? JSON.stringify(input.ops);
  return `${envelope.slice(0, -1)},"ops":${opsJson}}`;
}

/** Rust `prepare_and_register_model_resource` 返回的轻量 metadata。 */
export type PreparedModelMetadata = {
  resourceVersion: string;
  resourceKey: string;
  sceneVersion: string;
  signature: string;
  extent: number;
  aabb: Aabb | null;
};

/** 从模型 ops 直接 prepare（executor 成功结果接入点）。 */
export function prepareModelOps(
  sceneVersion: string,
  ops: readonly SceneV2Op[]
): PreparedModelResource {
  return prepareModelResource({ sceneVersion, ops });
}

/**
 * 轻量模型 descriptor envelope 版本
 * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
 *
 * descriptor 只包含内容身份与必要 bounds，**不含** ops；声明它与注册重型 payload 是两次
 * 独立确认。场景引用只需 descriptor 已声明，因此 1000 个离屏模型不强制常驻整场 IR。
 */
export const MODEL_DESCRIPTOR_VERSION = "woohaa-model-descriptor-v1" as const;
export type ModelDescriptorVersion = typeof MODEL_DESCRIPTOR_VERSION;

/** 轻量模型 descriptor（与 Rust `ModelDescriptorDto` 同形）。 */
export type ModelDescriptor = {
  resourceVersion: ModelDescriptorVersion;
  resourceKey: string;
  sceneVersion: string;
  signature: string;
  extent: number;
  aabb: Aabb | null;
};

/** 从 prepared resource 派生轻量 descriptor（不含 ops；可安全常驻）。 */
export function modelDescriptorOf(resource: PreparedModelResource): ModelDescriptor {
  return {
    resourceVersion: MODEL_DESCRIPTOR_VERSION,
    resourceKey: resource.resourceKey,
    sceneVersion: resource.sceneVersion,
    signature: resource.signature,
    extent: resource.extent,
    aabb: resource.aabb
  };
}

/** descriptor 声明边界的线格式 JSON。 */
export function modelDescriptorPayload(descriptor: ModelDescriptor): string {
  return JSON.stringify({
    resourceVersion: descriptor.resourceVersion,
    resourceKey: descriptor.resourceKey,
    sceneVersion: descriptor.sceneVersion,
    signature: descriptor.signature,
    extent: descriptor.extent,
    aabb: descriptor.aabb
  });
}

/** Rust `declare_model_resource` 的回执（与 descriptor 同形）。 */
export type DeclaredModelDescriptor = ModelDescriptor;

/**
 * 当前需求持有的 payload lease 请求线格式
 * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
 */
export function modelPayloadLeaseRequest(keys: Iterable<string>): string {
  return JSON.stringify({ keys: [...keys] });
}

