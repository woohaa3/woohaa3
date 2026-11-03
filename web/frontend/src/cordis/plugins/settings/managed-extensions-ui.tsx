/**
 * 受管扩展的设置面 UI（change: 2026-10-21-add-extension-marketplace-point，任务 7.2 / design D10）。
 *
 * - `ManagedInstallBar`：插件配置顶部「从文件安装」、进行中/最近任务的阶段进度与失败原因、
 *   需要重启时的「立即重启」；只有管理员且宿主启用了受管安装时出现；
 * - `ManagedExtensionDetails`：受管扩展卡片上的来源 / 信任 / 权限 / 观察期与「卸载」「回滚到 x.y.z」；
 *   内置根扩展（`managed !== true`）不渲染任何入口；
 * - `ReleaseChangedNotice`：已打开页面的升级/卸载不热换，提示重开画布。
 *
 * C 方向（子进程隔离已取消）：后端扩展与宿主同进程，含后端代码的升级走**进程内热切换**，
 * 因此卡片默认不显示「需重启」；只有没装配扩展层的最小组合才会置 restartRequired，此时才出现
 * 「立即重启」。崩溃隔离、解除隔离、权限强制标注与蓝绿切换都随子进程一起删除。
 */
import { useRef, useState, useSyncExternalStore } from "react";
import type { InstalledExtensionView, SettingsSnapshot } from "@woohaa3/contracts";
import { Button } from "@woohaa3/ui/primitives";
import { FileTextIcon } from "@woohaa3/ui/icons";
import { describeJob, type ManagedExtensionsController } from "./managed-extensions.js";
import { ManagedVersionStatusNotice } from "./managed-version-status.js";

