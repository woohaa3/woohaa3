/**
 * 任务活动展示解析（change: 2026-10-09-improve-canvas-workflow，任务 5.1/5.2 / design D3）。
 *
 * 主行优先表达「正在做什么」：已知操作 + 共用作品显示名称（如「生成图片 · 海边日落」）；
 * 模型名退居次行，且从目录取人类可读标题，目录缺失才回退 modelKey。
 *
 * 纯函数：输入活动项、当前授权画布与目录，输出主/次行文案与定位可用性；不读取完整提示词或参数。
 */
import type { CanvasTaskActivity, CanvasTaskCatalog } from "@woohaa3/contracts";
import { resolveNodeDisplayName } from "@woohaa3/contracts";

export type TaskActivityDisplay = {
  /** 主行：`生成图片 · 海边日落`。 */
  primary: string;
  /** 次行：模型可读名（目录缺失回退 modelKey）。 */
  secondary: string;
  /** 是否可定位（目标节点仍在当前授权画布）。 */
  locatable: boolean;
  /** 定位不可用原因（可读）。 */
  locateReason: string | null;
};

const MODEL_TYPE_ACTIONS: Record<NonNullable<CanvasTaskActivity["modelType"]>, string> = {
  language: "生成文字",
  image: "生成图片",
  video: "生成视频",
  audio: "生成音频",
  motion: "生成动作"
};

/** 已知操作（来自任务种类，不从 prompt 猜测）。 */
export function taskActivityAction(item: Pick<CanvasTaskActivity, "modelType">): string {
  if (item.modelType) return MODEL_TYPE_ACTIONS[item.modelType];
  return "生成内容";
}

export type ActivityCanvasNode = { id: string; type: string; title?: string; prompt?: string };

/**
 * 目录模型可读标题查找。目录缺失（null/未就绪）或未命中时回退 `modelKey`。
 */
export function modelDisplayName(modelKey: string | undefined, catalog: CanvasTaskCatalog | null): string {
  if (!modelKey) return "未知模型";
  if (!catalog) return modelKey;
  const model = catalog.models.find((entry) => entry.modelKey === modelKey);
  return model?.title ?? modelKey;
}

export function resolveTaskActivityDisplay(input: {
  item: Pick<CanvasTaskActivity, "modelType" | "modelKey" | "nodeId">;
  /** 当前授权画布的节点（缺失表示节点已删除或尚未回流）。 */
  node: ActivityCanvasNode | null;
  catalog: CanvasTaskCatalog | null;
}): TaskActivityDisplay {
  const action = taskActivityAction(input.item);
  const nodeName = input.node
    ? resolveNodeDisplayName({ type: input.node.type, explicitName: input.node.title, prompt: input.node.prompt }).displayName
    : null;
  const primary = nodeName ? `${action} · ${nodeName}` : action;
  const secondary = modelDisplayName(input.item.modelKey, input.catalog);
  return {
    primary,
    secondary,
    locatable: input.node !== null,
    locateReason: input.node === null ? "该作品已被删除或尚未同步，无法定位" : null
  };
}
