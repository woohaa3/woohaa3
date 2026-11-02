/**
 * `@woohaa3/contracts` 公共入口（change: split-web-runtime-services，任务 1.3）。
 *
 * 这是**唯一允许的跨运行单元代码依赖**：稳定 DTO、runtime schema、稳定错误码与无副作用
 * codec。它刻意不导出数据库 adapter、Yjs room、任务调度、provider、COS client、HTTP
 * handler 或服务 composition root（design D7）。
 */
export * from "./errors.js";
export * from "./validation.js";
export * from "./base-path/app-base-path.mjs";
export * from "./client/rules.js";
export * from "./task/dto.js";
export * from "./task/model-identity.js";
export * from "./task/model-capabilities.js";
export * from "./task/history.js";
export * from "./task/activity.js";
export * from "./task/background-activity.js";
export * from "./task/recording-activity.js";
export * from "./task/protocol.js";
export * from "./task/schema-validation.js";
export * from "./task/parameter-schema.js";
export * from "./task/image-parameters.js";
export * from "./task/audio-parameters.js";
export * from "./task/model-presets.js";
export * from "./task/generation-parameters/index.js";
export * from "./task/video-parameters.js";
export * from "./media/keys.js";
export * from "./media/protocol.js";
export * from "./media/storage.js";
export * from "./media/variants.js";
export * from "./canvas/protocol.js";
export * from "./canvas/catalog.js";
export * from "./canvas/source.js";
export * from "./canvas/preparation.js";
export * from "./canvas/commands.js";
export * from "./canvas/sync-protocol-version.js";
export * from "./canvas/edit-command.js";
export * from "./canvas/edit-plan.js";
export * from "./canvas/command-reducer.js";
export * from "./canvas/command-satisfaction.js";
export * from "./canvas/agent-node-descriptors.js";
export * from "./canvas/agent-canvas-protocol.js";
export * from "./canvas/agent-canvas-projection.js";
export * from "./canvas/agent-canvas-internal.js";
export * from "./canvas/agent-canvas-run.js";
export * from "./canvas/agent-media-continuation.js";
export * from "./canvas/canvas-script/index.js";
export * from "./canvas/domain/index.js";
export * from "./canvas/model-script.js";
export * from "./canvas/model-transform.js";
export * from "./canvas/content-runtime.js";
export * from "./canvas/model-definition.js";
export * from "./canvas/glb/parse.js";
export * from "./canvas/glb/import.js";
export * from "./canvas/scene-ir-v2.js";
export * from "./canvas/model-executor.js";
export * from "./canvas/model-executor-v2.js";
export * from "./canvas/model-api-descriptor.js";
export * from "./canvas/motion-script.js";
export * from "./canvas/motion-ir.js";
export * from "./canvas/motion-executor.js";
export * from "./canvas/model-api-descriptor-motion.js";
export * from "./canvas/mcp-internal.js";
export * from "./canvas/render-scene.js";
export * from "./canvas/viewport-update.js";
export * from "./canvas/observer-update.js";
export * from "./canvas/position-update.js";
export * from "./canvas/prepared-model.js";
export * from "./canvas/content-hash.js";
export * from "./canvas/node-history.js";
export * from "./canvas/merge-target.js";
export * from "./canvas/run-state.js";
export * from "./canvas/node-display-name.js";
export * from "./canvas/menu-sections.js";
export * from "./canvas/geometry.js";
export * from "./canvas/arrange.js";
export * from "./canvas/image-edit.js";
export * from "./canvas/image-edit-session.js";
export * from "./canvas/model-focus.js";
export * from "./canvas/model-focus-state.js";
export * from "./canvas/model-placement.js";
export * from "./canvas/model-cameras.js";
export * from "./canvas/shot-camera.js";
export * from "./canvas/gizmo.js";
export * from "./canvas/canvas-node-model.js";
export * from "./canvas/animation-snapshot.js";
export * from "./canvas/managed-node.js";
export * from "./canvas/managed-node-lifecycle.js";
export * from "./canvas/content-contribution.js";
export * from "./canvas/model-validity.js";
export * from "./theme/index.js";
export * from "./prompt-snippets/index.js";
export * from "./video/index.js";
export * from "./extension/index.js";
export { compareSemver, isSemver as isStrictSemver, maxSatisfying, satisfiesRange } from "./extension/host/semver.js";
export * from "./backend/index.js";
export * from "./settings/index.js";
export * from "./telemetry/event.js";
export * from "./telemetry/query.js";
export * from "./plugin-icon.js";


