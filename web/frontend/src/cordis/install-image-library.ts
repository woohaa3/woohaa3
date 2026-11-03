/**
 * 图片库服务装配（从 `install-services.ts` 的 `installCanvasPageServices` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`install-services.ts` 因图库跨画布放置涨到 825 行。这块自成一体，
 * 依赖只有 `ctx`、画布 id 与画布 state 门面三样，所以可以直接做成一个安装函数。
 *
 * 图库的**数据源与放置逻辑**在 `plugins/canvas-shell/image-library.ts`；这里只负责把它接到
 * 宿主服务上（惰性读 canvasCommands / canvasRuntime、跨画布取数与缓存）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CanvasCommand, CanvasNodeData, StoredAsset } from "@woohaa3/contracts";
import { createHighEntropyId } from "@woohaa3/contracts";
import { planInsertNode } from "../extension-api/command-planner.js";
import { planImportLayout } from "./plugins/paste-import/batch.js";
import { crossCanvasSource, currentCanvasSource, nearbyNodeCount, type ImageLibraryWrites } from "./plugins/canvas-shell/image-library.js";
import { planPlaceLibraryItem, withLibrary, type LibraryEntry } from "./plugins/canvas-shell/library-source.js";
import {
  installPinterestSave,
  registerLibraryItem,
  takeBlobFromDesktop
} from "./plugins/canvas-shell/pinterest-save.js";
import { appPublicUrl, getAppPublicFetch } from "./services/app-base-path.js";
import { CANVAS_IMAGES_PATH, withMediaCanvasHint } from "./services/paths.js";

/**
 * 跨画布图库一次取多少张图。
 *
 * 与后端 `handleImageList` 的上限（500）保持一致：后端会把超出的部分静默截掉，
 * 前端写再大也没用。图片继续增长时应当改成分页，而不是把这个数字调大。
 */
const FOREIGN_IMAGE_LIMIT = 500;

/** 画布 state 门面：图库只读，不直接 import 宿主内部 store。 */
type CanvasStateFacade = Parameters<typeof currentCanvasSource>[0];

