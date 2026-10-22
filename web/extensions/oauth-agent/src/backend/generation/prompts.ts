/**
 * ChatGPT 生成编排：提示词构造
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import { filmSetAnimationsOf, modelApiGuide, modelPrimitiveConstraintsText, modelRenderBudgetText, motionApiGuide, motionApiGuideText } from "@woohaa3/contracts";
import type { ChatGptCanvasPorts } from "../ports.js";
import type { GenerateRequest } from "./types.js";

type ReadOk = Extract<Awaited<ReturnType<ChatGptCanvasPorts["readNode"]>>, { ok: true }>;

/** 由权威上下文与 descriptor 派生指南构造明确目标的提示词。 */
export function buildPrompt(input: GenerateRequest, read: ReadOk): string {
  const model = modelApiGuide();
  const lines: string[] = [
    "You are a deterministic 3D authoring assistant inside a model canvas.",
    "Return ONLY a JSON object matching the required schema. Do not use tools, run commands, read files, or access the network.",
    `Target: canvas ${input.canvasId}, node ${input.nodeId}, type ${read.nodeType}, mode ${input.mode}.`,
    `User request: ${input.prompt}`,
    ...(input.itemId ? [`Captured actor itemId: ${input.itemId}; change only its binding in clip ${input.clipId}. Do not replace the clip or shared geometry.`] : [])
  ];
  if (input.mode === "model3d") {
    lines.push(
      `Produce a complete self-contained static model implemented with the ${model.preferredVersion} SceneBuilder API (language ${model.language}).`,
      "The model MUST be deterministic, must not read other nodes, and must not declare animations.",
      "The node ALREADY has a model authored by the user. By default you MUST KEEP it and make only the requested change (add/remove/modify specific parts).",
      "Only replace the whole model when the user explicitly asks to rebuild/rewrite it from scratch.",
      `API guide (methods: ${model.methods.map((m) => m.name).join(", ")}).`,
      `Reference example:\n${model.example}`,
      modelRenderBudgetText(),
      modelPrimitiveConstraintsText()
    );
    if (typeof read.source === "string" && read.source.trim() !== "") {
      lines.push(`Current modelScript (base to preserve and edit; keep all parts not mentioned by the user):\n${read.source}`);
    }
    if (read.modelContentVersion) lines.push(`Current model content hash: ${read.modelContentVersion.contentHash}.`);
    lines.push(cameraAppendix(read));
  } else if (input.mode === "film-set") {
    const motion = motionApiGuide();
    lines.push(
      "This is a film-set (composite-asset) node. It has NO top-level authored model: geometry lives in items.",
      "If you return `modelScript`, it edits the target model item (the captured itemId when provided, otherwise the existing model item). It MUST NOT be treated as a node-level model.",
      "If you return `motionScript`, it becomes the binding motion of the captured target object in the captured clip; it may only reference that object's stable part ids.",
      `motionScript uses ${motion.version}.`,
      `Model API methods: ${model.methods.map((m) => m.name).join(", ")}.`,
      `Motion API methods: ${motion.methods.map((m) => m.name).join(", ")}.`,
      `Model example:\n${model.example}`,
      modelRenderBudgetText(),
      modelPrimitiveConstraintsText(),
      `Motion example:\n${motion.example}`,
      motionApiGuideText(),
      "By default KEEP all existing objects, clips and geometry; change only what the user asked."
    );
    if (read.animation) {
      const collection = filmSetAnimationsOf(read.animation);
      const clip = collection.clips.find(candidate => candidate.id === (input.clipId ?? collection.defaultClipId));
      const captured = input.itemId ? read.animation.filmSetContent.items.find(item => item.id === input.itemId) : undefined;
      const targetModel = captured?.kind === "model" ? captured : read.animation.filmSetContent.items.find(item => item.kind === "model");
      lines.push(
        `Items: ${JSON.stringify(read.animation.filmSetContent.items.map(item => ({ id: item.id, kind: item.kind })))}.`,
        ...(captured ? [`Captured item: id=${captured.id}, kind=${captured.kind}.`] : []),
        ...(targetModel && targetModel.kind === "model" && !input.itemId ? [`Target model item: id=${targetModel.id}.`] : []),
        `Target clip: ${clip ? `id=${clip.id}, name=${clip.name}, duration=${clip.timeline.duration}, loop=${clip.timeline.loop}` : "(none)"}.`
      );
    }
    lines.push(cameraAppendix(read));
  } else {
    lines.push(
      "Produce a restricted list of camera mutations for the current node's canonical modelCameras.",
      "Allowed kinds: create, update, remove, rename, reset. Use stable ids from the current camera list for update/remove/rename/reset.",
      `Current cameras: ${JSON.stringify(read.cameras.map((camera) => ({ id: camera.id, name: camera.name, aspect: camera.aspect })))}.`,
      input.selectedCameraId ? `Selected camera id: ${input.selectedCameraId}.` : "No camera is selected."
    );
  }
  if (input.itemId) lines.push(`Only mutate the binding of captured itemId=${input.itemId} in clipId=${input.clipId}. No actor duplication or other actor changes.`);
  return lines.join("\n");
}

