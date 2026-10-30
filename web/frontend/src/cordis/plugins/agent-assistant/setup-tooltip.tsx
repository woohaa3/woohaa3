import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { PROVIDER_SETTING_PREFIX, type SettingsSnapshot } from "@woohaa3/contracts";
import { Tooltip } from "@woohaa3/ui/primitives";
import { useOptionalService, useService } from "../../react.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import type { SettingsRemote } from "../../services/settings-remote.js";
import { ASSISTANT_SETUP_TOOLTIP } from "@woohaa3/ui/assistant";

const noopSubscribe = () => () => undefined;

/**
 * 已保存的模型 API Key（`providers.<providerId>.apiKey`）同样算「用户已经配置过」。
 *
 * 生成服务能直接跑模型时不该再提示「尚未配置助手」，否则这块常驻引导会一直挡在右下角。
 */
export function hasProviderApiKey(snapshot: SettingsSnapshot | null | undefined): boolean {
  return Boolean(snapshot?.settings.some(entry =>
    entry.key.startsWith(PROVIDER_SETTING_PREFIX) && entry.key.endsWith(".apiKey") && entry.configured
  ));
}

/**
 * 右下角 AI 助手按钮的配置引导。
 *
 * 引导是常驻的：只要这个数据空间还没配置助手、也没保存过模型 API Key，就一直显示，
 * 不会被悬停结束、Escape 或点击其它地方关掉；只在弹窗打开时让位（提示层会被遮罩盖住，
 * 且弹窗自己就是配置入口）。任一条件满足后立即不再出现，恢复普通的「AI 助手」悬停提示。
 *
 * Uses the same scoped directory as composers; loading/failure is never an empty account.
 */
export function AssistantSetupTooltip({ children }: { children: ReactNode }) {
  const service = useService("agentConversationService");
  const user = useOptionalService("currentUser");
  const session = useOptionalService("canvasSession");
  const dialogs = useOptionalService("dialogs");
  const remote = useOptionalService("settingsRemote") as SettingsRemote | undefined;
  const namespace = useSyncExternalStore(user?.subscribe ?? service.subscribe ?? noopSubscribe,
    () => user ? user.getSnapshot()?.dataScopeId : service.getDataScopeId?.());
  const phase = useSyncExternalStore(session?.subscribe ?? noopSubscribe, () => session?.getStatus().phase);
  const dialogOpen = useSyncExternalStore(dialogs?.subscribe ?? noopSubscribe, () => Boolean(dialogs?.getSnapshot().stack.length));
  const directory = agentDirectory(service, namespace ?? "unresolved");
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  // Provider 密钥只在弹窗关闭后重读：写入都发生在弹窗内，关掉才回到画布。
  const [apiKey, setApiKey] = useState<{ scope: string; configured: boolean } | null>(null);
  useEffect(() => {
    if (namespace && phase === "ready") void directory.load();
  }, [directory, namespace, phase]);
  useEffect(() => {
    if (!namespace || phase !== "ready") return;
    // 弹窗打开即视为「正在配置」：先丢掉旧读数，关闭后重读，避免刚保存完又闪一次提示。
    if (dialogOpen) {
      setApiKey(null);
      return;
    }
    if (!remote) {
      setApiKey({ scope: namespace, configured: false });
      return;
    }
    let cancelled = false;
    const settle = (configured: boolean) => {
      if (!cancelled) setApiKey({ scope: namespace, configured });
    };
    void remote.fetchSnapshot().then(
      result => settle(result.ok && hasProviderApiKey(result.snapshot)),
      () => settle(false)
    );
    return () => { cancelled = true; };
  }, [remote, namespace, phase, dialogOpen]);
  const configuredApiKey = Boolean(apiKey && apiKey.scope === namespace && apiKey.configured);
  const empty = Boolean(namespace && snapshot.ready && !snapshot.loadingMessage && !snapshot.error && !snapshot.connections.length);
  // 密钥读回之前不提前收掉引导，避免配置过的用户先看到一次一闪而过的提示。
  const guide = empty && apiKey?.scope === namespace && !configuredApiKey && !dialogOpen;
  // 受控：引导期间忽略所有关闭请求（悬停结束、Escape、点击）；配置完成后回到普通悬停提示。
  const [hovered, setHovered] = useState(false);
  return <Tooltip content={guide ? ASSISTANT_SETUP_TOOLTIP : "AI 助手"} side="top" align="end"
    open={guide || hovered}
    onOpenChange={open => { if (!guide) setHovered(open); }}>
    {children}
  </Tooltip>;
}