export function installImageLibrary(ctx: Context, input: { canvasId: string; canvasStateFacade: CanvasStateFacade }): void {
  const { canvasId, canvasStateFacade } = input;
  /*
   * 图片库：资源栏面板与扩展（如四喜的资源页）读同一份，写也走同一个实现。范围只有当前画布。
   *
   * 写操作**惰性**读 `canvasCommands` / `canvasRuntime`：它们在 install 阶段还没提供
   * （同一批装配里晚到），装配期取一次会永久拿到 undefined，表现为按钮点了没反应。
   */
  const imageWrites: ImageLibraryWrites = {
    isWritable: () => (ctx.get("canvasCommands" as never) as { isWritable(): boolean } | undefined)?.isWritable() ?? false,
    submit: (commands, commandId) => {
      const service = ctx.get("canvasCommands" as never) as
        | { submit(commands: readonly CanvasCommand[], commandId: string): { ok: true } | { ok: false; reason: string } }
        | undefined;
      if (!service) return { ok: false, reason: "画布还没有就绪" };
      return service.submit(commands, commandId);
    },
    viewportCenter: () => {
      const controller = (
        ctx.get("canvasRuntime" as never) as
          | {
              controller(): {
                surface(): { width: number; height: number };
                viewport(): { x: number; y: number; zoom: number };
              } | null;
            }
          | undefined
      )?.controller();
      if (!controller) return { x: 0, y: 0, zoom: 1 };
      const surface = controller.surface();
      const viewport = controller.viewport();
      const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
      return {
        x: (surface.width / 2 - viewport.x) / zoom,
        y: (surface.height / 2 - viewport.y) / zoom,
        zoom
      };
    },
    /*
     * 其他画布的图带到当前画布。
     *
     * 资产本体照抄原画布那份（id / metadata / url 都不改），**只**把节点数据里的媒体地址
     * 换成带原画布提示的那一条：字节按画布分开存，少了这个提示当前画布读不到。
     * 拿不到原资产就直接失败，不写一个引用不到字节的节点。
     */
    async addForeignToCanvas(foreignCanvasId, assetId) {
      const blocked = (ctx.get("canvasCommands" as never) as { isWritable(): boolean } | undefined)?.isWritable()
        ? null
        : { ok: false as const, reason: "画布当前是只读的（未连接或同步未就绪）" };
      if (blocked) return blocked;
      const canvas = (ctx.get("canvasState" as never) as
        | { getCanvas(): import("@woohaa3/contracts").ServerCanvas | null }
        | undefined)?.getCanvas();
      if (!canvas) return { ok: false, reason: "画布还没有就绪" };
      const source = await loadForeignAsset(foreignCanvasId, assetId);
      if (!source) return { ok: false, reason: "读取不到这张图片（它所在画布的内容还没发布）" };

      const { x, y, zoom } = imageWrites.viewportCenter();
      const position = planImportLayout({ x, y }, nearbyNodeCount({ getCanvas: () => canvas, getWorkingCanvas: () => null }, x, y) + 1, zoom).at(-1)!;
      const nodeData: CanvasNodeData = {
        title: source.title || "图片",
        outputAssetId: source.id,
        resourceKind: "image",
        taskStatus: "successed"
      };
      const commands: CanvasCommand[] = [
        { type: "asset.upsert", asset: source },
        ...planInsertNode({ nodeType: "image", position, nodeData })
      ];
      const result = imageWrites.submit(commands, createHighEntropyId("image-add-foreign"));
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "没有添加到画布" };
    }
  };
  const currentImages = currentCanvasSource(canvasStateFacade, canvasId, undefined, imageWrites);
  /*
   * 跨画布图库：当前画布读 store，其余画布读后端 `GET /api/canvases/images`
   * （从各画布的已发布投影抽图片，见 canvas-service 的 `image-index.ts`）。
   *
   * **只有一处取数函数**，面板刷新和跨画布放置共用它：
   * 之前两个调用点各写了一份同样的请求，正常路径下缓存永远是空的，跨画布添加要再拉一遍。
   * 结果在 `foreignCache` 里留一份，放置时按 (画布, 资产) 取完整资产。
   */
  type ForeignEntry = {
    canvasId: string;
    canvasTitle?: string;
    id: string;
    title: string;
    url: string;
    source: "uploaded" | "generated" | "external";
    isFavorite: boolean;
    createdAt: string;
    asset: StoredAsset;
  };
  let foreignCache: ForeignEntry[] = [];
  let foreignRequest: Promise<ForeignEntry[]> | null = null;
  const loadForeignEntries = (): Promise<ForeignEntry[]> => {
    // 在途合并：面板刷新与「添加到画布」同时触发时只发一次请求
    if (foreignRequest) return foreignRequest;
    foreignRequest = (async () => {
      const response = await getAppPublicFetch()(
        appPublicUrl(`${CANVAS_IMAGES_PATH}?offset=0&limit=${FOREIGN_IMAGE_LIMIT}`),
        { credentials: "same-origin" }
      );
      if (!response.ok) throw new Error(`读取其他画布的图片失败（HTTP ${response.status}）`);
      const body = (await response.json()) as { items?: unknown };
      foreignCache = Array.isArray(body.items) ? (body.items as ForeignEntry[]) : [];
      return foreignCache;
    })().finally(() => {
      foreignRequest = null;
    });
    return foreignRequest;
  };

  const loadForeignAsset = async (foreignCanvasId: string, assetId: string) => {
    const find = () => foreignCache.find((entry) => entry.canvasId === foreignCanvasId && entry.id === assetId);
    const cached = find();
    if (cached) return cached.asset;
    try {
      await loadForeignEntries();
      return find()?.asset ?? null;
    } catch {
      return null;
    }
  };

  /*
   * Pinterest 窗口的右键「保存到素材库 / 发送到画布」落到这里（见 `plugins/canvas-shell/pinterest-save.ts`）。
   *
   * 复用上面的 `imageWrites`（可写判断、提交、视口中心）：「发送到画布」与「添加到画布」是同一套摆放。
   * 只在桌面壳里有意义 —— 浏览器里没有 Pinterest 窗口，挂了也永远不会被调用，所以不做形态判断。
   * 与 `ctx` 同生命周期：卸载时撤销，避免热重载后留着上一份处理者。
   */
  const disposePinterestSave = installPinterestSave({
    takeBlob: takeBlobFromDesktop,
    upload: async (file) => {
      const media = ctx.get("mediaRemote" as never) as
        | { upload(input: { file: File }): Promise<{ ok: true; media: import("./contract/remote.js").UploadedMedia } | { ok: false; error: string }> }
        | undefined;
      if (!media) return { ok: false, error: "媒体服务还没有就绪" };
      return media.upload({ file });
    },
    registerLibrary: (input) => registerLibraryItem(getAppPublicFetch(), appPublicUrl, input),
    canvas: {
      isWritable: () => imageWrites.isWritable(),
      hasCanvas: () => Boolean(canvasStateFacade.getCanvas()),
      center: () => imageWrites.viewportCenter(),
      nearby: (x, y) => nearbyNodeCount(canvasStateFacade, x, y),
      submit: (commands, commandId) => {
        const result = imageWrites.submit(commands, commandId);
        return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "没有添加到画布" };
      }
    }
  });
  ctx.effect(() => disposePinterestSave);

  /*
   * 素材库（浏览器扩展 / Pinterest 窗口存进来的图）并进图库，作为虚拟画布「素材库」，
   * 落在「外部导入」分组（见 `plugins/canvas-shell/library-source.ts`）。
   *
   * 包在 `crossCanvasSource` **外面**而不是改它：那个函数已经承担「当前画布实时 + 其他画布缓存」
   * 的合并，素材库的生命周期不同（不随画布切换），塞进去会让去重键、订阅、失败状态都变复杂。
   * 放置复用 `imageWrites`（可写判断 / 提交 / 视口中心），与「添加到画布」是同一套摆放规则。
   */
  ctx.provide(
    "imageLibrary" as never,
    withLibrary(
      crossCanvasSource({
        current: currentImages,
        currentCanvasId: canvasId,
        fetchOthers: async () => loadForeignEntries(),
        resolveUrl: (url, ownerCanvasId) => appPublicUrl(withMediaCanvasHint(url, ownerCanvasId)),
        addForeignToCanvas: (item) => imageWrites.addForeignToCanvas(item.canvasId, item.id)
      }),
      {
        fetchLibrary: async () => {
          const response = await getAppPublicFetch()(appPublicUrl("/api/library"), { credentials: "same-origin" });
          if (!response.ok) throw new Error(`读取素材库失败（HTTP ${response.status}）`);
          const body = (await response.json()) as { items?: unknown };
          return Array.isArray(body.items) ? (body.items as LibraryEntry[]) : [];
        },
        // 素材库的 url 是逻辑路径（`/api/media/<key>`），这里只加部署前缀；读取不需要画布提示（不属于任何画布）
        resolveUrl: (url) => appPublicUrl(url),
        placeLibraryItem: (entry) => {
          if (!imageWrites.isWritable()) return { ok: false, reason: "画布当前是只读的（未连接或同步未就绪）" };
          const { x, y, zoom } = imageWrites.viewportCenter();
          const commands = planPlaceLibraryItem({
            entry,
            center: { x, y, zoom },
            nearby: nearbyNodeCount(canvasStateFacade, x, y)
          });
          const result = imageWrites.submit(commands, createHighEntropyId("library-add-to-canvas"));
          return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "没有添加到画布" };
        }
      }
    ) as never
  );
}
