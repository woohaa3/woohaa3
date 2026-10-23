/**
 * 批量关闭与文档槽位上限的纯规则（本域纯数据）
 * （change: 2026-10-22-add-photocraft-file-workflows，U03 / design D1）。
 *
 * 关闭「全部/其他」必须在工作区上**串行**执行：每个文档各自结算（未保存确认、逐文档关闭），
 * 首个失败即停止，后续文档保持原状。这里只计算计划与结果，不持有文档、不注册标签——
 * 真正的关闭由共享工作区执行。
 */

export type CloseTarget = {
  /** 不透明文档 id。 */
  id: string;
  /** 是否有未保存变化（需要用户确认）。 */
  dirty: boolean;
  /** 活动操作门禁原因（笔迹/未确认草稿）；非空时该文档此刻不能关闭。 */
  gate: string | null;
};

export type ClosePlan =
  | {
      ok: true;
      /** 按顺序要关闭的文档 id（不含活动项，活动项最后关闭）。 */
      order: readonly string[];
      /** 有未保存变化的条目，界面需先确认。 */
      unsaved: readonly string[];
    }
  | { ok: false; code: "busy" | "empty" | "invalid"; reason: string };

function isUnique(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * 计算「关闭其他」计划：只保留活动项，其余按给定顺序关闭。
 *
 * 不移动活动项，也不猜测隐藏状态；`activeId` 不在列表里时明确拒绝（调用方状态已过期）。
 */
export function planCloseOthers(targets: readonly CloseTarget[], activeId: string): ClosePlan {
  if (targets.length === 0) return { ok: false, code: "empty", reason: "没有可关闭的文档" };
  if (!isUnique(targets.map((target) => target.id))) {
    return { ok: false, code: "invalid", reason: "文档列表包含重复 id，已取消本次操作" };
  }
  if (!targets.some((target) => target.id === activeId)) {
    return { ok: false, code: "invalid", reason: "活动文档已变化，请刷新后重试" };
  }
  const others = targets.filter((target) => target.id !== activeId);
  if (others.length === 0) return { ok: false, code: "empty", reason: "只有当前文档，无需关闭其他" };
  return {
    ok: true,
    order: others.map((target) => target.id),
    unsaved: others.filter((target) => target.dirty).map((target) => target.id)
  };
}

/**
 * 计算「关闭全部」计划：按标签顺序关闭每个文档，活动项最后关闭（视觉上不跳动）。
 */
export function planCloseAll(targets: readonly CloseTarget[], activeId: string | null): ClosePlan {
  if (targets.length === 0) return { ok: false, code: "empty", reason: "没有可关闭的文档" };
  if (!isUnique(targets.map((target) => target.id))) {
    return { ok: false, code: "invalid", reason: "文档列表包含重复 id，已取消本次操作" };
  }
  if (activeId !== null && !targets.some((target) => target.id === activeId)) {
    return { ok: false, code: "invalid", reason: "活动文档已变化，请刷新后重试" };
  }
  const inactive = targets.filter((target) => target.id !== activeId);
  const active = targets.filter((target) => target.id === activeId);
  return {
    ok: true,
    order: [...inactive, ...active].map((target) => target.id),
    unsaved: targets.filter((target) => target.dirty).map((target) => target.id)
  };
}

export type CloseStep = { id: string; ok: true } | { id: string; ok: false; reason: string };

/** 首个失败步骤：**必然**是失败态，调用方不必再收窄 `ok`。 */
export type CloseFailure = { id: string; ok: false; reason: string };

export type CloseOutcome = {
  /** 按顺序真正关闭的文档 id。 */
  closed: readonly string[];
  /** 首个失败的条目（其后条目保持原状）。 */
  failed: CloseFailure | null;
  /** 尚未尝试的文档 id。 */
  remaining: readonly string[];
  /** 是否全部关闭。 */
  complete: boolean;
};

/**
 * 按计划串行关闭：只调用一个关闭函数，首个失败立即停止并保留后续条目。
 *
 * 关闭函数自己负责逐文档结算（保存确认、宿主回写、草稿门禁）；本函数不吞掉失败原因，
 * 也不把「已停止」当成全部成功。
 */
export async function runClosePlan(
  plan: readonly string[],
  close: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
): Promise<CloseOutcome> {
  const closed: string[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const id = plan[index]!;
    const result = await close(id);
    if (!result.ok) {
      return { closed, failed: { id, ok: false, reason: result.reason }, remaining: plan.slice(index + 1), complete: false };
    }
    closed.push(id);
  }
  return { closed, failed: null, remaining: [], complete: true };
}

/**
 * 申请一个新文档槽位：达到上限时拒绝并说明原因（界面不得自行挤出别的文档）。
 *
 * 上限**由调用方传入**，不在这里声明第二份常量：标签上限的真源是共享
 * `document-workspace.ts` 的 `MAX_OPEN_DOCUMENTS`（注册表的实际执行者，也是宿主
 * `workspace-policy` 读取的那一份）。本域若自带一份，一旦共享侧调整就会出现
 * 「提示说最多 8 个、真正拒绝的理由却是别的数字」的分叉；依赖方向是 editor → protocol，
 * 这里也无法反向 import 共享实现。传参既保持了单向依赖，也让唯一真源只有一个。
 */
export function requestDocumentSlot(openCount: number, limit: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(openCount) || openCount < 0) return { ok: false, reason: "打开的文档数无效" };
  if (!Number.isInteger(limit) || limit < 1) return { ok: false, reason: "文档槽位上限无效" };
  if (openCount >= limit) {
    return { ok: false, reason: `最多同时打开 ${limit} 个文档，请先关闭其中一个` };
  }
  return { ok: true };
}
