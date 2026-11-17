/**
 * 依赖分层布局（DAG 从左到右）。
 *
 * 画布的连线有方向语义：`source` 的右侧输出接 `target` 的左侧输入。所以「整理」不能把所有卡片
 * 排成一行——那样把 A→B→C 读成三个并列的东西，连线变成绕回自己的一团。正确读法是**分层**：
 * 没有上游的排最左，每往右一层就是又深了一级的依赖。
 *
 * ## 为什么要给跨层边留通道
 *
 * 只分层还不够。考虑 `A→B`、`A→C`、`B→C`：C 因为最长路径落在层 2，而 A 有一条**跨层边**直达 C。
 * 这条边横穿层 1，层 1 的 B 会正好坐在两个端点之间把线挡住——看起来就是「线断了、信息丢了」。
 *
 * 所以跨层边在它穿过的每个中间层里占一个**通道槽位**，通道与真实卡片一起参与层内排序与间距
 * 约束：中间层的卡片被推开，跨层边有了自己的走线空隙。
 *
 * ## 步骤（Sugiyama 骨架的最小子集）
 *
 * 1. **分层**：Kahn 拓扑序 + 最长路径。成环（回边）不构成层约束——环没有可满足的左右次序，
 *    按稳定顺序兜底且不递归；
 * 2. **排序**：层内按邻居重心排序，通道与卡片一起参与，减少连线交叉；
 * 3. **定位**：以**中心线**为坐标做几轮松弛（通道对齐链上邻居的平均，卡片对齐邻居平均），
 *    每轮用「保序 + 最小间距」的单调投影收口——通道两侧因此各留出 `rowGap` 的空隙。
 *
 * **孤立项**（与选区里任何东西都没有连线）不塞进任何一列——塞进最后一列会被读成「最终的产物」，
 * 塞进第一列会被读成「源头」。它们单独排在流程下方一行，用更大的间距明确分开。
 *
 * 纯函数：只做数值计算，不读画布、不写 store、不产生命令。
 */

export type LayoutItemSize = { width: number; height: number };

/** 项之间的有向依赖（由节点连线归约而来；`from` 排左、`to` 排右）。 */
export type LayoutEdge = { from: number; to: number };

export type LayoutPosition = {
  x: number;
  y: number;
  /** 所在层；孤立项为 `-1`。 */
  layer: number;
};

export type LayeredLayoutInput = {
  items: readonly LayoutItemSize[];
  edges: readonly LayoutEdge[];
  /** 列间距（右边输出 → 左边输入，需要留出连线空间，通常大于行间距）。 */
  columnGap: number;
  /** 行间距。 */
  rowGap: number;
  /**
   * 孤立项排布的容器宽度下限，通常是原选区宽度。
   *
   * 没有它，孤立项会按「最宽的一张」当容器宽度，退化成每张独占一行。
   */
  preferredWidth?: number;
};

export type LayeredLayoutResult = {
  positions: LayoutPosition[];
  width: number;
  height: number;
};

/** 层内槽位：真实卡片，或一条跨层边在该层预留的通道。 */
type Slot = {
  /** 稳定身份（`n<index>` / `c<from><to>@<layer>`）。 */
  id: string;
  kind: "node" | "channel";
  /** 真实卡片的项下标；通道为 -1。 */
  index: number;
  height: number;
};

/** 松弛迭代次数：小图 6 轮足够，且结果确定。 */
const RELAX_ROUNDS = 6;
/** 重心排序迭代次数。 */
const ORDER_ROUNDS = 4;

/**
 * 计算分层布局。返回的坐标以 (0,0) 为左上原点，调用方自行加锚点偏移。
 *
 * 没有任何连线时退化为「逐行填充」：所有项都在 `layer: -1`，按 `preferredWidth` 排开。
 */
