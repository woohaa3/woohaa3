/**
 * 查看页画布 fixtures
 * （change: expand-showcase-execution-ux，任务 1.2 / 2.2 / 4.1–4.2）。
 *
 * 每个 fixture 都构造一个真实的 `ServerCanvas`：fixture 里的连线就是参考输入，chips /
 * mention 候选 / blocking reason 全部由生产 `resolveReferenceItems` /
 * `resolveNodeReferenceInputs` 从这张画布派生，而不是手写 UI 状态。
 */
import type { CanvasNodeData, CanvasNodeInputMapping, ServerCanvas, StoredAsset, Woohaa3CanvasEdge, Woohaa3CanvasNode } from "@woohaa3/contracts";
import {
  createEmptyWoohaa3ServerCanvas,
  createWoohaa3CanvasNode,
  toWoohaa3CanvasDocument
} from "@woohaa3/contracts";
import { mediaAsset, pendingVideoAsset, readyVideoAsset } from "./media.js";
import { resolveReferenceItems } from "../../../frontend/src/cordis/plugins/task-execution/reference-items.js";

const NOW = "2026-09-27T00:00:00.000Z";

/** 目标节点与上游节点的稳定 fixture id。 */
export const CANVAS_NODES = {
  targetId: "showcase-target",
  upstreamImageId: "showcase-upstream-image",
  pendingImageId: "showcase-pending-image",
  upstreamTextId: "showcase-upstream-text",
  videoId: "showcase-video",
  pendingVideoId: "showcase-pending-video",
  pickerImageId: "showcase-picker-image"
} as const;

export type CanvasFixtureId =
  | "empty"
  | "emptyPrompt"
  | "readyReferences"
  | "manyReferences"
  | "pendingReference"
  | "unavailableReference"
  | "pickerCandidates"
  | "editVideoReady"
  | "editVideoMissing"
  | "imageRunning"
  | "imageFailed"
  | "audioIdle"
  | "audioMusic"
  | "audioRunning"
  | "audioSucceeded"
  | "audioFailed"
  | "videoRunning"
  | "videoFailed";

type NodeSpec = {
  id: string;
  type: string;
  data?: CanvasNodeData;
};

type EdgeSpec = { id: string; source: string; target: string };

/** 组装画布（节点 / 边 / 资产都显式给出，保证确定性）。 */
function canvasFor(spec: { nodes: NodeSpec[]; edges: EdgeSpec[]; assets?: StoredAsset[] }): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("showcase", NOW);
  const nodes: Woohaa3CanvasNode[] = spec.nodes.map((entry) =>
    createWoohaa3CanvasNode(entry.type, { x: 0, y: 0 }, entry.id)
  );
  const edges: Woohaa3CanvasEdge[] = spec.edges.map((entry) => ({
    id: entry.id,
    source: entry.source,
    target: entry.target,
    sourceHandle: null,
    targetHandle: null,
    data: { kind: "dependency" }
  }));
  const nodeData: Record<string, CanvasNodeData> = {};
  for (const entry of spec.nodes) {
    if (entry.data) nodeData[entry.id] = entry.data as CanvasNodeData;
  }
  return {
    ...base,
    document: toWoohaa3CanvasDocument({ nodes, edges }, NOW),
    nodeData,
    assets: spec.assets ?? []
  };
}

function inputMapping(sourceNodeId: string, role: string, sortKey: string, label?: string): CanvasNodeInputMapping {
  return {
    slotId: `slot-${encodeURIComponent(sourceNodeId)}-${sortKey}`,
    sourceNodeId,
    role,
    sortKey,
    ...(label ? { label } : {})
  };
}

const IMAGE_PROMPT = "在薄雾森林中，一位旅行者沿着石阶前行，电影感光影";

