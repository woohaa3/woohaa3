/**
 * 把宿主的图片库接成四喜「资源」页的数据源。
 *
 * 宿主在画布页作用域提供 `imageLibrary`(见宿主 `canvas-shell/image-library.ts`),
 * 资源栏的「图片」面板读的就是它。这里不另取一份,只做字段映射,
 * 这样两边看到的图永远是同一批、同一个数量。
 *
 * ```
 * Asset.id        ← ImageLibraryItem.id
 * Asset.name      ← title
 * Asset.kind      ← 恒为 'image'(图片库只收图片)
 * Asset.url       ← url(宿主已加部署前缀与 ?canvas= 提示,可直接 <img src>)
 * Asset.thumbnailUrl ← 同一地址叠 `?variant=thumbnail&edge=256`(见 {@link thumbnailUrlFor})
 * Asset.projectId ← canvasId(四喜的「项目」就是宿主的画布)
 * Asset.origin    ← origin('uploaded' | 'generated' | 'external',取值一致)
 * Asset.favorite  ← isFavorite
 * ```
 *
 * 范围与宿主一致:当前画布 + 其他画布的图片(宿主 `imageLibrary` 已合并两路)。
 * `scopeLabel` 原样透出,资源页会如实显示。
 */
import type { ImageLibraryItem, ImageLibrarySource } from "@woohaa3/frontend/extension-api";
import type { Asset } from "@/api/contract";
import type { AssetSource } from "@/api/assetSource";

/**
 * 列表缩略图的边长档位。与宿主 `THUMBNAIL_VARIANT_EDGES`(128/256/512/1024)一致,
 * 卡片实际只有 ~150px,256 已经够 2x 屏。
 *
 * 只对内容寻址的媒体地址生效,外链原样返回 `undefined`,由调用方退回原图。
 * 两种键都算内容寻址(与宿主 `isDerivableSourceKey` 同一口径):
 * - `/api/media/sha256-<hash>`        上传件
 * - `/api/media/generation-outputs/<hash>.<ext>`  任务生成结果
 */
const THUMBNAIL_EDGE = 256;
const DERIVABLE_PATH = /\/api\/media\/(?:sha256-[0-9a-f]{64}|generation-outputs\/[0-9a-f]{64}\.[a-z0-9]+)$/;

export function thumbnailUrlFor(url: string, edge: number = THUMBNAIL_EDGE): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return undefined;
  }
  // 携带部署前缀时路径形如 `/sixi/api/media/…`,所以用后缀匹配而不是从头锚定
  if (!DERIVABLE_PATH.test(parsed.pathname)) return undefined;
  parsed.searchParams.set("variant", "thumbnail");
  parsed.searchParams.set("edge", String(edge));
  // 后端目前只有 PNG 编码器;格式不匹配时生成器会直接判失败
  parsed.searchParams.set("format", "png");
  return `${parsed.pathname}${parsed.search}`;
}

function toAsset(item: ImageLibraryItem): Asset {
  const thumbnailUrl = thumbnailUrlFor(item.url);
  return {
    id: item.id,
    name: item.title,
    kind: "image",
    url: item.url,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    projectId: item.canvasId,
    createdAt: item.createdAt,
    origin: item.origin,
    ...(item.isFavorite ? { favorite: true } : {})
  };
}

export function createHostAssetSource(
  library: ImageLibrarySource,
  currentCanvasId: string | null
): AssetSource {
  // `getItems` 必须对同一份数据返回同一个数组引用（`useSyncExternalStore` 靠它判断有没有变）：
  // 宿主那边只在资产变化时才换数组，这里就只在它换了的时候重新映射。
  let lastItems: readonly ImageLibraryItem[] | undefined;
  let cached: readonly Asset[] = [];
  return {
    scopeLabel: library.scopeLabel,
    currentCanvasId,
    getItems() {
      const items = library.getItems();
      if (items !== lastItems) {
        lastItems = items;
        cached = items.map(toAsset);
      }
      return cached;
    },
    subscribe: (listener) => library.subscribe(listener)
  };
}
