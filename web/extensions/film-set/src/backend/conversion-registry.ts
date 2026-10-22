/**
 * 转换任务幂等登记的内存实现
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2 / design D5）。
 *
 * 契约见 `@woohaa3/contracts` 的 `FilmSetConversionRegistry`。本实现用于测试与未配置持久 backend
 * 的单实例部署；生产由 Canvas Service 注入 durable 实现（跨重启保留回执）。
 */
import type { FilmSetConversionRecord, FilmSetConversionRegistry } from "@woohaa3/contracts";

/** 内存登记实现。 */
export class InMemoryFilmSetConversionRegistry implements FilmSetConversionRegistry {
  private readonly records = new Map<string, FilmSetConversionRecord>();

  private key(canvasId: string, requestId: string): string {
    return `${canvasId}\u0000${requestId}`;
  }

  async get(canvasId: string, requestId: string): Promise<FilmSetConversionRecord | null> {
    return this.records.get(this.key(canvasId, requestId)) ?? null;
  }

  async put(record: FilmSetConversionRecord): Promise<void> {
    this.records.set(this.key(record.canvasId, record.requestId), record);
  }

  async delete(canvasId: string, requestId: string): Promise<void> {
    this.records.delete(this.key(canvasId, requestId));
  }

  /** 当前记录数（测试/诊断用）。 */
  size(): number {
    return this.records.size;
  }
}
