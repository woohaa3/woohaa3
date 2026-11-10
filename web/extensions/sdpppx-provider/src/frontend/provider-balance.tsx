/**
 * 提供商列表行里的余额读数（`agent-assistant.provider-balance`）。
 *
 * 宿主只按 `providerId` 找到本贡献并渲染，不参与余额读取；余额仍由宿主侧 `/session` 返回，
 * 浏览器不接触令牌。未登录、读取中或上游不可用时都不占用行内空间。
 */
import { createElement, useEffect, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import type { SdpppxSessionSnapshot } from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";

export function SdpppxProviderBalance({ service }: { service: SdpppxAccountService }) {
  const snapshot: SdpppxSessionSnapshot = useSyncExternalStore<SdpppxSessionSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const authenticated = snapshot.status === "authenticated";

  // 列表行挂载时读一次 `/session`：快照初始是未登录，必须主动拉取才能显示余额。
  useEffect(() => {
    void service.refresh();
  }, [service]);

  if (!authenticated) return null;
  const total = snapshot.session?.balance?.totalBalance;
  if (total === undefined || !Number.isFinite(total)) return null;
  return (
    <span className="agent-assistant__balance" data-testid="sdpppx-provider-balance">
      余额 {total}
    </span>
  );
}

/** `agent-assistant.provider-balance` 的 renderer 工厂（入口文件保持无 JSX）。 */
export function createSdpppxProviderBalanceRenderer(service: SdpppxAccountService): () => ReactElement {
  return () => createElement(SdpppxProviderBalance, { service });
}
