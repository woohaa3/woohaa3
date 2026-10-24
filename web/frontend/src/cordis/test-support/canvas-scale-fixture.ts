/**
 * 千卡片媒体驻留的确定性 fixture
 * （change: 2026-10-23-scale-canvas-media-residency，任务 1.1）。
 *
 * 生成 100/500/1000/3000 节点的图片/视频/模型/混合画布，覆盖「相同资产 / 不同资产」与
 * 「固定可见 / 密集总览」两种需求形态，并把内容复杂度与固定 seed 一起写进 `meta`，供基准与
 * 回归引用。这里只产出规范数据，不创建解码器、视频元素或 GPU 资源；也不断言任何性能数字。
 *
 * 不是硬件证据：逻辑回归用它锁定「重资源数量只由需求集合决定」；容量结论仍须真实 GPU 采集。
 */
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";

/** fixture 规模（design D9 的必须规模 + 压力规模）。 */
export const SCALE_FIXTURE_COUNTS = [100, 500, 1000, 3000] as const;
export type ScaleFixtureCount = (typeof SCALE_FIXTURE_COUNTS)[number];

export type ScaleFixtureKind = "image" | "video" | "model" | "mixed";
/** 资产复用：`shared` 全部引用同一资产，`distinct` 每个节点一个资产。 */
export type ScaleFixtureAssets = "shared" | "distinct";
/**
 * 需求形态：
 * - `fixed`：节点沿一条水平线排开，视口只覆盖固定 24 个（design D9 的基准）；
 * - `dense`：节点密集堆叠，一次投影几乎全部可见（密集总览的压力形态）。
 */
export type ScaleFixtureDemand = "fixed" | "dense";

export const SCALE_FIXTURE_SEED = 0x5ca1e_2026;
/** 固定时间戳：fixture 内容必须逐字节可重建，不能带 `Date.now()`。 */
export const SCALE_FIXTURE_TIMESTAMP = "2026-10-23T00:00:00.000Z";

/** 固定可见需求数量（design D9：基础场景 24 个可见需求）。 */
export const SCALE_FIXTURE_FIXED_VISIBLE = 24;

export type ScaleFixtureMeta = {
  seed: number;
  count: ScaleFixtureCount;
  kind: ScaleFixtureKind;
  assets: ScaleFixtureAssets;
  demand: ScaleFixtureDemand;
  /** 实际节点类型分布。 */
  nodeKinds: Record<ScaleFixtureKind, number>;
  distinctAssets: number;
  /** 单张图片源像素（图片/视频封面共用）。 */
  imageSourcePixels: { width: number; height: number };
  /** 视频编码/时长（视频节点）。 */
  videoProfile: { codec: string; width: number; height: number; durationSeconds: number };
  /** 模型复杂度（模型节点）：越多的 op 与顶点，准备成本越高。 */
  modelProfile: { ops: number; triangles: number };
  /** 节点间距（世界单位）：`fixed` 用大间距，`dense` 用小间距。 */
  spacing: number;
  /** 节点基准尺寸（世界单位）。 */
  nodeSize: { width: number; height: number };
};

export type ScaleFixture = {
  canvas: ServerCanvas;
  meta: ScaleFixtureMeta;
  /** 固定可见需求的节点 id（`fixed` 形态下视口应覆盖这些节点）。 */
  visibleNodeIds: readonly string[];
};

export type ScaleFixtureOptions = {
  count: ScaleFixtureCount;
  kind?: ScaleFixtureKind;
  assets?: ScaleFixtureAssets;
  demand?: ScaleFixtureDemand;
  seed?: number;
  canvasId?: string;
};

/** mulberry32：小而确定的 PRNG，用于位置抖动等非语义细节。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const IMAGE_SOURCE = { width: 2048, height: 2048 } as const;
const VIDEO_PROFILE = { codec: "h264", width: 1280, height: 720, durationSeconds: 6 } as const;
const MODEL_PROFILE = { ops: 24, triangles: 12_000 } as const;

/** 按节点序号的类型分配（`mixed` 为 2:1:1 的图片/视频/模型）。 */
function kindOf(index: number, kind: ScaleFixtureKind): Exclude<ScaleFixtureKind, "mixed"> {
  if (kind !== "mixed") return kind;
  switch (index % 4) {
    case 0:
    case 1: return "image";
    case 2: return "video";
    default: return "model";
  }
}

