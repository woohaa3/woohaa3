/// <reference types="vite/client" />
/**
 * 仅 DEV 的媒体诊断开关（临时工具，用于「有/无视频」帧率 A/B）。
 *
 * 背景：`notes/frame-rate-analysis-2026-10-15-1050.md` 的 trace 显示，画布/片场里的视频节点会带来
 * 隐藏 `<video>` 解码与多 MB mp4 预取、以及 `drawImage → getImageData` 的 CPU 回读上传，
 * 这些工作与 wgpu 抢同一块 GPU，是那次卡顿的可疑来源。
 *
 * 为了做隔离实验，开启后让画布媒体层**完全不碰视频**：不建立视频帧会话（不创建 `<video>`、
 * 不下载、不上传），并跳过复合资产媒体源里的视频源。
 *
 * 开启方式（任一命中即可，便于不同入口/被改写 URL 的情况）：
 * 1. 页面 URL 带 `?woohaaDevNoVideo=1`（也接受 `#...?woohaaDevNoVideo=1`）；
 * 2. 同源父框架 URL 带该参数（应用被嵌在 iframe 里时）；
 * 3. `localStorage`/`sessionStorage` 的 `woohaa:devNoVideo` 为 `"1"`
 *    （URL 被重写/参数被吞时用：在应用页 Console 执行
 *    `sessionStorage.setItem("woohaa:devNoVideo","1")` 后刷新；用完 `removeItem` 清掉）。
 *
 * 边界：只在 DEV 生效；只读 URL/存储，不改动画布/节点数据/持久化状态；发布构建里恒为 false。
 * 这是录 trace 的临时手段，不属于产品行为。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CompositeAssetMediaSource } from "../../../extension-api/composite-assets.js";

/** 关闭视频用的查询参数名（值必须为 `1`）。 */
export const DEV_NO_VIDEO_PARAM = "woohaaDevNoVideo";
/** 关闭视频用的存储键（值为 `"1"`）。 */
export const DEV_NO_VIDEO_STORAGE_KEY = "woohaa:devNoVideo";

/** 从 `search` 或 `hash` 片段里解析开关。 */
function parseFlag(fragment: string): boolean {
  if (!fragment) return false;
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const at = text.indexOf("?");
  const query = at >= 0 ? text.slice(at + 1) : text;
  try {
    return new URLSearchParams(query).get(DEV_NO_VIDEO_PARAM) === "1";
  } catch {
    return false;
  }
}

/** 参数存在但值不是 `1`：多半是用错了写法（用于给出可见提示，而不是静默失败）。 */
export function hasMismatchedFlagIn(fragment: string): boolean {
  if (!fragment) return false;
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const at = text.indexOf("?");
  const query = at >= 0 ? text.slice(at + 1) : text;
  try {
    const value = new URLSearchParams(query).get(DEV_NO_VIDEO_PARAM);
    return value !== null && value !== "1";
  } catch {
    return false;
  }
}

function currentFragments(): string[] {
  const fragments: string[] = [];
  if (typeof globalThis.location === "undefined") return fragments;
  const location = globalThis.location as Location;
  fragments.push(`${location.search}${location.hash}`);
  // 应用被嵌在同源 iframe 时，参数通常在父框架 URL 上；跨源访问会抛错，此时放弃。
  try {
    let frame: Window = globalThis.window;
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = frame.parent;
      if (parent === frame) break;
      fragments.push(`${parent.location.search}${parent.location.hash}`);
      frame = parent;
    }
  } catch {
    /* 忽略：拿不到父框架（跨源等） */
  }
  return fragments;
}

/** 读取存储键；隐私模式/禁用时逐项忽略。 */
function storedFlag(): boolean {
  const storages: Array<Storage | undefined> = [];
  try {
    storages.push(globalThis.localStorage);
  } catch {
    /* 忽略 */
  }
  try {
    storages.push(globalThis.sessionStorage);
  } catch {
    /* 忽略 */
  }
  return storages.some((storage) => {
    try {
      return storage?.getItem(DEV_NO_VIDEO_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
}

/** 当前 URL（本框架 + 同源父框架）里是否带了写法不对的开关值。 */
export function hasMismatchedFlag(): boolean {
  return currentFragments().some(hasMismatchedFlagIn);
}

/** 是否处于「视频关闭」诊断模式（默认读 DEV 标记、URL 与 storage）。 */
export function isDevVideoDisabled(
  probe: { search?: string; hash?: string; fragments?: string[]; stored?: boolean; dev?: boolean } = {}
): boolean {
  if (!(probe.dev ?? import.meta.env.DEV)) return false;
  if (probe.stored === true) return true;
  const fragments = probe.fragments
    ?? (probe.search !== undefined || probe.hash !== undefined
      ? [`${probe.search ?? ""}${probe.hash ?? ""}`]
      : currentFragments());
  if (fragments.some(parseFlag)) return true;
  return probe.stored === false ? false : storedFlag();
}

/** 从交给视频会话的画布视图里去掉 `type: "video"` 节点（浅拷贝，不改动原画布/节点数据）。 */
export function withoutVideoNodes(canvas: ServerCanvas | null): ServerCanvas | null {
  if (!canvas) return null;
  const nodes = canvas.document.nodes;
  if (!nodes.some((node) => node.type === "video")) return canvas;
  return { ...canvas, document: { ...canvas.document, nodes: nodes.filter((node) => node.type !== "video") } };
}

/** 去掉复合资产媒体源里的视频源，保留图片等其它媒体。 */
export function withoutVideoMediaSources(sources: readonly CompositeAssetMediaSource[]): CompositeAssetMediaSource[] {
  return sources.filter((source) => source.kind !== "video");
}