/** 目标节点（图片 / 视频 / 音频）。 */
function targetNode(kind: "image" | "video" | "audio", extra: CanvasNodeData = {}): NodeSpec {
  const base: CanvasNodeData =
    kind === "image"
      ? { title: "图片生成", prompt: IMAGE_PROMPT, parameters: { model: "showcase-image", ratio: "1:1", resolution: "1K" } }
      : kind === "video"
        ? {
            title: "视频生成",
            prompt: "镜头缓推，人物转身面向镜头",
            parameters: {
              model: "showcase-video",
              generationMode: "omni_reference",
              durationSeconds: 5,
              generateAudio: true
            }
          }
        : { title: "音频生成", prompt: "用温暖的声音朗读这段旁白", parameters: { model: "showcase-audio-tts", voice: "female-warm" } };
  return { id: CANVAS_NODES.targetId, type: kind, data: { ...base, ...extra } };
}

/** 无参考输入的基础画布（由 `ShowcasePanelHost` 通过 `baseCanvas` 传入）。 */
export function baseCanvas(kind: "image" | "video" | "audio" = "image"): ServerCanvas {
  return canvasFor({ nodes: [targetNode(kind)], edges: [] });
}

/** 空 prompt：执行动作必须因为「没有提示词」而禁用。 */
export function emptyPromptCanvas(): ServerCanvas {
  return canvasFor({ nodes: [targetNode("image", { prompt: "" })], edges: [] });
}

/** 任务生命周期状态（running / succeeded / failed）。 */
export function taskStateCanvas(
  kind: "image" | "video" | "audio",
  state: CanvasNodeData
): ServerCanvas {
  return canvasFor({ nodes: [targetNode(kind, state)], edges: [] });
}

/** 图片 + 一个 ready 参考图（chips / `@` mention 候选都来自它）。 */
export function readyReferencesCanvas(): ServerCanvas {
  return canvasFor({
    nodes: [
      targetNode("image", {
        inputMapping: [inputMapping(CANVAS_NODES.upstreamImageId, "reference_image", "0", "参考图 1")]
      }),
      { id: CANVAS_NODES.upstreamImageId, type: "image", data: { title: "参考图 1", outputAssetId: "asset-image-ready" } },
      { id: CANVAS_NODES.pickerImageId, type: "image", data: { title: "候选图 A", outputAssetId: "asset-image-picker" } },
      { id: CANVAS_NODES.upstreamTextId, type: "text", data: { title: "文案", prompt: "薄雾森林的清晨" } }
    ],
    edges: [{ id: "e-ready", source: CANVAS_NODES.upstreamImageId, target: CANVAS_NODES.targetId }],
    assets: [
      mediaAsset({ id: "asset-image-ready", mediaKind: "image", title: "参考图 1" }),
      mediaAsset({ id: "asset-image-picker", mediaKind: "image", title: "候选图 A" })
    ]
  });
}

/** 图片 + 五个 ready 参考图（验证单行横向滚动、不折叠）。 */
export function manyReferencesCanvas(): ServerCanvas {
  const specs = Array.from({ length: 5 }, (_, index) => ({
    sourceId: `showcase-many-${index}`,
    assetId: `asset-many-${index}`,
    label: `参考图 ${index + 1}`
  }));
  return canvasFor({
    nodes: [
      targetNode("image", {
        inputMapping: specs.map((spec, index) =>
          inputMapping(spec.sourceId, "reference_image", String(index), spec.label)
        )
      }),
      ...specs.map((spec) => ({
        id: spec.sourceId,
        type: "image",
        data: { title: spec.label, outputAssetId: spec.assetId }
      }))
    ],
    edges: specs.map((spec, index) => ({
      id: `e-many-${index}`,
      source: spec.sourceId,
      target: CANVAS_NODES.targetId
    })),
    assets: specs.map((spec) => mediaAsset({ id: spec.assetId, mediaKind: "image", title: spec.label }))
  });
}

