/**
 * Canvas published 摘要目录 facade（统一后端 → Access 扩展）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 5.6/4.6 / design D7）。
 *
 * Access 拥有 ACL 与成员索引，但画布 title/revision/updatedAt/nodeCount 仍以 Canvas
 * published 权威为准。本 facade 只暴露**批量只读摘要**，不交出 Y.Doc/store/repository
 * 句柄，也不允许扩展据此推断 ACL。
 */
import type { CanvasService } from "@woohaa3/canvas-service";
import type { CanvasDirectoryFacade } from "../extensions/slot-contract.js";

/** 由 Canvas 组合的权威 service 派生只读摘要目录；未配置/不可读的目标不进入结果。 */
export function createCanvasDirectoryFacade(canvas: CanvasService): CanvasDirectoryFacade {
  const service = () => canvas.composition?.service ?? null;
  return {
    async listSummaries(canvasIds) {
      const current = service();
      if (!current) return [];
      const summaries: Array<{ canvasId: string; title: string; revision: number; updatedAt: string; nodeCount: number }> = [];
      for (const canvasId of canvasIds) {
        try {
          const canvasDocument = await current.getCanvas(canvasId);
          summaries.push({
            canvasId: canvasDocument.id,
            title: typeof canvasDocument.title === "string" ? canvasDocument.title : "",
            revision: canvasDocument.revision,
            updatedAt: canvasDocument.updatedAt,
            nodeCount: canvasDocument.document.nodes.length
          });
        } catch {
          // 不存在/读取失败：不作为可发现摘要（不泄漏存在性）。
        }
      }
      return summaries;
    }
  };
}
