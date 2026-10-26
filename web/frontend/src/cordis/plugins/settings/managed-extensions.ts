/**
 * 受管扩展的设置面状态（change: 2026-10-21-add-extension-marketplace-point，任务 7.2 / design D10、D11）。
 *
 * - 发起安装 / 卸载 / 回滚，按 jobId 轮询到终态；终态后重取 `/api/settings`（受管卡片与版本以它为准）；
 * - 设置快照里仍在运行的任务（`extensionInstallations.jobs`）会被接管继续轮询，关闭重开设置不丢进度；
 * - 失败码映射为稳定中文原因；未知码显示宿主给出的安全消息；
 * - 「需要重启」来自卡片的 `restartRequired` 或任务结果 `restart-required`；重启经宿主受控入口，
 *   不支持时提示手动重启（`MARKETPLACE_RESTART_UNSUPPORTED`）。
 *
 * - 子进程隔离（change: 2026-10-21-isolate-extension-host-process，D7/D10）：崩溃隔离（quarantined）的扩展
 *   经 `unquarantine` 解除；隔离开启时含后端扩展升级走蓝绿切换，不再提示重启；
 * - `track`：其他入口（如「从市场安装」）受理的任务交给同一个任务列表。
 *
 * 只持有本设置实例的展示状态；权威状态始终是宿主快照。
 */
import type { ExtensionInstallJobView, ExtensionInstallPhase, SettingsSnapshot } from "@woohaa3/contracts";
import type { ExtensionInstallRemote } from "../../services/extension-install-remote.js";

export const INSTALL_PHASE_LABELS: Record<ExtensionInstallPhase, string> = {
  queued: "排队中",
  resolve: "解析版本",
  download: "读取安装包",
  verify: "校验签名",
  stage: "解包",
  preflight: "预检声明",
  commit: "写入版本",
  reload: "重新加载",
  observe: "观察中"
};

const FAILURE_LABELS: Record<string, string> = {
  MARKETPLACE_SOURCE_UNAVAILABLE: "安装来源不可用",
  MARKETPLACE_ENGINES_INCOMPATIBLE: "扩展与当前宿主版本不兼容",
  MARKETPLACE_DEPENDENCY_UNSATISFIED: "缺少扩展依赖",
  MARKETPLACE_BUILTIN_CONFLICT: "内置版本不低于所选版本，或该内置扩展暂不支持覆盖升级",
  MARKETPLACE_PUBLISHER_CHANGED: "更新包的签名发布者与已安装版本不一致；请先卸载再安装",
  MARKETPLACE_DOWNLOAD_FAILED: "读取安装包失败",
  MARKETPLACE_PACKAGE_TOO_LARGE: "安装包超过大小上限",
  MARKETPLACE_DIGEST_MISMATCH: "安装包内容与摘要不符",
  MARKETPLACE_SIGNATURE_INVALID: "签名无效或不受信任",
  MARKETPLACE_UNSIGNED_REJECTED: "未签名的安装包被拒绝（本机未允许未签名本地包）",
  MARKETPLACE_ARCHIVE_UNSAFE: "安装包含不安全的条目",
  MARKETPLACE_PREFLIGHT_FAILED: "扩展声明未通过预检",
  MARKETPLACE_FORBIDDEN_DECLARATION: "扩展声明了受管扩展不允许的能力",
  MARKETPLACE_VERSION_CONTENT_CONFLICT: "同一版本号已安装了不同内容",
  MARKETPLACE_REVISION_CONFLICT: "安装记录已被其他操作修改，请重试",
  MARKETPLACE_RESTART_UNSUPPORTED: "当前运行方式不支持自动重启，请手动重启本机服务",
  MARKETPLACE_NOT_INSTALLED: "该扩展未安装",
  MARKETPLACE_NO_PREVIOUS_VERSION: "没有可回滚的上一版本",
  MARKETPLACE_WRITER_LOCKED: "另一个本机服务进程正在管理扩展安装",
  MARKETPLACE_INSTALLATIONS_CORRUPT: "安装记录损坏",
  MARKETPLACE_UNINSTALL_DRAINING: "扩展仍有进行中的工作，收尾后再卸载",
  MARKETPLACE_UNAVAILABLE: "本机宿主未启用扩展安装",
  MARKETPLACE_CANCELLED: "已取消",
  MARKETPLACE_PACKAGE_INVALID: "安装包缺少构建期描述，请用新版 pack:extension 重新打包",
  MARKETPLACE_SWAP_FAILED: "新版本未能在独立进程中就绪，已保留原版本",
  MARKETPLACE_SOURCE_NOT_FOUND: "安装来源不存在",
  unauthorized: "需要管理员权限",
  forbidden: "没有管理插件的权限",
  unavailable: "无法连接本机服务"
};

