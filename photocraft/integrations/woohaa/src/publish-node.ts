/**
 * 添加到画布：工程 + PNG 的原子发布
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.4 / design D5）。
 *
 * 独立文件文档经显式“添加到画布”在当前画布创建一个**带工程的图片节点**。要求：
 * - 一次操作拥有稳定 `operationId` 与冻结产物（上传重试复用同一对象，不重复创建节点）；
 * - 工程对象与 PNG 成对上传后才提交一个原子批次（`asset.upsert` + `node.add`），
 *   不允许“先建裸节点再补工程”的半完成结果；
 * - 创建结果未知时先查询/对账（按稳定 nodeId 判断是否已经存在），不能每次重试生成新节点；
 * - 成功才把原 tab 原位绑定为节点并聚焦；失败仍是原独立文档。
 *
 * 本模块只编排与规划；上传、回执与命令提交由宿主注入的端口提供，便于纯逻辑回归。
 */
import type { CanvasCommand, ImageProjectDocument, StoredAsset } from "@woohaa3/contracts";
import type { ProjectExportArtifacts } from "@woohaa3/photocraft-editor";
import { buildProjectDocument } from "./project-save.js";

export type PublishUploadedObject = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url: string;
};

/** 一次添加到画布的宿主端口。 */
export type PublishPorts = {
  /** 上传工程对象（`application/x-woohaa-image-project`）。失败返回 null。 */
  uploadProject: (bytes: Uint8Array, operationId: string) => Promise<PublishUploadedObject | null>;
  /** 上传合成 PNG。失败返回 null。 */
  uploadOutput: (bytes: Uint8Array, operationId: string) => Promise<PublishUploadedObject | null>;
  /** 提交一个原子命令批次（服务端保证整批生效或整批拒绝）。 */
  submit: (commands: readonly CanvasCommand[], operationId: string) => { ok: true } | { ok: false; reason: string };
  /** 已存在的节点（回执未知时核对）。 */
  findNode: (nodeId: string) => { exists: boolean; outputAssetId: string | null };
  /** 当前画布是否可写（只读/断线时拒绝，但允许本地保存）。 */
  isWritable: () => boolean;
  /** 当前画布上可用的插入位置。 */
  insertPosition: () => { x: number; y: number };
  /** 画布 id（节点身份与上传都带它）。 */
  canvasId: () => string;
};

/** 一次添加操作的稳定身份（重试复用）。 */
export type PublishOperation = {
  operationId: string;
  nodeId: string;
  /** 已上传对象（部分失败后复用，不重复上传）。 */
  project?: PublishUploadedObject;
  output?: PublishUploadedObject;
};

export type PublishResult =
  | { ok: true; nodeId: string; alreadyExisted: boolean }
  | { ok: false; code: "readonly" | "upload-failed" | "submit-failed" | "invalid-artifacts"; message: string };

/** 创建一次操作身份（`operationId`/`nodeId` 都由它派生，保证重试稳定）。 */
export function createPublishOperation(seed: string): PublishOperation {
  const stable = stableToken(seed);
  return { operationId: `photocraft-publish:${stable}`, nodeId: `image-publish-${stable}` };
}

/** 由稳定种子得到不依赖随机数的短标识（同一文档重试得到同一身份）。 */
function stableToken(seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 10);
}

/**
 * 执行一次添加：成对上传 → 原子提交。
 *
 * 上传任一侧失败时不提交任何命令（不留裸节点）；提交结果未知时先按稳定 `nodeId` 核对。
 */
