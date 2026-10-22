/**
 * Yjs 契约 fixtures（任务 1.3）。
 *
 * 这些 fixture 是后续所有 round-trip / 收敛测试的共同输入，覆盖：
 * 空画布、完整 nodes/edges/nodeData、assets/jobs、任务运行态、COS 图片引用。
 * 每个 fixture 都必须先通过 domain parser（否则 Yjs 映射测试会拿非法输入当合法）。
 */
import type { CanvasNodeData, ServerCanvas } from "../../domain/index.js";

const NOW = "2026-09-23T00:00:00.000Z";
export const FIXTURE_NOW = NOW;

const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);
export const FIXTURE_STORAGE_KEY = `sha256-${CHECKSUM_A}`;
export const FIXTURE_GENERATED_KEY = `generation-outputs/${CHECKSUM_B}.png`;

/** 空画布：无节点、无边、无资产、revision 0。 */
export function emptyCanvasFixture(): ServerCanvas {
  return {
    id: "canvas-empty",
    title: "空画布",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [],
      edges: [],
      updatedAt: NOW
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: NOW
  };
}

/** 完整图：text -> image 依赖边，含 nodeData。 */
export function fullGraphFixture(): ServerCanvas {
  return {
    id: "canvas-full",
    title: "完整画布",
    revision: 7,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [
        { id: "text-1", type: "text", position: { x: 0, y: 0 }, width: 360, height: 220, zIndex: 1 },
        { id: "image-1", type: "image", position: { x: 640, y: 0 }, width: 512, height: 742, zIndex: 2 }
      ],
      edges: [
        {
          id: "edge-1",
          source: "text-1",
          target: "image-1",
          sourceHandle: "out-0",
          targetHandle: "in-0",
          data: { kind: "dependency" }
        }
      ],
      updatedAt: NOW
    },
    nodeData: {
      "text-1": { title: "提示词", prompt: "一只猫坐在窗台上" },
      "image-1": {
        title: "主视觉",
        taskKind: "image-generation",
        panelPrompt: "一只猫坐在窗台上",
        taskStatus: "successed",
        outputAssetId: "asset-image-1",
        resourceKind: "image"
      }
    },
    assets: [],
    jobs: [],
    updatedAt: NOW
  };
}

/** 含 stabil COS 资产与任务记录。 */
export function assetsAndJobsFixture(): ServerCanvas {
  const base = fullGraphFixture();
  return {
    ...base,
    id: "canvas-assets",
    revision: 4,
    assets: [
      {
        id: "asset-image-1",
        nodeId: "image-1",
        title: "生成图",
        mediaKind: "image",
        source: "generated",
        status: "ready",
        url: `/api/media/${FIXTURE_GENERATED_KEY}`,
        createdAt: NOW,
        provenance: { taskNodeId: "image-1", taskKind: "image-generation", runId: "run-1", outputIndex: 0 },
        metadata: {
          storageKey: FIXTURE_GENERATED_KEY,
          checksum: CHECKSUM_B,
          contentType: "image/png",
          size: 2048
        }
      }
    ],
    jobs: [
      {
        id: "job-1",
        nodeId: "image-1",
        taskId: "task-1",
        runId: "run-1",
        status: "success",
        updatedAt: NOW
      }
    ]
  };
}

/** 任务运行态：processing + activeRunId。 */
export function taskRunStateFixture(): ServerCanvas {
  const base = fullGraphFixture();
  const imageNodeData = base.nodeData["image-1"];
  return {
    ...base,
    id: "canvas-run",
    revision: 2,
    nodeData: {
      ...base.nodeData,
      "image-1": {
        ...imageNodeData,
        taskStatus: "processing",
        activeRunId: "run-2",
        progress: 40,
        modelId: "gpt-image-2"
      } as CanvasNodeData
    },
    jobs: [
      {
        id: "job-2",
        nodeId: "image-1",
        taskId: "task-2",
        runId: "run-2",
        status: "running",
        updatedAt: NOW
      }
    ]
  };
}

/** 含上传型内容寻址 COS 引用（sha256- 前缀）。 */
export function uploadedAssetFixture(): ServerCanvas {
  const base = emptyCanvasFixture();
  return {
    ...base,
    id: "canvas-uploaded",
    revision: 1,
    assets: [
      {
        id: "asset-upload-1",
        title: "上传图",
        mediaKind: "image",
        source: "uploaded",
        status: "ready",
        url: `/api/media/${FIXTURE_STORAGE_KEY}`,
        createdAt: NOW,
        metadata: {
          storageKey: FIXTURE_STORAGE_KEY,
          checksum: CHECKSUM_A,
          contentType: "image/png",
          size: 4
        }
      }
    ]
  };
}

export const ALL_FIXTURES: ReadonlyArray<{ name: string; build: () => ServerCanvas }> = [
  { name: "empty", build: emptyCanvasFixture },
  { name: "full-graph", build: fullGraphFixture },
  { name: "assets-jobs", build: assetsAndJobsFixture },
  { name: "task-run-state", build: taskRunStateFixture },
  { name: "uploaded-asset", build: uploadedAssetFixture }
];
