/**
 * Pinterest 窗口右键「保存到素材库 / 发送到画布」的主窗口一侧。
 *
 * 整条链路（页面 → 主窗口）：
 *
 * ```
 * Pinterest 窗口里右键 → 页内菜单 → 哨兵导航（desktop/src/pinterest_menu.js）
 *   → Rust 校验并下载（desktop/src/pinterest_save.rs，只允许 pinimg.com，走系统代理）
 *   → Rust 对主窗口 eval：window.__sixiPinterestSave({ id, mode, title, sourceUrl, pageUrl })
 *   → 这里：取走暂存的图 → mediaRemote.upload（同源，无需令牌）
 *       mode=library → POST /api/library/register  （存进素材库，不属于任何画布）
 *       mode=canvas  → asset.upsert + 插入图片节点   （放到当前视口中心）
 *   → 回报结果，Rust 在 Pinterest 窗口里弹提示
 * ```
 *
 * 为什么字节要绕主窗口上传，而不是 Rust 直接传给后端：桌面模式下宿主后端不继承 `WOOHAA3_*` 令牌，
 * Rust 调不了需要令牌的接口；而主窗口发的是**同源**请求，本来就被后端接受。
 * 这样 Rust 侧不需要知道后端端口、令牌或任何业务，只负责「把图拿回来」。
 *
 * 纯规划与 IO 分开：`planPlaceOnCanvas` 不碰 DOM / fetch，可以直接单测。
 */
import type { CanvasCommand, StoredAsset } from "@woohaa3/contracts";
import { createHighEntropyId } from "@woohaa3/contracts";
import { buildUploadedAsset, planUploadedNode, type UploadedMedia } from "../../../extension-api/upload-asset.js";
import { nativeProtocolUrl } from "../../../desktop/native-protocol.js";
import { desktopBootstrap } from "../../../extension-api/host-platform.js";
import { nextPlacement } from "./image-library.js";

export type PinterestSaveMode = "library" | "canvas";

/** Rust 传来的事件。**页面给的文字（title / pageUrl）只当数据，不当代码。** */
export type PinterestSaveEvent = {
  id: string;
  mode: PinterestSaveMode;
  title: string;
  sourceUrl: string;
  pageUrl: string;
};

export type PinterestSaveOutcome = { ok: true; message: string } | { ok: false; message: string };

/** 把外部来源的图变成「外部导入」资产：复用上传的资产构造，只改来源与标题。 */
export function buildExternalAsset(input: { media: UploadedMedia; title: string; now?: string }): StoredAsset {
  const asset = buildUploadedAsset({
    media: input.media,
    mediaKind: "image",
    file: { name: input.title || "Pinterest 图片", type: input.media.contentType, size: input.media.size },
    ...(input.now ? { now: input.now } : {})
  });
  return { ...asset, source: "external" };
}

/**
 * 「发送到画布」的命令批次：资产 + 图片节点，位置在视口中心附近并错开已有节点。
 * 与「添加到画布」（图库面板）、粘贴导入是同一套摆放规则，所以连续发送不会叠在一起。
 */
export function planPlaceOnCanvas(input: {
  asset: StoredAsset;
  center: { x: number; y: number; zoom: number };
  nearby: number;
}): CanvasCommand[] {
  return planUploadedNode({
    nodeType: "image",
    position: nextPlacement(input.center, input.nearby),
    file: { name: input.asset.title, type: String(input.asset.metadata?.contentType ?? ""), size: Number(input.asset.metadata?.size ?? 0) },
    asset: input.asset
  });
}

/** 宿主能力的最小切面：测试可以替换，也避免这个模块直接依赖整个 ctx。 */
export type PinterestSaveDeps = {
  /** 从桌面壳取走暂存的图（取走即删）。 */
  takeBlob(id: string): Promise<File>;
  upload(file: File): Promise<{ ok: true; media: UploadedMedia } | { ok: false; error: string }>;
  /** 登记进素材库。后端会再核验媒体对象，不信任这里自报的信息。 */
  registerLibrary(input: { media: UploadedMedia; title: string; sourceUrl: string; pageUrl: string }): Promise<void>;
  canvas: {
    isWritable(): boolean;
    /** 没有打开的画布时为 `null`。 */
    hasCanvas(): boolean;
    center(): { x: number; y: number; zoom: number };
    nearby(x: number, y: number): number;
    submit(commands: readonly CanvasCommand[], commandId: string): { ok: true } | { ok: false; reason: string };
  };
};

function fileNameFor(title: string, mime: string): string {
  const ext = mime === "image/jpeg" ? "jpg" : mime.replace("image/", "") || "img";
  const base = (title || "pinterest").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "pinterest";
  return `${base}.${ext}`;
}

/**
 * 处理一次保存。**每一步失败都返回能直接显示给用户的原因**，从不静默吞掉：
 * 用户是在另一个窗口里点的，主窗口这边出错他看不到，只能靠回报。
 */
