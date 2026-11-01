/**
 * 把宿主的「当前画布」接给四喜的 `CanvasTopBar`（`src/app/hostCanvas.ts` 是那边的注入点）。
 *
 * 顶栏要显示两件只有宿主知道的事：
 * - **这张画布叫什么**：目录条目的标题（`CanvasSummary.title`），空标题由这里兜底；
 * - **切换器在哪**：直接唤起宿主自己的 `canvas-switcher` 弹窗。
 *
 * 为什么唤起宿主弹窗而不是自己画一个：那个弹窗里有重命名、删除、归档导出，
 * 全都绑在当前 Yjs 会话的命令通道上（宿主 `plugins/canvas-switcher/plugin.tsx`）。
 * 重写一遍等于复制一套会话逻辑，而且改一处就会和宿主分叉。
 *
 * **`CANVAS_SWITCHER_DIALOG_ID` 是写死的**：它在宿主内部，没有从
 * `@woohaa3/frontend/extension-api` 导出（扩展不允许 import 宿主 cordis 内部模块，
 * 见 `extension-api/dependency-audit.test.ts`）。这个名字属于宿主的公开 dialog 契约，
 * 宿主改名这里要跟着改 —— 失败时弹窗不出现，不会连带别的功能。
 */
import type {
  CanvasCatalogService,
  CanvasNavigationService
} from "@woohaa3/frontend/extension-api";
import type { HostCanvasBridge } from "@/app/hostCanvas";

/** 宿主画布切换器弹窗的 id（见宿主 `cordis/plugins/canvas-switcher/chrome.tsx`）。 */
const CANVAS_SWITCHER_DIALOG_ID = "canvas-switcher";

/** 目录里还没有这张画布的条目时（刚建、还没刷新）先显示这个。 */
const UNTITLED = "未命名画布";

export function createHostCanvasBridge(
  catalog: CanvasCatalogService | undefined,
  navigation: CanvasNavigationService | undefined,
  currentCanvasId: () => string | null
): HostCanvasBridge {
  const title = (): string | null => {
    const id = currentCanvasId();
    if (!id) return null;
    const entry = catalog?.getState().entries.find((item) => item.id === id);
    return entry ? entry.title.trim() || UNTITLED : UNTITLED;
  };

  return {
    currentTitle: title,
    subscribe(listener) {
      // 目录变化（新建 / 重命名 / 切换后刷新）时重读标题；读不到目录就不订阅。
      return catalog ? catalog.subscribe(listener) : () => {};
    },
    openSwitcher() {
      // 没有导航服务（非画布页作用域）时什么也不做：顶栏那一下点不动，但不报错。
      navigation?.openDialog({ dialogId: CANVAS_SWITCHER_DIALOG_ID, payload: {} });
    }
  };
}
