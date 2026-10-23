/**
 * 文件域的写入门禁与请求序号
 * （change: 2026-10-22-add-photocraft-file-workflows，任务 3.3 / design「门禁与代际」）。
 *
 * 两条规则解决的是**同一类**问题：异步操作在等待期间世界已经变了。
 *
 * 1. **写入门禁**：导出冻结/保存期间不接受内容修改。内核自身是同步的，但界面上的
 *    新建/复制/恢复/元数据写入都是「先记下请求、再做别的事」——如果不在这里挡，
 *    用户会在保存进行中改到正在冻结的修订，得到的产物与看到的画面不一致。
 * 2. **请求序号**：打开/重开文档是异步的（解码、WASM 打开、取景入场）。先发起的请求
 *    可能后完成；若它无条件把自己设为活动呈现，就会把用户在等待期间新发起的文档挤掉。
 *    规则只有一条：**只有最新一次请求可以改变呈现**，更早的请求仍完成打开（tab 保留），
 *    但不得抢走呈现。
 *
 * 这里只放纯规则，不读全局状态、不依赖宿主：调用方传入阶段与草稿事实，得到可显示的原因；
 * 模板与宿主各自用自己的序号实例。
 */

/** 门禁拒绝原因（稳定 code，界面与测试共用）。 */
export type FileWriteBlockCode = "exporting" | "saving" | "draft" | "no-document";

export type FileWritePlan =
  | { ok: true }
  | { ok: false; code: FileWriteBlockCode; message: string };

/** 调用方观测到的文档状态（缺省字段按「不阻塞」处理，便于精简宿主）。 */
export type FileWriteFacts = {
  /** 工作区阶段（`idle`/`editing`/`freezing`/`saving`/`failed`）。 */
  phase?: string | null;
  /** 仍有尚未权威确认的冻结产物（上一次保存失败后待重试）。 */
  pendingArtifacts?: boolean;
  /** 存在未确认的受控草稿（文字/变换/调整/属性/笔迹）。 */
  draft?: boolean;
  /** 当前会话是否已有文档（`createDocument` 之外的操作都需要）。 */
  hasDocument?: boolean;
  /** 该操作是否要求先有文档（`file.new` 不要求）。 */
  requireDocument?: boolean;
};

/**
 * 文件域写入的统一前置判定。
 *
 * 顺序有意如此：先报「正在导出/保存」（它不是用户的错，且等待即可），再报草稿
 * （用户可结算），最后才是没有文档。把「没有文档」放前面会把「保存中」误报成
 * 「没有文档」，用户按提示去新建一个文档只会让情况更糟。
 */
export function planFileWrite(facts: FileWriteFacts): FileWritePlan {
  if (facts.phase === "freezing") {
    return { ok: false, code: "exporting", message: "正在导出，完成后再修改文档" };
  }
  if (facts.phase === "saving" || facts.pendingArtifacts === true) {
    return { ok: false, code: "saving", message: "正在保存，请等待结果后再修改文档" };
  }
  if (facts.draft === true) {
    return { ok: false, code: "draft", message: "请先确认或取消当前草稿" };
  }
  if (facts.requireDocument === true && facts.hasDocument === false) {
    return { ok: false, code: "no-document", message: "当前没有可操作的文档" };
  }
  return { ok: true };
}

/**
 * 单调请求序号（按 key 分域）。
 *
 * 用法：`const token = sequence.next("open")` → 异步完成后 `sequence.isLatest("open", token)`。
 * 只有最新的那次可以推进呈现；更早的请求不推进，也不撤销自己已完成的工作（tab 保留）。
 */
export class RequestSequence {
  private readonly counters = new Map<string, number>();

  /** 发起一次请求，返回该 key 下递增的序号（从 1 开始）。 */
  next(key = "default"): number {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  /** 这次请求是否仍是该 key 下最新的一次。 */
  isLatest(key: string, token: number): boolean {
    return (this.counters.get(key) ?? 0) === token;
  }

  /** 当前序号（排障与测试用；从未发起为 0）。 */
  current(key = "default"): number {
    return this.counters.get(key) ?? 0;
  }

  /** 作废该 key 的全部在途请求（工作区释放/切换页面）。 */
  invalidate(key = "default"): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  clear(): void {
    this.counters.clear();
  }
}
