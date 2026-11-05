/**
 * 作品名称解析（change: 2026-10-09-improve-canvas-workflow，任务 2.1 / design D1）。
 *
 * 卡片主标题、任务活动与查找共用同一份纯展示解析，避免同一作品在三个区域名称分叉。
 * 优先级：
 * 1. 去首尾空白后的显式名称（普通节点/容器取 `nodeData.title`，legacy group 取既有
 *    `nodeData.title`）；
 * 2. 该节点**已提交**提示词首段的有界可读摘要（不读未提交草稿，不写回文档）；
 * 3. 中文默认名称（按内容类型）。
 *
 * 纯函数：不依赖 DOM / Node / Yjs，不修改输入文档，不产生输出内容。
 */
import { woohaa3CanvasMentionStorageToDisplay } from "./domain/core/mention-token.js";

export type NodeDisplayNameSource = "explicit" | "prompt-summary" | "default";

export type NodeDisplayName = {
  /** 主标题展示名（有界）。 */
  displayName: string;
  /** 次要类型标记（中文）。 */
  contentTypeLabel: string;
  /** 名称来源，决定是否属于自动摘要（不持久化）。 */
  nameSource: NodeDisplayNameSource;
};

/** 显式名称最大 Unicode 字符数（design D1 / spec）。 */
export const MAX_NODE_DISPLAY_NAME_LENGTH = 120;

/** 提示词摘要最大 Unicode 字符数（design D1）。 */
export const MAX_PROMPT_SUMMARY_LENGTH = 32;

/** 中文类型标记。 */
const CONTENT_TYPE_LABELS: Record<string, string> = {
  text: "文字",
  image: "图片",
  video: "视频",
  audio: "音频",
  model3d: "3D 模型",
  "composite-asset": "复合资产",
  "scene-area": "导演区",
  group: "分组",
  "world-camera": "镜头",
  custom: "自定义"
};

const DEFAULT_NAMES: Record<string, string> = {
  text: "未命名文字",
  image: "未命名图片",
  video: "未命名视频",
  audio: "未命名音频",
  model3d: "未命名模型",
  "composite-asset": "未命名复合资产",
  "scene-area": "导演区",
  group: "未命名分组",
  "world-camera": "未命名镜头"
};

/** 按类型返回中文代号（未知类型回退“作品”）。 */
export function contentTypeLabelForNode(type: string | undefined): string {
  if (type && type in CONTENT_TYPE_LABELS) return CONTENT_TYPE_LABELS[type]!;
  return "作品";
}

/** 按类型返回中文默认名称（未知类型回退“未命名作品”）。 */
export function defaultDisplayNameForNode(type: string | undefined): string {
  if (type && type in DEFAULT_NAMES) return DEFAULT_NAMES[type]!;
  return "未命名作品";
}

/**
 * 去除首尾空白并按 Unicode 码点截断到上限（不拆分代理对）。
 * 显式名称与摘要共用，避免同一处重复实现。
 */
export function truncateUnicode(input: string, max: number): string {
  const trimmed = input.trim();
  const codePoints = [...trimmed];
  if (codePoints.length <= max) return trimmed;
  return codePoints.slice(0, max).join("");
}

/**
 * 校验显式名称：去首尾空白、非纯空白、不超过 120 个 Unicode 字符。
 * 返回规范化后的名称或可读错误。
 */
export function validateExplicitName(input: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof input !== "string") return { ok: false, message: "请输入名称" };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, message: "名称不能为空" };
  if ([...trimmed].length > MAX_NODE_DISPLAY_NAME_LENGTH) {
    return { ok: false, message: `名称不能超过 ${MAX_NODE_DISPLAY_NAME_LENGTH} 个字` };
  }
  return { ok: true, value: trimmed };
}

/**
 * 从已提交提示词生成有界可读摘要。
 *
 * - 结构化 mention token 转成已有安全可读标签（`@label`），不展示内部 ID；
 * - 合并换行与多余空白；
 * - 按 Unicode 字符截断到 32 字。
 * 空提示词返回 null（调用方回退默认名称）。
 */
export function promptSummary(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const readable = woohaa3CanvasMentionStorageToDisplay(prompt).replace(/\s+/g, " ").trim();
  if (readable === "") return null;
  return truncateUnicode(readable, MAX_PROMPT_SUMMARY_LENGTH);
}

export type NodeNameInput = {
  type?: string;
  /** 显式名称（nodeData.title / group.title / 容器标题）。 */
  explicitName?: unknown;
  /** 已提交提示词（nodeData.prompt）。 */
  prompt?: unknown;
};

/**
 * 解析节点展示名称。
 *
 * 不读取未提交草稿：调用方只应传入规范 nodeData 的字段。自动摘要不持久化，也不被当作
 * 节点输出。
 */
export function resolveNodeDisplayName(input: NodeNameInput): NodeDisplayName {
  const type = input.type;
  const contentTypeLabel = contentTypeLabelForNode(type);

  if (typeof input.explicitName === "string") {
    const trimmed = input.explicitName.trim();
    if (trimmed !== "") {
      return {
        displayName: truncateUnicode(trimmed, MAX_NODE_DISPLAY_NAME_LENGTH),
        contentTypeLabel,
        nameSource: "explicit"
      };
    }
  }

  const summary = promptSummary(input.prompt);
  if (summary) {
    return { displayName: summary, contentTypeLabel, nameSource: "prompt-summary" };
  }

  return { displayName: defaultDisplayNameForNode(type), contentTypeLabel, nameSource: "default" };
}