/** 图片 + pending 参考（上游还没有可用输出 → tiles waiting + blocking）。 */
export function pendingReferenceCanvas(): ServerCanvas {
  return canvasFor({
    nodes: [
      targetNode("image", {
        inputMapping: [inputMapping(CANVAS_NODES.pendingImageId, "reference_image", "0", "待生成图")]
      }),
      { id: CANVAS_NODES.pendingImageId, type: "image", data: { title: "待生成图" } }
    ],
    edges: [{ id: "e-pending", source: CANVAS_NODES.pendingImageId, target: CANVAS_NODES.targetId }]
  });
}

/** 图片 + 失效参考（资产 ready 但模型 binding 不接受该媒体类型 → invalid）。 */
export function unavailableReferenceCanvas(): ServerCanvas {  return canvasFor({
    nodes: [
      targetNode("image", {
        inputMapping: [inputMapping(CANVAS_NODES.videoId, "reference_image", "0", "失效视频")]
      }),
      { id: CANVAS_NODES.videoId, type: "video", data: { title: "失效视频", outputAssetId: "asset-video-ready" } }
    ],
    edges: [{ id: "e-invalid", source: CANVAS_NODES.videoId, target: CANVAS_NODES.targetId }],
    // 视频资产被当作图片参考角色使用，binding 的 mediaKinds 只含 image ⇒ invalid。
    assets: [readyVideoAsset("asset-video-ready")]
  });
}

/** 图片 + 多个可连接候选 + 一个尚无输出的候选（picker 展示禁用原因与键盘导航）。 */
export function pickerCandidatesCanvas(): ServerCanvas {
  return canvasFor({
    nodes: [
      targetNode("image"),
      { id: CANVAS_NODES.pickerImageId, type: "image", data: { title: "候选图 A", outputAssetId: "asset-image-picker" } },
      { id: "showcase-picker-image-2", type: "image", data: { title: "候选图 D", outputAssetId: "asset-image-picker-2" } },
      { id: CANVAS_NODES.videoId, type: "video", data: { title: "候选视频 B", outputAssetId: "asset-video-ready" } },
      { id: CANVAS_NODES.pendingImageId, type: "image", data: { title: "候选图 C（待生成）" } }
    ],
    edges: [],
    assets: [
      mediaAsset({ id: "asset-image-picker", mediaKind: "image", title: "候选图 A" }),
      mediaAsset({ id: "asset-image-picker-2", mediaKind: "image", title: "候选图 D" }),
      readyVideoAsset("asset-video-ready")
    ]
  });
}

/** 视频 + ready 输入视频（`edit_video` 模式）。 */
export function editVideoReadyCanvas(): ServerCanvas {
  return canvasFor({
    nodes: [
      targetNode("video", {
        parameters: {
          model: "ark:seedance2_5",
          generationMode: "edit_video",
          durationSeconds: 5,
          generateAudio: true
        },
        videoEditIntents: [
          {
            id: "intent-1",
            startSeconds: 3.2,
            endSeconds: 7.5,
            prompt: "人物转身面向镜头",
            annotationShapes: [],
            frameWidth: 1280,
            frameHeight: 720
          },
          {
            id: "intent-2",
            startSeconds: 12.05,
            prompt: "镜头缓推向远景",
            annotationShapes: [],
            frameWidth: 1280,
            frameHeight: 720
          }
        ],
        inputMapping: [inputMapping(CANVAS_NODES.videoId, "edit_video", "0", "待编辑视频")]
      }),
      { id: CANVAS_NODES.videoId, type: "video", data: { title: "待编辑视频", outputAssetId: "asset-video-ready" } }
    ],
    edges: [{ id: "e-edit", source: CANVAS_NODES.videoId, target: CANVAS_NODES.targetId }],
    assets: [readyVideoAsset("asset-video-ready")]
  });
}