function useController(controller: ManagedExtensionsController) {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** 快照里是否有需要重启才生效的受管扩展。 */
export function restartPending(snapshot: SettingsSnapshot | null): boolean {
  return (snapshot?.installedExtensions ?? []).some((entry) => needsRestart(entry));
}

/** 卡片是否需要提示重启：C 方向下含后端代码的变更一律需要重启才生效。 */
function needsRestart(entry: InstalledExtensionView): boolean {
  return entry.managed === true && entry.restartRequired === true;
}

export function ManagedInstallBar({
  controller,
  snapshot,
  canManage,
  variant = "bar"
}: {
  controller: ManagedExtensionsController;
  snapshot: SettingsSnapshot | null;
  canManage: boolean;
  /** `view`：作为「从文件安装」独立视图时，主按钮改为选择文件，不重复页面标题。 */
  variant?: "bar" | "view";
}) {
  const state = useController(controller);
  const input = useRef<HTMLInputElement | null>(null);
  const installations = snapshot?.extensionInstallations;
  // 宿主没有受管安装能力（旧宿主或未配置受管根）：不出现入口。
  if (!installations || !canManage) return null;
  const needsRestart =
    restartPending(snapshot) || state.jobs.some((job) => job.status === "succeeded" && job.outcome === "restart-required");
  return (
    <div className={variant === "view" ? "managed-install is-view" : "managed-install"} data-testid="managed-install">
      {variant === "view" ? (
        <div className="managed-install__drop">
          <span className="managed-install__drop-icon"><FileTextIcon size={21} /></span>
          <strong>拖入 .wxt 扩展包</strong>
          <p>
            或选择本机文件。安装前会校验签名与逐文件摘要。签名对上信任根的扩展会标为已验证；未验证的包会先说明风险，确认后才安装。
          </p>
          <Button
            size="sm"
            tone="primary"
            disabled={state.submitting}
            onClick={() => input.current?.click()}
            data-testid="managed-install-file"
          >
            选择 .wxt 文件
          </Button>
        </div>
      ) : (
        <div className="managed-install__row">
          <Button
            size="sm"
            tone="primary"
            disabled={state.submitting}
            onClick={() => input.current?.click()}
            data-testid="managed-install-file"
          >
            从文件安装
          </Button>
          <span className="settings-page__hint">
            选择 .wxt 扩展包。已验证的扩展直接安装；签名不受信任时会先说明风险。
          </span>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept=".wxt"
        hidden
        data-testid="managed-install-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void controller.installFile(file);
        }}
      />
      {state.error ? (
        <p className="settings-page__error" role="alert" data-testid="managed-install-error">{state.error}</p>
      ) : null}
      {state.jobs.length > 0 ? (
        <ul className="managed-install__jobs" data-testid="managed-install-jobs">
          {state.jobs.map((job) => {
            const view = describeJob(job);
            return (
              <li key={job.jobId} className="managed-install__job" data-tone={view.tone} data-testid={`managed-job-${job.jobId}`}>
                <span className="managed-install__job-title">{view.title}</span>
                <span className="managed-install__job-detail" data-testid={`managed-job-detail-${job.jobId}`}>{view.detail}</span>
                {job.status === "running" && (job.phase === "queued" || job.phase === "resolve" || job.phase === "download" || job.phase === "verify" || job.phase === "stage" || job.phase === "preflight") ? (
                  <Button size="sm" tone="ghost" onClick={() => void controller.cancel(job.jobId)}>取消</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {needsRestart ? (
        <div className="managed-install__restart" role="status" data-testid="managed-restart">
          <span>
            {state.restart.message ??
              (installations.restartSupported ? "含后端代码的扩展已更新，重启本机服务后生效。" : "含后端代码的扩展已更新，请手动重启本机服务后生效。")}
          </span>
          {installations.restartSupported && state.restart.status !== "unsupported" ? (
            <Button
              size="sm"
              disabled={state.restart.status === "requesting" || state.restart.status === "requested"}
              onClick={() => void controller.restart()}
              data-testid="managed-restart-now"
            >
              立即重启
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 受管扩展的操作（回滚 / 卸载）：挂在详情头部右侧，和「返回」同一层。
 *
 * 正文只留提示，不再把卸载按钮泡在说明文字下面——操作属于头部操作区。
 */
export function ManagedExtensionActions({
  installed,
  controller,
  canManage
}: {
  installed: InstalledExtensionView | undefined;
  controller: ManagedExtensionsController;
  canManage: boolean;
}) {
  useController(controller);
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  if (!installed || installed.managed !== true || !canManage) return null;
  const id = installed.id;
  const busy = controller.busy(id);
  return (
    <div className="managed-extension__actions" data-testid={`managed-actions-${id}`}>
      {installed.previousVersion ? (
        <Button size="sm" disabled={busy} onClick={() => void controller.rollback(id)} data-testid={`managed-rollback-${id}`}>
          回滚到 v{installed.previousVersion}
        </Button>
      ) : null}
      {confirming ? (
        <>
          <label className="managed-extension__purge">
            <input type="checkbox" checked={purge} onChange={(event) => setPurge(event.currentTarget.checked)} />
            同时清除扩展数据
          </label>
          <Button
            size="sm"
            tone="danger"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              void controller.uninstall(id, { purgeData: purge });
            }}
            data-testid={`managed-uninstall-confirm-${id}`}
          >
            确认卸载
          </Button>
          <Button size="sm" tone="ghost" onClick={() => setConfirming(false)}>取消</Button>
        </>
      ) : (
        <Button size="sm" tone="ghost" disabled={busy} onClick={() => setConfirming(true)} data-testid={`managed-uninstall-${id}`}>
          卸载
        </Button>
      )}
    </div>
  );
}

/** 受管扩展的状态提示（需重启 / 覆盖内置 / 观察期 / 版本状态）；没有可说的就什么都不渲染。 */
export function ManagedExtensionDetails({
  installed
}: {
  installed: InstalledExtensionView | undefined;
}) {
  if (!installed || installed.managed !== true) return null;
  const id = installed.id;
  const observing = installed.observeUntil ? new Date(installed.observeUntil) : null;
  const hasNotice = installed.quarantine || installed.trust?.startsWith("certified:") || needsRestart(installed) || installed.builtinVersion || observing;
  if (!hasNotice) return null;
  return (
    <div className="managed-extension" data-testid={`managed-extension-${id}`}>
      {installed.quarantine ? <p className="settings-page__error" data-testid={`managed-quarantine-${id}`}>安全校验未通过，已阻止再次激活：{installed.quarantine}。请安装未被吊销的版本；添加裸公钥不能解除隔离。</p> : null}
      {installed.trust?.startsWith("certified:") ? <p className="managed-extension__note">信任域：{installed.trust.split(":")[1]} · 发布者：{installed.trust.split(":")[2]}</p> : null}
      {needsRestart(installed) ? (
        <p className="managed-extension__restart" data-testid={`managed-restart-required-${id}`}>新版本需重启本机服务后生效。</p>
      ) : null}
      {installed.builtinVersion ? (
        <p className="managed-extension__note" data-testid={`managed-builtin-${id}`}>
          当前受管版本覆盖内置 v{installed.builtinVersion}，卸载后回到内置版本。
        </p>
      ) : null}
      {observing ? (
        <p className="managed-extension__note" data-testid={`managed-observe-${id}`}>
          观察期至 {observing.toLocaleString()}，期间失败将自动回滚。
        </p>
      ) : null}
      <ManagedVersionStatusNotice installed={installed} />
    </div>
  );
}

/** 安装未验证扩展前的风险确认。确认后由调用方带上 acceptUntrusted 重试。 */
export function UntrustedInstallDialog({
  name,
  unsigned,
  busy,
  onCancel,
  onConfirm,
  testId = "untrusted-install-dialog"
}: {
  name: string;
  /** 完全没有签名，而不是公钥不在信任根。 */
  unsigned: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId?: string;
}) {
  return (
    <div className="trust-risk">
      <div className="trust-risk__panel" role="alertdialog" data-testid={testId}>
        <h3>安装未验证的扩展</h3>
        <p>
          {unsigned
            ? `「${name}」没有签名，无法确认发布者。`
            : `「${name}」的签名不在本机信任根中，无法确认发布者。`}
          它会和本机宿主在同一个进程里运行，权限相同，没有隔离。只在你确认来源可信时继续。
        </p>
        <div className="trust-risk__actions">
          <Button size="sm" tone="ghost" disabled={busy} onClick={onCancel}>取消</Button>
          <Button size="sm" tone="danger" disabled={busy} onClick={onConfirm} data-testid={`${testId}-confirm`}>仍要安装</Button>
        </div>
      </div>
    </div>
  );
}

/** 任务失败码需要确认时，挂在安装页上的弹窗。 */
export function UntrustedInstallPrompt({ controller }: { controller: ManagedExtensionsController }) {
  const state = useController(controller);
  const prompt = state.riskPrompt;
  if (!prompt) return null;
  return (
    <UntrustedInstallDialog
      name={prompt.name}
      unsigned={prompt.code === "MARKETPLACE_UNSIGNED_REJECTED"}
      busy={state.submitting}
      onCancel={() => controller.dismissRisk()}
      onConfirm={() => void controller.confirmRisk()}
    />
  );
}

/** 已打开页面里仍在用旧版本的扩展：提示重开画布（升级/卸载不在当前页面热换）。 */
export function ReleaseChangedNotice({ pending, onReopen }: { pending: readonly string[]; onReopen?: () => void }) {
  if (pending.length === 0) return null;
  return (
    <p className="settings-page__pending" role="status" data-testid="managed-release-pending">
      <span>{pending.join("、")} 已更新，重新打开画布后使用新版本。</span>
      {onReopen ? <Button size="sm" onClick={onReopen} data-testid="managed-release-reopen">重新打开画布</Button> : null}
    </p>
  );
}