/**
 * 工具模式提示词（design D4b）。
 */
export function buildToolsPrompt(input: GenerateRequest, read: ReadOk): string {
  const model = modelApiGuide();
  const lines = [
    "You are a 3D authoring assistant editing a node on a canvas through the provided MCP tools.",
    "Use the tools to inspect the current state and apply ONLY the change the user asks for; keep all other existing parts unchanged.",
    `Target: canvas id \"${input.canvasId}\", node id \"${input.nodeId}\", node type \"${read.nodeType}\".`,
    input.mode === "film-set"
      ? "Call get_model_api and get_model_node first. For a whole film-set target, generate objects with submit_film_set using the current snapshotHash as expectedSnapshotHash and preserving all untouched animation fields. Empty or ground-only film-sets support new model items; their model has modelScript/modelScriptLanguage/modelScriptVersion and the host derives hashes. Never submit a top-level model script. For a captured clip/item target only use mutate_film_set_clip; for an existing model item use import_model_snapshot with itemId."
      : "Suggested flow: call get_model_api for the script API, get_model_node to read the current modelScript/state, then submit_model_script (with a stable requestId and expectedModelContentHash from the read) for incremental edits; use the camera tools for framing. Prefer small targeted edits over rewriting the whole script.",
    "Only quote vertex/triangle counts returned by get_model_statistics, get_model_node(includeStatistics=true) or submit_model_script; NEVER recompute them from the per-primitive cost table. A segment without shape is a capsule, so hand arithmetic underestimates by tens of times.",
    `User request: ${input.prompt}`,
    ...(input.itemId ? [`Captured actor itemId: ${input.itemId}; change only its binding in clip ${input.clipId}. Do not replace the clip or shared geometry.`] : [])
  ];
  if (typeof read.source === "string" && read.source.trim() !== "") {
    lines.push(`Current modelScript (preserve unless asked to change it):\n${read.source}`);
  }
  if (input.mode === "film-set" || read.animation !== undefined) lines.push(motionApiGuideText());
  if (input.clipId) lines.push(`Captured target clipId: ${input.clipId}. Use get_film_set_clips then mutate_film_set_clip ONLY for this clip. Each shot has an explicit kind (static/dynamic): a static shot is zero-duration with no motion or timed media, so adding object motion to it is refused — convert it with set-kind first. For actor motion update the binding using its existing itemId and root keyframes; never duplicate actors or shared geometry. Camera tracks belong to this clip's independent cameraMotion (no top-level model). No camera.follow API exists. Use explicit camera tween tracks.`);
  lines.push(`Model API version: ${model.preferredVersion}.`);
  if (input.itemId) lines.push(`Only mutate the binding of captured itemId=${input.itemId} in clipId=${input.clipId}. No actor duplication or other actor changes.`);
  return lines.join("\n");
}

/** 模型/动画提示词里的**可选镜头附录**。 */
function cameraAppendix(read: ReadOk): string {
  return [
    "Optional: you MAY also return `cameraMutations` to adjust this node's canonical cameras in the same turn.",
    "Set it to null (or []) unless the user asks for framing/camera changes. Kinds: create, update, remove, rename, reset;",
    "for update/remove/rename/reset use stable ids from the current list below.",
    `Current cameras: ${JSON.stringify(read.cameras.map((camera) => ({ id: camera.id, name: camera.name, aspect: camera.aspect })))}.`
  ].join(" ");
}
