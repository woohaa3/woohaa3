/**
 * ChatGPT 生成编排：提示词构造
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import { modelApiGuide, modelPrimitiveConstraintsText, modelRenderBudgetText, modelScaleGuidanceText } from "@woohaa3/contracts";
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
    `User request: ${input.prompt}`
  ];
  if (input.mode === "model3d") {
    lines.push(
      `Produce a complete self-contained static model implemented with the ${model.preferredVersion} SceneBuilder API (language ${model.language}).`,
      "The model MUST be deterministic, must not read other nodes, and must not declare animations.",
      "The node ALREADY has a model authored by the user. By default you MUST KEEP it and make only the requested change (add/remove/modify specific parts).",
      "Only replace the whole model when the user explicitly asks to rebuild/rewrite it from scratch.",
      `API guide (methods: ${model.methods.map((m) => m.name).join(", ")}).`,
      modelScaleGuidanceText(),
      `Reference example:\n${model.example}`,
      modelRenderBudgetText(),
      modelPrimitiveConstraintsText()
    );
    if (typeof read.source === "string" && read.source.trim() !== "") {
      lines.push(`Current modelScript (base to preserve and edit; keep all parts not mentioned by the user):\n${read.source}`);
    }
    if (read.modelContentVersion) lines.push(`Current model content hash: ${read.modelContentVersion.contentHash}.`);
    lines.push(cameraAppendix(read));
  } else {
    lines.push(
      "Produce a restricted list of camera mutations for the current node's canonical modelCameras.",
      "Allowed kinds: create, update, remove, rename, reset. Use stable ids from the current camera list for update/remove/rename/reset.",
      `Current cameras: ${JSON.stringify(read.cameras.map((camera) => ({ id: camera.id, name: camera.name, aspect: camera.aspect })))}.`,
      input.selectedCameraId ? `Selected camera id: ${input.selectedCameraId}.` : "No camera is selected."
    );
  }
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
    "Suggested flow: call get_model_api for the script API, get_model_node to read the current modelScript/state, then submit_model_script (with a stable requestId and expectedModelContentHash from the read) for incremental edits; use the camera tools for framing. Prefer small targeted edits over rewriting the whole script.",
    modelScaleGuidanceText(),
    "Only quote vertex/triangle counts returned by get_model_statistics, get_model_node(includeStatistics=true) or submit_model_script; NEVER recompute them from the per-primitive cost table. A segment without shape is a capsule, so hand arithmetic underestimates by tens of times.",
    `User request: ${input.prompt}`
  ];
  if (typeof read.source === "string" && read.source.trim() !== "") {
    lines.push(`Current modelScript (preserve unless asked to change it):\n${read.source}`);
  }
  lines.push(`Model API version: ${model.preferredVersion}.`);
  return lines.join("\n");
}

/** 模型提示词里的**可选镜头附录**。 */
function cameraAppendix(read: ReadOk): string {
  return [
    "Optional: you MAY also return `cameraMutations` to adjust this node's canonical cameras in the same turn.",
    "Set it to null (or []) unless the user asks for framing/camera changes. Kinds: create, update, remove, rename, reset;",
    "for update/remove/rename/reset use stable ids from the current list below.",
    `Current cameras: ${JSON.stringify(read.cameras.map((camera) => ({ id: camera.id, name: camera.name, aspect: camera.aspect })))}.`
  ].join(" ");
}
