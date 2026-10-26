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
import { Button } from "../../../shared/ui/Button.js";
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
  canManage
}: {
  controller: ManagedExtensionsController;
  snapshot: SettingsSnapshot | null;
  canManage: boolean;
}) {
  const state = useController(controller);
  const input = useRef<HTMLInputElement | null>(null);
  const installations = snapshot?.extensionInstallations;
  // 宿主没有受管安装能力（旧宿主或未配置受管根）：不出现入口。
  if (!installations || !canManage) return null;
  const needsRestart =
    restartPending(snapshot) || state.jobs.some((job) => job.status === "succeeded" && job.outcome === "restart-required");
  return (
    <div className="managed-install" data-testid="managed-install">
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
          选择 .wxt 扩展包；安装前校验签名与声明{installations.allowUnsignedLocal ? "（本机允许未签名的本地包）" : ""}。
        </span>
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
      </div>
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

function trustLabel(trust: InstalledExtensionView["trust"]): string {
  if (!trust) return "未知";
  if (trust === "unsigned") return "未签名（本地开发）";
  return `已签名 · ${trust.slice("signed:".length)}`;
}

export function ManagedExtensionDetails({
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
  if (!installed || installed.managed !== true) return null;
  const id = installed.id;
  const busy = controller.busy(id);
  return (
    <div className="managed-extension" data-testid={`managed-extension-${id}`}>
      <dl className="managed-extension__facts">
        <dt>来源</dt>
        <dd data-testid={`managed-source-${id}`}>{installed.sourceId === "local-file" ? "本地文件" : installed.sourceId ?? "未知"}</dd>
        <dt>信任</dt>
        <dd data-testid={`managed-trust-${id}`}>{trustLabel(installed.trust)}</dd>
        {installed.observeUntil ? (
          <>
            <dt>观察期</dt>
            <dd>至 {new Date(installed.observeUntil).toLocaleString()}，期间失败将自动回滚</dd>
          </>
        ) : null}
      </dl>
      {needsRestart(installed) ? (
        <p className="managed-extension__restart" data-testid={`managed-restart-required-${id}`}>新版本需重启本机服务后生效。</p>
      ) : null}
      <ManagedVersionStatusNotice installed={installed} />
      {canManage ? (
        <div className="managed-extension__actions">
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
      ) : null}
    </div>
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