export function layeredLayout(input: LayeredLayoutInput): LayeredLayoutResult {
  const { items, columnGap, rowGap } = input;
  const count = items.length;
  const positions: LayoutPosition[] = new Array(count);
  if (count === 0) return { positions, width: 0, height: 0 };

  // 自环与重复边先去掉：它们不表达层关系，也不该让同一个依赖被算两次。
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const incoming: number[][] = Array.from({ length: count }, () => []);
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  const connected = new Set<number>();
  for (const edge of input.edges) {
    if (edge.from === edge.to) continue;
    if (edge.from < 0 || edge.from >= count || edge.to < 0 || edge.to >= count) continue;
    const key = `${edge.from}>${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
    outgoing[edge.from]!.push(edge.to);
    incoming[edge.to]!.push(edge.from);
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const nodeOrder = items.map((_, index) => index);
  const dagNodes = nodeOrder.filter((index) => connected.has(index));
  const isolated = nodeOrder.filter((index) => !connected.has(index));

  let dagWidth = 0;
  let dagHeight = 0;

  if (dagNodes.length > 0) {
    const layers = layerNodes(dagNodes, outgoing, incoming);
    const layerOf = new Map<number, number>();
    layers.forEach((layer, layerIndex) => { for (const node of layer) layerOf.set(node, layerIndex); });

    const slots = buildSlots(layers, items, edges, layerOf);
    const chains = buildChains(edges, layerOf);
    orderSlots(slots, chains, edges, layerOf);
    const centers = relaxCenters(slots, chains, rowGap);

    // 列宽只由真实卡片决定：通道不占横向空间，它只是纵向让位的占位。
    const layerWidths = slots.map((layer) => Math.max(
      0,
      ...layer.filter((slot) => slot.kind === "node").map((slot) => items[slot.index]!.width)
    ));

    let columnX = 0;
    let minTop = Number.POSITIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    slots.forEach((layer, layerIndex) => {
      for (const slot of layer) {
        if (slot.kind !== "node") continue;
        const height = items[slot.index]!.height;
        const top = centers.get(slot.id)! - height / 2;
        minTop = Math.min(minTop, top);
        maxBottom = Math.max(maxBottom, top + height);
        positions[slot.index] = { x: columnX, y: top, layer: layerIndex };
      }
      columnX += layerWidths[layerIndex]! + columnGap;
    });

    // 整体上移到原点：松弛只关心相对位置。
    if (Number.isFinite(minTop)) {
      for (const layer of slots) {
        for (const slot of layer) {
          if (slot.kind !== "node" || !positions[slot.index]) continue;
          positions[slot.index] = { ...positions[slot.index]!, y: positions[slot.index]!.y - minTop };
        }
      }
      dagHeight = maxBottom - minTop;
    }
    dagWidth = Math.max(0, columnX - columnGap);
  }

  let totalWidth = dagWidth;
  let totalHeight = dagHeight;

  if (isolated.length > 0) {
    // 有流程时，孤立项与流程之间留双倍行距，明确「这些还没接上」。
    const startY = dagHeight > 0 ? dagHeight + rowGap * 2 : 0;
    const containerWidth = Math.max(
      dagWidth,
      input.preferredWidth ?? 0,
      ...isolated.map((index) => items[index]!.width)
    );
    let cursorX = 0;
    let cursorY = startY;
    let rowHeight = 0;
    for (const index of isolated) {
      const item = items[index]!;
      if (cursorX > 0 && cursorX + item.width > containerWidth) {
        cursorX = 0;
        cursorY += rowHeight + rowGap;
        rowHeight = 0;
      }
      positions[index] = { x: cursorX, y: cursorY, layer: -1 };
      cursorX += item.width + rowGap;
      rowHeight = Math.max(rowHeight, item.height);
    }
    totalHeight = cursorY + rowHeight;
    totalWidth = Math.max(dagWidth, containerWidth);
  }

  return { positions, width: totalWidth, height: totalHeight };
}

/** 每层槽位：先放该层的真实卡片，再按跨层边补通道。 */
function buildSlots(
  layers: readonly number[][],
  items: readonly LayoutItemSize[],
  edges: readonly LayoutEdge[],
  layerOf: ReadonlyMap<number, number>
): Slot[][] {
  const slots: Slot[][] = layers.map((layer) => layer.map((index) => ({
    id: nodeId(index),
    kind: "node" as const,
    index,
    height: items[index]!.height
  })));
  for (const edge of edges) {
    const from = layerOf.get(edge.from);
    const to = layerOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    // 跨层边（层差 > 1）在它穿越的每个中间层占一个通道。
    for (let layerIndex = from + 1; layerIndex < to; layerIndex += 1) {
      slots[layerIndex]!.push({
        id: channelId(edge, layerIndex),
        kind: "channel",
        index: -1,
        height: 0
      });
    }
  }
  return slots;
}

function nodeId(index: number): string {
  return `n${index}`;
}

function channelId(edge: LayoutEdge, layerIndex: number): string {
  return `c${edge.from}>${edge.to}@${layerIndex}`;
}

/**
 * 每条跨层边的槽位链：源卡片 → 各中间层通道 → 目标卡片。
 *
 * 松弛时沿链传播位置，通道因此被拉到两端之间，中间层卡片也被它挤开。
 */
function buildChains(
  edges: readonly LayoutEdge[],
  layerOf: ReadonlyMap<number, number>
): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  for (const edge of edges) {
    const from = layerOf.get(edge.from);
    const to = layerOf.get(edge.to);
    if (from === undefined || to === undefined || to - from <= 1) continue;
    const chain = [nodeId(edge.from)];
    for (let layerIndex = from + 1; layerIndex < to; layerIndex += 1) {
      chain.push(channelId(edge, layerIndex));
    }
    chain.push(nodeId(edge.to));
    chains.set(`${edge.from}>${edge.to}`, chain);
  }
  return chains;
}

/** 槽位之间的无向邻接（只连有连线关系的槽位；跨层边走完整条链）。 */
function buildNeighbours(
  chains: ReadonlyMap<string, readonly string[]>,
  edges: readonly LayoutEdge[],
  layerOf: ReadonlyMap<number, number>
): Map<string, string[]> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    neighbours.set(a, list);
  };
  for (const edge of edges) {
    const from = layerOf.get(edge.from);
    const to = layerOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (to - from > 1) {
      const chain = chains.get(`${edge.from}>${edge.to}`);
      if (!chain) continue;
      for (let index = 0; index + 1 < chain.length; index += 1) {
        link(chain[index]!, chain[index + 1]!);
        link(chain[index + 1]!, chain[index]!);
      }
    } else {
      link(nodeId(edge.from), nodeId(edge.to));
      link(nodeId(edge.to), nodeId(edge.from));
    }
  }
  return neighbours;
}

/** 层内按邻居重心排序（通道与卡片一起排），迭代若干轮以接近稳定。 */
function orderSlots(
  slots: Slot[][],
  chains: ReadonlyMap<string, readonly string[]>,
  edges: readonly LayoutEdge[],
  layerOf: ReadonlyMap<number, number>
): void {
  const neighbours = buildNeighbours(chains, edges, layerOf);

  // 初始顺序 = 建槽时的顺序。
  let keys = new Map<string, number>();
  for (const layer of slots) layer.forEach((slot, index) => keys.set(slot.id, index));

  for (let round = 0; round < ORDER_ROUNDS; round += 1) {
    const next = new Map<string, number>();
    for (const layer of slots) {
      for (const slot of layer) {
        const own = keys.get(slot.id) ?? 0;
        const hits = (neighbours.get(slot.id) ?? [])
          .map((id) => keys.get(id))
          .filter((value): value is number => value !== undefined);
        // 少量自身权重，避免完全被邻居拖走造成来回摆动。
        next.set(slot.id, hits.length > 0
          ? hits.reduce((sum, value) => sum + value, 0) / hits.length * 0.75 + own * 0.25
          : own);
      }
    }
    keys = next;
    for (const layer of slots) {
      const sorted = [...layer].sort((a, b) => (keys.get(a.id)! - keys.get(b.id)!) || a.id.localeCompare(b.id));
      layer.splice(0, layer.length, ...sorted);
    }
  }
}

/**
 * 以中心线为坐标松弛各槽位位置。
 *
 * 每个槽位的期望值取所有邻居的中心平均；通道只有跨层边两端的邻居，于是天然被拉到两端之间。
 * 每轮用「保序 + 最小间距」的投影收口——这就是把中间层卡片推开的机制。
 */
function relaxCenters(
  slots: readonly Slot[][],
  chains: ReadonlyMap<string, readonly string[]>,
  rowGap: number
): Map<string, number> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    neighbours.set(a, list);
  };
  for (const chain of chains.values()) {
    for (let index = 0; index + 1 < chain.length; index += 1) {
      link(chain[index]!, chain[index + 1]!);
      link(chain[index + 1]!, chain[index]!);
    }
  }

  const heightOf = new Map<string, number>();
  for (const layer of slots) for (const slot of layer) heightOf.set(slot.id, slot.height);

  let centers = new Map<string, number>();
  for (const layer of slots) {
    let cursor = 0;
    for (const slot of layer) {
      centers.set(slot.id, cursor + slot.height / 2);
      cursor += slot.height + rowGap;
    }
  }

  for (let round = 0; round < RELAX_ROUNDS; round += 1) {
    const desired = new Map<string, number>();
    for (const layer of slots) {
      for (const slot of layer) {
        const hits = (neighbours.get(slot.id) ?? [])
          .map((id) => centers.get(id))
          .filter((value): value is number => value !== undefined);
        desired.set(slot.id, hits.length > 0
          ? hits.reduce((sum, value) => sum + value, 0) / hits.length
          : centers.get(slot.id)!);
      }
    }
    const next = new Map<string, number>();
    for (const layer of slots) {
      const row = placeRow(layer, desired, heightOf, rowGap);
      layer.forEach((slot, index) => next.set(slot.id, row[index]!));
    }
    centers = next;
  }
  return centers;
}

/**
 * 单层定位：从期望值出发做单调投影，保证「层内顺序不变 + 相邻间距 ≥ rowGap」。
 *
 * 先把每项往下推到不与前一项重叠，再把整层整体平移回期望的重心附近——整层平移不改变顺序与
 * 间距，因此两个约束都保持。返回每个槽位的中心 y。
 */
function placeRow(
  layer: readonly Slot[],
  desired: ReadonlyMap<string, number>,
  heightOf: ReadonlyMap<string, number>,
  rowGap: number
): number[] {
  if (layer.length === 0) return [];
  const half = layer.map((slot) => heightOf.get(slot.id)! / 2);
  const row = new Array<number>(layer.length);
  for (let index = 0; index < layer.length; index += 1) {
    const want = desired.get(layer[index]!.id)!;
    if (index === 0) { row[index] = want; continue; }
    const floor = row[index - 1]! + half[index - 1]! + rowGap + half[index]!;
    row[index] = Math.max(want, floor);
  }
  // 整体回移，让整层重心贴近期望重心（纯平移，不破坏顺序与间距）。
  const drift = row.reduce((sum, value, index) => sum + (value - desired.get(layer[index]!.id)!), 0) / row.length;
  for (let index = 0; index < row.length; index += 1) row[index] = row[index]! - drift;
  return row;
}

/** 最长路径分层：按拓扑序推进，层 = 所有上游层 + 1；回边因上游尚未定层而被跳过。 */
export function layerNodes(
  dagNodes: readonly number[],
  outgoing: readonly number[][],
  incoming: readonly number[][]
): number[][] {
  const inDag = new Set(dagNodes);
  const indegree = new Map<number, number>();
  for (const node of dagNodes) {
    indegree.set(node, incoming[node]!.filter((parent) => inDag.has(parent)).length);
  }

  // Kahn：稳定顺序（小 index 优先）让结果可复现。
  const ready = dagNodes.filter((node) => indegree.get(node) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  const emitted = new Set<number>();
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    emitted.add(node);
    for (const child of outgoing[node]!) {
      if (!inDag.has(child)) continue;
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort((a, b) => a - b);
      }
    }
  }
  // 有环：剩余节点按稳定顺序追加。它们之间的边在下面算层时被忽略（上游还没定层）。
  for (const node of dagNodes) {
    if (!emitted.has(node)) order.push(node);
  }

  const layerOf = new Map<number, number>();
  for (const node of order) {
    const settled = incoming[node]!.filter((parent) => layerOf.has(parent));
    layerOf.set(node, settled.length > 0 ? Math.max(...settled.map((parent) => layerOf.get(parent)! + 1)) : 0);
  }

  const layerCount = Math.max(...layerOf.values()) + 1;
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (const node of order) layers[layerOf.get(node)!]!.push(node);
  return layers;
}
