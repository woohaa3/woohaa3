/**
 * Plugin Manager 视图投影
 * （change: add-frontend-plugin-manager，任务 2.3/4.1 / design D4）。
 *
 * 纯函数：由「本次启动实际装配状态」（startup snapshot）、「已保存目标状态」（desired）
 * 与启动失败集合派生每个**可配置 optional** 插件行状态；required 插件不出现在面板中，
 * 因此不产生行（也不从某个开关的即时值推断 Fiber 状态）。
 *
 * - 实际装配 + 目标启用 + 未失败：`active`。
 * - 实际装配 + 目标启用 + Fiber 失败：`failed`（目标开关仍为启用）。
 * - 未装配 + 目标禁用：`disabled`。
 * - 实际装配 + 目标禁用：`pending-disable`。
 * - 未装配 + 目标启用：`pending-enable`。
 */
import type { CanvasExtensionMetadata, ExtensionManagerViewRow, ExtensionManagerRowStatus } from "./contract.js";

export type ProjectExtensionRowsInput = {
  /** 本次启动有效选择（只含可配置 optional ID → 是否装配）。 */
  assembled: Readonly<Record<string, boolean>>;
  /** 已保存目标状态。 */
  desired: Readonly<Record<string, boolean>>;
  /** 启动失败的可配置 optional ID。 */
  failed?: ReadonlySet<string>;
  /** 启动失败原因（`extensionId → message`）；缺失时只显示状态。 */
  failures?: Readonly<Record<string, string>>;
};

/** 目标状态与本次启动实际装配是否不一致（存在待生效变更）。 */
export function hasPendingExtensionChanges(
  catalog: readonly CanvasExtensionMetadata[],
  input: ProjectExtensionRowsInput
): boolean {
  return catalog.some((entry) => {
    if (!entry.configurable) return false;
    const fallback = entry.defaultEnabled ?? true;
    const actual = input.assembled[entry.id] ?? fallback;
    const desired = input.desired[entry.id] ?? fallback;
    return actual !== desired;
  });
}

/**
 * 派生管理面板的稳定清单（顺序即 catalog 顺序）。
 *
 * 只包含用户可配置的 optional Plugin：required 与不可配置定义不进入面板。
 */
export function projectExtensionManagerRows(
  catalog: readonly CanvasExtensionMetadata[],
  input: ProjectExtensionRowsInput
): ExtensionManagerViewRow[] {
  return catalog
    .filter((entry) => entry.configurable)
    .map((entry) => {
      const base = {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        ...(entry.directory ? { directory: entry.directory } : {}),
        required: entry.required,
        configurable: entry.configurable,
        ...(entry.icon ? { icon: entry.icon } : {})
      };
      const fallback = entry.defaultEnabled ?? true;
      const actual = input.assembled[entry.id] ?? fallback;
      const desired = input.desired[entry.id] ?? fallback;
      let status: ExtensionManagerRowStatus;
      if (actual === desired) {
        if (actual) status = input.failed?.has(entry.id) ? "failed" : "active";
        else status = "disabled";
      } else {
        status = actual ? "pending-disable" : "pending-enable";
      }
      const failureReason = status === "failed" ? input.failures?.[entry.id] : undefined;
      return { ...base, status, ...(failureReason ? { failureReason } : {}) };
    });
}

/** 状态 → 面向用户的简短说明（含 pending 语义）。 */
export function extensionRowStatusLabel(status: ExtensionManagerRowStatus): string {
  switch (status) {
    case "active":
      return "已启用";
    case "disabled":
      return "已停用";
    case "failed":
      return "启动失败";
    case "pending-enable":
      return "待启用";
    case "pending-disable":
      return "待停用";
  }
}

/**
 * 站点插件实际状态 → 面向用户的说明
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 4.2）。
 *
 * 面板不得从开关布尔值推断后端可用性；这里为每个有限状态给出明确文案。
 */
export function siteActualStateLabel(actualState: string): string {
  switch (actualState) {
    case "disabled":
      return "已停用";
    case "unconfigured":
      return "未配置";
    case "configuring":
      return "配置中";
    case "active":
      return "运行中";
    case "degraded":
      return "降级运行";
    case "failed":
      return "激活失败";
    case "draining":
      return "正在收尾（draining）";
    case "suspended":
      return "安全模式下已暂停";
    default:
      return "未知状态";
  }
}

/**
 * 站点行是否处于**进行中**（配置中/draining）。
 *
 * `degraded` 刻意不算 busy：它是「已装载但能力没就绪」的稳态（比如生成 Provider 还没配 API Key），
 * 开关必须保持可用，否则管理员补上凭据之前根本关不掉这个插件。
 */
export function isSiteRowBusy(actualState: string): boolean {
  return actualState === "configuring" || actualState === "draining";
}
