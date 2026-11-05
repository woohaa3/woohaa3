import type { Woohaa3CanvasNode } from "./canvas-runtime";
import { woohaa3CanvasGridSize } from "./grid";

type Woohaa3CanvasPosition = {
  x: number;
  y: number;
};

/** 节点默认尺寸只属于画布布局，不承载节点类型语义。 */
export const DEFAULT_NODE_DIMS: { width: number; height: number } = { width: 260, height: 195 };

/**
 * 节点尺寸最小下限（change: add-node-resize）。
 *
 * 映射层、浏览器命中/拖拽 clamp 与 Canvas Service 命令校验共用同一下限，
 * 避免「前端能拖、服务端静默改写」的分叉。
 *
 * 高度取 64：woohaa3 的紧凑 3D 模型节点规范尺寸就是 `196×64`（`bevyNodeSize("model")`），
 * 且 model3d 节点经命令路径创建时即写入该尺寸；下限若大于 64 会让「创建模型节点」
 * 被服务端拒绝、并改写既有记录。参考实现（旧版画布）的 180×120 不适用于本项目的
 * 紧凑模型节点，故按实际最小规范尺寸收敛。
 */
export const MIN_NODE_WIDTH = 180;
export const MIN_NODE_HEIGHT = 64;

/**
 * 右下角 resize 抓手边长（世界坐标，change: add-node-resize）。
 *
 * 命中区域与 Bevy 绘制（`bevy/src/canvas2d/layout.rs` 的 `RESIZE_HANDLE_SIZE`）共用同一数值：
 * 跨 WASM 边界无法直接 import，因此两侧都必须引用本常量定义的数值，并由
 * `render-scene.test.ts` 断言两边一致。
 */
export const RESIZE_HANDLE_SIZE = 20;

export function createWoohaa3CanvasNode(
  type: string,
  position: Woohaa3CanvasPosition,
  id = createWoohaa3CanvasNodeId(type)
): Woohaa3CanvasNode {
  return {
    id,
    type,
    position,
    width: DEFAULT_NODE_DIMS.width,
    height: DEFAULT_NODE_DIMS.height,
    data: {}
  };
}

export function duplicateWoohaa3CanvasNode(
  source: Woohaa3CanvasNode,
  existingIds: Set<string>,
  existingNodes?: Woohaa3CanvasNode[]
): Woohaa3CanvasNode {
  const id = createUniqueWoohaa3CanvasNodeId(`${source.id}-copy`, existingIds);
  return {
    ...source,
    id,
    ...(source.position ? { position: resolveDuplicateNodePosition(source, existingNodes) } : {}),
    data: {}
  };
}

function resolveDuplicateNodePosition(source: Woohaa3CanvasNode, existingNodes?: Woohaa3CanvasNode[]): Woohaa3CanvasPosition {
  const origin = source.position ?? { x: 0, y: 0 };
  const fallback = {
    x: origin.x + woohaa3CanvasGridSize * 2,
    y: origin.y + woohaa3CanvasGridSize * 2
  };
  if (!existingNodes?.length) return fallback;
  const sourceWidth = source.width ?? DEFAULT_NODE_DIMS.width;
  return findNonOverlappingNodePosition({
    x: origin.x + sourceWidth + woohaa3CanvasGridSize * 3,
    y: origin.y
  }, source, existingNodes);
}

function findNonOverlappingNodePosition(
  preferred: Woohaa3CanvasPosition,
  source: Woohaa3CanvasNode,
  existingNodes: Woohaa3CanvasNode[]
): Woohaa3CanvasPosition {
  const width = source.width ?? DEFAULT_NODE_DIMS.width;
  const height = source.height ?? DEFAULT_NODE_DIMS.height;
  const gap = woohaa3CanvasGridSize * 2;
  const stepX = width + gap;
  const stepY = height + gap;
  for (let column = 0; column < 5; column += 1) {
    for (const row of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      const candidate = { x: preferred.x + column * stepX, y: preferred.y + row * stepY };
      if (!existingNodes.some((node) => rectsOverlap(candidate, { width, height }, node, gap))) return candidate;
    }
  }
  return preferred;
}

function rectsOverlap(
  position: Woohaa3CanvasPosition,
  size: { width: number; height: number },
  node: Woohaa3CanvasNode,
  gap: number
): boolean {
  const nodeWidth = node.width ?? DEFAULT_NODE_DIMS.width;
  const nodeHeight = node.height ?? DEFAULT_NODE_DIMS.height;
  if (!node.position) return false;
  return position.x < node.position.x + nodeWidth + gap
    && position.x + size.width + gap > node.position.x
    && position.y < node.position.y + nodeHeight + gap
    && position.y + size.height + gap > node.position.y;
}

export function createWoohaa3CanvasNodeId(type: string): string {
  return `${stableIdPrefix(`asset-${type}`)}-${highEntropySuffix()}`;
}

/**
 * 高熵稳定 ID（change: add-frontend-speculative-canvas-state，design D7）。
 *
 * 时间戳只作为可读前缀，唯一性由 `crypto.randomUUID()`（或等价高熵回退）承担。
 * 这样同一毫秒内并发创建也不会冲突，且能安全用作跨端稳定实体 ID。
 */
export function createHighEntropyId(prefix: string): string {
  return `${stableIdPrefix(prefix)}-${highEntropySuffix()}`;
}

/** 只保留可读前缀（去除空白并截断），不承担唯一性。 */
function stableIdPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\s+/g, "-");
  return trimmed.length > 0 ? trimmed : "id";
}

/** 生成高熵后缀；优先 Web Crypto，回退到时间戳 + 随机。 */
function highEntropySuffix(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function createUniqueWoohaa3CanvasNodeId(prefix: string, existingIds: Set<string>): string {
  let index = 1;
  let id = `${prefix}-${Date.now().toString(36)}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}-${Date.now().toString(36)}-${index}`;
  }
  return id;
}
