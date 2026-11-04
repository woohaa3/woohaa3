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
export * from "./canvas/generated-image-registry.js";
export * from "./canvas/agent-canvas-run.js";
export * from "./canvas/agent-media-continuation.js";
export * from "./canvas/canvas-script/index.js";
export * from "./canvas/domain/index.js";
export * from "./canvas/model-script.js";
export * from "./canvas/model-transform.js";
export * from "./canvas/content-frame.js";
export * from "./canvas/content-conversion.js";
export * from "./canvas/film-set-mcp.js";
export * from "./canvas/content-runtime.js";
export * from "./canvas/content-recording.js";
export * from "./canvas/content-recording-port.js";
export * from "./canvas/film-set-export-profile.js";
export * from "./canvas/recording-protocol.js";
export * from "./canvas/model-definition.js";
export * from "./canvas/humanoid-rig.js";
export * from "./canvas/glb/parse.js";
export * from "./canvas/glb/import.js";
export * from "./canvas/group-appearance.js";
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
export * from "./canvas/render-scene/overview-cache.js";
export * from "./canvas/viewport-update.js";
export * from "./canvas/observer-update.js";
export * from "./canvas/position-update.js";
export * from "./canvas/resource-state-update.js";
export * from "./canvas/prepared-model.js";
export * from "./canvas/content-hash.js";
export * from "./canvas/source-descriptor.js";
export * from "./canvas/node-history.js";
export * from "./canvas/merge-target.js";
export * from "./canvas/run-state.js";
export * from "./canvas/node-display-name.js";
export * from "./canvas/director-studio-title.js";
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
export * from "./canvas/film-set-content.js";
export * from "./canvas/film-set-group.js";
export * from "./canvas/film-set-group-member-layout.js";
export * from "./canvas/film-set-animations.js";
export * from "./canvas/film-set-clip-view.js";
export * from "./canvas/film-set-clip-ops.js";
export * from "./canvas/film-set-clip-compilation.js";
export * from "./canvas/film-set-shot-preview.js";
export * from "./canvas/managed-node.js";
export * from "./canvas/managed-node-lifecycle.js";
export * from "./canvas/content-contribution.js";
export * from "./canvas/film-set-shot-reference.js";
export * from "./canvas/film-set-shot-image-reference.js";
export * from "./canvas/film-set-clip-edit.js";
export * from "./canvas/film-set-item-ops.js";
export * from "./canvas/film-set-item-edit.js";
export * from "./canvas/film-set-object-container.js";
export * from "./canvas/film-set-object-replacement.js";
export * from "./canvas/film-set-conversion.js";
export * from "./canvas/film-set-composition.js";
export * from "./canvas/film-set-layout.js";
export * from "./canvas/film-set-space.js";
export * from "./canvas/film-set-camera-motion.js";
export * from "./canvas/film-set-placement-repair.js";
export * from "./canvas/motion-validation.js";
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
// 日志信封导出除与 telemetry 同名的两个文本工具外的全部内容：
// 两处实现有意不同——日志截断要留省略号，telemetry 的按码点上限截断则不留。
export {
  LOG_ATTRIBUTE_VALUE_LIMIT,
  LOG_ERROR_CODE_PATTERN,
  LOG_EVENT_PATTERN,
  LOG_LEVELS,
  LOG_LIMITS,
  LOG_MESSAGE_LIMIT,
  LOG_MODULE_PATTERN,
  LOG_SCHEMA_VERSION,
  LOG_TRACE_ID_PATTERN,
  REDACTED,
  isSensitiveLogKey,
  logLevelAtLeast,
  logText,
  logValueToString,
  normalizeLogRecord,
  redactLogPatterns,
  redactLogText,
  type LogAttrValue,
  type LogLevel,
  type LogRecord,
  type LogRuntime,
  type NormalizeLogInput
} from "./log/index.js";
export * from "./plugin-icon.js";

export { compositeAssetSceneOps } from "./canvas/composite-asset-scene.js";

export * from "./canvas/media-time.js";

export * from "./canvas/model-script-batch.js";

export * from "./canvas/image-project-references.js";
export * from "./mcp-installation.js";
export * from "./canvas/group-authoring-scope.js";
export * from "./canvas/node-history/execution-presentation.js";

export * from "./canvas/composite-children.js";

export * from "./canvas/node-capabilities.js";
export * from "./canvas/builtin-node-capabilities.js";

export * from "./canvas/media-content.js";
export * from "./canvas/group-presentation.js";
export * from "./canvas/group-badge.js";
export * from "./canvas/ground-anchor.js";
export * from "./canvas/film-set-animation-projection.js";
export * from "./canvas/film-set-group-projection.js";

export type { MediaFormatValidator, MediaFormatRegistry, HostMediaFormatService } from "./extension/services/host/media-formats.js";
export * from "./canvas/scene-package.js";
export * from "./media/image-resource.js";
