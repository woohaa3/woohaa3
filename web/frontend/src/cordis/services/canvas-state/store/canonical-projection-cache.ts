/**
 * 规范投影复用缓存（change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 8.1）。
 *
 * Y.Doc → `ServerCanvas` 的派生要全量排序节点/边/资产/任务并做引用完整性校验。但 provider 的
 * 状态通知远多于内容变化（syncing/synced/权限/重连等），每次通知都重新派生 1000+ 节点既浪费
 * 主线程，也让「静止帧不重复全量准备」无法成立。
 *
 * 复用身份是 **doc（画布）+ room epoch + revision + doc 版本** 四元组：
 * - 只用 revision 不够：同一 revision 在重连换 epoch、换画布或本地 doc 被替换后可能指向完全
 *   不同的内容（spec 明令禁止跨文档/epoch 复用）；
 * - doc 版本在每个服务端 update 后递增，覆盖「revision 未变但内容变了」的合并写入；
 * - 失败结果（完整性/格式拒绝）**不进缓存**：损坏状态必须每次重新报告，不能因为「上次也失败」
 *   就复用旧结论，更不能把失败伪装成成功。
 *
 * 权限/连接状态不进本缓存：调用方在 ready 门禁之后才请求投影，状态通知本身仍按原路径发布。
 */

/** 投影身份：任一字段变化都必须重新派生。 */
export type CanonicalProjectionKey = {
  /** 画布 id（同一 session 内通常不变；切换画布必须新建 session）。 */
  canvasId: string;
  /** 服务端声明的 room epoch；未知为 null（不得与已知 epoch 复用）。 */
  roomEpoch: string | null;
  /** 规范业务 revision。 */
  revision: number;
  /** doc 版本：每个应用的服务端 update 递增（覆盖 revision 未变的写入）。 */
  docVersion: number;
};

export type CanonicalProjectionResult<T> = {
  value: T;
  /** true 表示命中缓存，未重新派生。 */
  reused: boolean;
};

export type CanonicalProjectionStats = {
  /** 成功派生次数。 */
  derived: number;
  /** 命中复用次数。 */
  reused: number;
  /** 派生失败次数（不入缓存）。 */
  failed: number;
  /** 主动失效次数（换 epoch/画布/权限或恢复）。 */
  invalidated: number;
};

export type CanonicalProjectionCache<T> = {
  /**
   * 取得当前身份的投影。
   *
   * `produce` 只在未命中时调用；抛错时不缓存，异常原样抛给调用方。
   */
  resolve: (key: CanonicalProjectionKey, produce: () => T) => CanonicalProjectionResult<T>;
  /** 丢弃缓存（换 epoch、换画布、恢复、权限变化时调用）。 */
  invalidate: () => void;
  /** 诊断快照（只读）。 */
  stats: () => CanonicalProjectionStats;
};

function sameKey(a: CanonicalProjectionKey, b: CanonicalProjectionKey): boolean {
  return a.canvasId === b.canvasId
    && a.roomEpoch === b.roomEpoch
    && a.revision === b.revision
    && a.docVersion === b.docVersion;
}

export function createCanonicalProjectionCache<T>(): CanonicalProjectionCache<T> {
  let cached: { key: CanonicalProjectionKey; value: T } | null = null;
  const counters: CanonicalProjectionStats = { derived: 0, reused: 0, failed: 0, invalidated: 0 };

  return {
    resolve(key, produce) {
      if (cached && sameKey(cached.key, key)) {
        counters.reused += 1;
        return { value: cached.value, reused: true };
      }
      let value: T;
      try {
        value = produce();
      } catch (error) {
        counters.failed += 1;
        // 失败不缓存：下一次请求仍要重新校验并重新报告。
        cached = null;
        throw error;
      }
      counters.derived += 1;
      // 复制身份，避免调用方后续改动对象字段影响命中判定。
      cached = { key: { ...key }, value };
      return { value, reused: false };
    },
    invalidate() {
      if (cached) counters.invalidated += 1;
      cached = null;
    },
    stats() {
      return { ...counters };
    }
  };
}
