/**
 * 设置 → 插件配置 → SDPPPX 详情面板。
 *
 * 部署身份编译在 `deployment-config.ts`，运行参数来自环境变量，因此这里**只读展示解析
 * 结果**：租户、Supabase host、Authing、模板类型映射与超时。没有输入框，
 * 不产生 dirty 状态。
 *
 * 提供的动作只有「刷新模型」：登录由 AI 助手的供应商入口发起；这里不复制一条登录入口。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { SettingsFeedback, SettingsSection } from "@woohaa3/ui/settings";
import {
  SDPPPX_ERROR_CODES,
  type SdpppxSessionSnapshot
} from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";
import "./sdpppx.css";

export type SdpppxSettingsPanelProps = {
  service: SdpppxAccountService;
};

const STATUS_LABEL: Record<SdpppxSessionSnapshot["status"], string> = {
  authenticated: "已登录",
  anonymous: "未登录",
  unconfigured: "未配置"
};

function refreshMessage(code: string | undefined): string {
  switch (code) {
    case SDPPPX_ERROR_CODES.sessionExpired:
      return "登录已过期，请重新扫码。";
    case SDPPPX_ERROR_CODES.catalogUnavailable:
      return "模板目录暂时不可用，已保留上一次结果。";
    case SDPPPX_ERROR_CODES.configIncomplete:
      return "缺少 SDPPPX 部署参数。";
    case SDPPPX_ERROR_CODES.serviceUnavailable:
    default:
      return "刷新失败，可稍后重试。";
  }
}

function formatTime(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : "—";
}

export function SdpppxSettingsPanel({ service }: SdpppxSettingsPanelProps) {
  const snapshot: SdpppxSessionSnapshot = useSyncExternalStore<SdpppxSessionSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    void service.refresh();
  }, [service]);

  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    setFeedback(null);
    const result = await service.refreshModels();
    setRefreshing(false);
    if (!result.ok) {
      setFeedback({ tone: "danger", text: refreshMessage(result.code) });
      return;
    }
    if (result.error) {
      setFeedback({ tone: "danger", text: refreshMessage(result.error) });
      return;
    }
    setFeedback({
      tone: "success",
      text: result.available
        ? `已刷新：${result.modelCount} 个模板（目录版本 ${result.catalogRevision}）。`
        : "已刷新：当前租户没有启用的模板。"
    });
  }, [service]);

  const config = snapshot.config;
  const session = snapshot.session;
  const modelTypeCount = Object.keys(config.templateModelTypes).length;

  return (
    <div className="sdpppx-settings" data-testid="sdpppx-settings-panel">
      <SettingsSection
        title="账号"
        description="微信扫码登录在宿主进程完成；浏览器只显示状态、昵称与余额。"
      >
        <dl className="sdpppx-settings__facts">
          <dt>状态</dt>
          <dd data-testid="sdpppx-settings-status" data-state={snapshot.status}>
            {STATUS_LABEL[snapshot.status]}
            {snapshot.notice === SDPPPX_ERROR_CODES.sessionExpired ? "（登录已过期）" : ""}
          </dd>
          <dt>昵称</dt>
          <dd>{session?.displayName ?? "—"}</dd>
          <dt>会话到期</dt>
          <dd>{session ? formatTime(session.expiresAt) : "—"}</dd>
          <dt>余额</dt>
          <dd>
            {session?.balance
              ? `${session.balance.totalBalance}`
              : snapshot.status === "authenticated"
                ? "暂不可用"
                : "—"}
          </dd>
        </dl>
        {snapshot.status === "unconfigured" ? (
          <SettingsFeedback tone="warning">
            缺少部署配置：{snapshot.missing.length > 0 ? snapshot.missing.join(" / ") : "未知"}。检查 `deployment-config.ts` 并重新构建扩展后生效。
          </SettingsFeedback>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="部署身份与运行参数（只读）"
        description="部署身份编译在 deployment-config.ts；运行参数来自 SDPPPX_* 环境变量；这里只展示解析结果，不写入任何密钥。"
      >
        <dl className="sdpppx-settings__facts" data-testid="sdpppx-settings-config">
          <dt>服务地址</dt>
          <dd>{config.baseUrl || "—"}</dd>
          <dt>租户</dt>
          <dd>{config.tenantId ?? "—"}</dd>
          <dt>Supabase</dt>
          <dd>{config.supabaseHost ?? "—"}</dd>
          <dt>Authing appId</dt>
          <dd>{config.authingAppIdConfigured ? "已显式配置" : "按租户查询"}</dd>
          <dt>Authing 地址</dt>
          <dd>{config.authingHost || "—"}</dd>
          <dt>扫码场景</dt>
          <dd>{config.authingScene || "—"}</dd>
          <dt>Bridge</dt>
          <dd>{config.bridgeHost ?? "—"}</dd>
          <dt>提示词字段</dt>
          <dd>{config.promptField || "—"}</dd>
          <dt>上传通道</dt>
          <dd>{config.uploadProvider || "—"}</dd>
          <dt>任务超时</dt>
          <dd>{config.taskTimeoutMs > 0 ? `${Math.round(config.taskTimeoutMs / 1000)} 秒` : "—"}</dd>
          <dt>视频模板映射</dt>
          <dd>{modelTypeCount > 0 ? `${modelTypeCount} 个模板已指定输出类型` : "未配置（全部按图片）"}</dd>
        </dl>
      </SettingsSection>

      <SettingsSection
        title="模型目录"
        description="登录后从租户模板刷新；刷新失败会保留上一次成功目录。"
        action={
          <Button
            size="sm"
            tone="neutral"
            onClick={() => void refreshModels()}
            loading={refreshing}
            data-testid="sdpppx-settings-refresh-models"
          >
            刷新模型
          </Button>
        }
      >
        {feedback ? (
          <SettingsFeedback tone={feedback.tone}>
            <span data-testid="sdpppx-settings-feedback">{feedback.text}</span>
          </SettingsFeedback>
        ) : (
          <p className="sdpppx-settings__hint">登录后自动刷新；也可在这里手动重试。</p>
        )}
      </SettingsSection>
    </div>
  );
}
