/**
 * 设置「通知」分区（change: 2026-10-17-move-settings-into-canvas-dialog，任务 9.1/9.3 / design D10）。
 *
 * 与外观同级的一级分区，只**消费** App scope 通知服务：
 * - 不创建第二份任务订阅或偏好 store；
 * - 开关是本地非敏感偏好，即时生效、不产生未保存草稿，因此不参与 dirty 门禁；
 * - OS 授权与用户意愿分开显示：只有用户开启系统通知且未询问时才申请权限；
 * - 异步申请/测试计入设置 pending（通过宿主注入的 `beginPending`），强制释放后的迟到结果
 *   只更新服务事实，不复活视图。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Switch } from "@woohaa3/ui/primitives";
import type { TaskNotificationService } from "../../contract/notification.js";

const PERMISSION_LABELS: Record<string, string> = {
  unknown: "未知",
  prompt: "尚未授权",
  granted: "已允许",
  denied: "已拒绝",
  unsupported: "平台不支持"
};

export type NotificationSettingsSectionProps = {
  notifications: TaskNotificationService;
  /** 异步申请/测试的 pending 上报（接入设置 edit-session；缺省不参与门禁）。 */
  reportPending?: (pending: boolean) => void;
};

export function NotificationSettingsSection({ notifications, reportPending }: NotificationSettingsSectionProps) {
  const snapshot = useSyncExternalStore(
    notifications.subscribe,
    notifications.getSnapshot,
    notifications.getSnapshot
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const actions = notifications.actions;
  const platform = snapshot.platform;
  const prefs = snapshot.preferences;

  useEffect(() => {
    reportPending?.(busy);
  }, [reportPending, busy]);

  // 进入分区/窗口重新聚焦时重查外部权限变化（不自动申请）。
  useEffect(() => {
    if (platform !== "desktop") return undefined;
    void actions.refreshPermission();
    const onFocus = () => void actions.refreshPermission();
    globalThis.addEventListener?.("focus", onFocus);
    return () => globalThis.removeEventListener?.("focus", onFocus);
  }, [actions, platform]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试");
    } finally {
      setBusy(false);
    }
  };

  const permissionText = useMemo(
    () => PERMISSION_LABELS[snapshot.permission] ?? snapshot.permission,
    [snapshot.permission]
  );

  return (
    <div data-testid="notification-settings">
      <p className="settings-page__hint" data-testid="notification-settings-hint">
        仅在应用处于后台时提醒。提醒只反映任务最终结果，不改任务面板自己的未读。
      </p>

      <ul className="settings-page__list">
        <NotificationRow
          label="任务完成提醒"
          description="任务成功结束时提醒。"
          checked={prefs.categories.succeeded}
          disabled={busy}
          testId="notification-category-succeeded"
          onCheckedChange={(next) => actions.setCategory("succeeded", next)}
        />
        <NotificationRow
          label="任务失败提醒"
          description="任务失败结束时提醒。"
          checked={prefs.categories.failed}
          disabled={busy}
          testId="notification-category-failed"
          onCheckedChange={(next) => actions.setCategory("failed", next)}
        />
        {platform === "web" ? (
          <NotificationRow
            label="标签页标题提醒"
            description="后台完成时在文档标题前显示完成/失败数量；回到应用后恢复原标题。"
            checked={prefs.titleEnabled}
            disabled={busy}
            testId="notification-channel-title"
            onCheckedChange={(next) => actions.setChannel("title", next)}
          />
        ) : (
          <NotificationRow
            label="系统通知"
            description="通过系统通知中心提醒；首次开启时才申请权限。"
            checked={prefs.systemEnabled}
            disabled={busy}
            testId="notification-channel-system"
            onCheckedChange={(next) => void run(() => actions.setChannel("system", next).then(() => undefined))}
          />
        )}
      </ul>

      {platform === "desktop" ? (
        <div className="settings-page__item" data-testid="notification-desktop-status">
          <div className="settings-page__item-head">
            <span className="settings-page__item-label">系统权限</span>
            <span className="settings-page__badge" data-testid="notification-permission">
              {permissionText}
            </span>
          </div>
          <p className="settings-page__item-description">
            权限由系统授予，与本页开关分开记录。
            {snapshot.channels.system.status === "blocked" && snapshot.channels.system.reason
              ? ` ${snapshot.channels.system.reason}`
              : ""}
          </p>
          <div className="settings-page__item-control">
            <Button
              size="sm"
              disabled={busy || snapshot.permission === "unsupported" || snapshot.permission === "granted"}
              onClick={() => void run(() => actions.requestPermission())}
              data-testid="notification-request-permission"
            >
              申请权限
            </Button>
            <Button
              size="sm"
              tone="neutral"
              disabled={busy || snapshot.permission !== "granted"}
              onClick={() =>
                void run(async () => {
                  const result = await actions.sendTestNotification();
                  setTestResult(result.ok ? "测试通知已发送" : result.error);
                })
              }
              data-testid="notification-send-test"
            >
              发送测试通知
            </Button>
          </div>
          {testResult ? (
            <p className="settings-page__hint" role="status" data-testid="notification-test-result">
              {testResult}
            </p>
          ) : null}
        </div>
      ) : null}

      {snapshot.source.status === "unavailable" ? (
        <p className="settings-page__hint" data-testid="notification-source-unavailable">
          任务提醒当前不可用：{snapshot.source.reason ?? "无法读取任务历史"}。偏好仍会保存。
        </p>
      ) : null}
      {snapshot.storageError ? (
        <p className="settings-page__error" role="alert" data-testid="notification-storage-error">
          {snapshot.storageError}
        </p>
      ) : null}
      {error ? (
        <p className="settings-page__error" role="alert" data-testid="notification-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NotificationRow({
  label,
  description,
  checked,
  disabled,
  testId,
  onCheckedChange
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  testId: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <li className="settings-page__item" data-setting-key={testId}>
      <div className="settings-page__item-head">
        <span className="settings-page__item-label">{label}</span>
        <span className="settings-page__badge is-muted">本地偏好</span>
      </div>
      <p className="settings-page__item-description">{description}</p>
      <div className="settings-page__item-control">
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-label={label}
          testId={testId}
        />
      </div>
    </li>
  );
}
