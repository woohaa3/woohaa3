import type { CanvasNodeData } from "../types";

/**
 * 写入前的引用完整性防线（change: 2026-11-16-repair-generation-callback-stalls，缺陷 1）。
 *
 * 与 [`validateReferentialIntegrity`](../yjs/mapping.ts) 同语义，但放在 domain 层以便
 * **命令 reducer** 直接使用：reducer 是浏览器预览与服务端事务共用的唯一写入语义，
 * 在这里拦下比等到 Y.Doc 导出时才拒绝更早、也更容易定位。
 *
 * 为什么必须有这道防线：Y.Doc 导出对悬空引用是**拒绝**而不是修剪（spec：Y.Doc 是权威状态，
 * 出现悬空引用说明文档已损坏）。一旦孤儿 nodeData 被写进权威文档，这张画布就再也导出不了，
 * 连带效应见 `result-consumer` 的画布级隔离。删除路径本身会清理 nodeData，但扩展命令、
 * 内容归属钩子与历史恢复都能构造出「只加 nodeData、不加节点」的批次；防线必须独立于
 * 具体命令族的实现细节。
 *
 * 只做**结构**校验：不读 schema、不看节点类型，因此对任何节点族都成立。
 */
export type ReferentialIntegrityViolation = {
  code:
    | "orphan-node-data"
    | "dangling-edge-endpoint"
    | "dangling-parent"
    | "duplicate-node-id"
    | "duplicate-job-id";
  message: string;
};

export function findReferentialIntegrityViolation(input: {
  nodes: readonly { id: string; parentId?: string }[];
  edges: readonly { id: string; source: string; target: string }[];
  nodeData: Readonly<Record<string, unknown>>;
  jobs?: readonly { id: string }[];
}): ReferentialIntegrityViolation | null {
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (nodeIds.has(node.id)) {
      return { code: "duplicate-node-id", message: `节点 id 重复：${node.id}` };
    }
    nodeIds.add(node.id);
  }

  for (const edge of input.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return {
        code: "dangling-edge-endpoint",
        message: `边 ${edge.id} 的端点不存在：${edge.source} -> ${edge.target}`
      };
    }
  }

  // 孤儿 nodeData 是「画布损坏」最常见的形态，也是唯一致命的一种：
  // 其它问题的修复成本都很低，而这个会让整张画布再也导不出来。
  for (const key of Object.keys(input.nodeData)) {
    if (!nodeIds.has(key)) {
      return { code: "orphan-node-data", message: `nodeData 指向不存在的节点 ${key}` };
    }
  }

  for (const node of input.nodes) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      return { code: "dangling-parent", message: `节点 ${node.id} 的父节点 ${node.parentId} 不存在` };
    }
  }

  if (input.jobs) {
    const jobIds = new Set<string>();
    for (const job of input.jobs) {
      if (jobIds.has(job.id)) {
        return { code: "duplicate-job-id", message: `任务 id 重复：${job.id}` };
      }
      jobIds.add(job.id);
    }
  }

  return null;
}

/** 便捷重载：直接吃一份规范画布。 */
export function findCanvasReferentialIntegrityViolation(canvas: {
  document: { nodes: readonly { id: string; parentId?: string }[]; edges: readonly { id: string; source: string; target: string }[] };
  nodeData: Readonly<Record<string, CanvasNodeData>>;
  jobs: readonly { id: string }[];
}): ReferentialIntegrityViolation | null {
  return findReferentialIntegrityViolation({
    nodes: canvas.document.nodes,
    edges: canvas.document.edges,
    nodeData: canvas.nodeData,
    jobs: canvas.jobs
  });
}
