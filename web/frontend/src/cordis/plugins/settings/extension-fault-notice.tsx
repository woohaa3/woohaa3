/**
 * 插件卡片上的「本次会话已停用」提示与重新加载入口
 * （change: 2026-10-21-harden-extension-fault-isolation，design D3，任务 2.5）。
 *
 * 只读 App 级 `extensionFaults`；熔断只在当前页面会话内有效，不写站点配置或浏览器偏好。
 * 「重新加载此扩展」推进 epoch 后重新装配并清零计数；装配方未提供重新装配时提示刷新页面。
 */
import { useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { useExtensionFaults } from "../../host.js";

export function ExtensionFaultNotice({ extensionId }: { extensionId: string }) {
  const faults = useExtensionFaults();
  useSyncExternalStore(
    (listener) => faults?.subscribe(listener) ?? (() => undefined),
    () => faults?.version() ?? 0,
    () => 0
  );
  const state = faults?.stateOf(extensionId);
  if (!faults || !state?.tripped) return null;
  return (
    <div className="plugin-card__fault" role="status" data-testid={`settings-plugin-fault-${extensionId}`}>
      <span>本次会话已停用：渲染错误过多{state.lastMessage ? `（${state.lastMessage}）` : ""}</span>
      {state.reloadable ? (
        <Button size="sm" onClick={() => faults.reload(extensionId)} data-testid={`settings-plugin-fault-reload-${extensionId}`}>
          重新加载此扩展
        </Button>
      ) : (
        <span className="settings-page__hint">刷新页面后恢复。</span>
      )}
    </div>
  );
}
