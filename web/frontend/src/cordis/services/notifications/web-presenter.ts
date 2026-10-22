/**
 * Web 标题 presenter（change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.4 / design D9）。
 *
 * 唯一拥有标题前缀的 writer：
 * - 保留启动时注入的基础标题（含 worktree 名），只替换前缀，不嵌套；
 * - 不闪烁、不引入逐帧循环：只在计数变化/清除时写一次 `document.title`；
 * - 恢复（重新聚焦、关闭渠道、服务释放）一律回到基础标题；
 * - 不触碰任务活动面板自己的 unread。
 *
 * 纯逻辑 + 注入 title 适配，便于无 DOM 回归。
 */
export type TitlePresenter = {
  /** 记录部署注入的基础标题（启动时一次）。 */
  setBaseTitle(title: string): void;
  /** 用计数替换前缀；全零时恢复基础标题。 */
  render(counts: { succeeded: number; failed: number }): void;
  /** 恢复基础标题（重新聚焦 / 关闭渠道 / dispose）。 */
  clear(): void;
  /** 当前实际写入的标题（回归/诊断）。 */
  current(): string;
};

/** 标题前缀文案：保留失败数（即使为 0 也只在有成功时省略）。 */
export function titlePrefix(counts: { succeeded: number; failed: number }): string {
  const parts: string[] = [];
  if (counts.succeeded > 0) parts.push(`${counts.succeeded} 项完成`);
  if (counts.failed > 0) parts.push(`${counts.failed} 项失败`);
  return parts.length > 0 ? `（${parts.join("，")}）` : "";
}

export function createTitlePresenter(options: {
  /** 写入标题（缺省写 `document.title`）。 */
  write?: (title: string) => void;
  /** 读取当前标题（缺省 `document.title`）；用于初始化基础标题。 */
  read?: () => string;
} = {}): TitlePresenter {
  const write =
    options.write ??
    ((title: string) => {
      const doc = globalThis.document;
      if (doc) doc.title = title;
    });
  const read = options.read ?? (() => globalThis.document?.title ?? "");
  // 基础标题在首次使用时固定；之后即使外部改了标题也不把前缀叠上去。
  let baseTitle = read();
  let last = "";

  const apply = (next: string) => {
    if (next === last) return;
    last = next;
    write(next);
  };

  return {
    setBaseTitle(title) {
      baseTitle = title;
      last = "";
    },
    render(counts) {
      if (counts.succeeded <= 0 && counts.failed <= 0) {
        apply(baseTitle);
        return;
      }
      apply(`${titlePrefix(counts)}${baseTitle}`);
    },
    clear() {
      apply(baseTitle);
    },
    current: () => last
  };
}