/** 稳定失败码 → 中文原因；未知码回落宿主的安全消息。 */
export function failureReason(code: string, message?: string): string {
  const label = FAILURE_LABELS[code];
  const withDetail = code === "MARKETPLACE_PREFLIGHT_FAILED" || code === "MARKETPLACE_SWAP_FAILED";
  if (label) return message && message !== label && withDetail ? `${label}：${message}` : label;
  return message || "操作失败";
}

const ACTION_LABELS: Record<ExtensionInstallJobView["action"], string> = { install: "安装", uninstall: "卸载", rollback: "回滚" };

/** 一行任务的展示文案。 */
export function describeJob(job: ExtensionInstallJobView): { title: string; detail: string; tone: "running" | "success" | "failed" } {
  const subject = job.extensionId ? `${job.extensionId}${job.version ? ` v${job.version}` : ""}` : "扩展";
  const title = `${ACTION_LABELS[job.action]} ${subject}`;
  if (job.status === "running") {
    const percent = job.progress !== undefined ? ` ${Math.round(job.progress * 100)}%` : "";
    return { title, detail: `${INSTALL_PHASE_LABELS[job.phase]}${percent}`, tone: "running" };
  }
  if (job.status === "succeeded") {
    const detail = job.outcome === "restart-required" ? "已完成，重启本机服务后生效" : job.outcome === "already-current" ? "已是当前版本" : "已完成";
    return { title, detail, tone: "success" };
  }
  if (job.status === "cancelled") return { title, detail: "已取消", tone: "failed" };
  return { title, detail: failureReason(job.failure?.code ?? "", job.failure?.message), tone: "failed" };
}

export type ManagedExtensionsState = {
  /** 本设置实例跟踪的任务（新的在前）。 */
  jobs: ExtensionInstallJobView[];
  /** 发起请求本身失败（未产生任务）。 */
  error: string | null;
  /** 正在提交（上传或请求）。 */
  submitting: boolean;
  restart: { status: "idle" | "requesting" | "requested" | "unsupported" | "failed"; message: string | null };
  /** 正在解除隔离的扩展。 */
  unquarantining: readonly string[];
};

