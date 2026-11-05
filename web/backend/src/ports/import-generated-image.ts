/**
 * 把本回合 Codex 生图产物导入画布（change: 2026-11-03-add-codex-image-import）。
 *
 * 路径只从本进程登记表按 index 取。媒体先写入；节点创建失败时保留已写入对象（D8），
 * 并向调用方返回原始错误。节点是成品图：加入当前 2D 组（workflow-group-2d）的成员表，
 * 不写 prompt，也不写入旧组容器字段。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  findAgentNodeDescriptor,
  type CanvasCommand,
  type CanvasNodeData,
  type MediaMetadata,
  type StoredAsset,
  type WorkflowGroupData
} from "@woohaa3/contracts";
import { stableAuthorityVersion } from "@woohaa3/canvas-service";
import { resolveGeneratedImage } from "./generated-image-source.js";

export type CodexImageImportReceipt = {
  nodeId: string;
  mediaRef: string;
  sha256: string;
  totalGenerated: number;
  importedIndex: number;
};

export type CodexImageImportResult =
  | { ok: true; receipt: CodexImageImportReceipt; duplicate: boolean }
  | { ok: false; code: string; message: string; totalGenerated?: number };

export type CodexImageImportDeps = {
  canvasId: string;
  requestId: string;
  index: number;
  /** 当前 2D 组（workflow-group-2d）；成品图片节点加入其 memberNodeIds。 */
  group: {
    nodeId: string;
    nodeData: Record<string, unknown>;
    workflowGroup: WorkflowGroupData;
  };
  codexHome: string;
  paths: readonly string[];
  importBytes(input: { bytesBase64: string; contentType: string; maxBytes?: number; canvasId: string }): Promise<MediaMetadata>;
  apply(commands: CanvasCommand[], commandId: string): Promise<{ ok: true; revision: number } | { ok: false; code: string; message: string }>;
  now?: () => string;
};

const receipts = new Map<string, CodexImageImportReceipt>();

export function resetCodexImageImportReceipts(): void {
  receipts.clear();
}

function receiptKey(canvasId: string, requestId: string, index: number, savedPath: string): string {
  return `${canvasId}\0${requestId}\0${index}\0${savedPath}`;
}

function entityId(canvasId: string, requestId: string, index: number): string {
  return createHash("sha256").update(`${canvasId}\0${requestId}\0${index}`).digest("hex").slice(0, 16);
}

export async function importCodexGeneratedImage(deps: CodexImageImportDeps): Promise<CodexImageImportResult> {
  const totalGenerated = deps.paths.length;
  if (!Number.isInteger(deps.index) || deps.index < 0 || deps.index >= totalGenerated) {
    return {
      ok: false,
      code: "image-index-out-of-range",
      message: `index ${deps.index} 超出本轮产物数量 ${totalGenerated}`,
      totalGenerated
    };
  }
  const savedPath = deps.paths[deps.index]!;
  const key = receiptKey(deps.canvasId, deps.requestId, deps.index, savedPath);
  const existing = receipts.get(key);
  if (existing) return { ok: true, receipt: { ...existing, totalGenerated }, duplicate: true };

  const resolved = resolveGeneratedImage(savedPath, { codexHome: deps.codexHome });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, totalGenerated };

  const bytes = readFileSync(resolved.path);
  const metadata = await deps.importBytes({
    bytesBase64: bytes.toString("base64"),
    contentType: resolved.contentType,
    maxBytes: resolved.size,
    canvasId: deps.canvasId
  });

  const hash = entityId(deps.canvasId, deps.requestId, deps.index);
  const nodeId = `codex-image-${hash}`;
  const assetId = `codex-asset-${hash}`;
  const size = findAgentNodeDescriptor("image")?.defaultSize ?? { width: 320, height: 320 };
  const createdAt = deps.now?.() ?? new Date().toISOString();
  const asset: StoredAsset = {
    id: assetId,
    nodeId,
    title: "Codex 图片",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    url: `/api/media/${metadata.storageKey}`,
    createdAt,
    provenance: { taskKind: "codex-image-import", outputIndex: deps.index, taskNodeId: nodeId },
    metadata: {
      storageKey: metadata.storageKey,
      checksum: metadata.checksum,
      contentType: metadata.contentType,
      size: metadata.size
    }
  };
  // 2D 组成员来自 workflowGroup2d.memberNodeIds；新节点不加 parentId，也不复用旧组容器。
  const memberNodeIds = deps.group.workflowGroup.memberNodeIds.filter(id => id !== nodeId);
  const nextMembers = [...memberNodeIds, nodeId];
  const scopeVersion = stableAuthorityVersion("workflow-group-scope", {
    groupId: deps.group.workflowGroup.groupId,
    memberNodeIds: nextMembers
  });
  const commands: CanvasCommand[] = [
    {
      type: "node.add",
      node: {
        id: nodeId,
        type: "image",
        position: { x: 48 + deps.index * (size.width + 40), y: 48 },
        width: size.width,
        height: size.height
      },
      nodeData: {
        title: "Codex 图片",
        codexImageImport: true,
        outputAssetId: assetId,
        resourceKind: "image",
        taskStatus: "successed"
      }
    },
    { type: "asset.upsert", asset },
    {
      type: "nodeData.patch",
      nodeId: deps.group.nodeId,
      value: {
        ...deps.group.nodeData,
        workflowGroup2d: {
          ...deps.group.workflowGroup,
          memberNodeIds: nextMembers,
          scopeVersion
        }
      } as unknown as CanvasNodeData
    }
  ];
  const commandId = `codex-image-import:${hash}`;
  const applied = await deps.apply(commands, commandId);
  if (!applied.ok) return { ok: false, code: applied.code, message: applied.message, totalGenerated };

  const receipt: CodexImageImportReceipt = {
    nodeId,
    mediaRef: metadata.storageKey,
    sha256: metadata.checksum,
    totalGenerated,
    importedIndex: deps.index
  };
  receipts.set(key, receipt);
  return { ok: true, receipt, duplicate: false };
}

export function resolveCodexHome(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  return env.WOOHAA3_LOCAL_AGENT_CODEX_HOME || env.CODEX_HOME || (home ? `${home}/.codex` : ".codex");
}