/** 视频 + 缺失输入视频（`edit_video` 模式，入口禁用 + 稳定原因）。 */
export function editVideoMissingCanvas(): ServerCanvas {
  return canvasFor({
    nodes: [
      targetNode("video", {
        parameters: {
          model: "ark:seedance2_5",
          generationMode: "edit_video",
          durationSeconds: 5,
          generateAudio: true
        },
        videoEditIntents: [
          {
            id: "intent-1",
            startSeconds: 1,
            prompt: "整体提亮",
            annotationShapes: [],
            frameWidth: 1280,
            frameHeight: 720
          }
        ]
      }),
      { id: CANVAS_NODES.pendingVideoId, type: "video", data: { title: "待生成视频", outputAssetId: "asset-video-pending" } }
    ],
    edges: [{ id: "e-missing", source: CANVAS_NODES.pendingVideoId, target: CANVAS_NODES.targetId }],
    assets: [pendingVideoAsset("asset-video-pending")]
  });
}

export const CANVAS_FIXTURES: Record<CanvasFixtureId, () => ServerCanvas> = {
  empty: () => baseCanvas("image"),
  emptyPrompt: emptyPromptCanvas,
  readyReferences: readyReferencesCanvas,
  manyReferences: manyReferencesCanvas,
  pendingReference: pendingReferenceCanvas,
  unavailableReference: unavailableReferenceCanvas,
  pickerCandidates: pickerCandidatesCanvas,
  editVideoReady: editVideoReadyCanvas,
  editVideoMissing: editVideoMissingCanvas,
  imageRunning: () => taskStateCanvas("image", { taskStatus: "processing", progress: 55 }),
  imageFailed: () => taskStateCanvas("image", { taskStatus: "failed", errorMessage: "Provider 返回无效结果" }),
  audioIdle: () => baseCanvas("audio"),
  audioMusic: () =>
    canvasFor({
      nodes: [
        targetNode("audio", {
          title: "音乐生成",
          prompt: "轻快明亮的电子音乐",
          parameters: { model: "showcase-audio-music", durationSeconds: 30 }
        })
      ],
      edges: []
    }),
  audioRunning: () => taskStateCanvas("audio", { taskStatus: "processing", progress: 40 }),
  audioSucceeded: () => taskStateCanvas("audio", { taskStatus: "successed", progress: 100 }),
  audioFailed: () => taskStateCanvas("audio", { taskStatus: "failed", errorMessage: "音频合成失败：voice 不可用" }),
  videoRunning: () => taskStateCanvas("video", { taskStatus: "processing", progress: 30 }),
  videoFailed: () => taskStateCanvas("video", { taskStatus: "failed", errorMessage: "Seedance 执行失败" })
};

export function canvasFixture(id: CanvasFixtureId): ServerCanvas {
  return CANVAS_FIXTURES[id]();
}

/**
 * 从 fixture 画布派生 `@` mention 候选（与生产 `ModelExecutionHost` 的投影一致）。
 *
 * 生产使用 `resolveReferenceItems(...).items.filter(ready && slotId)`；这里复用同一函数，
 * component test 直接断言候选来源，typeahead 菜单的打开/选择由 Playwright 在真实浏览器覆盖。
 */
export function mentionCandidatesFor(canvas: ServerCanvas): Array<{
  slotId: string;
  type: string;
  label: string;
}> {
  return resolveReferenceItems({ canvas, nodeId: CANVAS_NODES.targetId, bindings: MENTION_TEST_BINDINGS })
    .items.filter((item) => item.status === "ready" && item.slotId !== "")
    .map((item) => ({ slotId: item.slotId, type: item.mentionType, label: item.label }));
}

/** 与 catalog fixture 的图片模型 binding 一致的测试 bindings。 */
const MENTION_TEST_BINDINGS = [
  {
    field: "reference-image",
    semantic: "reference-image" as const,
    roles: ["reference_image"],
    mediaKinds: ["image" as const],
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    maxItems: 16,
    valueFormat: "url" as const
  }
];
