/**
 * 把图片/视频节点的历史圆点从 Bevy scene 搬到宿主 store（见 `services/history-layers-store.ts`）。
 *
 * 在 `applyRunStateProjection` 之后调用：投影本身保持纯函数不动，这里只做「取走并删除」。
 * 删除 `historyStrip` 后 Bevy 不再绘制圆点；依赖它的命中/锚点查询都用了可选链，会自然退化为无结果。
 *
 * 只处理图片与视频：缩略图来自历史条目的 `thumbnail` 预览；模型等其它类型的缩略图要页面内渲染，
 * 暂时仍保留 Bevy 圆点。
 */
import type { BevyRenderNode } from "@woohaa3/contracts";
import { historyLayersStore, type NodeHistoryLayers } from "../../services/history-layers-store.js";

const LAYER_NODE_TYPES: ReadonlySet<string> = new Set(["image", "video"]);

export function relocateHistoryStrips(nodes: readonly BevyRenderNode[]): void {
  const collected = new Map<string, NodeHistoryLayers>();
  for (const node of nodes) {
    if (!LAYER_NODE_TYPES.has(node.type) || !node.historyStrip) continue;
    collected.set(node.id, {
      layers: node.historyStrip.dots.map(({ hovered: _hovered, pressed: _pressed, ...layer }) => layer),
      truncated: node.historyStrip.truncated
    });
    delete node.historyStrip;
  }
  historyLayersStore.replace(collected);
}
