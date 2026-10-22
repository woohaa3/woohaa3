/**
 * 视频生成模式的角色/数量约束（change: add-audio-video-generation-and-align-model-catalog，任务 3.3）。
 *
 * `parameters.generationMode` 决定可接受的引用角色：
 * - `omni_reference`（默认）：普通图片/视频/音频角色；
 * - `first_last_frame`：至多一个 first_frame、至多一个 last_frame（图片）；
 * - `edit_video`：恰好一个 edit_video（视频）。
 *
 * 纯函数：Canvas Service 与 Frontend 共用同一规则，在 provider 调用前拒绝并给出稳定原因。
 */
import type { CanvasTaskInputBinding } from "../../task/dto";
import type { CanvasReferenceMediaKind } from "../../task/dto";

export type GenerationMode = "omni_reference" | "first_last_frame" | "edit_video";

export type ResolvedInput = {
  role: string;
  mediaKind?: CanvasReferenceMediaKind;
};

export function readGenerationMode(parameters: Record<string, unknown> | undefined): GenerationMode {
  const mode = parameters?.generationMode;
  if (mode === "first_last_frame" || mode === "edit_video") return mode;
  return "omni_reference";
}

/** 返回阻止原因列表（空表示满足约束）。 */
export function validateGenerationModeInputs(
  mode: GenerationMode,
  inputs: readonly ResolvedInput[],
  bindings: readonly CanvasTaskInputBinding[]
): string[] {
  const reasons: string[] = [];
  const mediaInputs = inputs.filter((input) => !isTextPrompt(input.role));

  if (mode === "first_last_frame") {
    const first = mediaInputs.filter((input) => input.role === "first_frame").length;
    const last = mediaInputs.filter((input) => input.role === "last_frame").length;
    const others = mediaInputs.filter((input) => input.role !== "first_frame" && input.role !== "last_frame");
    if (first > 1) reasons.push("first_last_frame 模式最多允许一个 first_frame");
    if (last > 1) reasons.push("first_last_frame 模式最多允许一个 last_frame");
    for (const input of others) {
      if (input.mediaKind !== "image") {
        reasons.push(`first_last_frame 模式只接受图片引用（收到 ${input.role}）`);
      }
    }
    if (!bindingAccepts(bindings, "first_frame") && first > 0) {
      reasons.push("所选模型不接受 first_frame");
    }
  }

  if (mode === "edit_video") {
    const edits = mediaInputs.filter((input) => input.role === "edit_video");
    if (edits.length !== 1) {
      reasons.push("edit_video 模式要求恰好一个 edit_video 输入");
    }
    for (const input of mediaInputs) {
      if (input.role !== "edit_video") {
        reasons.push(`edit_video 模式不接受 ${input.role}（只允许一个 edit_video）`);
      } else if (input.mediaKind !== "video") {
        reasons.push("edit_video 输入必须是视频");
      }
    }
    if (edits.length === 1 && !bindingAccepts(bindings, "edit_video")) {
      reasons.push("所选模型不接受 edit_video");
    }
  }

  return reasons;
}

function bindingAccepts(bindings: readonly CanvasTaskInputBinding[], role: string): boolean {
  return bindings.some((binding) => binding.roles.includes(role));
}

function isTextPrompt(role: string): boolean {
  return role === "text_prompt";
}