/** 生成一份确定性 fixture（相同参数永远得到逐字节相同的画布与 meta）。 */
export function createScaleFixture(options: ScaleFixtureOptions): ScaleFixture {
  const {
    count,
    kind = "image",
    assets = "shared",
    demand = "fixed",
    seed = SCALE_FIXTURE_SEED,
    canvasId = `scale-${kind}-${assets}-${demand}-${count}`
  } = options;
  const base = createEmptyWoohaa3ServerCanvas(canvasId, SCALE_FIXTURE_TIMESTAMP);
  const random = createRandom(seed);
  const spacing = demand === "fixed" ? 10_000 : 32;
  const nodeSize = { width: 248, height: 232 };
  const assetCount = assets === "shared" ? 1 : count;
  const nodeKinds: Record<ScaleFixtureKind, number> = { image: 0, video: 0, model: 0, mixed: 0 };

  // 资产按内容身份去重：`shared` 只有一个，`distinct` 每节点一个。
  const storedAssets: StoredAsset[] = Array.from({ length: Math.max(1, assetCount) }, (_, index) => {
    const checksum = index.toString(16).padStart(64, "0");
    return {
      id: `asset-${index}`,
      title: `素材 ${index}`,
      mediaKind: kind === "video" ? "video" : "image",
      source: "generated",
      status: "ready",
      url: `/api/media/sha256-${checksum}`,
          // 资产 createdAt 也是 fixture 内容：与画布时间戳一致，便于逐字节比较。
          createdAt: SCALE_FIXTURE_TIMESTAMP,
        metadata: {
          storageKey: `sha256-${checksum}`,
          checksum,
          contentType: kind === "video" ? "video/mp4" : "image/png",
          size: kind === "video" ? 4 * 1024 * 1024 : 512 * 1024,
          ...(kind === "video" ? { posterUrl: `/api/media/sha256-${checksum}-poster` } : {})
        }
      };
  });

  const nodes: ServerCanvas["document"]["nodes"] = [];
  const nodeData: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < count; index += 1) {
    const nodeKind = kindOf(index, kind);
    nodeKinds[nodeKind] += 1;
    const id = `n${index}`;
    // `dense` 略微抖动，避免所有包围盒完全重合导致投影退化成单点；抖动是确定的。
    const jitter = demand === "dense" ? Math.round(random() * 6) : 0;
    nodes.push({
      id,
      type: nodeKind === "model" ? "model3d" : nodeKind,
      position: { x: (index % 64) * spacing + jitter, y: Math.floor(index / 64) * spacing + jitter },
      width: nodeSize.width,
      height: nodeSize.height
    });
    const assetIndex = assets === "shared" ? 0 : index;
    nodeData[id] = nodeKind === "model"
      ? {}
      : {
          outputAssetId: `asset-${assetIndex}`,
          ...(nodeKind === "video" ? { title: `视频 ${index}` } : {})
        };
  }

  const visibleNodeIds = demand === "fixed"
    ? nodes.slice(0, SCALE_FIXTURE_FIXED_VISIBLE).map((node) => node.id)
    : nodes.map((node) => node.id);

  return {
    canvas: {
      ...base,
      revision: 1,
      document: { ...base.document, nodes, edges: [] },
      nodeData: nodeData as ServerCanvas["nodeData"],
      assets: storedAssets
    },
    meta: {
      seed,
      count,
      kind,
      assets,
      demand,
      nodeKinds,
      distinctAssets: assets === "shared" ? 1 : count,
      imageSourcePixels: IMAGE_SOURCE,
      videoProfile: VIDEO_PROFILE,
      modelProfile: MODEL_PROFILE,
      spacing,
      nodeSize
    },
    visibleNodeIds
  };
}

/**
 * 覆盖固定可见集合的视口与 surface（`fixed` 形态用）。
 *
 * 缩放 1、DPR 1，宽度刚好容纳 24 个卡片中的一个列宽，保证只有第一列进入可见范围而不依赖
 * 数字细节；`dense` 形态的调用方通常直接给全画布 surface。
 */
export function fixedDemandProjection(fixture: ScaleFixture): {
  viewport: { x: number; y: number; zoom: number };
  surface: { width: number; height: number; pixelRatio: number };
} {
  const { meta } = fixture;
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    surface: {
      width: meta.spacing,
      height: meta.spacing * Math.max(1, Math.ceil(SCALE_FIXTURE_FIXED_VISIBLE / 64)),
      pixelRatio: 1
    }
  };
}
