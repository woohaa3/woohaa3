import {
  filmSetAnimationsOf,
  filmSetClipHash,
  type ContentAgentTargetDeclaration,
  type ContentAgentTargetVersionContext,
  type FilmSetNodeData
} from "@woohaa3/contracts";

/**
 * 片场 Agent 目标的运行时描述符
 * （change: 2026-10-28-generic-extension-content-ownership，任务 6.3）。
 *
 * 宿主只消费通用目录：mode、读写工具、提示词与事件归属都在这里声明；共享
 * `agent-connections` 不再包含片场工具或业务提示词。实际每次调用仍由 grant 校验。
 */
export const filmSetAgentTarget: ContentAgentTargetDeclaration = {
  mode: "film-set",
  readTools: ["get_model_api", "get_model_node", "get_film_set_clips", "get_film_set_export"],
  writeTools: [
    "submit_film_set",
    "mutate_film_set_item",
    "mutate_film_set_clip",
    "add_film_set_media",
    "export_film_set_clip",
    "create_film_set_node",
    "import_model_snapshot"
  ],
  events: ["film-set"],
  hashArgs: ["expectedSnapshotHash", "expectedClipHash"],
  prompt: [
    "流程：先调用 get_model_api 了解脚本 API，再调用 get_model_node 读取完整 animation 和 snapshotHash；需要镜头/机位时调用 get_film_set_clips。",
    "生成或增添场景对象用 submit_film_set，在现有节点保存完整 filmSetContent 与 filmSetAnimations，expectedSnapshotHash 使用读取到的 snapshotHash；片场只有地面或为空也能生成。主要对象分别建模，新 model item 的 model 提供 modelScript、modelScriptLanguage=javascript、modelScriptVersion=woohaa-model-js-v2，版本和哈希由宿主派生。",
    "sceneCamera 只是无拍摄镜头时的回退构图，不是镜头，也不会出现在 get_film_set_clips 的 clips 中。用户要求镜头/机位/拍摄时，必须创建至少一个 clip（静态构图也用 kind=static）；submit_film_set 不会自动创建镜头，提交内容后调用 get_film_set_clips，clips 为空时把 clipTemplate 改 id/name/initialCamera，用 missingClipHash 调 mutate_film_set_clip(op.kind=\"create\")，确认 clips 非空再报告完成。",
    "片场不保存顶层模型脚本。修改已有模型用 import_model_snapshot 并指定 itemId；片场对象变换/绑定/片段用 mutate_film_set_item / mutate_film_set_clip。仅有 clipId/itemId 的动作目标必须使用局部工具，不得整体提交。",
    "只有明确要求在另一节点新建片场时才使用 create_film_set_node。",
    "图片/视频（含做成图片的文字）用 add_film_set_media 放入片场，画布拖放仍只接受模型；",
    "成片导出用 export_film_set_clip（standard / hd / hd60）并以 get_film_set_export 轮询；原生不可用时它会返回 recording-unavailable，请如实告知用户改用界面上的「生成视频」。",
    "保留未提及的对象、片段、运动、镜头与时间线；修改后核对运动适配状态。"
  ]
};

/**
 * 片场目标的内容身份：整节点目标用宿主默认哈希，单个 clip 目标用该 clip 的稳定哈希。
 * 找不到冻结 clip 时返回空串，让调用方按版本冲突拒绝而不是退回整节点快照。
 */
export function filmSetAgentTargetVersion(input: ContentAgentTargetVersionContext): string | null {
  if (!input.clipId) return null;
  const animation = (input.target as { animation?: unknown } | null | undefined)?.animation;
  if (!animation) return "";
  try {
    const clip = filmSetAnimationsOf(animation as FilmSetNodeData).clips.find((entry) => entry.id === input.clipId);
    return clip ? filmSetClipHash(clip) : "";
  } catch {
    return "";
  }
}
