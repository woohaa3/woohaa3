/**
 * 整页跳转后外壳要落在哪个路由。
 *
 * 点项目卡打开**另一张**画布、或首页「生成」新建画布后进入,都是一次整页跳转,外壳会在新页面上
 * 重新挂载,MemoryRouter 回到初始位置(首页)。用户要的是"进这张画布",落回首页就等于没反应。
 * 所以跳转前记一笔,新外壳挂载时读走 —— 这一笔必须跨整页跳转,用 sessionStorage。
 *
 * `PENDING_ENTRY_KEY` 必须有时效:它靠"外壳挂载后清掉"来收尾,而外壳一旦没挂载成功
 * (扩展加载失败、渲染抛错被错误边界隐藏),清除就永远不会执行 —— 于是这把键永久留在
 * sessionStorage 里,之后每次打开都直接落到 `/create`:`.sixi-host-root` 不渲染、画布没人盖,
 * 界面上就是"打开直接是画布,没有四喜"。所以写入时带上时间戳,超过 10 秒的落点视为过期。
 */
const PENDING_ENTRY_KEY = "sixi-spike.entry";

/** 落点只在紧跟一次整页跳转时有意义;超时说明那次跳转没落成,读回首页。 */
const PENDING_ENTRY_TTL_MS = 10_000;

export function readPendingEntry(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_ENTRY_KEY);
    if (!raw) return null;
    // 新格式 `{ route, at }`;旧版本直接存字符串,读到即视为过期并清掉。
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(PENDING_ENTRY_KEY);
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      sessionStorage.removeItem(PENDING_ENTRY_KEY);
      return null;
    }
    const { route, at } = parsed as { route?: unknown; at?: unknown };
    if (typeof route !== "string" || typeof at !== "number" || Date.now() - at > PENDING_ENTRY_TTL_MS) {
      sessionStorage.removeItem(PENDING_ENTRY_KEY);
      return null;
    }
    return route;
  } catch {
    return null;
  }
}

export function writePendingEntry(entry: string | null): void {
  try {
    if (entry) sessionStorage.setItem(PENDING_ENTRY_KEY, JSON.stringify({ route: entry, at: Date.now() }));
    else sessionStorage.removeItem(PENDING_ENTRY_KEY);
  } catch {
    /* 存储不可用:落回首页,不影响跳转本身 */
  }
}