export * from "./canvas/model-script-batch.js";

export * from "./canvas/image-project-references.js";
export * from "./mcp-installation.js";
export * from "./canvas/node-history/execution-presentation.js";

export * from "./canvas/composite-children.js";

export * from "./canvas/node-capabilities.js";
export * from "./canvas/builtin-node-capabilities.js";

export * from "./canvas/media-content.js";
export * from "./canvas/ground-anchor.js";

export type { MediaFormatValidator, MediaFormatRegistry, HostMediaFormatService } from "./extension/services/host/media-formats.js";
export * from "./canvas/scene-package.js";
export * from "./canvas/shared-world.js";
export * from "./canvas/world-conversion.js";
export {
  SharedWorldCodecError,
  decodeWorldInstanceData,
  decodeWorldPoint,
  decodeWorldRotation,
  decodeWorldTransform,
  encodeWorldInstanceData,
  encodeWorldPoint,
  encodeWorldRotation,
  encodeWorldTransform,
  type SharedWorldCodecFailureCode
} from "./canvas/shared-world-codec.js";
export {
  decodeCreationScopeData,
  decodeGroundAabb,
  decodeGroundPoint,
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  encodeCreationScopeData,
  encodeGroundAabb,
  encodeGroundPoint,
  encodeSceneAreaData,
  encodeWorkflowGroupData,
  type CreationScopeNodeData
} from "./canvas/creation-scope-codec.js";
export {
  remapWorldCopyReferences,
  type WorldCopyIdTable,
  type WorldCopySourceNode,
  type WorldReferenceRemapEntry,
  type WorldReferenceRemapFailure,
  type WorldReferenceRemapFailureCode,
  type WorldReferenceRemapIdMap,
  type WorldReferenceRemapInput,
  type WorldReferenceRemapResult,
  type WorldReferenceRemapWorldKind,
  type WorldReferenceRelation,
  type WorldReferenceUnavailable
} from "./canvas/world-reference-remap.js";
export {
  WORLD_CAMERA_HISTORY_VERSION,
  decodeWorldCamera,
  decodeWorldCameraHistorySnapshot,
  encodeWorldCamera,
  encodeWorldCameraHistorySnapshot,
  worldCameraCompletionKey,
  type WorldCameraHistorySnapshot
} from "./canvas/world-camera-codec.js";
export {
  WORLD_CAPTURE_INPUT_VERSION,
  WORLD_CAPTURE_MEDIA_VERSION,
  WORLD_CAPTURE_NON_AUTHORING_CAUSES,
  applyWorldCaptureChange,
  decodeWorldCaptureFrozenInput,
  decodeWorldCaptureMediaMetadata,
  decodeWorldCaptureVersionKey,
  encodeWorldCaptureFrozenInput,
  encodeWorldCaptureMediaMetadata,
  encodeWorldCaptureVersionKey,
  freezeWorldCaptureInput,
  resolveWorldCaptureWait,
  settleWorldCaptureResult,
  toWorldCaptureInput,
  worldCaptureChangeInvalidates,
  worldCaptureVersionKeysEqual,
  worldCaptureVersionSignature,
  type WorldCaptureAuthoringChange,
  type WorldCaptureChange,
  type WorldCaptureFreezeFailureCode,
  type WorldCaptureFreezeResult,
  type WorldCaptureFrozenInput,
  type WorldCaptureMediaMetadata,
  type WorldCaptureNonAuthoringCause,
  type WorldCaptureSettlement,
  type WorldCaptureSettlementDecision,
  type WorldCaptureWaitRequest,
  type WorldCaptureWaitResolution
} from "./canvas/world-capture-contract.js";
export {
  compareWorldCaptureVersionKeys,
  decodeWorldCaptureInputMetadata,
  decodeWorldCaptureVersionKeyText,
  encodeWorldCaptureInputMetadata,
  encodeWorldCaptureVersionKeyText,
  worldCaptureInputMetadataEqual,
  type WorldCaptureVersionComparison
} from "./canvas/world-capture-codec.js";
export * from "./canvas/scene-area-plan-contract.js";
export * from "./canvas/scene-area-operation-plan.js";