export async function handlePinterestSave(event: PinterestSaveEvent, deps: PinterestSaveDeps): Promise<PinterestSaveOutcome> {
  // 发送到画布：先确认画布能写，再去上传。否则白白上传一张图，最后才告诉用户「没画布」。
  if (event.mode === "canvas") {
    if (!deps.canvas.hasCanvas()) return { ok: false, message: "还没有打开的画布，先打开一张画布再发送" };
    if (!deps.canvas.isWritable()) return { ok: false, message: "画布当前是只读的（未连接或同步未就绪）" };
  }

  let file: File;
  try {
    file = await deps.takeBlob(event.id);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "取回图片失败" };
  }
  // 文件名只是展示用；真正的类型以魔数为准（Rust 已校验），这里补一个合理的扩展名
  const named = new File([file], fileNameFor(event.title, file.type), { type: file.type });

  const uploaded = await deps.upload(named);
  if (!uploaded.ok) return { ok: false, message: `上传失败：${uploaded.error}` };
  const { media } = uploaded;

  if (event.mode === "library") {
    try {
      await deps.registerLibrary({ media, title: event.title, sourceUrl: event.sourceUrl, pageUrl: event.pageUrl });
      return { ok: true, message: "已保存到素材库" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "保存到素材库失败" };
    }
  }

  const asset = buildExternalAsset({ media, title: event.title });
  const center = deps.canvas.center();
  const commands = planPlaceOnCanvas({ asset, center, nearby: deps.canvas.nearby(center.x, center.y) });
  const result = deps.canvas.submit(commands, createHighEntropyId("pinterest-send"));
  return result.ok ? { ok: true, message: "已发送到画布" } : { ok: false, message: result.reason || "没有添加到画布" };
}

// ---------------------------------------------------------------------------
// 与桌面壳、后端的真实 IO。上面的逻辑都不直接碰它们。

declare global {
  interface Window {
    __sixiPinterestSave?: (event: PinterestSaveEvent) => void;
  }
}

/** 从桌面壳取走暂存的图。原生协议只认主窗口的 token，Pinterest 窗口调不了。 */
export async function takeBlobFromDesktop(id: string): Promise<File> {
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) throw new Error("只能在桌面端使用");
  const response = await fetch(`${nativeProtocolUrl("pinterest-blob")}?id=${encodeURIComponent(id)}`, {
    headers: { "X-Woohaa-Token": bootstrap.token },
    signal: AbortSignal.timeout(15_000)
  });
  const type = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !type.startsWith("image/")) {
    // 取不到时 Rust 回的是 JSON：把原因带出来
    let reason = "图片已过期，请重新保存";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) reason = body.error;
    } catch {
      // 不是 JSON 就用默认说法
    }
    throw new Error(reason);
  }
  return new File([await response.blob()], "pinterest", { type });
}

/** 把结果回报给桌面壳，由它在 Pinterest 窗口里弹提示。回报本身失败不影响已完成的保存。 */
export async function reportToDesktop(outcome: PinterestSaveOutcome): Promise<void> {
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) return;
  try {
    await fetch(nativeProtocolUrl("pinterest-result"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Woohaa-Token": bootstrap.token },
      body: JSON.stringify({ ok: outcome.ok, message: outcome.message }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    // 提示发不出去只是少一条 toast
  }
}

/** 登记进素材库。同源请求，由后端按 Origin 放行，不需要令牌。 */
export async function registerLibraryItem(
  fetchImpl: typeof fetch,
  publicUrl: (path: string) => string,
  input: { media: UploadedMedia; title: string; sourceUrl: string; pageUrl: string }
): Promise<void> {
  const response = await fetchImpl(publicUrl("/api/library/register"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storageKey: input.media.storageKey,
      checksum: input.media.checksum,
      contentType: input.media.contentType,
      size: input.media.size,
      title: input.title,
      sourceUrl: input.sourceUrl,
      pageUrl: input.pageUrl
    })
  });
  if (response.ok) return;
  let reason = `保存到素材库失败（HTTP ${response.status}）`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) reason = body.error;
  } catch {
    // 不是 JSON 就用默认说法
  }
  throw new Error(reason);
}

/**
 * 在主窗口挂上入口。**同一时刻只有一个处理者**：重复安装（热重载 / 严格模式）返回的清理函数
 * 只会撤销自己挂的那一份，不会把后挂的也清掉。
 */
export function installPinterestSave(deps: PinterestSaveDeps): () => void {
  const handler = (event: PinterestSaveEvent) => {
    void handlePinterestSave(event, deps).then(reportToDesktop);
  };
  window.__sixiPinterestSave = handler;
  return () => {
    if (window.__sixiPinterestSave === handler) delete window.__sixiPinterestSave;
  };
}