export type ManagedExtensionsController = {
  getState(): ManagedExtensionsState;
  subscribe(listener: () => void): () => void;
  installFile(file: Blob & { name?: string }): Promise<void>;
  uninstall(extensionId: string, options?: { purgeData?: boolean }): Promise<void>;
  rollback(extensionId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  restart(): Promise<void>;
  /** 其他入口受理的任务交给同一个任务列表（行为同安装受理成功后）。 */
  track(jobId: string, job?: ExtensionInstallJobView): void;
  /** 接管设置快照里的任务（进行中的继续轮询）。 */
  adoptSnapshot(snapshot: SettingsSnapshot | null): void;
  /** 某扩展是否有进行中的任务（卡片按钮据此禁用）。 */
  busy(extensionId: string): boolean;
  dispose(): void;
};

export type ManagedExtensionsOptions = {
  remote: ExtensionInstallRemote;
  /** 任务终态后重取权威设置快照。 */
  reload: () => Promise<void>;
  pollIntervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

const MAX_JOBS = 8;

export function createManagedExtensionsController(options: ManagedExtensionsOptions): ManagedExtensionsController {
  const pollMs = options.pollIntervalMs ?? 800;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let state: ManagedExtensionsState = { jobs: [], error: null, submitting: false, restart: { status: "idle", message: null }, unquarantining: [] };
  const timers = new Map<string, unknown>();
  let disposed = false;

  const set = (patch: Partial<ManagedExtensionsState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const upsertJob = (job: ExtensionInstallJobView) => {
    const rest = state.jobs.filter((entry) => entry.jobId !== job.jobId);
    set({ jobs: [job, ...rest].slice(0, MAX_JOBS) });
  };

  const poll = (jobId: string) => {
    if (disposed || timers.has(jobId)) return;
    timers.set(
      jobId,
      setTimer(async () => {
        timers.delete(jobId);
        if (disposed) return;
        const result = await options.remote.job(jobId);
        if (disposed) return;
        if (!result.ok) {
          // 读取失败（宿主重启中等）：继续轮询，不把任务标成失败。
          poll(jobId);
          return;
        }
        upsertJob(result.job);
        if (result.job.status === "running") poll(jobId);
        else void options.reload().catch(() => undefined);
      }, pollMs)
    );
  };

  type Placeholder = Omit<ExtensionInstallJobView, "jobId" | "status" | "phase" | "startedAt">;
  const track = (jobId: string, job: ExtensionInstallJobView | undefined, placeholder: Placeholder) => {
    if (disposed) return;
    const initial = job ?? { ...placeholder, jobId, status: "running" as const, phase: "queued" as const, startedAt: new Date().toISOString() };
    upsertJob(initial);
    if (initial.status === "running") poll(jobId);
    else void options.reload().catch(() => undefined);
  };

  const start = async (request: () => Promise<{ ok: true; jobId: string; job?: ExtensionInstallJobView } | { ok: false; code: string; error: string }>, placeholder: Placeholder) => {
    set({ submitting: true, error: null });
    const result = await request();
    if (disposed) return;
    if (!result.ok) {
      set({ submitting: false, error: failureReason(result.code, result.error) });
      return;
    }
    set({ submitting: false });
    track(result.jobId, result.job, placeholder);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    installFile: (file) => start(() => options.remote.installFile(file), { action: "install", sourceId: "local-file" }),
    uninstall: (extensionId, opts) => start(() => options.remote.uninstall(extensionId, opts), { action: "uninstall", sourceId: "local-file", extensionId }),
    rollback: (extensionId) => start(() => options.remote.rollback(extensionId), { action: "rollback", sourceId: "local-file", extensionId }),
    async cancel(jobId) {
      const result = await options.remote.cancel(jobId);
      if (disposed) return;
      if (result.ok) upsertJob(result.job);
      else set({ error: failureReason(result.code, result.error) });
    },
    async restart() {
      set({ restart: { status: "requesting", message: null } });
      const result = await options.remote.restart();
      if (disposed) return;
      if (result.ok) set({ restart: { status: "requested", message: "正在重启本机服务，连接恢复后自动继续。" } });
      else if (result.code === "MARKETPLACE_RESTART_UNSUPPORTED") set({ restart: { status: "unsupported", message: failureReason(result.code) } });
      else set({ restart: { status: "failed", message: failureReason(result.code, result.error) } });
    },
    track: (jobId, job) => track(jobId, job, { action: "install", sourceId: job?.sourceId ?? "unknown" }),
    adoptSnapshot(snapshot) {
      for (const job of snapshot?.extensionInstallations?.jobs ?? []) {
        const known = state.jobs.find((entry) => entry.jobId === job.jobId);
        if (known && known.status !== "running") continue;
        upsertJob(job);
        if (job.status === "running") poll(job.jobId);
      }
    },
    busy: (extensionId) => state.submitting || state.jobs.some((job) => job.status === "running" && job.extensionId === extensionId),
    dispose() {
      disposed = true;
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
      listeners.clear();
    }
  };
}