export async function publishToCanvas(
  artifacts: ProjectExportArtifacts,
  operation: PublishOperation,
  ports: PublishPorts,
  base?: { title?: string }
): Promise<PublishResult> {
  if (!ports.isWritable()) {
    return { ok: false, code: "readonly", message: "当前画布只读或未连接，无法添加到画布（可先保存到本地文件）" };
  }
  const project = operation.project ?? await ports.uploadProject(artifacts.project, operation.operationId);
  if (!project) return { ok: false, code: "upload-failed", message: "工程对象上传失败，文档仍保留为独立文件" };
  operation.project = project;
  const output = operation.output ?? await ports.uploadOutput(artifacts.output, operation.operationId);
  if (!output) return { ok: false, code: "upload-failed", message: "合成图上传失败，文档仍保留为独立文件" };
  operation.output = output;

  // 上传完成后再次检查写入门禁（等待期间可能被置为只读）。
  if (!ports.isWritable()) {
    return { ok: false, code: "readonly", message: "画布已变为只读，未提交节点（可先保存到本地文件）" };
  }

  const projectAssetId = `asset-image-project-${project.checksum}`;
  const outputAssetId = `asset-image-publish-${output.checksum}`;
  // 工程定义的基底就是刚上传的合成图（独立文件没有画布节点资产）。
  const projectDocument = publishedProjectDocument({
    artifacts,
    project,
    baseAssetId: outputAssetId,
    sourceAssetIds: [outputAssetId]
  });
  const commands = planPublishCommands({
    operation,
    project,
    output,
    projectAssetId,
    outputAssetId,
    projectDocument,
    canvasId: ports.canvasId(),
    position: ports.insertPosition(),
    ...(base?.title ? { title: base.title } : {})
  });
  const submitted = ports.submit(commands, operation.operationId);
  if (submitted.ok) return { ok: true, nodeId: operation.nodeId, alreadyExisted: false };

  // 结果未知/失败：先按稳定 nodeId 核对是否其实已提交（回执未知不当普通失败重试）。
  const existing = ports.findNode(operation.nodeId);
  if (existing.exists) return { ok: true, nodeId: operation.nodeId, alreadyExisted: true };
  return { ok: false, code: "submit-failed", message: submitted.reason || "创建节点失败，文档仍保留为独立文件" };
}

/**
 * 由冻结产物与已上传对象组装工程定义（与节点保存路径同构）。
 *
 * 复用 `project-save` 的 `buildProjectDocument` 需要宿主 `UploadedObject` 形状；这里做一次
 * 等价映射，保证“添加到画布”写出的 `.pcraft` 引用与保存路径一致。
 */
function publishedProjectDocument(input: {
  artifacts: ProjectExportArtifacts;
  project: PublishUploadedObject;
  baseAssetId: string;
  sourceAssetIds: readonly string[];
}): ImageProjectDocument {
  const document = buildProjectDocument({
    artifacts: input.artifacts,
    uploadedProject: {
      storageKey: input.project.storageKey,
      checksum: input.project.checksum,
      contentType: input.project.contentType,
      size: input.project.size,
      url: input.project.url
    },
    baseAsset: {
      id: input.baseAssetId,
      title: "图片",
      mediaKind: "image",
      source: "uploaded",
      status: "ready",
      createdAt: new Date().toISOString(),
      url: input.project.url,
      metadata: {}
    },
    document: null,
    sourceAssetIds: input.sourceAssetIds
  });
  return document;
}

/**
 * 规划原子命令批次：工程资产 + 输出资产 + 带工程的图片节点。
 *
 * 工程定义（`imageEdit`）在 `nodeData` 中与节点一起创建，因此不会出现“节点已建但工程缺失”
 * 的中间状态；服务端整批生效或整批拒绝。工程定义由同一份冻结产物与已上传对象组装
 * （`buildProjectDocument`），与节点保存路径完全一致。
 */
export function planPublishCommands(input: {
  operation: PublishOperation;
  project: PublishUploadedObject;
  output: PublishUploadedObject;
  projectAssetId: string;
  outputAssetId: string;
  canvasId: string;
  position: { x: number; y: number };
  title?: string;
  /** 与节点保存同构的工程定义（同一冻结修订 + 同一工程引用）。 */
  projectDocument: ImageProjectDocument;
}): CanvasCommand[] {
  const now = new Date().toISOString();
  const projectAsset: StoredAsset = {
    id: input.projectAssetId,
    title: `${input.title ?? "PhotoCraft 工程"}.pcraft`,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: now,
    url: input.project.url,
    metadata: {
      storageKey: input.project.storageKey,
      checksum: input.project.checksum,
      contentType: input.project.contentType,
      size: input.project.size
    }
  };
  const outputAsset: StoredAsset = {
    id: input.outputAssetId,
    title: input.title ?? "图片",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: now,
    url: input.output.url,
    metadata: {
      storageKey: input.output.storageKey,
      checksum: input.output.checksum,
      contentType: input.output.contentType,
      size: input.output.size
    }
  };
  const data: Record<string, unknown> = {
    outputAssetId: input.outputAssetId,
    ...(input.title ? { title: input.title } : {}),
    // 工程定义与节点同批创建：与节点保存写出的定义同构（同一冻结修订 + 同一工程引用）。
    imageEdit: input.projectDocument
  };
  return [
    { type: "asset.upsert", asset: projectAsset },
    { type: "asset.upsert", asset: outputAsset },
    {
      type: "node.add",
      node: { id: input.operation.nodeId, type: "image", position: { ...input.position }, width: 248, height: 232 },
      nodeData: data as never
    }
  ];
}
